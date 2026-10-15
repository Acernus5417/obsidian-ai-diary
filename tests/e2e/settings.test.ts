// @vitest-environment happy-dom
import { it, expect, afterEach, vi } from 'vitest';
import AIDiaryPlugin from '../../src/main';
import { DiarySettingsTab } from '../../src/ui/settings';
import { Gateway } from '../../src/ai/gateway';
import { host, Notice } from '../fixtures/obsidian';
import manifest from '../../manifest.json';
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); document.body.replaceChildren(); Notice.messages = []; });
async function setup() {
  const h = host(), p = new AIDiaryPlugin(h.app, manifest); await p.onload();
  const tab = new DiarySettingsTab(h.app, p); document.body.append(tab.containerEl); tab.display();
  cleanups.push(() => { tab.hide(); p.unload(); });
  const requests: { url: string; body: string; headers: Record<string, string> }[] = [];
  p.gateway = new Gateway(() => p.settings, p.secrets, async req => { requests.push(req); return { status: 200, text: JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) }; });
  const input = (name: string) => {
    const row = [...tab.containerEl.querySelectorAll('.setting-item')].find(el => el.querySelector('.setting-item-name')?.textContent === name)!;
    return row.querySelector<HTMLInputElement>('input')!;
  };
  const fill = (name: string, value: string) => { const el = input(name); el.value = value; el.dispatchEvent(new Event('input')); };
  const click = (name: string) => { [...tab.containerEl.querySelectorAll('button')].find(b => b.textContent === name)!.click(); };
  return { ...h, p, tab, requests, input, fill, click };
}
it('immediate connection test saves and uses the values just entered, without the bottom save button', async () => {
  const f = await setup(); f.secrets.set(f.p.settings.credentialRef, 'SETTINGS-TEST-SECRET');
  f.fill('服务地址', 'https://example.invalid/proxy/v1'); f.fill('模型名称', 'new-model'); f.click('测试连接');
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  expect(f.requests[0]!.url).toBe('https://example.invalid/proxy/v1/chat/completions');
  expect(JSON.parse(f.requests[0]!.body).model).toBe('new-model');
  expect(await f.p.loadData()).toMatchObject({ baseUrl: 'https://example.invalid/proxy/v1', modelId: 'new-model' });
  expect(JSON.stringify(await f.p.loadData())).not.toContain('SETTINGS-TEST-SECRET');
});
it('closing settings immediately flushes address and model, recognized after reload', async () => {
  const f = await setup(); f.fill('服务地址', 'https://example.invalid/v1'); f.fill('模型名称', 'kept-model'); f.tab.hide();
  await vi.waitFor(() => expect(f.p.settings.modelId).toBe('kept-model'));
  const reloaded = new AIDiaryPlugin(f.app, manifest); (reloaded as any).data = await f.p.loadData();
  await reloaded.onload(); expect(reloaded.settings.baseUrl).toBe('https://example.invalid/v1'); expect(reloaded.settings.modelId).toBe('kept-model'); reloaded.unload();
});
it('automatically updates the journal setup banner after valid fields are entered', async () => {
  const f = await setup(); await f.p.openDiary(); expect(document.querySelector('.ai-diary-setup')).not.toBeNull();
  f.fill('服务地址', 'https://example.invalid/v1'); f.fill('模型名称', 'auto-model');
  await vi.waitFor(() => expect(f.p.settings.modelId).toBe('auto-model'));
  expect(document.querySelector('.ai-diary-setup')).toBeNull();
});
it('invalid address never falls back to testing stale settings and keeps the entered value', async () => {
  const f = await setup(); f.fill('服务地址', 'not-a-url'); f.fill('模型名称', 'typed-model'); f.click('测试连接');
  await vi.waitFor(() => expect(f.tab.containerEl.textContent).toContain('设置未保存'));
  expect(f.requests).toHaveLength(0); expect(f.p.settings.baseUrl).toBe('');
  f.tab.display(); expect(f.input('服务地址').value).toBe('not-a-url'); expect(f.input('模型名称').value).toBe('typed-model');
});
it('model autosave and test do not silently save an unrelated invalid folder edit', async () => {
  const f = await setup(); f.secrets.set(f.p.settings.credentialRef, 'SETTINGS-TEST-SECRET');
  f.fill('日记目录', '../invalid-folder'); f.fill('服务地址', 'https://example.invalid/v1'); f.fill('模型名称', 'new-model'); f.click('测试连接');
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  expect(f.p.settings.diaryFolder).toBe('日记'); f.click('保存设置');
  await vi.waitFor(() => expect(f.tab.containerEl.textContent).toContain('设置未保存'));
  expect(f.input('日记目录').value).toBe('../invalid-folder'); expect(f.p.settings.modelId).toBe('new-model');
});
it('refuses stale form writes after external settings change and keeps local form text', async () => {
  const f = await setup(); f.fill('服务地址', 'https://local.invalid/v1'); f.fill('模型名称', 'local-draft');
  await f.p.updateSettings({ ...structuredClone(f.p.settings), baseUrl: 'https://remote.invalid/v1', modelId: 'remote-model' }, f.p.settingsRevision);
  f.click('测试连接'); await vi.waitFor(() => expect(f.tab.containerEl.textContent).toContain('未覆盖'));
  expect(f.requests).toHaveLength(0); expect(f.p.settings.modelId).toBe('remote-model'); expect(f.input('模型名称').value).toBe('local-draft');
  f.click('载入最新设置（替换本页填写）'); expect(f.input('模型名称').value).toBe('remote-model');
});
it('failed persistence preserves inputs and a retry can save then test', async () => {
  const f = await setup(); f.secrets.set(f.p.settings.credentialRef, 'SETTINGS-TEST-SECRET');
  vi.spyOn(f.p, 'saveData').mockRejectedValueOnce(new Error('injected storage error'));
  f.fill('服务地址', 'https://example.invalid/v1'); f.fill('模型名称', 'retry-model'); f.click('测试连接');
  await vi.waitFor(() => expect(f.tab.containerEl.textContent).toContain('设置未保存'));
  expect(f.requests).toHaveLength(0); expect(f.input('模型名称').value).toBe('retry-model');
  f.click('测试连接'); await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  expect((await f.p.loadData()).modelId).toBe('retry-model');
});
it('serializes a new edit during a delayed save, retaining the latest configuration after reload', async () => {
  const f = await setup(); f.secrets.set(f.p.settings.credentialRef, 'SETTINGS-TEST-SECRET');
  const original = f.p.saveData.bind(f.p); let release!: () => void;
  vi.spyOn(f.p, 'saveData').mockImplementationOnce(async data => { await new Promise<void>(r => { release = r; }); await original(data); });
  f.fill('服务地址', 'https://example.invalid/v1'); f.fill('模型名称', 'earlier-model'); f.click('测试连接');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  f.fill('模型名称', 'latest-model'); f.tab.hide(); release();
  await vi.waitFor(() => expect(f.p.settings.modelId).toBe('latest-model'));
  expect((await f.p.loadData()).modelId).toBe('latest-model');
});
it('saving credentials and testing typed model fields keeps the key out of ordinary settings', async () => {
  const f = await setup(); f.fill('服务地址', 'https://example.invalid/v1'); f.fill('模型名称', 'key-model');
  f.fill('本设备 API Key', 'SETTINGS-UI-KEY-MARKER'); f.click('保存凭据'); f.click('测试连接');
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  expect(f.secrets.get(f.p.settings.credentialRef)).toBe('SETTINGS-UI-KEY-MARKER');
  expect(JSON.stringify(await f.p.loadData())).not.toContain('SETTINGS-UI-KEY-MARKER'); expect(f.input('本设备 API Key').value).toBe('');
});
it('clears the earlier missing-model error in an already open diary after fields are saved', async () => {
  const f = await setup(); await f.p.openDiary(); await f.p.diary.reply();
  expect(f.p.diary.error).toContain('填写服务地址和模型名称');
  f.fill('服务地址', 'https://example.invalid/v1'); f.fill('模型名称', 'configured-model');
  await vi.waitFor(() => expect(f.p.settings.modelId).toBe('configured-model'));
  expect(f.p.diary.error).toBe(''); expect(document.body.textContent).not.toContain('填写服务地址和模型名称');
});
it('clears a missing-key reminder when credentials are saved without leaking them to settings', async () => {
  const f = await setup(); f.fill('服务地址', 'https://example.invalid/v1'); f.fill('模型名称', 'configured-model');
  await vi.waitFor(() => expect(f.p.settings.modelId).toBe('configured-model'));
  await f.p.diary.reply(); expect(f.p.diary.error).toContain('尚未配置 API Key');
  f.fill('本设备 API Key', 'SETTINGS-UI-KEY-MARKER'); f.click('保存凭据');
  expect(f.p.diary.error).toBe(''); expect(JSON.stringify(await f.p.loadData())).not.toContain('SETTINGS-UI-KEY-MARKER');
});
