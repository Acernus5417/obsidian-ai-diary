import { App, TFile, TFolder, requestUrl } from 'obsidian';
import { DiaryError, type VaultPort } from '../domain/types';
import { safePath } from '../domain/util';
import { type HttpPort, type SecretPort } from '../ai/gateway';
export class ObsidianVault implements VaultPort {
  constructor(private app: App) {}
  list(): string[] { return this.app.vault.getMarkdownFiles().map(f => f.path); }
  revision(path: string): string {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? `${f.stat.mtime}:${f.stat.size}` : '';
  }
  async read(path: string): Promise<string | null> {
    const f = this.app.vault.getAbstractFileByPath(safePath(path));
    if (f === null) return null;
    if (!(f instanceof TFile)) throw new DiaryError('path', '目标位置是文件夹，请调整归档目录。');
    return this.app.vault.read(f);
  }
  async create(path: string, text: string): Promise<void> { await this.app.vault.create(safePath(path), text); }
  async process(path: string, fn: (text: string) => string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(safePath(path));
    if (!(f instanceof TFile)) throw new DiaryError('missing', '目标笔记尚未到达或已移动，请检查同步后重试。');
    await this.app.vault.process(f, fn);
  }
  async mkdir(path: string): Promise<void> {
    const p = safePath(path), f = this.app.vault.getAbstractFileByPath(p);
    if (f instanceof TFolder) return;
    if (f) throw new DiaryError('path', '目录位置被同名文件占用。');
    try { await this.app.vault.createFolder(p); }
    catch (e) { if (!(this.app.vault.getAbstractFileByPath(p) instanceof TFolder)) throw e; }
  }
}
export class ObsidianSecrets implements SecretPort {
  constructor(private app: App) {}
  get(name: string): string | null {
    if (!this.app.secretStorage?.getSecret) throw new DiaryError('version', '当前 Obsidian 不支持凭据存储，请升级到 1.11.5 或以上。');
    return this.app.secretStorage.getSecret(name);
  }
  set(name: string, value: string): void {
    if (!this.app.secretStorage?.setSecret) throw new DiaryError('version', '请升级 Obsidian 后配置凭据。');
    this.app.secretStorage.setSecret(name, value);
  }
}
export const obsidianHttp: HttpPort = async req => {
  const r = await requestUrl({ url: req.url, method: 'POST', headers: req.headers, body: req.body, contentType: 'application/json', throw: false });
  return { status: r.status, text: r.text };
};
