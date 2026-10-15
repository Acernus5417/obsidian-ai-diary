import { type DiaryEvent, type Session, type Thread, type Draft, type ArchivePlan } from '../domain/types';
import { descends, payload } from './events';

export function session(events: DiaryEvent[], date: string, issues: string[] = []): Session {
  const s: Session = { date, topicId: 'daily', messages: [], input: '', focusMomentId: null, inputAlternatives: [], drafts: [], consumedIds: [], archivedDraftIds: [], pending: [], issues };
  const draftEvents: DiaryEvent[] = [], inputs: DiaryEvent[] = [], plans = new Map<string, ArchivePlan>();
  let selected: string | undefined;
  const consumed = new Set<string>();
  for (const e of events.filter(e => e.sessionKey === `day:${date}`)) {
    switch (e.type) {
      case 'session-started': case 'topic-changed': {
        const p = payload(e, 'topic-changed'); s.topicId = p.topicId;
        if (p.focusMomentId !== undefined) s.focusMomentId = p.focusMomentId;
        break;
      }
      case 'user-message':
        s.messages.push(payload(e, 'user-message'));
        // Sending and clearing the consumed input are one durable event.
        inputs.push({ ...e, payload: { text: '', deviceId: e.writerId } } as DiaryEvent);
        break;
      case 'assistant-message': s.messages.push(payload(e, 'assistant-message')); break;
      case 'input-draft-saved': inputs.push(e); break;
      case 'draft-generated': case 'draft-edited': draftEvents.push(e); break;
      case 'draft-selected': selected = payload(e, 'draft-selected').draftId; break;
      case 'archive-prepared': { const p = payload(e, 'archive-prepared'); plans.set(p.id, p); break; }
      case 'archive-completed': {
        const p = payload(e, 'archive-completed'); plans.delete(p.transactionId);
        s.archivedDraftIds.push(p.draftId); p.consumedIds.forEach(i => consumed.add(i)); break;
      }
    }
  }
  const frontier = (list: DiaryEvent[]) => list.filter(e => !list.some(other => other.eventId !== e.eventId && descends(events, other.eventId, e.eventId)));
  s.drafts = frontier(draftEvents).map(e => e.payload as Draft);
  s.draft = s.drafts.find(d => d.id === selected) ?? s.drafts.at(-1);
  s.inputAlternatives = [...new Set(frontier(inputs).map(e => payload(e, 'input-draft-saved').text).filter(Boolean))];
  s.input = payload(inputs.at(-1) ?? { payload: { text: '' } } as DiaryEvent, 'input-draft-saved').text;
  s.consumedIds = [...consumed]; s.pending = [...plans.values()];
  return s;
}
export function threads(events: DiaryEvent[]): Thread[] {
  const state = new Map<string, Thread>();
  const suppressed = new Map<string, DiaryEvent[]>();
  for (const e of events) {
    if (e.type === 'thread-upserted') {
      const t = payload(e, 'thread-upserted'), previous = state.get(t.id);
      state.set(t.id, { ...t, status: previous?.status === 'suppressed' ? 'suppressed' : t.status });
    }
    if (e.type === 'thread-suppressed') {
      const tid = payload(e, 'thread-suppressed').threadId;
      suppressed.set(tid, [...(suppressed.get(tid) ?? []), e]);
      const t = state.get(tid); if (t) t.status = 'suppressed';
    }
    if (e.type === 'thread-reopened-by-user') {
      const p = payload(e, 'thread-reopened-by-user');
      const message = events.find(m => m.type === 'user-message' && payload(m, 'user-message').id === p.messageId);
      if (message && descends(events, e.eventId, message.eventId) && (suppressed.get(p.threadId) ?? []).every(v => descends(events, e.eventId, v.eventId))) {
        suppressed.delete(p.threadId); const t = state.get(p.threadId); if (t) t.status = 'active';
      }
    }
  }
  for (const [tid] of suppressed) { const t = state.get(tid); if (t) t.status = 'suppressed'; }
  return [...state.values()];
}
