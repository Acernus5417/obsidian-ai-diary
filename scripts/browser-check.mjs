import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, readdir } from 'node:fs/promises';
const longitudinal = process.argv.includes('--longitudinal-replay');
const coherent = process.argv.includes('--coherence-replay');
import assert from 'node:assert/strict';
await mkdir('test-results', { recursive: true });
await build({ entryPoints: ['tests/fixtures/browser.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: 'test-results/browser.js' });
const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AI 日记 · 主题变量界面检查</title><link rel="stylesheet" href="/styles.css"><style>:root{--font-text:"Segoe UI","Microsoft YaHei",sans-serif;--font-interface:var(--font-text);--font-text-size:16px;--background-primary:#fff;--background-primary-alt:#fafafa;--background-secondary:#f6f6f6;--text-normal:#222;--text-muted:#666;--background-modifier-border:#e0e0e0;--interactive-accent:#8067c1;--interactive-accent-hover:#6e57ab;--text-on-accent:#fff;--button-radius:5px}.theme-dark{--background-primary:#1e1e1e;--background-primary-alt:#222;--background-secondary:#262626;--text-normal:#dadada;--text-muted:#999;--background-modifier-border:#363636;--interactive-accent:#a88bfa;--interactive-accent-hover:#b599ff;--text-on-accent:#1e1e1e}*{box-sizing:border-box}body{margin:0;font:16px system-ui,sans-serif;height:100dvh}#app{height:100%}button,select,input,textarea{font:inherit}button{cursor:pointer}</style><body><main id="app"></main><script type="module" src="/browser.js"></script></body></html>`;
async function longitudinalReplay() {
  const day = JSON.parse(await readFile('test-results/two-months/days/2026-08-31.json', 'utf8'));
  const files = {};
  async function collect(directory) {
    for (const entry of await readdir(`test-results/two-months/vault/${directory}`, { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await collect(path);
      else if (path.endsWith('.md')) files[path] = await readFile(`test-results/two-months/vault/${path}`, 'utf8');
    }
  }
  for (const directory of ['日记', '周记', '月记']) await collect(directory);
  const paths = Object.keys(files);
  const newestWeek = paths.filter(p => p.startsWith('周记/')).sort().at(-1);
  const reviews = [paths.find(p => p.endsWith('/2026-07.md')), newestWeek, paths.find(p => p.endsWith('/2026-08.md'))].filter(Boolean)
    .map(path => ({ path, title: files[path].match(/^# (.+)$/m)?.[1] ?? path }));
  return { longitudinal: true, files, reviews, results: [{ id: 'workday', date: day.date, diary: day.body, observations: day.observations, dialogue: day.dialogue }] };
}
async function coherenceReplay() {
  const r = JSON.parse(await readFile('test-results/coherence/writing/ellipsis-narrative.json', 'utf8'));
  return { results: [{ id: 'workday', date: r.date, diary: r.revised.body, observations: r.revised.observations, dialogue: r.revised.dialogue }] };
}
const server = createServer(async (req, res) => {
  try {
    const route = req.url?.split('?')[0];
    if (route === '/styles.css') { res.setHeader('Content-Type', 'text/css'); res.end(await readFile('styles.css')); }
    else if (route === '/real-result.json') { res.setHeader('Content-Type', 'application/json'); res.end(coherent ? JSON.stringify(await coherenceReplay()) : longitudinal ? JSON.stringify(await longitudinalReplay()) : await readFile('test-results/recall-recovered.json')); }
    else if (route === '/browser.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile('test-results/browser.js')); }
    else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); }
  } catch { res.writeHead(500); res.end('test error'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
let browser;
const consoleErrors = [];
const syntheticDiary = '下午方案又改了三遍。最烦的时候，脑子里就是一句：今天的时间又全耗在这里了。本来还想留点力气给自己的小工具，最后一直没碰。\n\n傍晚走回家的时候，风很舒服。走了一会儿，心里慢慢安静下来，但想到没做成的事，还是有一点不甘心。\n\n这一刻回头看，两个感觉都还在。今天先这样留下，也不用急着把它想明白。';
async function ready(page) { await page.waitForFunction(() => !window.testDiary.busy); assert.deepEqual(await page.locator('[role="alert"]').allTextContents(), [], 'UI error'); }
async function snapshot(page, name) { await page.screenshot({ path: `test-results/${coherent ? 'coherent' : longitudinal ? 'longitudinal' : 'native'}-${name}.png`, fullPage: true, animations: 'disabled' }); }
async function noOverflow(page, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('#app').scrollWidth <= innerWidth + 1), true, `${label}: horizontal overflow`);
  const metrics = await page.evaluate(() => {
    const shell = document.querySelector('.ai-diary-shell'), root = document.querySelector('#app'), messages = document.querySelector('.ai-diary-messages');
    return { shell: shell.getBoundingClientRect().height, root: root.getBoundingClientRect().height, messageOverflow: messages ? getComputedStyle(messages).overflowY : 'visible' };
  });
  assert.ok(metrics.shell <= metrics.root + 1, `${label}: page exceeds workspace`);
  assert.equal(metrics.messageOverflow, 'visible', `${label}: nested message scroll`);
}
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', e => consoleErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`); await page.getByLabel('日记回答').waitFor();
  await snapshot(page, 'start-desktop');
  assert.equal(await page.getByRole('button', { name: '日常小事', exact: true }).first().isVisible(), false, 'category entries start folded');
  assert.equal(await page.locator('h1').count(), 0, 'no decorative large title');
  await page.getByRole('button', { name: '开始回顾', exact: true }).click(); await ready(page);
  assert.equal(await page.evaluate(() => window.testDiary.state.messages.filter(m => m.role === 'user').length), 0, 'start must not become user facts');
  await page.getByLabel('日记回答').fill('下午方案改了三遍，烦。回家路上风很舒服，突然安静下来。');
  await page.getByRole('button', { name: '发送', exact: true }).click(); await ready(page);
  await page.getByRole('button', { name: '继续问我', exact: true }).click(); await ready(page);
  await page.locator('.ai-diary-current .ai-diary-question').waitFor();
  await snapshot(page, 'chat-desktop'); await noOverflow(page, 'desktop conversation');
  await page.evaluate(() => document.body.classList.add('theme-dark'));
  await snapshot(page, 'chat-desktop-dark');
  await page.evaluate(() => document.body.classList.remove('theme-dark'));
  await page.evaluate(() => { const root = document.querySelector('#app'); root.style.setProperty('--background-primary','#edf2f8'); root.style.setProperty('--text-normal','#1e334d'); root.style.setProperty('--interactive-accent','#285eab'); root.style.setProperty('--background-modifier-border','#bac9dd'); });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.ai-diary-primary')).backgroundColor === 'rgb(40, 94, 171)');
  assert.equal(await page.locator('#app').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(237, 242, 248)', 'host theme background applies');
  assert.equal(await page.getByRole('button', { name: '发送', exact: true }).evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(40, 94, 171)', 'host accent applies');
  await snapshot(page, 'chat-custom-theme');
  await page.evaluate(() => { document.querySelector('#app').removeAttribute('style'); });
  // User controls choose the next angle; there are no automatic polling questions.
  await page.locator('.ai-diary-directions > summary').click();
  await page.getByRole('button', { name: '换个问法', exact: true }).click(); await ready(page);
  await page.getByLabel('日记回答').fill('最烦的时候想的是：今天的时间又全耗在这里了。本来想做自己的小工具。');
  await page.getByRole('button', { name: '发送', exact: true }).click(); await ready(page);
  // Preserve the actual insertion point across a persistence-driven re-render.
  await page.getByLabel('日记回答').evaluate(el => { window.testInputNode = el; window.inputBlurCount = 0; el.addEventListener('blur', () => { ++window.inputBlurCount; }); });
  await page.getByLabel('日记回答').fill('这句话还在输入框里。');
  await page.getByLabel('日记回答').evaluate(el => { el.focus(); el.setSelectionRange(2, 5); });
  await page.waitForFunction(() => window.testDiary.state.input === '这句话还在输入框里。');
  assert.deepEqual(await page.getByLabel('日记回答').evaluate(el => [document.activeElement === el, el.selectionStart, el.selectionEnd]), [true, 2, 5]);
  assert.equal(await page.getByLabel('日记回答').evaluate(el => window.testInputNode === el && window.inputBlurCount === 0), true, 'autosave keeps textarea attached, without blur');
  await page.getByRole('button', { name: '生成日记', exact: true }).click();
  await page.getByRole('button', { name: '仅生成已发送内容', exact: true }).click();
  await page.locator('article[aria-label="日记正文"]').waitFor(); await ready(page);
  assert.equal(await page.locator('textarea[aria-label="日记正文"]').count(), 0, 'preview opens as an article');
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.getByLabel('日记正文', { exact: true }).evaluate(el => { window.testBodyNode = el; window.bodyBlurCount = 0; el.addEventListener('blur', () => { ++window.bodyBlurCount; }); });
  await page.getByLabel('日记正文', { exact: true }).fill(syntheticDiary);
  await page.waitForFunction(body => window.testDiary.state.draft.body === body, syntheticDiary);
  assert.equal(await page.getByLabel('日记正文', { exact: true }).evaluate(el => window.testBodyNode === el && document.activeElement === el && window.bodyBlurCount === 0), true, 'body autosave keeps the editor attached');
  await page.locator('.ai-diary-observation > summary').click();
  await page.getByLabel('AI 观察', { exact: true }).fill('从这些表达看，你可能既想留住自己的时间，也想让疲惫先缓一缓。这只是一个暂时的理解。');
  await page.getByLabel('AI 观察', { exact: true }).evaluate(el => { window.testObsNode = el; window.obsBlurCount = 0; el.addEventListener('blur', () => { ++window.obsBlurCount; }); });
  await page.waitForFunction(() => window.testDiary.state.draft.observations.includes('也想让疲惫先缓一缓'));
  assert.equal(await page.getByLabel('AI 观察', { exact: true }).evaluate(el => window.testObsNode === el && document.activeElement === el && window.obsBlurCount === 0), true, 'observation autosave keeps the editor attached');
  await page.getByRole('button', { name: '完成编辑', exact: true }).click();
  await snapshot(page, 'preview-desktop');
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  assert.equal(await page.getByLabel('日记回答').inputValue(), '这句话还在输入框里。');
  await page.getByRole('button', { name: '查看预览', exact: true }).click();
  assert.equal(await page.locator('article[aria-label="日记正文"]').innerText(), syntheticDiary);
  for (const width of [360, 390, 412]) {
    await page.setViewportSize({ width, height: 844 }); await noOverflow(page, `${width}px preview`);
    if (width === 390) { await page.locator('.ai-diary-scroll').evaluate(el => { el.scrollTop = 0; }); await snapshot(page, 'preview-mobile-width'); await page.evaluate(() => document.body.classList.add('theme-dark')); await snapshot(page, 'preview-mobile-dark'); await page.evaluate(() => document.body.classList.remove('theme-dark')); }
  }
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await page.locator('.ai-diary-directions > summary').click();
  await page.getByRole('button', { name: '聊下一段时间', exact: true }).click(); await ready(page);
  await snapshot(page, 'chat-mobile-width');
  await page.setViewportSize({ width: 390, height: 420 }); await noOverflow(page, 'short viewport (keyboard approximation)');
  const sendBox = await page.getByRole('button', { name: '发送', exact: true }).boundingBox();
  assert.ok(sendBox && sendBox.y >= 0 && sendBox.y + sendBox.height <= 421, 'send remains reachable with a short viewport');
  await snapshot(page, 'chat-short-viewport');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => document.querySelector('#app').style.setProperty('--font-text-size', '20px')); await noOverflow(page, 'increased base font');
  assert.ok(await page.locator('.ai-diary-user .ai-diary-message-text').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 20), 'host text-size preference is respected');
  await page.getByRole('button', { name: '查看预览', exact: true }).click();
  await page.getByRole('button', { name: '确认归档', exact: true }).click(); await page.getByRole('button', { name: '已归档', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '编辑正文', exact: true }).count(), 0, 'archive is read-only');
  await snapshot(page, 'archive-mobile-width');
  // Isolated synthetic error and pending-request states exercise actual controls.
  const states = await browser.newPage({ viewport: { width: 390, height: 844 } });
  states.on('pageerror', e => consoleErrors.push(e.message));
  await states.goto(`http://127.0.0.1:${port}/`); await states.getByLabel('日记回答').waitFor();
  await snapshot(states, 'start-mobile-width');
  await states.evaluate(() => { window.testDiary.model.fail = 'conversation'; });
  await states.getByLabel('日记回答').fill('窗边晒了一会儿太阳，什么也没想。');
  await states.getByRole('button', { name: '发送', exact: true }).click();
  await states.getByRole('alert').waitFor();
  assert.equal(await states.evaluate(() => window.testDiary.state.messages.filter(m => m.role === 'user').length), 1, 'failure preserves submitted words');
  await snapshot(states, 'error-mobile-width');
  await states.evaluate(() => { window.testDiary.model.fail = undefined; });
  await states.getByRole('button', { name: '重试上次操作', exact: true }).click(); await ready(states);
  await states.evaluate(() => {
    const model = window.testDiary.model, original = model.run.bind(model);
    window.restoreTestModel = () => { model.run = original; };
    model.run = async (task, input, valid) => {
      if (task === 'conversation') await new Promise(resolve => { window.releaseTestModel = resolve; });
      return original(task, input, valid);
    };
  });
  await states.getByRole('button', { name: '继续问我', exact: true }).click();
  await states.getByRole('button', { name: '停止等待', exact: true }).waitFor();
  await snapshot(states, 'waiting-mobile-width');
  await states.getByRole('button', { name: '停止等待', exact: true }).click();
  await states.evaluate(() => { window.releaseTestModel(); window.restoreTestModel(); });
  await ready(states);
  assert.equal(await states.evaluate(() => window.testDiary.state.messages.filter(m => m.role === 'user').length), 1, 'cancel preserves material');
  assert.deepEqual(consoleErrors, []);
  if (process.argv.includes('--real-replay') || longitudinal || coherent) {
    const replay = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    replay.on('pageerror', e => consoleErrors.push(e.message));
    await replay.goto(`http://127.0.0.1:${port}/?replay=workday`); await replay.getByLabel('日记回答').waitFor();
    if (longitudinal) {
      const calls = await replay.evaluate(() => window.testDiary.model.calls.length);
      await replay.getByRole('button', { name: '周/月回顾', exact: true }).click();
      await replay.waitForFunction(() => !window.testDiary.reviewBusy);
      assert.equal(await replay.evaluate(() => window.testDiary.model.calls.length), calls, 'already generated periods do not call a model again');
      await replay.getByRole('button', { name: '月记 2026-08', exact: true }).click();
      assert.equal(await replay.evaluate(() => window.lastOpenedFile), '月记/2026/2026-08.md');
    }
    await replay.evaluate(() => document.body.classList.add('theme-dark'));
    await noOverflow(replay, 'real-output desktop'); await snapshot(replay, 'real-output-chat');
    await replay.getByRole('button', { name: '查看预览', exact: true }).click();
    await replay.locator('article[aria-label="日记正文"]').waitFor(); await noOverflow(replay, 'real-output preview');
    await snapshot(replay, 'real-output-preview');
    await replay.setViewportSize({ width: 390, height: 844 }); await noOverflow(replay, 'real-output mobile');
    if (longitudinal) for (const width of [360, 390, 412]) { await replay.setViewportSize({ width, height: 844 }); await noOverflow(replay, 'period controls mobile'); }
    await snapshot(replay, 'real-output-mobile'); await replay.close();
    assert.deepEqual(consoleErrors, []);
    console.log('PASS: fictional real-service output rendered through the production screen at desktop and mobile widths. Rendering replay, not another API call.');
  }
  console.log('PASS: actual Chromium UI journey; free opening, explicit follow-up/rephrase, cursor persistence, unsent-draft choice, article/edit preview, observation separation, archive, desktop/dark and 360/390/412px, short viewport. Synthetic model and host; not real Obsidian/Android/keyboard/Sync.');
} finally { await browser?.close(); await new Promise(r => server.close(r)); }
