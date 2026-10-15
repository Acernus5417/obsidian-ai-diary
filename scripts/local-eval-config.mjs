import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';

// Reads only the selected installed diary plugin's configuration and credential.
// Decrypts the local container in memory, selects only this reference, and never
// emits other entries, vault Markdown, or a clear-text secret file.
export function localEvalConfig(vaultPath) {
  const root = path.join(process.env.APPDATA, 'obsidian');
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'obsidian.json'), 'utf8'));
  const candidates = Object.entries(registry.vaults ?? {}).map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => Number(b.ts ?? 0) - Number(a.ts ?? 0));
  const selected = candidates.find(v => (!vaultPath || path.resolve(v.path).toLowerCase() === path.resolve(vaultPath).toLowerCase()) && fs.existsSync(path.join(v.path, '.obsidian/plugins/ai-diary/data.json')));
  if (!selected) throw new Error('没有找到已安装插件的配置。');
  const settings = JSON.parse(fs.readFileSync(path.join(selected.path, '.obsidian/plugins/ai-diary/data.json'), 'utf8'));
  const ref = settings.credentialRef;
  if (typeof ref !== 'string' || !ref.startsWith('ai-diary-')) throw new Error('插件凭据引用无效。');
  const prefix = `${selected.id}-`;
  const values = new Map();
  const directory = path.join(root, 'Local Storage/leveldb');
  // LocalStorage's current WAL is read without taking a database lock or writing
  // to the user's store. Refuse rather than guess if it has been compacted away.
  for (const file of fs.readdirSync(directory).filter(n => /^\d+\.log$/.test(n)).sort()) {
    for (const batch of logRecords(fs.readFileSync(path.join(directory, file)))) {
      for (const entry of batchEntries(batch)) {
        const key = entry.key.toString('latin1');
        for (const suffix of ['secrets-encrypted', 'secrets']) {
          if (!key.endsWith(`\x01${prefix}${suffix}`)) continue;
          if (!entry.value) values.delete(suffix);
          else values.set(suffix, decodeStorage(entry.value));
        }
      }
    }
  }
  let secrets;
  const encrypted = values.get('secrets-encrypted');
  if (typeof encrypted === 'string') {
    const bytes = Buffer.from(encrypted, 'base64');
    let decrypted;
    if (bytes.subarray(0, 3).toString() === 'v10') {
      const state = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8'));
      const wrapped = Buffer.from(state.os_crypt.encrypted_key, 'base64');
      if (wrapped.subarray(0, 5).toString() !== 'DPAPI') throw new Error('不支持当前加密密钥格式。');
      const key = unprotect(wrapped.subarray(5));
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(3, 15));
      decipher.setAuthTag(bytes.subarray(-16));
      decrypted = Buffer.concat([decipher.update(bytes.subarray(15, -16)), decipher.final()]);
      key.fill(0);
    } else decrypted = unprotect(bytes);
    secrets = JSON.parse(decrypted.toString('utf8')); decrypted.fill(0);
  } else secrets = values.get('secrets');
  const apiKey = secrets?.[ref];
  secrets = undefined;
  if (typeof apiKey !== 'string' || !apiKey) throw new Error('未能从本设备读取插件当前配置的凭据。');
  return { baseUrl: settings.baseUrl, modelId: settings.modelId, apiKey };
}
function unprotect(bytes) {
  const script = 'Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($p))';
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: bytes.toString('base64'), encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  return Buffer.from(raw.trim(), 'base64');
}
function decodeStorage(bytes) {
  const text = bytes.subarray(1).toString(bytes[0] === 0 ? 'utf16le' : 'latin1');
  try { return JSON.parse(text); } catch { return undefined; }
}
function* logRecords(bytes) {
  let fragments = [];
  for (let offset = 0; offset + 7 <= bytes.length;) {
    const remain = 32768 - offset % 32768;
    if (remain < 7) { offset += remain; continue; }
    const size = bytes.readUInt16LE(offset + 4), type = bytes[offset + 6];
    if (!size && !type) { offset += remain; continue; }
    if (size + 7 > remain || offset + size + 7 > bytes.length) break;
    const record = bytes.subarray(offset + 7, offset + 7 + size); offset += size + 7;
    if (type === 1) { fragments = []; yield record; }
    else if (type === 2) fragments = [record];
    else if (type === 3 && fragments.length) fragments.push(record);
    else if (type === 4 && fragments.length) { fragments.push(record); yield Buffer.concat(fragments); fragments = []; }
  }
}
function* batchEntries(bytes) {
  if (bytes.length < 12) return;
  let offset = 12;
  const variable = () => { let value = 0, shift = 0; for (; offset < bytes.length && shift < 35; shift += 7) { const b = bytes[offset++]; value += (b & 127) * 2 ** shift; if (!(b & 128)) return value; } throw new Error('截断的本机配置记录。'); };
  const field = () => { const size = variable(); if (offset + size > bytes.length) throw new Error('截断的本机配置字段。'); const result = bytes.subarray(offset, offset + size); offset += size; return result; };
  for (let i = 0, count = bytes.readUInt32LE(8); i < count; i++) {
    const type = bytes[offset++]; if (type !== 0 && type !== 1) return;
    const key = field(), value = type === 1 ? field() : undefined;
    yield { key, value };
  }
}
