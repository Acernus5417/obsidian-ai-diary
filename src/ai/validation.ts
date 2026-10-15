import { DiaryError, type Action, type Evidence, type Settings, type Thread, type Message, type DayMap, type DayMoment, type ReflectionDecision } from '../domain/types';
import { record, strings, link } from '../domain/util';
import { mentions } from '../memory/retrieval';
import { buildDayMap, validateExperience } from './experience';
function invalid(): never { throw new DiaryError('format', '服务没有返回可读的内容，素材仍保留，请重试。'); }
export interface Reply { action: Action; text: string; question: string | null; topicId: string; threadId: string | null; thread: { title: string; aliases: string[]; sourceIds: string[] } | null; moments?: DayMoment[]; reflection?: ReflectionDecision }

/** Validate transport and explicit user boundaries, never emotional meaning,
 * question style, number of questions or which conversational angle to take. */
export function validateReply(x: unknown, s: Settings, messages: Message[], active: Thread[], suppressed: Thread[], _trigger: string, dayMap?: DayMap): Reply {
  const value = record(x) ? x : {};
  let text = typeof x === 'string' ? x.trim() : typeof value.text === 'string' ? value.text.trim() : '';
  const suppliedQuestion = typeof value.question === 'string' ? value.question.trim() : '';
  if (suppliedQuestion && !text.endsWith(suppliedQuestion)) text = [text, suppliedQuestion].filter(Boolean).join('\n\n');
  if (!text) invalid();
  // Only the user's explicitly skipped matters remain a conversational veto.
  if (suppressed.some(t => mentions(text, t))) throw new DiaryError('suppressed', '已跳过的事项不会再次主动追问，可以换个方向继续。');
  const lastParagraph = text.split(/\n\s*\n/).at(-1)!;
  const question = suppliedQuestion || (/[?？]\s*$/.test(lastParagraph) ? lastParagraph : null);
  const topicId = typeof value.topicId === 'string' && s.topics.some(t => t.id === value.topicId && t.enabled) ? value.topicId : s.topics.find(t => t.enabled)?.id ?? 'diary-free-recall';
  const action = ['acknowledge', 'ask', 'transition', 'follow_up'].includes(String(value.action)) ? value.action as Action : question ? 'ask' : 'acknowledge';
  const threadId = typeof value.threadId === 'string' && active.some(t => t.id === value.threadId) ? value.threadId : null;
  let thread: Reply['thread'] = null;
  const t = value.thread;
  if (record(t) && typeof t.title === 'string' && strings(t.aliases) && strings(t.sourceIds) && t.sourceIds.length) {
    const sourceIds = t.sourceIds;
    if (sourceIds.every(id => messages.some(m => m.role === 'user' && m.id === id)) &&
        t.aliases.every(a => a.length >= 3 && messages.some(m => m.role === 'user' && sourceIds.includes(m.id) && m.text.includes(a))))
      thread = { title: t.title, aliases: t.aliases, sourceIds };
  }
  return { action, text, question, topicId, threadId, thread,
    ...validateExperience(value, messages, dayMap ?? buildDayMap(messages, { suppressed }), suppressed) };
}
export interface Source { id: string; kind: 'current-body' | 'new-answer'; text: string }
export function validateWriting(x: unknown, sources: Source[]): { body: string; sourceMap: { paragraph: string; sourceIds: string[] }[]; sourceMapScope?: 'document' } {
  if (!record(x) || typeof x.bodyMarkdown !== 'string' || !x.bodyMarkdown.trim()) invalid();
  const ids = new Set(sources.map(s => s.id));
  if (!Array.isArray(x.sourceMap)) {
    if (!strings(x.sourceIds) || !x.sourceIds.length || x.sourceIds.some(id => !ids.has(id)) || /<!--|^---\s*$|^#{1,6}\s*AI\s*观察/m.test(x.bodyMarkdown)) invalid();
    return { body: x.bodyMarkdown, sourceMap: x.bodyMarkdown.split('\n\n').map(paragraph => ({ paragraph, sourceIds: x.sourceIds as string[] })), sourceMapScope: 'document' };
  }
  if (!x.sourceMap.length) invalid();
  const sourceMap = x.sourceMap.map(s => {
    if (!record(s) || typeof s.paragraph !== 'string' || !strings(s.sourceIds) || !s.sourceIds.length || s.sourceIds.some(i => !ids.has(i))) invalid();
    return { paragraph: s.paragraph, sourceIds: s.sourceIds };
  });
  if (sourceMap.map(p => p.paragraph).join('\n\n') !== x.bodyMarkdown || /<!--|^---\s*$|^#{1,6}\s*AI\s*观察/m.test(x.bodyMarkdown)) invalid();
  return { body: x.bodyMarkdown, sourceMap };
}
export function validateObservations(x: unknown, evidence: Evidence[]): string {
  if (!record(x) || typeof x.understanding !== 'string' || (!Array.isArray(x.patterns) && !strings(x.evidenceIds))) invalid();
  const plain = (v: string) => { if (/\[\[|\]\(|https?:|<[^>]*>/.test(v)) invalid(); return v; };
  const sections: string[] = [];
  const understanding = x.understanding.trim().replace(/^(?:(?:#{1,6}\s*AI\s*观察|可能的理解[：:])\s*)+/, '');
  if (understanding) sections.push(`可能的理解：${plain(understanding)}`);
  if (strings(x.evidenceIds)) {
    if (x.evidenceIds.some(id => !evidence.some(e => e.id === id))) invalid();
    const ids = new Set(x.evidenceIds);
    const cited = evidence.filter(e => ids.has(e.id));
    if (cited.length) sections.push(`参考：${cited.map(e => link(e.path)).join('、')}`);
  }
  for (const p of Array.isArray(x.patterns) ? x.patterns : []) {
    if (!record(p) || typeof p.text !== 'string' || !strings(p.evidenceIds) || p.evidenceIds.some(i => !evidence.some(e => e.id === i))) invalid();
    const evidenceIds = p.evidenceIds;
    const cited = evidence.filter(e => evidenceIds.includes(e.id));
    sections.push(`可能的联系：${plain(p.text)}${cited.length ? `\n\n参考：${cited.map(e => link(e.path)).join('、')}` : ''}`);
  }
  return sections.join('\n\n');
}
