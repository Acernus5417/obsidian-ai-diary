import { it, expect } from 'vitest';
import { fixture, note } from '../fixtures/helpers';
import { dayPath } from '../../src/domain/util';
it('suppresses a specific affair across dates and devices, then reopens only on user mention', async () => {
  const f = fixture();
  f.model.run = async (task, input: any) => {
    if (task !== 'conversation') return { understanding: '', patterns: [] };
    const user = input.messages.find((m: any) => m.role === 'user');
    return { action: 'acknowledge', text: '记下了。', question: null, topicId: 'work', threadId: null,
      thread: user ? { title: '论文返修', aliases: ['论文返修'], sourceIds: [user.id] } : null };
  };
  await f.app.send('论文返修让我烦。'); const thread = f.app.allThreads()[0]!; expect(thread).toBeTruthy();
  await f.app.skip(); expect(f.app.allThreads()[0]?.status).toBe('suppressed');
  const b = fixture('device-b', f.vault); await b.app.open('2026-10-13');
  expect(b.app.allThreads()[0]?.status).toBe('suppressed');
  await b.app.reply(); const call = b.model.calls.at(-1)!;
  expect(call.input.followUps).toHaveLength(0); expect(JSON.stringify(call.input)).not.toContain('论文返修');
  await b.app.send('我想自己再说说论文返修。'); expect(b.app.allThreads()[0]?.status).toBe('active');
});
it('revoked settings invalidate a pending result, retaining user data', async () => {
  const f = fixture(); let resolve!: (x: unknown) => void;
  f.model.run = async () => new Promise(r => { resolve = r; });
  const request = f.app.reply(); await new Promise(r => setTimeout(r, 10));
  f.s.allowedPaths = ['新的范围']; resolve({ action: 'ask', text: '', question: '失效问题？', topicId: 'daily' });
  await request; expect(f.app.state.messages).toHaveLength(0);
});
it('double click send persists one user message', async () => {
  const f = fixture(); await Promise.all([f.app.send('同一条输入'), f.app.send('同一条输入')]);
  expect(f.app.state.messages.filter(m => m.role === 'user')).toHaveLength(1);
});
it('stops an in-flight result if another device supplies new facts', async () => {
  const f = fixture(), b = fixture('b', f.vault); let resolve!: (x: unknown) => void;
  f.model.run = () => new Promise(r => { resolve = r; });
  const request = f.app.reply(); await new Promise(r => setTimeout(r, 10));
  await b.app.send('手机的新素材'); await f.app.refresh();
  resolve({ action: 'acknowledge', text: '旧上下文', question: null, topicId: 'daily', thread: null }); await request;
  expect(f.app.state.messages.some(m => m.text === '旧上下文')).toBe(false);
});
it('restores unfinished earlier date on first initialization without relabeling it today', async () => {
  const f = fixture(); await f.app.open('2026-10-11'); await f.app.send('昨晚还没聊完');
  const b = fixture('b', f.vault); await b.app.initialize(); expect(b.app.date).toBe('2026-10-11'); expect(b.app.state.messages[0]?.text).toBe('昨晚还没聊完');
});
it('does not expose a disabled topic as the requested next topic', async () => {
  const f = fixture(); await f.app.selectTopic('work', false); f.s.topics.find(t => t.id === 'work')!.enabled = false;
  await f.app.reply(); expect(f.model.calls.at(-1)!.input.topicId).not.toBe('work');
});
it('drops an observation if its history evidence changes during the request', async () => {
  const f = fixture(); f.s.historyEnabled = true; f.s.allowedPaths = ['日记'];
  const path = '日记/2026/10/2026-10-01.md'; f.vault.files.set(path, '以前也买过面包。');
  const original = f.model.run.bind(f.model);
  f.model.run = async (task, input) => { const result = await original(task, input); if (task === 'observations') f.vault.files.set(path, '人工删除了原材料。'); return result; };
  await note(f); expect(f.app.state.draft?.body).toContain('面包'); expect(f.app.state.draft?.observations).toBe('');
});
