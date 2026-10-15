import { DiaryError, type DiaryEvent, type Draft, type ArchivePlan, type EventType, type Payloads, type ReflectionDecision, type DayMoment } from '../domain/types';
import { hash, record, strings, validDate, safePath } from '../domain/util';

export function isDraft(x: unknown): x is Draft {
  return record(x) && typeof x.id === 'string' && typeof x.body === 'string' && typeof x.observations === 'string' &&
    (x.baseHash === null || typeof x.baseHash === 'string') && strings(x.consumedIds) &&
    ['initial', 'append', 'reintegrate'].includes(String(x.mode)) && typeof x.diaryPath === 'string' && typeof x.transcriptPath === 'string' &&
    Array.isArray(x.sourceMap) && x.sourceMap.every(s => record(s) && typeof s.paragraph === 'string' && strings(s.sourceIds)) &&
    (x.factDocument === undefined || record(x.factDocument) && Array.isArray(x.factDocument.facts) && x.factDocument.facts.every(f => record(f) && typeof f.id === 'string' && typeof f.text === 'string' && strings(f.sourceIds)));
}
function isPlan(x: unknown): x is ArchivePlan {
  return record(x) && ['id', 'date', 'draftId', 'diaryPath', 'transcriptPath', 'target', 'transcript'].every(k => typeof x[k] === 'string') &&
    (x.baseHash === null || typeof x.baseHash === 'string') && (x.transcriptBaseHash === null || typeof x.transcriptBaseHash === 'string') && strings(x.consumedIds);
}
export function isReflection(x: unknown): x is ReflectionDecision {
  return record(x) && ['recall','feeling','thought','wish','change','detail','broaden','pause','follow_up'].includes(String(x.intent)) &&
    (x.momentId === null || typeof x.momentId === 'string') && (x.dimension === null || ['context','feeling','thought','wish','change'].includes(String(x.dimension))) && strings(x.sourceIds);
}
export function isMoment(x: unknown): x is DayMoment {
  return record(x) && typeof x.id === 'string' && typeof x.title === 'string' && strings(x.sourceIds) && Array.isArray(x.notes) && x.notes.every(n =>
    record(n) && ['context','feeling','thought','wish','change'].includes(String(n.dimension)) && typeof n.text === 'string' && typeof n.sourceId === 'string' && ['then','now','unspecified'].includes(String(n.when)));
}
export function validEvent(x: unknown): x is DiaryEvent {
  if (!record(x) || x.schemaVersion !== 1 || typeof x.eventId !== 'string' || !/^[\w-]{1,100}$/.test(x.eventId) ||
    typeof x.sessionKey !== 'string' || !validDate(x.sessionKey.replace(/^day:/, '')) || typeof x.writerId !== 'string' ||
    !Number.isInteger(x.sequence) || Number(x.sequence) < 1 || !strings(x.parentEventIds) || typeof x.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(x.createdAt)) || typeof x.type !== 'string' || !record(x.payload)) return false;
  const p = x.payload;
  switch (x.type as EventType) {
    case 'session-started': case 'topic-changed': return typeof p.topicId === 'string' && (p.focusMomentId === undefined || p.focusMomentId === null || typeof p.focusMomentId === 'string');
    case 'user-message': case 'assistant-message': return typeof p.id === 'string' && typeof p.text === 'string' && typeof p.topicId === 'string' && typeof p.createdAt === 'string' && p.role === (x.type === 'user-message' ? 'user' : 'assistant') &&
      (p.reflection === undefined || isReflection(p.reflection)) && (p.moments === undefined || Array.isArray(p.moments) && p.moments.every(isMoment)) &&
      (p.historyEvidence === undefined || Array.isArray(p.historyEvidence) && p.historyEvidence.every(e => {
        if (!record(e) || typeof e.path !== 'string' || typeof e.hash !== 'string') return false;
        try { safePath(e.path); return true; } catch { return false; }
      })) && (p.conversationBasis === undefined || record(p.conversationBasis) && typeof p.conversationBasis.bodyHash === 'string' && strings(p.conversationBasis.answerIds));
    case 'input-draft-saved': return typeof p.text === 'string' && typeof p.deviceId === 'string';
    case 'draft-generated': case 'draft-edited':
      if (!isDraft(p)) return false;
      try { safePath(p.diaryPath); safePath(p.transcriptPath); } catch { return false; } return true;
    case 'draft-selected': return typeof p.draftId === 'string';
    case 'thread-upserted': return typeof p.id === 'string' && typeof p.title === 'string' && strings(p.aliases) && strings(p.sourceIds) && ['active', 'resolved', 'suppressed'].includes(String(p.status));
    case 'thread-suppressed': return typeof p.threadId === 'string';
    case 'thread-reopened-by-user': return typeof p.threadId === 'string' && typeof p.messageId === 'string';
    case 'archive-prepared':
      if (!isPlan(p) || !validDate(p.date)) return false;
      try { safePath(p.diaryPath); safePath(p.transcriptPath); } catch { return false; } return true;
    case 'archive-completed': return typeof p.transactionId === 'string' && typeof p.draftId === 'string' && strings(p.consumedIds);
    default: return false;
  }
}
export function block(e: DiaryEvent): string {
  const json = JSON.stringify(e);
  return `\n<!-- ai-diary-event:${hash(json)} -->\n\`\`\`ai-diary-event-v1\n${json}\n\`\`\`\n`;
}
export function parseEvents(text: string): { events: DiaryEvent[]; issues: string[] } {
  const events: DiaryEvent[] = [], issues: string[] = [];
  const re = /<!-- ai-diary-event:([a-f0-9]+) -->\r?\n```ai-diary-event-v1\r?\n([^\r\n]+)\r?\n```/g;
  const starts = text.match(/<!-- ai-diary-event:/g)?.length ?? 0;
  let match: RegExpExecArray | null, count = 0;
  while ((match = re.exec(text))) {
    count++;
    try {
      const raw = match[2]!;
      const e: unknown = JSON.parse(raw);
      if (hash(raw) !== match[1] || !validEvent(e)) throw new Error('invalid');
      events.push(e);
    } catch { issues.push('有事件块校验失败或版本不受支持，原文件已保留。'); }
  }
  if (starts !== count || /```ai-diary-event-v(?!1\b)/.test(text)) issues.push('有不完整或未知版本的记录块，原文件已保留。');
  return { events, issues };
}
export function mergeEvents(input: DiaryEvent[]): { events: DiaryEvent[]; issues: string[] } {
  const map = new Map<string, DiaryEvent>(), issues: string[] = [];
  for (const e of input) {
    const prior = map.get(e.eventId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(e)) issues.push('同一事件 ID 内容冲突，已停止写入以保留原记录。');
    else map.set(e.eventId, e);
  }
  const pending = [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.writerId.localeCompare(b.writerId) || a.sequence - b.sequence || a.eventId.localeCompare(b.eventId));
  const result: DiaryEvent[] = [], applied = new Set<string>();
  while (pending.length) {
    const index = pending.findIndex(e => e.parentEventIds.every(p => applied.has(p)));
    if (index < 0) { issues.push('部分记录的前序文件尚未到达，等待同步或恢复。'); break; }
    const [e] = pending.splice(index, 1); result.push(e!); applied.add(e!.eventId);
  }
  return { events: result, issues };
}
export function payload<K extends EventType>(e: DiaryEvent, _type: K): Payloads[K] { return e.payload as Payloads[K]; }
export function descends(events: DiaryEvent[], child: string, parent: string): boolean {
  const map = new Map(events.map(e => [e.eventId, e]));
  const todo = [child], seen = new Set<string>();
  while (todo.length) {
    const n = todo.pop()!; if (n === parent) return true;
    if (seen.has(n)) continue; seen.add(n); todo.push(...(map.get(n)?.parentEventIds ?? []));
  }
  return false;
}
export function assertClean(issues: string[]): void {
  if (issues.length) throw new DiaryError('recovery', issues[0]!);
}
