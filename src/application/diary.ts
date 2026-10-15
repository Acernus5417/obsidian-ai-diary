import { DiaryError, errorText, type Draft, type Settings, type ModelPort, type Session, type Mode, type Thread, type Message, type ArchivePlan, type DayMap } from '../domain/types';
import { dateKey, dayPath, hash, id, validDate, weekday } from '../domain/util';
import { validateSettings } from '../domain/settings';
import { EventStore } from '../storage/store';
import { session, threads } from '../storage/projections';
import { ArchiveService, bodyOf } from './archive';
import { mentions, retrieve, observationContext, evidenceStillValid, permitted } from '../memory/retrieval';
import { PeriodicService, type PeriodResult } from './periodic';
import { validateReply, validateWriting, type Source } from '../ai/validation';
import { generateObservations } from '../ai/observations';
import { buildDayMap } from '../ai/experience';
import { authorizedDialogue, questionAnswerPairs } from '../ai/context';
import { validateFacts } from '../ai/facts';

function dialogueBody(current: string | null, draft?: Draft): string {
  const body = current === null ? '' : bodyOf(current);
  return draft ? draft.mode === 'append' ? [body, draft.body].filter(Boolean).join('\n\n') : draft.body : body;
}

export class DiaryApp {
  date = dateKey();
  state: Session;
  busy = false;
  error = '';
  private failureCode?: string;
  private epoch = 0;
  private sending = false;
  private archiving = false;
  private closed = false;
  private lastAttempt?: () => Promise<void>;
  get isSaving(): boolean { return this.archiving; }
  private listeners = new Set<() => void>();
  readonly archive: ArchiveService;
  readonly periods: PeriodicService;
  reviewBusy = false;
  reviewProgress = '';
  reviewError = '';
  reviewFiles: PeriodResult[] = [];
  constructor(readonly store: EventStore, readonly model: ModelPort, readonly settings: () => Settings) {
    this.state = session([], this.date);
    this.archive = new ArchiveService(store.vault, store, settings);
    this.periods = new PeriodicService(store.vault, model, settings);
  }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  emit(): void { this.listeners.forEach(fn => fn()); }
  cancel(): void { if (this.archiving) return; ++this.epoch; this.busy = false; this.emit(); }
  shutdown(): void { this.closed = true; ++this.epoch; if (!this.archiving) this.busy = false; this.emit(); }
  configurationChanged(): void {
    if (this.failureCode && ['configuration', 'credentials', 'auth', 'url'].includes(this.failureCode)) {
      this.error = ''; this.failureCode = undefined;
    }
    this.cancel(); this.emit();
  }
  private recordError(e: unknown): void {
    this.error = errorText(e); this.failureCode = e instanceof DiaryError ? e.code : undefined;
  }
  async refresh(): Promise<void> {
    await this.store.refresh(); this.state = session(this.store.events, this.date, this.store.issues); this.emit();
  }
  async open(date = this.date): Promise<void> {
    if (!validDate(date)) throw new DiaryError('date', '请选择有效的记录日期。');
    this.cancel(); this.date = date; this.error = ''; await this.refresh();
  }
  async initialize(): Promise<void> {
    await this.refresh();
    if (this.state.messages.length || this.state.input) return;
    const dates = [...new Set(this.store.events.map(e => e.sessionKey.slice(4)))].sort().reverse();
    const unfinished = dates.find(date => {
      const s = session(this.store.events, date);
      return !!s.input || !!s.pending.length || s.messages.some(m => m.role === 'user' && !s.consumedIds.includes(m.id)) || (s.draft && !s.archivedDraftIds.includes(s.draft.id));
    });
    if (unfinished) await this.open(unfinished);
  }
  allThreads(): Thread[] { return threads(this.store.events); }
  get dayMap(): DayMap {
    return buildDayMap(this.state.messages, { suppressed: this.allThreads().filter(t => t.status === 'suppressed'), focusMomentId: this.state.focusMomentId });
  }
  async focusMoment(momentId: string): Promise<void> {
    if (!this.dayMap.moments.some(m => m.id === momentId)) throw new DiaryError('moment', '这个片刻已变化或已被跳过，请重新选择。');
    this.cancel();
    await this.store.append(this.date, 'topic-changed', { topicId: this.state.topicId, focusMomentId: momentId });
    await this.refresh();
  }
  async input(text: string): Promise<void> {
    if (this.state.input === text) return;
    await this.store.append(this.date, 'input-draft-saved', { text, deviceId: this.store.deviceId }); await this.refresh();
  }
  async selectTopic(topicId: string, ask = true): Promise<void> {
    if (!this.settings().topics.some(t => t.id === topicId && t.enabled)) throw new DiaryError('topic', '请先启用一个回顾入口。');
    this.cancel();
    if (this.state.messages.length) await this.store.append(this.date, 'topic-changed', { topicId, focusMomentId: null });
    else await this.store.append(this.date, 'session-started', { topicId });
    await this.refresh();
    if (ask) await this.reply('change');
  }
  async send(text: string): Promise<void> {
    if (!text.trim() || this.busy || this.sending || this.closed) return;
    this.sending = true;
    try {
    this.cancel();
    this.busy = true; this.emit();
    const m: Message = { id: id(), role: 'user', text: text.trim(), topicId: this.state.topicId, createdAt: new Date().toISOString() };
    const date = this.date;
    await this.store.append(date, 'user-message', m);
    await this.refresh();
    const skip = /不想(?:再)?聊|别(?:再)?问|不要(?:再)?问|跳过这|先不(?:聊|谈)|暂时不(?:聊|谈)/.test(m.text);
    if (skip) await this.suppressFocused(date);
    if (!skip) for (const t of this.allThreads().filter(t => t.status === 'suppressed' && mentions(m.text, t)))
      await this.store.append(date, 'thread-reopened-by-user', { threadId: t.id, messageId: m.id });
    await this.refresh(); this.busy = false; await this.reply(skip ? 'skip' : 'answer');
    } finally { this.sending = false; if (!this.archiving) this.busy = false; this.emit(); }
  }
  async skip(): Promise<void> {
    this.cancel(); await this.suppressFocused(this.date);
    await this.refresh(); await this.reply('skip');
  }
  private async suppressFocused(date: string): Promise<void> {
    const map = this.dayMap, moment = map.moments.find(m => m.id === map.focusMomentId);
    const last = this.state.messages.filter(m => m.role === 'assistant').at(-1);
    let threadId = last?.threadId;
    if (moment && last?.reflection && last.reflection.momentId !== moment.id) threadId = undefined;
    if (!threadId && moment) {
      threadId = `moment-thread-${moment.id}`;
      if (!this.allThreads().some(t => t.id === threadId)) await this.store.append(date, 'thread-upserted', {
        id: threadId, title: moment.title, aliases: [moment.title].filter(v => v.length >= 3),
        sourceIds: moment.sourceIds, status: 'active'
      });
    }
    if (threadId) await this.store.append(date, 'thread-suppressed', { threadId });
  }
  private async operation(work: (valid: () => boolean) => Promise<void>): Promise<void> {
    if (this.busy || this.closed) return;
    if (this.store.issues.length) { this.error = this.store.issues[0]!; this.failureCode = 'recovery'; this.emit(); return; }
    const epoch = ++this.epoch, date = this.date;
    const config = JSON.stringify(this.settings());
    const events = this.store.events.map(e => e.eventId).join('|');
    const valid = () => epoch === this.epoch && date === this.date && config === JSON.stringify(this.settings());
    this.busy = true; this.error = ''; this.emit();
    try {
      await work(() => valid() && events === this.store.events.map(e => e.eventId).join('|'));
    } catch (e) { if (valid()) this.recordError(e); }
    finally { if (epoch === this.epoch) { this.busy = false; await this.refresh(); } }
  }
  async reply(trigger = 'continue'): Promise<void> {
    this.lastAttempt = () => this.reply(trigger);
    await this.refresh();
    await this.operation(async valid => {
      const s = this.settings(), all = this.allThreads(), suppressed = all.filter(t => t.status === 'suppressed');
      const current = await this.store.vault.read(dayPath(s.diaryFolder, this.date));
      const prior = this.state.draft && !this.state.archivedDraftIds.includes(this.state.draft.id) ? this.state.draft : undefined;
      const consumed = new Set(prior?.consumedIds ?? this.state.consumedIds), currentDiary = dialogueBody(current, prior);
      const users = this.state.messages.filter(m => m.role === 'user' && !consumed.has(m.id));
      const hiddenSourceIds = new Set(suppressed.flatMap(t => t.sourceIds));
      const candidates = this.state.messages.filter(m => !hiddenSourceIds.has(m.id) && !m.reflection?.sourceIds.some(id => hiddenSourceIds.has(id)) &&
        !suppressed.some(t => m.threadId === t.id || mentions(m.text, t))).map(m => m.moments ? {
          ...m, moments: m.moments.filter(moment => !moment.sourceIds.some(id => hiddenSourceIds.has(id)) && !suppressed.some(t => mentions(moment.title, t)))
        } : m);
      const context = await authorizedDialogue(this.store.vault, s, candidates, new Set(users.filter(m => !hiddenSourceIds.has(m.id)).map(m => m.id)), currentDiary, consumed.size > 0, valid);
      const safeMessages = context.messages;
      const dayMap = buildDayMap(safeMessages, { suppressed, focusMomentId: this.state.focusMomentId });
      const evidence = await retrieve(this.store.vault, s, users.slice(-4).map(m => m.text).join('\n'), this.date, suppressed, valid);
      const contextEvidence = [...evidence, ...context.dependencies];
      const sources = new Map(this.store.events.filter(e => e.type === 'user-message').map(e => [(e.payload as Message).id, e.sessionKey.slice(4)]));
      const active = all.filter(t => t.status === 'active' && t.sourceIds.some(mid => {
        const date = sources.get(mid);
        return date && permitted(dayPath(s.diaryFolder, date), s) && evidence.some(e => e.path === dayPath(s.diaryFolder, date) && mentions(e.text, t));
      }));
      const enabledTopics = s.topics.filter(t => t.enabled);
      // Entries are optional starting points; disabling every entry must not
      // prevent someone from freely telling their day.
      if (!enabledTopics.length) enabledTopics.push({ id: 'diary-free-recall', name: '自由回顾', enabled: true });
      const topicId = enabledTopics.some(t => t.id === this.state.topicId) ? this.state.topicId : enabledTopics[0]!.id;
      const modelSettings = { ...s, topics: [enabledTopics.find(t => t.id === topicId)!, ...enabledTopics.filter(t => t.id !== topicId)] };
      const focus = this.state.focusMomentId ? dayMap.moments.find(m => m.id === this.state.focusMomentId) : undefined;
      const input = {
        date: this.date, weekday: weekday(this.date), trigger, topicId, currentDiary: currentDiary || undefined,
        chosenEntry: trigger === 'change' ? enabledTopics.find(t => t.id === topicId)?.name : undefined,
        messages: safeMessages.map(({ id, role, text }) => ({ id, role, text })),
        selectedPassage: focus ? { title: focus.title, excerpts: safeMessages.filter(m => focus.sourceIds.includes(m.id)).map(m => m.text) } : undefined,
        followUps: active.map(t => t.title), evidence
      };
      const requestReply = async (context: unknown) => {
        const raw = await this.model.run('conversation', context, valid);
        if (!valid() || !await evidenceStillValid(this.store.vault, this.settings(), contextEvidence)) throw new DiaryError('stale', '资料或会话已变化，请重新请求；已有记录保留。');
        if (dialogueBody(await this.store.vault.read(dayPath(s.diaryFolder, this.date)), prior) !== currentDiary) throw new DiaryError('stale', '当前日记已变化，请重新回顾；已有回答保留。');
        return validateReply(raw, modelSettings, this.state.messages, active, suppressed, trigger, dayMap);
      };
      let r;
      try { r = await requestReply(input); }
      catch (e) {
        if (!(e instanceof DiaryError) || e.code !== 'format' || !valid()) throw e;
        r = await requestReply({ ...input, repair: {
          instruction: '上一轮没有返回可读内容，请根据对话用自然中文回复。'
        } });
      }
      let tid = r.threadId ?? undefined;
      if (r.thread) {
        const found = all.find(t => r.thread!.aliases.some(a => t.aliases.includes(a)));
        if (found?.status === 'suppressed') throw new DiaryError('suppressed', '已跳过的事项不会再次主动追问，请换个方面。');
        tid = found?.id ?? id();
        await this.store.append(this.date, 'thread-upserted', { id: tid, ...r.thread, status: 'active' });
      }
      await this.store.append(this.date, 'assistant-message', {
        id: id(), role: 'assistant', text: r.text,
        topicId: r.topicId, action: r.action, question: r.question, threadId: tid, createdAt: new Date().toISOString(),
        reflection: r.reflection, moments: r.moments,
        historyEvidence: [...new Map(contextEvidence.map(e => [`${e.path}:${e.hash}`, { path: e.path, hash: e.hash }])).values()],
        conversationBasis: { bodyHash: hash(currentDiary), answerIds: safeMessages.filter(m => m.role === 'user').map(m => m.id) }
      });
      await this.store.append(this.date, 'topic-changed', { topicId: r.topicId, ...(r.reflection?.momentId ? { focusMomentId: r.reflection.momentId } : {}) });
    });
  }
  async editDraft(body: string, observations: string): Promise<void> {
    const d = this.state.draft; if (!d || (body === d.body && observations === d.observations)) return;
    this.cancel();
    await this.store.append(this.date, 'draft-edited', { ...d, id: id(), body, observations, factDocument: undefined }); await this.refresh();
  }
  async chooseDraft(draftId: string): Promise<void> { await this.store.append(this.date, 'draft-selected', { draftId }); await this.refresh(); }
  async generate(mode: Mode = 'initial', useCurrentFile = false): Promise<void> {
    this.lastAttempt = () => this.generate(mode, useCurrentFile);
    await this.refresh(); validateSettings(this.settings());
    await this.operation(async valid => {
      const s = this.settings(), date = this.date;
      const diaryPath = dayPath(s.diaryFolder, date), transcriptPath = dayPath(s.transcriptFolder, date);
      const current = await this.store.vault.read(diaryPath);
      const prior = !useCurrentFile && this.state.draft && !this.state.archivedDraftIds.includes(this.state.draft.id) ? this.state.draft : undefined;
      if (current !== null && mode === 'initial') mode = 'reintegrate';
      const consumed = new Set(prior?.consumedIds ?? this.state.consumedIds);
      // Sync may deliver the formal Markdown before its completion event. Never
      // guess that old answers are new when the archive watermark is unknown.
      if (current !== null) for (const match of current.matchAll(/<!-- ai-diary-transaction:([\w-]+) -->/g)) {
        const prepared = this.store.events.find(e => e.type === 'archive-prepared' && (e.payload as ArchivePlan).id === match[1]);
        if (!prepared) throw new DiaryError('sync', '日记已到达，但对应归档记录尚未同步完整。请等待同步后重新读取，避免把旧回答误当作新增。');
        (prepared.payload as ArchivePlan).consumedIds.forEach(mid => consumed.add(mid));
      }
      const sources: Source[] = [];
      if (prior) sources.push({ id: 'current-body', kind: 'current-body', text: prior.body });
      else if (current !== null && mode !== 'append') sources.push({ id: 'current-body', kind: 'current-body', text: bodyOf(current) });
      const newMessages = this.state.messages.filter(m => m.role === 'user' && !consumed.has(m.id));
      sources.push(...newMessages.map(m => ({ id: m.id, kind: 'new-answer' as const, text: m.text })));
      if (!sources.length || !sources.some(s => s.text.trim())) throw new DiaryError('empty', '先留下一点当天的素材，就可以生成日记。');
      const context = await authorizedDialogue(this.store.vault, s, this.state.messages, new Set(newMessages.map(m => m.id)), dialogueBody(current, prior), consumed.size > 0, valid);
      const exchanges = questionAnswerPairs(context.messages);
      const input = { date, weekday: weekday(date), sources, exchanges, mode };
      const facts = await this.model.run('facts', input, valid);
      if (!valid() || !await evidenceStillValid(this.store.vault, this.settings(), context.dependencies)) throw new DiaryError('stale', '问答依据或授权已变化，原稿仍保留，请重新生成。');
      const factDocument = validateFacts(facts, sources);
      const raw = await this.model.run(s.style === 'natural' ? 'write-natural' : 'write-narrative', { ...input, factDocument }, valid);
      if (!valid()) return;
      if (!await evidenceStillValid(this.store.vault, this.settings(), context.dependencies)) throw new DiaryError('stale', '问答依据或授权已变化，原稿仍保留，请重新生成。');
      const writing = validateWriting(raw, sources);
      const d: Draft = {
        id: id(), body: writing.body, observations: '', observationError: 'AI 观察尚未完成，正文已保留；可以稍后重新生成。', baseHash: prior ? prior.baseHash : (current === null ? null : hash(current)),
        consumedIds: [...new Set([...consumed, ...newMessages.map(m => m.id)])], mode: prior?.mode ?? mode,
        sourceMap: writing.sourceMap, sourceMapScope: writing.sourceMapScope, factDocument, diaryPath, transcriptPath
      };
      // Commit the body before optional observations; failure must never erase it.
      await this.store.append(date, 'draft-generated', d);
      await this.refresh();
      const epoch = this.epoch, config = JSON.stringify(s), observationEvents = this.store.events.map(e => e.eventId).join('|');
      const observationValid = () => this.epoch === epoch && this.date === date && JSON.stringify(this.settings()) === config && this.state.draft?.id === d.id && this.store.events.map(e => e.eventId).join('|') === observationEvents;
      try {
        const { evidence } = await observationContext(this.store.vault, s, writing.body, date, this.allThreads().filter(t => t.status === 'suppressed'), observationValid);
        const observations = await generateObservations(this.model, { date, weekday: weekday(date), currentBody: writing.body, evidence }, evidence, observationValid);
        if (!observationValid()) return;
        if (!await evidenceStillValid(this.store.vault, this.settings(), evidence)) throw new DiaryError('stale', '历史资料已变化，观察未保存；正文已保留。');
        await this.store.append(date, 'draft-edited', { ...d, id: id(), observations, observationError: undefined });
      } catch (e) {
        if (observationValid()) await this.store.append(date, 'draft-edited', { ...d, id: id(), observationError: errorText(e) });
      }
    });
  }
  async save(): Promise<void> {
    this.lastAttempt = () => this.save();
    if (this.busy || !this.state.draft || this.closed) return;
    const archiveDate = this.date;
    this.archiving = true; this.busy = true; this.error = ''; this.emit();
    let saved = false;
    try { await this.archive.save(this.state, this.state.draft); saved = true; }
    catch (e) { this.recordError(e); }
    finally { this.archiving = false; this.busy = false; await this.refresh(); }
    if (saved) await this.reviewPeriods(archiveDate, true);
  }
  async reviewPeriods(asOf = this.date, includeRecordedEndDay = asOf === this.date && this.state.archivedDraftIds.length > 0): Promise<void> {
    if (this.reviewBusy || this.closed || !this.settings().periodicEnabled) return;
    const epoch = this.epoch, config = JSON.stringify(this.settings());
    this.reviewBusy = true; this.reviewError = ''; this.emit();
    try {
      const created = await this.periods.generateDue(asOf, () => this.epoch === epoch && JSON.stringify(this.settings()) === config, title => { this.reviewProgress = `正在生成${title}`; this.emit(); }, includeRecordedEndDay);
      this.reviewFiles = await this.periods.available(asOf);
      if (!created.length) this.reviewProgress = '目前没有需要新增的已结束周期回顾。';
      else this.reviewProgress = '周月回顾已保存。';
    } catch (e) { this.reviewError = errorText(e); }
    finally { this.reviewBusy = false; this.emit(); }
  }
  async recover(): Promise<void> {
    try { await this.archive.recover(this.state); this.error = ''; }
    catch (e) { this.recordError(e); }
    await this.refresh();
  }
  async retry(): Promise<void> { if (!this.busy) await this.lastAttempt?.(); }
}
