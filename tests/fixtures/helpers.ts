import { type VaultPort, type ModelPort, type ModelTask, type Settings } from '../../src/domain/types';
import { loadSettings } from '../../src/domain/settings';
import { EventStore } from '../../src/storage/store';
import { DiaryApp } from '../../src/application/diary';
import { type Source } from '../../src/ai/validation';

export class MemoryVault implements VaultPort {
  files = new Map<string, string>();
  reads: string[] = [];
  writes: string[] = [];
  fail?: (path: string, text: string) => boolean;
  list(): string[] { return [...this.files.keys()]; }
  async read(path: string): Promise<string | null> { this.reads.push(path); return this.files.get(path) ?? null; }
  async create(path: string, text: string): Promise<void> {
    if (this.files.has(path)) throw new Error('exists'); this.write(path, text);
  }
  async process(path: string, fn: (text: string) => string): Promise<void> {
    const current = this.files.get(path); if (current === undefined) throw new Error('missing');
    this.write(path, fn(current));
  }
  private write(path: string, text: string): void {
    if (this.fail?.(path, text)) throw new Error('injected storage failure');
    this.files.set(path, text); this.writes.push(path);
  }
  async mkdir(_path: string): Promise<void> {}
  copyTo(other: MemoryVault): void {
    for (const [p, text] of this.files) {
      const local = other.files.get(p);
      // A device that never edited the shared initial segment must not resend an
      // older prefix over its owner's newly appended segment.
      if (local?.startsWith(text)) continue;
      other.files.set(p, text);
    }
  }
}
export class FakeModel implements ModelPort {
  calls: { task: ModelTask; input: any }[] = [];
  fail?: ModelTask;
  private defaultReply = { action: 'acknowledge', text: '这段经历可以原样留下。', question: null, topicId: 'daily', threadId: null, thread: null };
  reply: unknown = this.defaultReply;
  async run(task: ModelTask, input: any): Promise<unknown> {
    this.calls.push({ task, input });
    if (this.fail === task) throw new Error('injected model failure');
    if (task === 'conversation') {
      if (['start', 'continue', 'change', 'broaden', 'rephrase'].includes(input.trigger)) {
        // Scripted UI transport, deliberately independent of conversation strategy.
        const questions: Record<string, string> = {
          start: '今天早上起床后做了什么？', change: '今天先发生了什么事？',
          continue: '接下来发生了什么？', rephrase: '那件事发生时，你在想什么？', broaden: '那之后，中午做了什么？'
        };
        return questions[input.trigger];
      }
      return this.reply === this.defaultReply ? { ...this.defaultReply, topicId: input.topicId ?? 'daily' } : this.reply;
    }
    if (task === 'observations') return { understanding: '从描述看，这一刻可能让你松了一口气。', patterns: [] };
    const sources = input.sources as Source[];
    if (task === 'facts') return { facts: sources.filter(s => s.text.trim()).map(s => ({ text: s.text, sourceIds: [s.id] })) };
    const rows = sources.filter(s => s.text.trim()).map(s => ({ paragraph: s.text, sourceIds: [s.id] }));
    return { bodyMarkdown: rows.map(r => r.paragraph).join('\n\n'), sourceMap: rows };
  }
}
export function fixture(device = 'device-a', vault = new MemoryVault(), settings?: Settings) {
  const s = settings ?? loadSettings({ baseUrl: 'https://example.invalid/v1', modelId: 'test-model', namespace: 'test-vault-namespace' });
  const model = new FakeModel(), store = new EventStore(vault, s.transcriptFolder, device);
  const app = new DiaryApp(store, model, () => s); app.date = '2026-10-12';
  return { s, model, store, app, vault };
}
export async function note(f: ReturnType<typeof fixture>, text = '下班买了面包，挺香的。') {
  await f.app.refresh(); await f.app.send(text); await f.app.generate();
}
