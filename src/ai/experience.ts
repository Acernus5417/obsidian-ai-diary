import { type DayMap, type DayMoment, type ExperienceNote, type Message, type ReflectionDecision, type Thread } from '../domain/types';
import { hash, record, strings } from '../domain/util';
import { mentions } from '../memory/retrieval';

// These labels only read optional 0.2.0 annotations. They never select, score,
// or reject a conversational response.
const dimensions = ['context', 'feeling', 'thought', 'wish', 'change'];
const intents = ['recall', 'feeling', 'thought', 'wish', 'change', 'detail', 'broaden', 'pause', 'follow_up'];
const controls = /^(?:继续问我|换个方向|换个问法|生成日记|保存日记|跳过(?:这件事)?|先不(?:聊|谈)(?:这件事|这个|了)?|不想(?:再)?聊(?:这件事|这个|了)?)[，,。！!\s]*$/;

function sourcesFor(messages: Message[], suppressed: Thread[]): Map<string, Message> {
  return new Map(messages.filter(m => m.role === 'user' &&
    !suppressed.some(t => t.sourceIds.includes(m.id) || mentions(m.text, t))).map(m => [m.id, m]));
}
function noteFrom(value: unknown, sources: Map<string, Message>, ids: string[]): value is ExperienceNote {
  return record(value) && dimensions.includes(String(value.dimension)) && typeof value.text === 'string' &&
    typeof value.sourceId === 'string' && ids.includes(value.sourceId) &&
    !!value.text.trim() && !!sources.get(value.sourceId)?.text.includes(value.text) &&
    ['then', 'now', 'unspecified'].includes(String(value.when));
}
function momentFrom(value: unknown, sources: Map<string, Message>): value is DayMoment {
  return record(value) && typeof value.id === 'string' && !!value.id && typeof value.title === 'string' &&
    !!value.title.trim() && strings(value.sourceIds) && !!value.sourceIds.length &&
    value.sourceIds.every(id => sources.has(id)) &&
    value.sourceIds.some(id => sources.get(id)!.text.includes(value.title as string)) &&
    Array.isArray(value.notes) && value.notes.every(n => noteFrom(n, sources, value.sourceIds as string[]));
}
function decisionFrom(value: unknown, sources: Map<string, Message>, moments: DayMoment[]): value is ReflectionDecision {
  return record(value) && intents.includes(String(value.intent)) &&
    (value.momentId === null || moments.some(m => m.id === value.momentId)) &&
    (value.dimension === null || dimensions.includes(String(value.dimension))) &&
    strings(value.sourceIds) && value.sourceIds.every(id => sources.has(id));
}

/** Read-only navigation index. The complete original conversation, not this
 * index or its labels, is supplied to the model. */
export function buildDayMap(messages: Message[], options: { suppressed?: Thread[]; focusMomentId?: string | null } = {}): DayMap {
  const sources = sourcesFor(messages, options.suppressed ?? []), byId = new Map<string, DayMoment>();
  for (const m of messages) if (m.role === 'assistant') {
    for (const value of Array.isArray(m.moments) ? m.moments : []) if (momentFrom(value, sources)) {
      const previous = byId.get(value.id);
      byId.set(value.id, { ...value, sourceIds: [...new Set([...previous?.sourceIds ?? [], ...value.sourceIds])],
        notes: [...new Map([...previous?.notes ?? [], ...value.notes].map(n => [JSON.stringify(n), n])).values()] });
    }
  }
  const covered = new Set([...byId.values()].flatMap(m => m.sourceIds));
  for (const m of sources.values()) if (!covered.has(m.id) && !controls.test(m.text.trim())) {
    const title = m.text.trim().split(/[\n。！？!?]/)[0]!.slice(0, 32);
    if (title) byId.set(`moment-${hash(m.id)}`, { id: `moment-${hash(m.id)}`, title, sourceIds: [m.id],
      notes: [{ dimension: 'context', text: m.text.slice(0, 400), sourceId: m.id, when: 'unspecified' }] });
  }
  const moments = [...byId.values()];
  const oldDecisions = messages.filter(m => m.role === 'assistant' && decisionFrom(m.reflection, sources, moments));
  const selected = options.focusMomentId ?? [...oldDecisions].reverse().find(m => m.reflection?.momentId)?.reflection?.momentId;
  return { moments, focusMomentId: moments.some(m => m.id === selected) ? selected! : moments.at(-1)?.id ?? null,
    askedAngles: oldDecisions.filter(m => m.question).map(m => ({ ...m.reflection!, question: m.question! })),
    recentIntents: oldDecisions.slice(-8).map(m => m.reflection!.intent) };
}

/** Optional legacy metadata is best-effort. Invalid annotations are ignored;
 * they cannot block an otherwise readable natural-language reply. */
export function validateExperience(value: Record<string, unknown>, messages: Message[], dayMap: DayMap, suppressed: Thread[] = []): { moments?: DayMoment[]; reflection?: ReflectionDecision } {
  const sources = sourcesFor(messages, suppressed);
  const moments = Array.isArray(value.moments) ? value.moments.filter(m => momentFrom(m, sources)) : [];
  const combined = [...dayMap.moments, ...moments];
  return { ...(moments.length ? { moments } : {}),
    ...(decisionFrom(value.reflection, sources, combined) ? { reflection: value.reflection } : {}) };
}
