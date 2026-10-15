import { type VaultPort, type DiaryEvent, type Payloads, type EventType } from '../domain/types';
import { id, ensureParent, safePath, validDate } from '../domain/util';
import { assertClean, block, mergeEvents, parseEvents } from './events';

export class EventStore {
  events: DiaryEvent[] = [];
  issues: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private cache = new Map<string, { revision: string; parsed: ReturnType<typeof parseEvents> }>();
  readonly writerId: string;
  readonly root: string;
  constructor(readonly vault: VaultPort, transcriptFolder: string, readonly deviceId: string, instance = id()) {
    this.root = `${safePath(transcriptFolder)}/_数据`;
    this.writerId = `${deviceId}-${instance}`;
  }
  async refresh(): Promise<void> {
    const files = this.vault.list().filter(p => p.startsWith(`${this.root}/`) && p.endsWith('.md'));
    const events: DiaryEvent[] = [], issues: string[] = [];
    for (const path of files) {
      const revision = this.vault.revision?.(path), cached = this.cache.get(path);
      let parsed: ReturnType<typeof parseEvents>;
      if (revision !== undefined && cached?.revision === revision) parsed = cached.parsed;
      else {
        const text = await this.vault.read(path); if (text === null) continue;
        parsed = parseEvents(text); if (revision !== undefined) this.cache.set(path, { revision, parsed });
      }
      events.push(...parsed.events); issues.push(...parsed.issues.map(i => `${path}：${i}`));
    }
    const merged = mergeEvents(events);
    this.events = merged.events; this.issues = [...issues, ...merged.issues];
  }
  invalidate(path: string): void { this.cache.delete(path); }
  append<K extends EventType>(date: string, type: K, value: Payloads[K]): Promise<DiaryEvent<K>> {
    const work = this.queue.then(async () => {
      if (!validDate(date)) throw new Error('invalid date');
      await this.refresh(); assertClean(this.issues);
      const parents = new Set(this.events.flatMap(e => e.parentEventIds));
      const e: DiaryEvent<K> = {
        schemaVersion: 1, eventId: id(), sessionKey: `day:${date}`, writerId: this.writerId,
        sequence: ++this.sequence, parentEventIds: this.events.filter(e => !parents.has(e.eventId)).map(e => e.eventId),
        createdAt: new Date().toISOString(), type, payload: value
      };
      const path = `${this.root}/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}/${this.writerId}.md`;
      await ensureParent(this.vault, path);
      if (await this.vault.read(path) === null) await this.vault.create(path, '# AI 日记接续记录\n\n由插件追加管理。请保留文件以接续对话。\n');
      await this.vault.process(path, text => { assertClean(parseEvents(text).issues); return text + block(e); });
      this.invalidate(path);
      this.events.push(e as DiaryEvent);
      return e;
    });
    this.queue = work.catch(() => undefined); return work;
  }
  async flush(): Promise<void> { await this.queue; }
}
