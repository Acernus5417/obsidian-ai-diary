import { type DiaryApp } from '../application/diary';
import { errorText, type Message, type Mode } from '../domain/types';
import { dateKey, dayPath } from '../domain/util';
import { reading } from './reading';
import { reconcile } from './reconcile';

export interface ScreenHost { settings(): void; openFile(path: string): void }
type Selection = { start: number; end: number; direction: 'forward' | 'backward' | 'none'; scroll: number };

export class DiaryScreen {
  private unsubscribe: () => void;
  private page: 'chat' | 'preview' = 'chat';
  private renderedPage: 'chat' | 'preview' = 'chat';
  private inputText: string;
  private editBody = '';
  private editObservation = '';
  private editingDraftId = '';
  private editing = false;
  private inputDirty = false;
  private editDirty = false;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private localError = '';
  private lastVisibleError = '';
  private destroyed = false;
  private lastDate: string;
  private askUnsent = false;
  private mode: Mode = 'initial';
  private composing = false;
  private followEnd = false;
  private pendingFocus = '';
  private selections = new Map<string, Selection>();
  private disclosures = new Map<string, boolean>();
  private pageScroll = new Map<'chat' | 'preview', number>();
  private mainAtEnd = true;
  private outsideDirections = (event: Event): void => {
    const direction = this.root.querySelector<HTMLDetailsElement>('.ai-diary-directions[open]');
    if (direction && event.target instanceof Node && !direction.contains(event.target)) this.closeDisclosure('directions');
  };
  private escapeDirections = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    const direction = this.root.querySelector<HTMLDetailsElement>('.ai-diary-directions[open]');
    if (direction) { event.preventDefault(); event.stopPropagation(); this.closeDisclosure('directions'); direction.querySelector<HTMLElement>('summary')?.focus(); }
  };
  private closeDisclosure(key: string): void {
    this.disclosures.set(key, false);
    this.root.querySelectorAll<HTMLDetailsElement>(`[data-disclosure="${key}"]`).forEach(d => { d.open = false; });
  }
  private viewportChanged = (event?: Event): void => {
    const viewport = window.visualViewport;
    if (!viewport || !this.root.clientHeight) return;
    const available = Math.min(this.root.clientHeight, viewport.height + viewport.offsetTop - this.root.getBoundingClientRect().top);
    if (available > 0) this.root.style.setProperty('--diary-visible-height', `${available}px`);
    const scroll = this.root.querySelector<HTMLElement>('.ai-diary-scroll');
    if (event && this.page === 'chat' && this.mainAtEnd && scroll) scroll.scrollTop = scroll.scrollHeight;
  };
  constructor(private root: HTMLElement, readonly diary: DiaryApp, private host: ScreenHost) {
    this.inputText = diary.state.input; this.lastDate = diary.date;
    this.unsubscribe = diary.subscribe(() => this.render()); this.render();
    window.addEventListener('resize', this.viewportChanged);
    window.visualViewport?.addEventListener('resize', this.viewportChanged);
    window.visualViewport?.addEventListener('scroll', this.viewportChanged);
    this.root.addEventListener('pointerdown', this.outsideDirections);
    this.root.addEventListener('keydown', this.escapeDirections);
  }
  async dispose(): Promise<void> {
    this.destroyed = true; clearTimeout(this.saveTimer); this.unsubscribe();
    window.removeEventListener('resize', this.viewportChanged);
    window.visualViewport?.removeEventListener('resize', this.viewportChanged);
    window.visualViewport?.removeEventListener('scroll', this.viewportChanged);
    this.root.removeEventListener('pointerdown', this.outsideDirections);
    this.root.removeEventListener('keydown', this.escapeDirections);
    await this.flush(); this.root.replaceChildren();
  }
  async persist(): Promise<void> { await this.act(() => this.flush()); }
  private element<K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, text?: string, className?: string): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag); if (text !== undefined) el.textContent = text;
    if (className) el.className = className; parent.append(el); return el;
  }
  private button(parent: HTMLElement, text: string, fn: () => void | Promise<void>, primary = false, disabled = false): HTMLButtonElement {
    const b = this.element('button', parent, text, primary ? 'mod-cta ai-diary-primary' : 'ai-diary-button');
    b.type = 'button'; b.disabled = disabled;
    b.addEventListener('click', () => { void this.act(fn); }); return b;
  }
  private details(parent: HTMLElement, key: string, title: string, className = ''): HTMLDetailsElement {
    const d = this.element('details', parent, undefined, className); d.dataset.disclosure = key;
    d.open = this.disclosures.get(key) ?? false; this.element('summary', d, title);
    d.addEventListener('toggle', () => { this.disclosures.set(key, d.open); }); return d;
  }
  private async act(fn: () => void | Promise<void>): Promise<void> {
    try { this.localError = ''; await fn(); } catch (e) { this.localError = errorText(e); }
    if (!this.destroyed) this.render();
  }
  private async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (this.inputDirty) {
      const text = this.inputText; this.inputDirty = false;
      try { await this.diary.input(text); } catch (e) { this.inputDirty = true; throw e; }
    }
    if (this.editDirty) {
      const b = this.editBody, o = this.editObservation; this.editDirty = false;
      try { await this.diary.editDraft(b, o); } catch (e) { this.editDirty = true; throw e; }
    }
  }
  private autosave(): void {
    clearTimeout(this.saveTimer); if (this.composing) return;
    this.saveTimer = setTimeout(() => { void this.flush().catch(e => { this.localError = errorText(e); this.render(); }); }, 500);
  }
  private textarea(parent: HTMLElement, value: string, key: string, label: string, change: (text: string) => void): HTMLTextAreaElement {
    const input = this.element('textarea', parent); input.dataset.focus = key; input.value = value; input.setAttribute('aria-label', label);
    const rememberSelection = () => this.selections.set(key, { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection, scroll: input.scrollTop });
    input.addEventListener('blur', rememberSelection); input.addEventListener('select', rememberSelection);
    input.addEventListener('input', () => { change(input.value); this.autosave(); });
    input.addEventListener('compositionstart', () => { this.composing = true; clearTimeout(this.saveTimer); });
    input.addEventListener('compositionend', () => { this.composing = false; change(input.value); this.autosave(); });
    return input;
  }
  private async generate(current = false): Promise<void> {
    this.closeDisclosure('directions');
    await this.flush();
    if (this.inputText.trim() && !this.askUnsent) { this.askUnsent = true; this.render(); return; }
    this.askUnsent = false;
    await this.diary.generate(this.mode, current);
    if (this.diary.state.draft) { this.page = 'preview'; this.editing = false; }
  }
  private async send(): Promise<void> {
    if (this.diary.busy || !this.inputText.trim() || this.composing) return;
    this.closeDisclosure('directions'); clearTimeout(this.saveTimer); await this.flush(); this.followEnd = true;
    const text = this.inputText; await this.diary.send(text); this.inputText = this.diary.state.input;
  }
  render(): void {
    if (this.destroyed || this.composing) return;
    const focused = this.root.contains(document.activeElement) ? document.activeElement as HTMLTextAreaElement : null;
    const focusKey = focused?.dataset.focus;
    if (focusKey && typeof focused?.selectionStart === 'number') this.selections.set(focusKey, {
      start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection, scroll: focused.scrollTop
    });
    this.root.querySelectorAll<HTMLDetailsElement>('[data-disclosure]').forEach(d => this.disclosures.set(d.dataset.disclosure!, d.open));
    const oldScroll = this.root.querySelector<HTMLElement>('.ai-diary-scroll');
    const scrollTop = oldScroll?.scrollTop ?? 0;
    if (oldScroll) this.pageScroll.set(this.renderedPage, scrollTop);
    const nearEnd = oldScroll ? oldScroll.scrollHeight - oldScroll.clientHeight - oldScroll.scrollTop < 100 : true;
    const s = this.diary.state;
    const visibleError = this.localError || this.diary.error || s.issues[0] || '';
    const newError = !!visibleError && visibleError !== this.lastVisibleError; this.lastVisibleError = visibleError;
    if (this.lastDate !== this.diary.date) {
      this.lastDate = this.diary.date; this.inputDirty = false; this.editDirty = false; this.editingDraftId = '';
      this.page = 'chat'; this.editing = false; this.mode = 'initial'; this.selections.clear(); this.disclosures.clear();
      this.pageScroll.clear();
    }
    if (!this.inputDirty) this.inputText = s.input;
    if (!this.editDirty && s.draft && this.editingDraftId !== s.draft.id) {
      this.editingDraftId = s.draft.id; this.editBody = s.draft.body; this.editObservation = s.draft.observations;
    }
    if (this.page === 'preview' && !s.draft) this.page = 'chat';
    const pageChanged = this.renderedPage !== this.page;
    this.root.classList.add('ai-diary');
    const stage = document.createElement('div');
    const shell = this.element('div', stage, undefined, 'ai-diary-shell');
    shell.dataset.page = this.page; this.header(shell);
    const scroll = this.element('div', shell, undefined, 'ai-diary-scroll');
    scroll.addEventListener('scroll', () => {
      if (this.page === 'chat') this.mainAtEnd = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 100;
    });
    scroll.setAttribute('aria-label', this.page === 'chat' ? '回顾这一天' : '日记预览');
    const content = this.element('div', scroll, undefined, 'ai-diary-content');
    this.notices(content);
    if (this.page === 'preview' && s.draft) this.preview(content, shell);
    else { this.chat(content); this.composer(shell); }
    if (pageChanged) this.root.replaceChildren(...stage.childNodes);
    else reconcile(this.root, stage);
    const actualScroll = this.root.querySelector<HTMLElement>('.ai-diary-scroll')!;
    const focus = this.pendingFocus || focusKey; this.pendingFocus = '';
    if (focus) {
      const el = this.root.querySelector<HTMLTextAreaElement>(`[data-focus="${focus}"]`);
      if (el && !el.disabled) {
        if (document.activeElement !== el) el.focus({ preventScroll: true });
        const selection = this.selections.get(focus);
        if (selection) {
          if (el.selectionStart !== selection.start || el.selectionEnd !== selection.end || el.selectionDirection !== selection.direction)
            el.setSelectionRange(selection.start, selection.end, selection.direction);
          if (el.scrollTop !== selection.scroll) el.scrollTop = selection.scroll;
        }
      }
    }
    actualScroll.scrollTop = newError ? 0 : pageChanged ? this.pageScroll.get(this.page) ?? 0 : this.page === 'chat' && (nearEnd || this.followEnd) ? actualScroll.scrollHeight : scrollTop;
    if (this.page === 'chat') this.mainAtEnd = actualScroll.scrollHeight - actualScroll.clientHeight - actualScroll.scrollTop < 100;
    this.followEnd = false; this.renderedPage = this.page;
    this.viewportChanged();
  }
  private header(shell: HTMLElement): void {
    const s = this.diary.state, locked = this.diary.busy || !!s.issues.length;
    const header = this.element('header', shell, undefined, 'ai-diary-header');
    const identity = this.element('div', header, undefined, 'ai-diary-identity');
    const words = this.element('div', identity, undefined, 'ai-diary-identity-text');
    const date = this.element('input', words, undefined, 'ai-diary-date'); date.type = 'date'; date.value = this.diary.date;
    date.setAttribute('aria-label', '记录日期'); date.disabled = this.diary.busy;
    date.addEventListener('change', () => { void this.act(async () => { await this.flush(); await this.diary.open(date.value); }); });
    const actions = this.element('div', header, undefined, 'ai-diary-header-actions');
    if (this.page === 'preview') this.button(actions, '返回对话', async () => { await this.flush(); this.page = 'chat'; });
    else this.button(actions, '生成日记', () => this.generate(), false, locked || !s.messages.some(m => m.role === 'user'));
    const settings = this.button(actions, '设置', () => this.host.settings()); settings.classList.add('ai-diary-settings');
    if (this.diary.settings().periodicEnabled) this.button(actions, '周/月回顾', () => this.diary.reviewPeriods(), false, this.diary.reviewBusy || locked);
    if (this.diary.date !== dateKey()) this.button(actions, '今天', async () => { await this.flush(); await this.diary.open(dateKey()); });
  }
  private notices(content: HTMLElement): void {
    const s = this.diary.state, config = this.diary.settings();
    if (this.diary.reviewBusy || this.diary.reviewError || this.diary.reviewProgress || this.diary.reviewFiles.length) {
      const review = this.element('div', content, undefined, 'ai-diary-banner');
      this.element('p', review, this.diary.reviewError ? `日记仍保留，周月回顾未完成：${this.diary.reviewError}` : this.diary.reviewProgress || '周月回顾已保存。');
      if (this.diary.reviewBusy) this.button(review, '停止生成回顾', () => this.diary.cancel());
      if (this.diary.reviewError) this.button(review, '重试周月回顾', () => this.diary.reviewPeriods());
      if (this.diary.reviewError) this.button(review, '回顾设置', () => this.host.settings());
      for (const file of this.diary.reviewFiles.slice(-3)) this.button(review, file.title, () => this.host.openFile(file.path));
    }
    const error = this.localError || this.diary.error || s.issues[0];
    if (error) {
      const alert = this.element('div', content, undefined, 'ai-diary-error'); alert.setAttribute('role', 'alert');
      this.element('p', alert, error);
      const controls = this.element('div', alert, undefined, 'ai-diary-inline-actions');
      this.button(controls, '重新读取记录', async () => { await this.flush(); await this.diary.refresh(); });
      if (this.diary.error) this.button(controls, '重试上次操作', async () => { await this.flush(); await this.diary.retry(); }, false, this.diary.busy);
      if (this.diary.error.includes('日记') || this.diary.error.includes('修改')) {
        this.button(controls, '打开当前日记', () => this.host.openFile(dayPath(config.diaryFolder, this.diary.date)));
        this.button(controls, '按当前笔记重建预览', () => this.generate(true));
      }
    }
    if (s.pending.length) {
      const recovery = this.element('div', content, '有一笔归档尚未完成，内容仍保留。', 'ai-diary-banner');
      this.button(recovery, '恢复归档', () => this.diary.recover(), false, this.diary.busy);
    }
    if (!config.baseUrl || !config.modelId) {
      const setup = this.element('section', content, undefined, 'ai-diary-setup');
      this.element('span', setup, '开始之前', 'ai-diary-eyebrow'); this.element('h2', setup, '连接你使用的 AI');
      this.element('p', setup, '在设置中填写服务地址、模型名称和本设备的 API Key。对话会发送给你选择的服务。');
      this.button(setup, '打开插件设置', () => this.host.settings(), true);
    }
  }
  private chat(content: HTMLElement): void {
    const s = this.diary.state, config = this.diary.settings(), locked = this.diary.busy || !!s.issues.length;
    if (!s.messages.length) {
      const welcome = this.element('section', content, undefined, 'ai-diary-welcome');
      this.element('p', welcome, '从今天早上开始回顾', 'ai-diary-start-label');
      this.element('p', welcome, '先说起床后做了什么，AI 会顺着问。也可以直接说你想记的事。', 'ai-diary-welcome-copy');
      const prompts = this.element('div', welcome, undefined, 'ai-diary-entry-hints');
      this.button(prompts, '开始回顾', async () => { await this.flush(); this.followEnd = true; await this.diary.reply('start'); this.pendingFocus = 'input'; }, false, locked);
      this.topics(welcome, locked, 'entry-topics');
      if (s.input) this.element('p', welcome, '上次没说完的文字还在下面，接着写就好。', 'ai-diary-resume');
    }
    if (s.archivedDraftIds.length) {
      const saved = this.element('div', content, undefined, 'ai-diary-banner');
      this.element('p', saved, '今天的日记已归档，可以继续补记。');
      this.button(saved, '打开日记', () => this.host.openFile(dayPath(config.diaryFolder, s.date)));
      const label = this.element('label', saved, '本次补记方式 '), select = this.element('select', label); select.setAttribute('aria-label', '本次补记方式');
      for (const [value, title] of [['append', '追加到末尾'], ['reintegrate', '结合当前正文重新整合']]) {
        const option = this.element('option', select, title); option.value = value!;
      }
      if (this.mode === 'initial') this.mode = 'append'; select.value = this.mode;
      if (s.draft && !s.archivedDraftIds.includes(s.draft.id)) { this.mode = s.draft.mode; select.value = this.mode; select.disabled = true; }
      select.addEventListener('change', () => { this.mode = select.value as Mode; });
    }
    if (s.inputAlternatives.length > 1) {
      const alt = this.details(content, 'alternatives', '其他设备留下了输入草稿', 'ai-diary-alternatives');
      s.inputAlternatives.forEach(text => {
        this.element('pre', alt, text);
        this.button(alt, '合并到输入框', async () => { this.inputText = [this.inputText, text].filter(Boolean).join('\n'); this.inputDirty = true; await this.flush(); });
      });
    }
    const map = this.diary.dayMap;
    if (map.moments.length) {
      const moments = this.details(content, 'moments', `已聊内容 · ${map.moments.length}`, 'ai-diary-moments');
      const list = this.element('div', moments, undefined, 'ai-diary-moment-list');
      map.moments.forEach(moment => {
        const b = this.button(list, moment.title, async () => { await this.flush(); await this.diary.focusMoment(moment.id); }, false, locked);
        b.setAttribute('aria-pressed', String(map.focusMomentId === moment.id));
      });
      this.element('p', moments, '选择一段内容，可以继续聊。', 'ai-diary-muted');
    }
    const messages = this.element('div', content, undefined, 'ai-diary-messages'); messages.setAttribute('aria-label', '当天对话');
    s.messages.forEach((m, i) => this.message(messages, m, i === s.messages.length - 1 && m.role === 'assistant'));
    if (this.diary.busy) {
      const waiting = this.element('div', messages, '正在回复…', 'ai-diary-waiting'); waiting.setAttribute('role', 'status');
    } else if (s.messages.length && !s.messages.at(-1)?.question) {
      this.element('p', messages, '你可以接着说。也可以让 AI 再问一句。', 'ai-diary-pause');
    }
    if (s.draft) {
      const draft = this.element('div', content, undefined, 'ai-diary-draft-link');
      this.element('span', draft, s.archivedDraftIds.includes(s.draft.id) ? '已归档的日记' : '已有一份日记预览');
      this.button(draft, '查看预览', async () => { await this.flush(); this.page = 'preview'; this.editing = false; });
    }
  }
  private topics(parent: HTMLElement, disabled: boolean, key = 'direction-topics'): void {
    const topics = this.details(parent, key, '从某个方面聊', 'ai-diary-topics');
    const entries = this.element('div', topics, undefined, 'ai-diary-entries');
    this.diary.settings().topics.filter(t => t.enabled).forEach(t => this.button(entries, t.name, async () => {
      await this.flush(); this.followEnd = true; await this.diary.selectTopic(t.id);
    }, false, disabled));
    if (!entries.childElementCount) this.element('p', entries, '可以在设置中添加入口，也可以直接开口。', 'ai-diary-muted');
  }
  private message(parent: HTMLElement, m: Message, current: boolean): void {
    const item = this.element('article', parent, undefined, `ai-diary-message ai-diary-${m.role}${current ? ' ai-diary-current' : ''}`);
    this.element('div', item, m.role === 'user' ? '我' : 'AI', 'ai-diary-speaker');
    const text = m.question && m.text.endsWith(m.question) ? m.text.slice(0, -m.question.length).trim() : m.text;
    if (text) this.element('div', item, text, 'ai-diary-message-text');
    if (m.question) this.element('p', item, m.question, 'ai-diary-question');
  }
  private composer(shell: HTMLElement): void {
    const s = this.diary.state, locked = this.diary.busy || !!s.issues.length;
    const footer = this.element('footer', shell, undefined, 'ai-diary-composer');
    const inside = this.element('div', footer, undefined, 'ai-diary-composer-inner');
    if (this.askUnsent) {
      const choice = this.element('div', inside, undefined, 'ai-diary-unsent');
      choice.setAttribute('role', 'status'); this.element('p', choice, '输入框还有未发送的文字，要如何处理？');
      const controls = this.element('div', choice, undefined, 'ai-diary-inline-actions');
      this.button(controls, '发送并生成', async () => { await this.send(); this.askUnsent = true; await this.generate(); });
      this.button(controls, '仅生成已发送内容', async () => { this.askUnsent = true; await this.generate(); });
      this.button(controls, '继续写', () => { this.askUnsent = false; this.pendingFocus = 'input'; });
    }
    const box = this.element('div', inside, undefined, 'ai-diary-input-box');
    const input = this.textarea(box, this.inputText, 'input', '日记回答', text => { this.inputText = text; this.inputDirty = true; });
    input.placeholder = s.messages.length ? '写下你的回答…' : '今天早上起床后做了什么？';
    input.rows = s.messages.length ? 2 : 3; input.disabled = !!s.issues.length;
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing && !this.composing) { e.preventDefault(); void this.act(() => this.send()); }
    });
    const controls = this.element('div', box, undefined, 'ai-diary-composer-actions');
    this.element('small', controls, '回答会自动保存', 'ai-diary-input-note');
    const send = this.button(controls, '发送', () => this.send(), true, locked); send.setAttribute('title', 'Ctrl / ⌘ + Enter 发送，Enter 换行');
    const under = this.element('div', inside, undefined, 'ai-diary-composer-meta');
    const actions = this.element('div', under, undefined, 'ai-diary-gentle-actions');
    this.button(actions, '继续问我', async () => { await this.flush(); this.followEnd = true; await this.diary.reply(); }, false, locked);
    const directions = this.details(actions, 'directions', '换个方向', 'ai-diary-directions');
    const options = this.element('div', directions, undefined, 'ai-diary-direction-menu');
    this.button(options, '换个问法', async () => { this.closeDisclosure('directions'); await this.flush(); this.followEnd = true; await this.diary.reply('rephrase'); }, false, locked || !s.messages.some(m => m.question));
    this.button(options, '聊下一段时间', async () => { this.closeDisclosure('directions'); await this.flush(); this.followEnd = true; await this.diary.reply('broaden'); }, false, locked);
    if (this.diary.dayMap.focusMomentId || s.messages.some(m => m.role === 'assistant' && m.threadId)) this.button(options, '先不聊这件事', async () => { this.closeDisclosure('directions'); await this.flush(); await this.diary.skip(); }, false, locked);
    this.topics(options, locked);
    if (this.diary.busy && !this.diary.isSaving) this.button(actions, '停止等待', () => this.diary.cancel());
    const status = this.element('span', under, this.localError && (this.inputDirty || this.editDirty) ? '保存尚未完成' : this.diary.busy ? '等待回复…' : this.inputDirty || this.editDirty ? '保存中…' : '已保存在本机', 'ai-diary-status');
    status.setAttribute('role', 'status');
  }
  private preview(content: HTMLElement, shell: HTMLElement): void {
    const s = this.diary.state, draft = s.draft!, archived = s.archivedDraftIds.includes(draft.id);
    this.element('p', content, archived ? '已归档' : '日记预览', 'ai-diary-preview-label');
    const date = this.element('p', content, this.displayDate(this.diary.date), 'ai-diary-preview-date'); date.setAttribute('aria-label', '日记日期');
    if (s.drafts.length > 1) {
      const branches = this.details(content, 'branches', '其他设备留下的预览版本', 'ai-diary-alternatives');
      s.drafts.forEach((d, i) => this.button(branches, `版本 ${i + 1}${d.id === draft.id ? '（当前）' : ''}`, async () => { await this.flush(); await this.diary.chooseDraft(d.id); }));
    }
    const toolbar = this.element('div', content, undefined, 'ai-diary-reading-tools');
    this.element('span', toolbar, archived ? '正文已归档' : this.editing ? '修改会自动保存' : '确认正文后归档', 'ai-diary-muted');
    if (!archived) this.button(toolbar, this.editing ? '完成编辑' : '编辑正文', async () => {
      await this.flush(); this.editing = !this.editing; if (this.editing) this.pendingFocus = 'body';
    }, false, this.diary.busy);
    if (this.editing && !archived) {
      const body = this.textarea(content, this.editBody, 'body', '日记正文', text => { this.editBody = text; this.editDirty = true; });
      body.className = 'ai-diary-body-editor'; body.rows = 12; body.disabled = this.diary.isSaving;
    } else {
      const article = this.element('article', content, undefined, 'ai-diary-reading'); article.setAttribute('aria-label', '日记正文');
      reading(article, this.editBody, path => this.host.openFile(path));
    }
    const observation = this.details(content, 'observation', 'AI 观察 · 另一种可能的理解', 'ai-diary-observation');
    this.element('p', observation, '这是 AI 的暂定理解，不属于日记事实。你可以修改或删除。', 'ai-diary-muted');
    if (this.editing && !archived) {
      const obs = this.textarea(observation, this.editObservation, 'observations', 'AI 观察', text => { this.editObservation = text; this.editDirty = true; });
      obs.rows = 5; obs.disabled = this.diary.isSaving;
    } else {
      const article = this.element('div', observation, undefined, 'ai-diary-reading ai-diary-observation-reading'); article.setAttribute('aria-label', 'AI 观察');
      if (this.editObservation) reading(article, this.editObservation, path => this.host.openFile(path));
      else this.element('p', article, '暂无 AI 观察。', 'ai-diary-muted');
    }
    if (draft.observationError) this.element('p', observation, `观察未完成：${draft.observationError}`, 'ai-diary-error');
    const location = this.details(content, 'location', '归档位置', 'ai-diary-location'); this.element('p', location, draft.diaryPath, 'ai-diary-muted');
    const footer = this.element('footer', shell, undefined, 'ai-diary-preview-footer');
    const actions = this.element('div', footer, undefined, 'ai-diary-preview-footer-inner');
    this.button(actions, '重新生成', async () => { await this.flush(); this.editing = false; await this.diary.generate(draft.mode); }, false, this.diary.busy || archived);
    this.element('span', actions, this.editDirty ? '保存修改中…' : archived ? '随时可以回到对话补记' : '确认后，存入你的日记', 'ai-diary-muted ai-diary-save-note');
    this.button(actions, archived ? '已归档' : '确认归档', async () => { await this.flush(); await this.diary.save(); this.editing = false; }, true, this.diary.busy || archived || !this.editBody.trim());
    if (archived) this.button(actions, '打开日记', () => this.host.openFile(draft.diaryPath));
    if (this.diary.busy && !this.diary.isSaving) this.button(actions, '停止等待', () => this.diary.cancel());
  }
  private displayDate(value: string): string {
    const [year, month, day] = value.split('-'); return `${year} 年 ${Number(month)} 月 ${Number(day)} 日`;
  }
}
