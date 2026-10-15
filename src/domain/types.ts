export type Style = 'natural' | 'narrative';
export type Mode = 'initial' | 'append' | 'reintegrate';
export interface Topic { id: string; name: string; enabled: boolean }
export interface Settings {
  version: 1; namespace: string; baseUrl: string; modelId: string; credentialRef: string;
  style: Style; diaryFolder: string; transcriptFolder: string; topics: Topic[];
  allowedPaths: string[]; historyEnabled: boolean;
  periodicEnabled: boolean; weeklyFolder: string; monthlyFolder: string;
}
export interface Message {
  id: string; role: 'user' | 'assistant'; text: string; topicId: string;
  threadId?: string; action?: Action; question?: string | null; createdAt: string;
  reflection?: ReflectionDecision; moments?: DayMoment[];
  historyEvidence?: { path: string; hash: string }[];
  conversationBasis?: { bodyHash: string; answerIds: string[] };
}
export type Action = 'acknowledge' | 'ask' | 'transition' | 'follow_up';
export type ExperienceDimension = 'context' | 'feeling' | 'thought' | 'wish' | 'change';
export type ReflectionIntent = 'recall' | 'feeling' | 'thought' | 'wish' | 'change' | 'detail' | 'broaden' | 'pause' | 'follow_up';
export interface ExperienceNote {
  dimension: ExperienceDimension; text: string; sourceId: string;
  when: 'then' | 'now' | 'unspecified';
}
export interface DayMoment { id: string; title: string; sourceIds: string[]; notes: ExperienceNote[] }
export interface ReflectionDecision {
  intent: ReflectionIntent; momentId: string | null;
  dimension: ExperienceDimension | null; sourceIds: string[];
}
export interface DayMap {
  moments: DayMoment[]; focusMomentId: string | null;
  askedAngles: (ReflectionDecision & { question: string })[];
  recentIntents: ReflectionIntent[];
}
export interface Thread {
  id: string; title: string; aliases: string[]; sourceIds: string[];
  status: 'active' | 'resolved' | 'suppressed';
}
export interface Evidence { id: string; path: string; hash: string; text: string; date: string | null; weekday?: string }
export interface Draft {
  id: string; body: string; observations: string; observationError?: string;
  baseHash: string | null; consumedIds: string[]; mode: Mode;
  sourceMap: { paragraph: string; sourceIds: string[] }[];
  diaryPath: string; transcriptPath: string;
  factDocument?: FactDocument;
  sourceMapScope?: 'document';
}
export interface FactDocument { facts: { id: string; text: string; sourceIds: string[] }[]; writingBrief?: string }
export interface ArchivePlan {
  id: string; date: string; draftId: string; diaryPath: string; transcriptPath: string;
  baseHash: string | null; target: string; transcript: string;
  transcriptBaseHash: string | null; consumedIds: string[];
}
export interface Payloads {
  'session-started': { topicId: string };
  'topic-changed': { topicId: string; focusMomentId?: string | null };
  'user-message': Message;
  'assistant-message': Message;
  'input-draft-saved': { text: string; deviceId: string };
  'draft-generated': Draft;
  'draft-edited': Draft;
  'draft-selected': { draftId: string };
  'thread-upserted': Thread;
  'thread-suppressed': { threadId: string };
  'thread-reopened-by-user': { threadId: string; messageId: string };
  'archive-prepared': ArchivePlan;
  'archive-completed': { transactionId: string; draftId: string; consumedIds: string[] };
}
export type EventType = keyof Payloads;
export type DiaryEvent<K extends EventType = EventType> = {
  schemaVersion: 1; eventId: string; sessionKey: string; writerId: string; sequence: number;
  parentEventIds: string[]; createdAt: string; type: K; payload: Payloads[K];
};
export interface Session {
  date: string; topicId: string; messages: Message[]; input: string;
  focusMomentId: string | null;
  inputAlternatives: string[]; drafts: Draft[]; draft?: Draft; consumedIds: string[];
  archivedDraftIds: string[]; pending: ArchivePlan[]; issues: string[];
}
export interface VaultPort {
  list(): string[];
  revision?(path: string): string;
  read(path: string): Promise<string | null>;
  create(path: string, text: string): Promise<void>;
  process(path: string, fn: (current: string) => string): Promise<void>;
  mkdir(path: string): Promise<void>;
}
export type ModelTask = 'conversation' | 'facts' | 'write-natural' | 'write-narrative' | 'observations' | 'week-review' | 'month-review';
export interface ModelPort { run(task: ModelTask, input: unknown, valid?: () => boolean): Promise<unknown> }
export class DiaryError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'DiaryError'; }
}
export function errorText(e: unknown): string {
  return e instanceof DiaryError ? e.message : '操作未完成，内容仍保留。请检查本机存储或重新尝试。';
}
