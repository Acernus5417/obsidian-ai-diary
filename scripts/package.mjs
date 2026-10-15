import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const folder = join('dist', manifest.id);
await mkdir(folder, { recursive: true });
const entries = [];
for (const file of ['manifest.json', 'main.js', 'styles.css']) {
  const data = await readFile(file); await copyFile(file, join(folder, file));
  entries.push({ name: `${manifest.id}/${file}`, data });
}
for (const [source, name] of [['docs/安装与使用.md', '安装与使用.md'], ['docs/测试报告.md', '测试报告.md'], ['CHANGELOG.md', 'CHANGELOG.md']]) entries.push({ name, data: await readFile(source) });
const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = data => { let c = 0xffffffff; for (const n of data) c = table[(c ^ n) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const local = [], central = []; let offset = 0;
for (const e of entries) {
  const name = Buffer.from(e.name), crc = crc32(e.data);
  const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(33, 12);
  h.writeUInt32LE(crc, 14); h.writeUInt32LE(e.data.length, 18); h.writeUInt32LE(e.data.length, 22); h.writeUInt16LE(name.length, 26);
  local.push(h, name, e.data);
  const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(33, 14);
  c.writeUInt32LE(crc, 16); c.writeUInt32LE(e.data.length, 20); c.writeUInt32LE(e.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
  central.push(c, name); offset += h.length + name.length + e.data.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...local, directory, end]), zipName = `${manifest.id}-${manifest.version}.zip`;
await writeFile(join('dist', zipName), zip);
const checksums = [...entries.map(e => `${createHash('sha256').update(e.data).digest('hex')}  ${e.name}`), `${createHash('sha256').update(zip).digest('hex')}  ${zipName}`];
await writeFile('dist/SHA256SUMS.txt', `${checksums.join('\n')}\n`);
console.log(`Packaged dist/${zipName} (${zip.length} bytes); whitelist ${entries.length} files.`);
