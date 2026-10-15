import { DiaryError, type ArchivePlan, type Draft, type Session, type VaultPort, type Settings } from '../domain/types';
import { dayPath, ensureParent, hash, id, link } from '../domain/util';
import { OBS_START, OBS_END } from '../memory/retrieval';
import { EventStore } from '../storage/store';
import { session as projectSession } from '../storage/projections';
export const BODY_START = '<!-- ai-diary-body:start -->';
export const BODY_END = '<!-- ai-diary-body:end -->';
export function bodyOf(text: string): string {
  const start = text.indexOf(BODY_START), end = text.indexOf(BODY_END);
  if (start >= 0 && end > start) return text.slice(start + BODY_START.length, end).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  return text;
}
function marked(text: string, start: string, end: string): boolean {
  return text.split(start).length === 2 && text.split(end).length === 2 && text.indexOf(start) < text.indexOf(end);
}
export function documentFor(current: string | null, d: Draft, transaction: string, date: string): string {
  let next: string;
  const body = `${BODY_START}\n${d.body}\n${BODY_END}`;
  const observations = `${OBS_START}\n## AI 观察\n\n${d.observations || '本次没有保存 AI 观察。'}\n${OBS_END}`;
  if (current === null) next = `---\n日期: ${date}\n类型: AI问答日记\n---\n\n# ${date}\n\n${body}\n\n${observations}\n\n原始问答：${link(d.transcriptPath)}\n`;
  else if (marked(current, BODY_START, BODY_END) && marked(current, OBS_START, OBS_END)) {
    const start = current.indexOf(BODY_START), end = current.indexOf(BODY_END) + BODY_END.length;
    const merged = d.mode === 'append' ? `${BODY_START}\n${bodyOf(current)}${d.body ? `\n\n${d.body}` : ''}\n${BODY_END}` : body;
    next = current.slice(0, start) + merged + current.slice(end);
    const os = next.indexOf(OBS_START), oe = next.indexOf(OBS_END) + OBS_END.length;
    next = next.slice(0, os) + observations + next.slice(oe);
  } else if (d.mode === 'append') {
    next = `${current}\n\n${d.body}\n\n${observations}\n\n原始问答：${link(d.transcriptPath)}\n`;
  } else throw new DiaryError('unmanaged', '当前笔记的管理标记已变化，已保留原文。请使用追加，或将预览内容手动整理到笔记。');
  return `${next}\n<!-- ai-diary-transaction:${transaction} -->\n`;
}
export function transcriptFor(s: Session, diaryPath: string): string {
  return `# ${s.date} 原始问答\n\n日记：${link(diaryPath)}\n\n` + s.messages.map(m => `## ${m.role === 'user' ? '我' : 'AI'} · ${m.createdAt}\n\n${m.text}\n`).join('\n');
}
export class ArchiveService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private vault: VaultPort, private store: EventStore, private settings: () => Settings) {}
  save(s: Session, draft: Draft): Promise<void> {
    const work = this.queue.then(async () => {
      await this.store.refresh();
      // A retry after a completed write uses the original prepared transaction.
      const existing = this.store.events.find(e => e.type === 'archive-prepared' && (e.payload as ArchivePlan).draftId === draft.id);
      if (existing) { await this.execute(existing.payload as ArchivePlan); return; }
      const current = await this.vault.read(draft.diaryPath);
      if ((current === null ? null : hash(current)) !== draft.baseHash) throw new DiaryError('conflict', '正式日记已经变化，未覆盖。请按当前笔记重新生成预览，或打开两份内容进行对照。');
      const transcript = transcriptFor(projectSession(this.store.events, s.date), draft.diaryPath);
      const previous = await this.vault.read(draft.transcriptPath);
      const transaction = id();
      const p: ArchivePlan = {
        id: transaction, date: s.date, draftId: draft.id, diaryPath: draft.diaryPath, transcriptPath: draft.transcriptPath,
        baseHash: draft.baseHash, target: documentFor(current, draft, transaction, s.date), transcript,
        transcriptBaseHash: previous === null ? null : hash(previous), consumedIds: draft.consumedIds
      };
      await this.store.append(s.date, 'archive-prepared', p);
      await this.execute(p);
    });
    this.queue = work.catch(() => undefined); return work;
  }
  async recover(s: Session): Promise<void> { for (const p of s.pending) await this.execute(p); }
  private async backup(p: ArchivePlan, kind: string, text: string): Promise<void> {
    const path = `${this.settings().transcriptFolder}/_版本/${p.date.slice(0, 4)}/${p.date.slice(5, 7)}/${p.date}/${p.id}-${kind}-${hash(text)}.md`;
    await ensureParent(this.vault, path);
    if (await this.vault.read(path) === null) await this.vault.create(path, text);
  }
  private async execute(p: ArchivePlan): Promise<void> {
    const s = this.settings();
    // Never follow a synced or damaged transaction to an arbitrary file.
    if (p.diaryPath !== dayPath(s.diaryFolder, p.date) || p.transcriptPath !== dayPath(s.transcriptFolder, p.date)) throw new DiaryError('path', '归档目录已变化，已保留待恢复记录。请恢复原目录后重试。');
    const done = this.store.events.some(e => e.type === 'archive-completed' && (e.payload as { transactionId: string }).transactionId === p.id);
    if (done) return;
    const marker = `<!-- ai-diary-transaction:${p.id} -->`;
    const current = await this.vault.read(p.diaryPath);
    if (!current?.includes(marker)) {
      if ((current === null ? null : hash(current)) !== p.baseHash) throw new DiaryError('conflict', '归档期间正式日记已变化，原文和待保存稿都保留。请先处理版本差异。');
      if (current !== null) await this.backup(p, 'diary', current);
      await ensureParent(this.vault, p.diaryPath);
      if (current === null) await this.vault.create(p.diaryPath, p.target);
      else await this.vault.process(p.diaryPath, text => {
        if (text.includes(marker)) return text;
        if (hash(text) !== p.baseHash) throw new DiaryError('conflict', '保存前检测到新的人工修改，已停止覆盖。');
        return p.target;
      });
    }
    const previous = await this.vault.read(p.transcriptPath);
    if (previous !== p.transcript) {
      if (previous !== null) await this.backup(p, 'transcript', previous);
      await ensureParent(this.vault, p.transcriptPath);
      if (previous === null) await this.vault.create(p.transcriptPath, p.transcript);
      else await this.vault.process(p.transcriptPath, text => {
        if (text !== previous) throw new DiaryError('conflict', '原始问答汇总在保存期间变化，已保留双方；请重试恢复。');
        return p.transcript;
      });
    }
    await this.store.append(p.date, 'archive-completed', { transactionId: p.id, draftId: p.draftId, consumedIds: p.consumedIds });
  }
}
