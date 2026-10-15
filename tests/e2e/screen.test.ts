// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { DiaryScreen } from '../../src/ui/screen';
import { fixture, note } from '../fixtures/helpers';
import { reading } from '../../src/ui/reading';
const screens: DiaryScreen[] = [];
async function setup(withNote = false) {
  const f = fixture(); if (withNote) await note(f); else await f.app.refresh();
  const root = document.createElement('div'); document.body.append(root);
  const host = { settings() {}, openFile(_path: string) {} };
  const screen = new DiaryScreen(root, f.app, host); screens.push(screen);
  return { ...f, root, screen };
}
const settle = () => new Promise(r => setTimeout(r, 30));
function click(root: HTMLElement, text: string) {
  const b = [...root.querySelectorAll('button')].find(b => b.textContent === text);
  expect(b, text).toBeTruthy(); b!.click();
}
afterEach(async () => { for (const s of screens.splice(0)) await s.dispose(); document.body.replaceChildren(); });
describe('interactive view harness (not real Obsidian)', () => {
  it('starts from customized entry and only responds when requested again', async () => {
    const f = await setup(); click(f.root, '日常小事'); await settle();
    expect(f.root.querySelectorAll('.ai-diary-assistant')).toHaveLength(1);
    const calls = f.model.calls.length; await settle(); expect(f.model.calls).toHaveLength(calls);
    const before = f.app.state.messages.length;
    click(f.root, '继续问我'); await settle();
    expect(f.app.state.messages.length).toBeGreaterThan(before);
    expect(f.root.querySelectorAll('.ai-diary-current .ai-diary-question')).toHaveLength(1);
  });
  it('does not send during IME composition, Ctrl+Enter sends later', async () => {
    const f = await setup(), input = f.root.querySelector('textarea')!;
    input.value = '输入法组合'; input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.dispatchEvent(new Event('input')); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true }));
    await settle(); expect(f.app.state.messages).toHaveLength(0);
    input.dispatchEvent(new CompositionEvent('compositionend'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    await settle(); expect(f.app.state.messages.filter(m => m.role === 'user')).toHaveLength(1);
  });
  it('switches full page, retains edited preview and returns to conversation', async () => {
    const f = await setup(true); click(f.root, '查看预览'); await settle();
    expect(f.root.querySelector('article[aria-label="日记正文"]')).not.toBeNull();
    expect(f.root.querySelector('textarea[aria-label="日记正文"]')).toBeNull();
    click(f.root, '编辑正文'); await settle();
    const body = f.root.querySelector<HTMLTextAreaElement>('[aria-label="日记正文"]')!;
    body.value = '这是我修改过的语气。'; body.dispatchEvent(new Event('input'));
    click(f.root, '返回对话'); await settle(); expect(f.root.querySelector('[aria-label="日记正文"]')).toBeNull();
    click(f.root, '查看预览'); await settle();
    expect(f.root.querySelector('article[aria-label="日记正文"]')!.textContent).toBe('这是我修改过的语气。');
    click(f.root, '编辑正文'); await settle();
    expect(f.root.querySelector<HTMLTextAreaElement>('[aria-label="日记正文"]')!.value).toBe('这是我修改过的语气。');
    expect(f.app.state.draft?.body).toBe('这是我修改过的语气。');
  });
  it('requires explicit choice with unsent text and preserves the text', async () => {
    const f = await setup(true), input = f.root.querySelector('textarea')!;
    input.value = '这段尚未发送'; input.dispatchEvent(new Event('input'));
    click(f.root, '生成日记'); await settle(); expect(f.root.textContent).toContain('输入框还有未发送');
    click(f.root, '仅生成已发送内容'); await settle(); expect(f.app.state.draft?.body).not.toContain('尚未发送'); expect(f.app.state.input).toContain('尚未发送');
  });
  it('shows saved journal and keeps archived draft read only', async () => {
    const f = await setup(true); click(f.root, '查看预览'); await settle(); click(f.root, '确认归档'); await settle();
    expect(f.root.textContent).toContain('已归档');
    expect(f.root.querySelector('textarea[aria-label="日记正文"]')).toBeNull();
    expect(f.root.querySelector('article[aria-label="日记正文"]')).not.toBeNull();
    expect([...f.root.querySelectorAll('button')].some(b => b.textContent === '编辑正文')).toBe(false);
    click(f.root, '返回对话'); await settle(); expect(f.root.textContent).toContain('本次补记方式');
  });
  it('never injects model HTML into DOM', async () => {
    const f = await setup(); f.model.reply = { action: 'acknowledge', text: '<img src=x onerror=alert(1)>', question: null, topicId: 'daily', thread: null };
    await f.app.send('测试'); expect(f.root.querySelector('img')).toBeNull(); expect(f.root.textContent).toContain('<img');
  });
  it('persists input before view is disposed', async () => {
    const f = await setup(), input = f.root.querySelector('textarea')!; input.value = '关页前的草稿'; input.dispatchEvent(new Event('input'));
    await f.screen.persist(); expect(f.app.state.input).toBe('关页前的草稿');
  });
  it('allows a free opening and starts recall without fabricating user material', async () => {
    const f = await setup();
    expect(f.root.querySelector('textarea')).not.toBeNull();
    click(f.root, '开始回顾'); await settle();
    expect(f.model.calls).toHaveLength(1); expect(f.app.state.messages.filter(m => m.role === 'user')).toHaveLength(0);
    const input = f.root.querySelector('textarea')!;
    input.value = '下午有些烦，走到楼下又轻松了一点。'; input.dispatchEvent(new Event('input'));
    click(f.root, '发送'); await settle();
    expect(f.app.state.messages.find(m => m.role === 'user')?.text).toContain('走到楼下');
    expect(f.app.state.messages.some(m => m.text === '开始回顾')).toBe(false);
  });
  it('keeps input focus, selection, and composition intact during store refreshes', async () => {
    const f = await setup(); let input = f.root.querySelector('textarea')!;
    input.value = '留在心里的那个片刻'; input.dispatchEvent(new Event('input')); input.focus(); input.setSelectionRange(2, 5, 'backward');
    f.app.emit(); input = f.root.querySelector('textarea')!;
    expect(document.activeElement).toBe(input); expect(input.selectionStart).toBe(2); expect(input.selectionEnd).toBe(5);
    input.dispatchEvent(new CompositionEvent('compositionstart')); f.app.emit();
    expect(f.root.querySelector('textarea')).toBe(input);
    input.dispatchEvent(new CompositionEvent('compositionend')); await f.screen.persist();
    expect(f.app.state.input).toBe('留在心里的那个片刻');
  });
  it('keeps the composer and its ancestors attached across refresh and asynchronous autosave', async () => {
    const f = await setup(), input = f.root.querySelector('textarea')!;
    const ancestors: HTMLElement[] = []; for (let node: HTMLElement | null = input; node && node !== f.root; node = node.parentElement) ancestors.push(node);
    const removals: Node[] = [], observer = new MutationObserver(records => records.forEach(r => removals.push(...r.removedNodes)));
    observer.observe(f.root, { subtree: true, childList: true });
    const blurred = vi.fn(); input.addEventListener('blur', blurred); input.focus();
    input.value = '异步保存时，键盘也应该留在原处。'; input.dispatchEvent(new Event('input')); input.setSelectionRange(3, 6);
    await f.app.refresh();
    expect(f.root.querySelector('textarea')).toBe(input); expect(document.activeElement).toBe(input);
    await vi.waitFor(() => expect(f.app.state.input).toBe('异步保存时，键盘也应该留在原处。'));
    expect(f.root.querySelector('textarea')).toBe(input); expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(3); expect(input.selectionEnd).toBe(6); expect(blurred).not.toHaveBeenCalled();
    expect(removals.some(removed => ancestors.some(node => removed === node || removed.contains(node)))).toBe(false);
    observer.disconnect();
  });
  it('keeps both preview editors and their ancestors attached while edits autosave', async () => {
    const f = await setup(true); click(f.root, '查看预览'); await settle(); click(f.root, '编辑正文'); await settle();
    const body = f.root.querySelector<HTMLTextAreaElement>('[aria-label="日记正文"]')!;
    const observation = f.root.querySelector<HTMLTextAreaElement>('[aria-label="AI 观察"]')!;
    const protectedNodes: HTMLElement[] = [];
    for (const input of [body, observation]) for (let node: HTMLElement | null = input; node && node !== f.root; node = node.parentElement) protectedNodes.push(node);
    const removals: Node[] = [], observer = new MutationObserver(records => records.forEach(r => removals.push(...r.removedNodes)));
    observer.observe(f.root, { subtree: true, childList: true });
    const bodyBlur = vi.fn(); body.addEventListener('blur', bodyBlur); body.focus();
    body.value = '正文保留着我自己的语气。'; body.dispatchEvent(new Event('input')); body.setSelectionRange(2, 4);
    await f.app.refresh(); await vi.waitFor(() => expect(f.app.state.draft?.body).toBe('正文保留着我自己的语气。'));
    expect(f.root.querySelector('[aria-label="日记正文"]')).toBe(body); expect(document.activeElement).toBe(body);
    expect(body.selectionStart).toBe(2); expect(body.selectionEnd).toBe(4); expect(bodyBlur).not.toHaveBeenCalled();
    f.root.querySelector<HTMLDetailsElement>('.ai-diary-observation')!.open = true;
    const obsBlur = vi.fn(); observation.addEventListener('blur', obsBlur); observation.focus();
    observation.value = '这只是一种可能的理解。'; observation.dispatchEvent(new Event('input')); observation.setSelectionRange(1, 3);
    await f.app.refresh(); await vi.waitFor(() => expect(f.app.state.draft?.observations).toBe('这只是一种可能的理解。'));
    expect(f.root.querySelector('[aria-label="AI 观察"]')).toBe(observation); expect(document.activeElement).toBe(observation);
    expect(observation.selectionStart).toBe(1); expect(observation.selectionEnd).toBe(3); expect(obsBlur).not.toHaveBeenCalled();
    expect(removals.some(removed => protectedNodes.some(node => removed === node || removed.contains(node)))).toBe(false);
    observer.disconnect();
  });
  it('retains disclosure and main scroll position when reading earlier conversation', async () => {
    const f = await setup(true), scroll = f.root.querySelector<HTMLElement>('.ai-diary-scroll')!;
    Object.defineProperties(scroll, { scrollHeight: { value: 1600 }, clientHeight: { value: 400 } }); scroll.scrollTop = 180;
    const disclosure = f.root.querySelector<HTMLDetailsElement>('.ai-diary-directions')!; disclosure.open = true;
    f.app.emit();
    expect(f.root.querySelector<HTMLElement>('.ai-diary-scroll')!.scrollTop).toBe(180);
    expect(f.root.querySelector<HTMLDetailsElement>('.ai-diary-directions')!.open).toBe(true);
  });
  it('restores conversation scroll after returning from the full-page preview', async () => {
    const f = await setup(true), scroll = f.root.querySelector<HTMLElement>('.ai-diary-scroll')!;
    Object.defineProperties(scroll, { scrollHeight: { value: 1600 }, clientHeight: { value: 400 } }); scroll.scrollTop = 180;
    click(f.root, '查看预览'); await settle();
    click(f.root, '返回对话'); await settle(); expect(f.root.querySelector<HTMLElement>('.ai-diary-scroll')!.scrollTop).toBe(180);
  });
  it('routes broadening and rephrasing through explicit user controls', async () => {
    const f = await setup(); await f.app.send('下午有点烦。'); await f.app.reply();
    const reply = vi.spyOn(f.app, 'reply').mockResolvedValue();
    click(f.root, '换个问法'); await settle(); expect(reply).toHaveBeenLastCalledWith('rephrase');
    click(f.root, '聊下一段时间'); await settle(); expect(reply).toHaveBeenLastCalledWith('broaden');
  });
  it('closes the directions menu before starting an action so it cannot cover other controls', async () => {
    const f = await setup(); const details = f.root.querySelector<HTMLDetailsElement>('.ai-diary-directions')!; details.open = true;
    vi.spyOn(f.app, 'reply').mockResolvedValue(); click(f.root, '聊下一段时间'); await settle();
    expect(f.root.querySelector<HTMLDetailsElement>('.ai-diary-directions')!.open).toBe(false);
  });
  it('shows source-backed moments without completion scores and can focus a moment', async () => {
    const f = await setup(); await f.app.send('下午改方案，烦得不想说话。');
    const moment = f.app.dayMap.moments[0]!; expect(moment).toBeTruthy();
    const details = f.root.querySelector<HTMLDetailsElement>('.ai-diary-moments')!; expect(details.open).toBe(false);
    click(f.root, moment.title); await settle(); expect(f.app.dayMap.focusMomentId).toBe(moment.id);
    expect(f.root.textContent).not.toContain('完成率');
  });
  it('allows skipping the focused moment even when no assistant thread exists yet', async () => {
    const f = await setup(); await f.app.send('下午改方案，烦得不想说话。');
    expect(f.app.state.messages.some(m => m.threadId)).toBe(false);
    const skip = vi.spyOn(f.app, 'skip').mockResolvedValue();
    click(f.root, '先不聊这件事'); await settle(); expect(skip).toHaveBeenCalledOnce();
  });
  it('keeps a failed input save recoverable instead of clearing local words', async () => {
    const f = await setup(), input = f.root.querySelector('textarea')!;
    input.value = '存储失败也要留下'; input.dispatchEvent(new Event('input'));
    f.vault.fail = () => true; await f.screen.persist();
    expect(f.root.querySelector('textarea')!.value).toBe('存储失败也要留下');
    expect(f.root.querySelector('[role="alert"]')).not.toBeNull();
    f.vault.fail = undefined; await f.screen.persist(); expect(f.app.state.input).toBe('存储失败也要留下');
  });
  it('edits observations without exposing them as diary body and preserves folded state', async () => {
    const f = await setup(true); click(f.root, '查看预览'); await settle(); click(f.root, '编辑正文'); await settle();
    const details = f.root.querySelector<HTMLDetailsElement>('.ai-diary-observation')!; details.open = true;
    const input = f.root.querySelector<HTMLTextAreaElement>('[aria-label="AI 观察"]')!;
    input.value = '可能只是疲惫，也可以删掉这句。'; input.dispatchEvent(new Event('input'));
    click(f.root, '完成编辑'); await settle();
    expect(f.root.querySelector<HTMLDetailsElement>('.ai-diary-observation')!.open).toBe(true);
    expect(f.root.querySelector('[aria-label="AI 观察"]')!.textContent).toContain('可能只是疲惫');
    expect(f.root.querySelector('[aria-label="日记正文"]')!.textContent).not.toContain('可能只是疲惫');
  });
  it('renders readable Markdown safely and follows vault links through host navigation', () => {
    const root = document.createElement('div'), open = vi.fn();
    reading(root, '# 一点想法\n\n**心里的话**\n\n- 很小的事\n\n[[日记/昨天|昨天]]\n\n<img src=x>\n[javascript](javascript:alert(1))', open);
    expect(root.querySelector('h2')!.textContent).toBe('一点想法'); expect(root.querySelector('strong')!.textContent).toBe('心里的话');
    expect(root.querySelector('li')!.textContent).toBe('很小的事'); expect(root.querySelector('img')).toBeNull();
    expect(root.querySelectorAll('a')).toHaveLength(1); root.querySelector('a')!.click(); expect(open).toHaveBeenCalledWith('日记/昨天');
  });
  it('refuses absolute, traversal, URI, and encoded wiki destinations while retaining safe anchors', () => {
    const root = document.createElement('div'), open = vi.fn();
    reading(root, '[[../私密]] [[/根目录]] [[C:/Users/笔记]] [[obsidian://open]] [[%2e%2e/越界]] [[昨天#傍晚|傍晚]]', open);
    expect(root.querySelectorAll('a')).toHaveLength(1);
    expect(root.textContent).toContain('[[../私密]]'); expect(open).not.toHaveBeenCalled();
    root.querySelector('a')!.click(); expect(open).toHaveBeenCalledWith('昨天#傍晚');
  });
});
