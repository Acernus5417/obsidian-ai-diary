import { describe, it, expect } from 'vitest';
import { loadSettings, validateSettings, endpoint } from '../../src/domain/settings';
import { validDate, dateKey, safePath, hash } from '../../src/domain/util';
import { block, parseEvents, mergeEvents, type payload } from '../../src/storage/events';
import { threads, session } from '../../src/storage/projections';
import { type DiaryEvent } from '../../src/domain/types';
import { validateWriting, validateObservations, validateReply } from '../../src/ai/validation';

function event(id: string, parents: string[] = [], type = 'session-started', payload: any = { topicId: 'daily' }): DiaryEvent {
  return { schemaVersion: 1, eventId: id, sessionKey: 'day:2026-10-12', writerId: 'a', sequence: 1, parentEventIds: parents, createdAt: '2026-10-12T00:00:00Z', type, payload } as DiaryEvent;
}
describe('dates, paths and settings', () => {
  it('keeps calendar identity and rejects invalid dates', () => { expect(validDate('2026-02-30')).toBe(false); expect(validDate('2026-10-12')).toBe(true); expect(dateKey(new Date(2026, 9, 12, 23, 59))).toBe('2026-10-12'); });
  it.each(['../a', '/a', '.obsidian/a', 'C:/a', 'a/../b', 'a//b', 'a/NUL.md', 'a/#b', 'a/b.'])('rejects unsafe vault path %s', p => expect(() => safePath(p)).toThrow());
  it('rejects overlapping archive directories', () => { const s = loadSettings({ diaryFolder: '日记', transcriptFolder: '日记/问答' }); expect(() => validateSettings(s)).toThrow(); });
  it('never carries unknown secret fields into settings', () => { const s = loadSettings({ apiKey: 'TEST-KEY-NOT-STORED', token: 'secret' }); expect(JSON.stringify(s)).not.toContain('TEST-KEY'); expect(JSON.stringify(s)).not.toContain('token'); });
  it.each([
    ['https://api.example/v1/', 'https://api.example/v1/chat/completions'],
    ['https://api.example/proxy/custom', 'https://api.example/proxy/custom/chat/completions'],
    ['http://localhost:8888/chat/completions', 'http://localhost:8888/chat/completions']
  ])('preserves API prefixes %s', (base, expected) => expect(endpoint(base)).toBe(expected));
  it.each(['https://key:secret@example.com', 'https://example.com?key=x', 'file:///x'])('rejects credentials or non-HTTP URLs %s', v => expect(() => endpoint(v)).toThrow());
});
describe('immutable events and causality', () => {
  it('round trips Unicode and embedded markdown', () => { const e = event('a', [], 'input-draft-saved', { text: '你好\n```\n<!-- ai-diary-event:x -->', deviceId: 'a' }); expect(parseEvents(block(e)).events).toEqual([e]); });
  it('detects corrupted, partial and future-schema records', () => {
    expect(parseEvents(block(event('a')).replace('daily', 'work')).issues).not.toHaveLength(0);
    expect(parseEvents(block(event('a')).slice(0, -5)).issues).not.toHaveLength(0);
    const future = { ...event('f'), schemaVersion: 99 }; const raw = JSON.stringify(future);
    expect(parseEvents(`<!-- ai-diary-event:${hash(raw)} -->\n\`\`\`ai-diary-event-v1\n${raw}\n\`\`\``).issues).not.toHaveLength(0);
  });
  it('deduplicates and orders by parents instead of clocks', () => { const a = event('a'), b = event('b', ['a']); b.createdAt = '2026-01-01T00:00:00Z'; expect(mergeEvents([b, a, a]).events.map(e => e.eventId)).toEqual(['a', 'b']); });
  it('defers missing parents and refuses conflicting IDs', () => { expect(mergeEvents([event('b', ['a'])]).issues).not.toHaveLength(0); expect(mergeEvents([event('a'), event('a', [], 'session-started', { topicId: 'work' })]).issues).not.toHaveLength(0); });
  it('suppression wins concurrent reopen, only causal user reopening clears it', () => {
    const t = event('t', [], 'thread-upserted', { id: 'thread', title: '论文返修', aliases: ['论文返修'], sourceIds: ['m'], status: 'active' });
    const s = event('s', ['t'], 'thread-suppressed', { threadId: 'thread' });
    const m = event('m', ['t'], 'user-message', { id: 'message', text: '论文返修又来了', role: 'user', topicId: 'work', createdAt: t.createdAt });
    const r = event('r', ['m'], 'thread-reopened-by-user', { threadId: 'thread', messageId: 'message' });
    expect(threads(mergeEvents([r, s, m, t]).events)[0]?.status).toBe('suppressed');
    const r2 = event('r2', ['s', 'r'], 'thread-reopened-by-user', { threadId: 'thread', messageId: 'message' });
    expect(threads(mergeEvents([r2, r, s, m, t]).events)[0]?.status).toBe('active');
  });
});
describe('model output boundaries', () => {
  it('requires paragraph coverage from authorized source IDs', () => { expect(() => validateWriting({ bodyMarkdown: '我开心。', sourceMap: [{ paragraph: '我开心。', sourceIds: ['fake'] }] }, [])).toThrow(); });
  it('rejects invented references', () => {
    expect(() => validateObservations({ understanding: '', patterns: [{ text: '反复出现', evidenceIds: ['missing'] }] }, [{ id: 'e1', path: '日记/2026-10-01.md', text: 'a', hash: 'h', date: '2026-10-01' }])).toThrow();
    expect(() => validateObservations({ understanding: '[[虚构]]', patterns: [] }, [])).toThrow();
  });
  it('turns verified two-date IDs into links', () => {
    const ev = [1, 2].map(n => ({ id: `e${n}`, path: `日记/2026-10-0${n}.md`, text: 'a', hash: 'h', date: `2026-10-0${n}` }));
    expect(validateObservations({ understanding: '可能有些疲惫。', patterns: [{ text: '这两次都提到修改。', evidenceIds: ['e1', 'e2'] }] }, ev)).toContain('[[日记/2026-10-01]]');
  });
  it('rejects explicitly suppressed matters', () => {
    const s = loadSettings({}); const r = { text: '论文返修有进展吗？' };
    expect(() => validateReply(r, s, [], [], [{ id: 't', title: '论文返修', aliases: ['论文返修'], status: 'suppressed', sourceIds: [] }], 'continue')).toThrow();
  });
});
