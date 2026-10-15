import { describe, it, expect } from 'vitest';
import { fixture } from '../fixtures/helpers';
import { Gateway } from '../../src/ai/gateway';
import { DiaryApp } from '../../src/application/diary';
import type { Message } from '../../src/domain/types';

describe('experience recall application and compatibility', () => {
  it('allows free recall even when every customizable entry is disabled', async () => {
    const f = fixture(); f.s.topics.forEach(t => { t.enabled = false; });
    await f.app.send('今天在窗边看了一会儿树，心里安静。');
    expect(f.app.error).toBe(''); expect(f.app.state.messages.filter(m => m.role === 'assistant')).toHaveLength(1);
    expect(f.s.topics.every(t => !t.enabled)).toBe(true);
    expect(f.model.calls.at(-1)!.input.topicId).toBe('diary-free-recall');
  });
  it('persists grounded notes and focus across devices without rewriting legacy events', async () => {
    const f = fixture();
    f.model.run = async (_task, input: any) => {
      const u = input.messages.filter((m: Message) => m.role === 'user').at(-1)!;
      return {
        action: 'ask', text: '', question: '那一刻心里冒出的那句话是什么？', topicId: 'daily', thread: null,
        moments: [{ id: 'revision', title: '改方案', sourceIds: [u.id], notes: [{ dimension: 'feeling', text: '很烦', sourceId: u.id, when: 'then' }] }],
        reflection: { intent: 'thought', momentId: 'revision', dimension: 'thought', sourceIds: [u.id] }
      };
    };
    await f.app.send('下午改方案，很烦。'); expect(f.app.error).toBe('');
    expect(f.app.dayMap.moments[0]?.notes[0]?.text).toBe('很烦');
    await f.app.focusMoment('revision');
    const b = fixture('device-b', f.vault); await b.app.refresh();
    expect(b.app.dayMap.focusMomentId).toBe('revision'); expect(b.app.dayMap.askedAngles[0]?.dimension).toBe('thought');
    await expect(b.app.focusMoment('invented')).rejects.toThrow();
    expect(b.app.store.events.every(e => e.schemaVersion === 1)).toBe(true);
  });
  it('still recovers old conversations that have no experience annotations', async () => {
    const f = fixture(); await f.app.send('今天散步，看了一会儿树。');
    const b = fixture('device-b', f.vault); await b.app.refresh();
    expect(b.app.dayMap.moments[0]?.title).toContain('散步');
    expect(b.app.dayMap.moments[0]?.notes.every(n => n.dimension === 'context')).toBe(true);
  });
  it('allows skipping a focused moment even when the model did not create a follow-up thread', async () => {
    const f = fixture(); await f.app.send('下午改方案，很烦。');
    expect(f.app.allThreads()).toHaveLength(0); await f.app.skip();
    expect(f.app.allThreads()[0]?.status).toBe('suppressed'); expect(f.app.dayMap.moments).toHaveLength(0);
    const call = f.model.calls.at(-1)!; expect(JSON.stringify(call.input)).not.toContain('改方案');
  });
  it('retries unreadable conversation content once', async () => {
    const f = fixture(); let calls = 0;
    const model = new Gateway(() => f.s, { get: () => 'synthetic-key' }, async () => {
      calls++;
      const content = calls === 1 ? '' : '可以先停在这里。';
      return { status: 200, text: JSON.stringify({ choices: [{ message: { content } }] }) };
    });
    const app = new DiaryApp(f.store, model, () => f.s); app.date = f.app.date;
    await app.send('今天走了十分钟，风舒服。'); expect(calls).toBe(2); expect(app.error).toBe('');
    expect(app.state.messages.filter(m => m.role === 'assistant')).toHaveLength(1);
  });
  it('a second invalid reply retains the input without looping or saving a fabricated assistant reply', async () => {
    const f = fixture(); let calls = 0;
    f.model.run = async () => { calls++; return ''; };
    await f.app.send('今天有点烦。'); expect(calls).toBe(2);
    expect(f.app.error).toBeTruthy(); expect(f.app.state.messages.filter(m => m.role === 'user')).toHaveLength(1);
    expect(f.app.state.messages.filter(m => m.role === 'assistant')).toHaveLength(0);
  });
  it('does not use generated experience indexes as extra facts when a preview was manually edited', async () => {
    const f = fixture(); await f.app.send('上午发生争执。'); await f.app.generate();
    await f.app.editDraft('今天平静地回家。', ''); await f.app.send('晚上听了雨。'); await f.app.generate();
    const call = f.model.calls.filter(c => c.task === 'write-natural').at(-1)!;
    expect(JSON.stringify(call.input)).not.toContain('争执'); expect(call.input.dayMap).toBeUndefined();
  });
  it('persistently suppresses a moment when the user types the UI wording rather than clicking skip', async () => {
    const f = fixture(); await f.app.send('下午改方案，很烦。'); await f.app.send('先不聊这件事。');
    expect(f.app.allThreads().some(t => t.status === 'suppressed')).toBe(true);
    expect(f.app.dayMap.moments).toHaveLength(0);
    const b = fixture('device-b', f.vault); await b.app.open('2026-10-13');
    expect(b.app.allThreads().some(t => t.status === 'suppressed')).toBe(true);
  });
  it('removes derived assistant history text, questions and metadata after permission is revoked', async () => {
    const f = fixture(); f.s.historyEnabled = true; f.s.allowedPaths = ['日记'];
    const path = '日记/2026/10/2026-10-01.md'; f.vault.files.set(path, 'HISTORICAL_CANARY 是上周的记录。');
    f.model.reply = { action: 'acknowledge', text: '上周你提过 HISTORICAL_CANARY。', question: null, topicId: 'daily', thread: null };
    await f.app.send('今天想到了一些事。');
    expect(f.app.state.messages.at(-1)?.historyEvidence?.[0]?.path).toBe(path);
    f.s.historyEnabled = false; f.s.allowedPaths = []; f.app.configurationChanged(); f.vault.reads = [];
    await f.app.reply(); expect(JSON.stringify(f.model.calls.at(-1)!.input)).not.toContain('HISTORICAL_CANARY');
    expect(f.vault.reads).not.toContain(path);
    expect(f.app.state.messages.some(m => m.text.includes('HISTORICAL_CANARY'))).toBe(true);
  });
  it('does not resend assistant text based on an outdated history file version', async () => {
    const f = fixture(); f.s.historyEnabled = true; f.s.allowedPaths = ['日记'];
    const path = '日记/2026/10/2026-10-01.md'; f.vault.files.set(path, 'HISTORICAL_CANARY 是上周的记录。');
    f.model.reply = { action: 'acknowledge', text: 'HISTORICAL_CANARY 留在过去的记录里。', question: null, topicId: 'daily', thread: null };
    await f.app.send('今天看看旧事。'); f.vault.files.set(path, '用户已经改写了过去这段记录。'); await f.app.reply();
    expect(JSON.stringify(f.model.calls.at(-1)!.input)).not.toContain('HISTORICAL_CANARY');
  });
  it('keeps legacy assistant messages with unknown provenance locally without sending them to the model', async () => {
    const f = fixture(); await f.app.send('今天散了步。');
    await f.store.append(f.app.date, 'assistant-message', { id: 'legacy-message', role: 'assistant', text: 'LEGACY_HISTORY_CANARY', topicId: 'daily', createdAt: new Date().toISOString() });
    await f.app.refresh(); await f.app.reply();
    expect(JSON.stringify(f.model.calls.at(-1)!.input)).not.toContain('LEGACY_HISTORY_CANARY');
    expect(f.app.state.messages.some(m => m.id === 'legacy-message')).toBe(true);
  });
  it('tracks inherited evidence across turns and rejects a response if an older referenced file changes', async () => {
    const f = fixture(); f.s.historyEnabled = true; f.s.allowedPaths = ['日记'];
    const path = '日记/2026/10/2026-10-01.md'; f.vault.files.set(path, '继承的旧片段。');
    await f.app.send('今天改方案。');
    for (let i = 2; i <= 7; i++) f.vault.files.set(`日记/2026/10/2026-10-0${i}.md`, '今天改方案的新参考。');
    const original = f.model.run.bind(f.model);
    f.model.run = async (task, input) => {
      const result = await original(task, input);
      if (task === 'conversation') {
        expect(input.evidence.some((e: { path: string }) => e.path === path)).toBe(false);
        f.vault.files.set(path, '用户已改写这个历史片段。');
      }
      return result;
    };
    const before = f.app.state.messages.length; await f.app.reply();
    expect(f.app.error).toContain('资料或会话已变化'); expect(f.app.state.messages).toHaveLength(before);
  });
  it('inherits history provenance beyond the current six snippets, so revocation also removes derived later replies', async () => {
    const f = fixture(); f.s.historyEnabled = true; f.s.allowedPaths = ['日记'];
    const old = '日记/2026/10/2026-10-01.md'; f.vault.files.set(old, 'OLD_PROVENANCE_CANARY');
    f.model.reply = { action: 'acknowledge', text: 'OLD_PROVENANCE_CANARY', question: null, topicId: 'daily', thread: null };
    await f.app.send('今天改方案。');
    const newer = Array.from({ length: 6 }, (_, i) => `日记/2026/10/2026-10-0${i + 2}.md`);
    newer.forEach(p => f.vault.files.set(p, '今天改方案的新参考。'));
    f.model.reply = { action: 'acknowledge', text: 'DERIVED_PROVENANCE_CANARY', question: null, topicId: 'daily', thread: null };
    await f.app.reply('answer');
    expect(f.app.state.messages.at(-1)?.historyEvidence).toHaveLength(7);
    f.s.allowedPaths = newer; f.app.configurationChanged();
    f.model.reply = { action: 'acknowledge', text: '这一小段先留下。', question: null, topicId: 'daily', thread: null };
    await f.app.reply('answer'); const sent = JSON.stringify(f.model.calls.at(-1)!.input);
    expect(sent).not.toContain('OLD_PROVENANCE_CANARY'); expect(sent).not.toContain('DERIVED_PROVENANCE_CANARY');
  });
});
