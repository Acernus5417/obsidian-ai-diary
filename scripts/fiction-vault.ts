import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { type VaultPort } from '../src/domain/types';
import { safePath } from '../src/domain/util';

/** Project-local, disk-backed fictional vault. Never points at the real vault. */
export class DiskVault implements VaultPort {
  private paths = new Set<string>();
  readonly reads: string[] = [];
  constructor(readonly directory: string, private traceReads = false) {}
  private file(path: string) {
    const result = resolve(this.directory, safePath(path));
    if (!result.startsWith(this.directory + sep)) throw new Error('Outside fictional vault'); return result;
  }
  async load(dir = this.directory): Promise<void> {
    await mkdir(dir, { recursive: true });
    for (const file of await readdir(dir, { withFileTypes: true })) {
      if (file.isSymbolicLink()) continue;
      const full = resolve(dir, file.name);
      if (file.isDirectory()) await this.load(full);
      else if (file.name.endsWith('.md')) this.paths.add(relative(this.directory, full).split(sep).join('/'));
    }
  }
  list() { return [...this.paths]; }
  revision(path: string) { try { const s = statSync(this.file(path)); return `${s.mtimeMs}:${s.size}`; } catch { return ''; } }
  async read(path: string) {
    if (this.traceReads) this.reads.push(path);
    try { return await readFile(this.file(path), 'utf8'); } catch (e) { if ((e as { code?: string }).code === 'ENOENT') return null; throw e; }
  }
  async create(path: string, text: string) { await writeFile(this.file(path), text, { encoding: 'utf8', flag: 'wx' }); this.paths.add(path); }
  async process(path: string, fn: (text: string) => string) { const text = await readFile(this.file(path), 'utf8'); await writeFile(this.file(path), fn(text), 'utf8'); }
  async mkdir(path: string) { await mkdir(this.file(path), { recursive: true }); }
}
