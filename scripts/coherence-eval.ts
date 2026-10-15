import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import { Gateway } from '../src/ai/gateway';
import { DiaryApp } from '../src/application/diary';
import { bodyOf } from '../src/application/archive';
import { EventStore } from '../src/storage/store';
import { loadSettings } from '../src/domain/settings';
import { DiaryError, type ModelPort, type ModelTask } from '../src/domain/types';
import { hash, dayPath } from '../src/domain/util';
import { validateWriting } from '../src/ai/validation';
import { DiskVault } from './fiction-vault';
import { coherenceCases, questionCases, type CoherenceCase } from '../tests/fixtures/coherence';
import { prompts, PROMPT_VERSION } from '../src/prompts';
// @ts-expect-error User-authorized fictional testing; key never emitted.
import { localEvalConfig } from './local-eval-config.mjs';

const root = resolve('test-results/coherence'); await mkdir(root, { recursive: true });
const config = localEvalConfig();
const settings = () => loadSettings({ namespace: 'coherence-fiction', baseUrl: config.baseUrl, modelId: config.modelId });
let baseline: any;
try { baseline = JSON.parse(await readFile(resolve(root, 'baseline-prompts-3.0.5.json'), 'utf8')); }
catch { baseline = JSON.parse(await readFile('test-results/two-months-targeted/negation-3-0-5/prompts-3.0.5.json', 'utf8')).prompts; await writeFile(resolve(root, 'baseline-prompts-3.0.5.json'), JSON.stringify(baseline, null, 2)); }
const context = new AsyncLocalStorage<{ caseId: string; variant: string; task?: string }>();
let calls = 0, logTail = Promise.resolve(), blockedByRate = false;
async function log(row: object) {
  const text = JSON.stringify({ time: new Date().toISOString(), version: PROMPT_VERSION, ...context.getStore(), ...row }).replaceAll(config.apiKey, '[credential omitted]');
  logTail = logTail.then(() => appendFile(resolve(root, 'requests.jsonl'), text + '\n')); await logTail;
}
const gateway = (variant: string) => new Gateway(settings, { get: () => config.apiKey }, async request => {
  const payload = JSON.parse(request.body), task = context.getStore()?.task;
  if (variant === 'baseline' && task && baseline[task]) payload.messages[0].content = baseline[task];
  const requestId = ++calls;
  try {
    const response = await fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(90000) });
    const raw = await response.text();
    await log({ requestId, status: response.status, messages: payload.messages, responseText: raw, responseHash: hash(raw) });
    return { status: response.status, text: raw.replaceAll(config.apiKey, '[credential omitted]') };
  } catch { await log({ requestId, error: 'network-or-timeout' }); throw new DiaryError('network', '真实测试连接中断或超时。'); }
});
const gateways = { baseline: gateway('baseline'), revised: gateway('revised') };
const model = (variant: keyof typeof gateways): ModelPort => ({ async run(task, input, valid = () => true) {
  return context.run({ ...context.getStore()!, variant, task }, async () => {
    for (let attempt = 0; ; attempt++) {
      try { const output = await gateways[variant].run(task, input, valid); await log({ attempt, input, output }); return output; }
      catch (e) { const code = e instanceof DiaryError ? e.code : 'unknown'; await log({ attempt, error: code });
        if (code === 'rate') { blockedByRate = true; throw e; }
        if (attempt >= 2 || !valid() || !['network', 'timeout', 'service', 'rate'].includes(code)) throw e;
        await new Promise(r => setTimeout(r, (attempt + 1) * 2000)); }
    }
  });
} });
const json = (file: string, value: unknown) => writeFile(resolve(root, file), JSON.stringify(value, null, 2), 'utf8');
await json(`prompts-${PROMPT_VERSION}.json`, { version: PROMPT_VERSION, prompts, baselineVersion: '3.0.5', baseline });
await json('fixtures.json', { coherenceCases, questionCases });
await mkdir(resolve(root, 'writing'), { recursive: true }); await mkdir(resolve(root, 'questions'), { recursive: true });
async function old(file: string): Promise<any> { try { return JSON.parse(await readFile(resolve(root, file), 'utf8')); } catch { return null; } }
async function preserve(file: string, previous: any) {
  if (!previous || previous.version === PROMPT_VERSION) return;
  const target = resolve(root, 'variants', previous.version, file); await mkdir(resolve(target, '..'), { recursive: true });
  try { await writeFile(target, JSON.stringify(previous, null, 2), { flag: 'wx' }); } catch (e) { if ((e as { code?: string }).code !== 'EEXIST') throw e; }
}
async function writingCase(f: CoherenceCase, index: number) {
  const file = `writing/${f.id}.json`, previous = await old(file);
  if (previous?.version === PROMPT_VERSION && previous?.status === 'complete') return;
  await preserve(file, previous);
  const s = { ...settings(), style: f.style ?? 'natural' };
  const vault = new DiskVault(resolve(root, 'vaults', PROMPT_VERSION, f.id)); await vault.load();
  const store = new EventStore(vault, s.transcriptFolder, `coherence-${f.id}`);
  const app = new DiaryApp(store, model('revised'), () => s), date = `2026-09-${String(index + 1).padStart(2, '0')}`;
  await app.open(date);
  if (!app.state.messages.length) {
    if (f.baseBody) {
      await store.append(date, 'user-message', { id: 'old-answer', role: 'user', text: 'DELETED_DETAIL 旧事已从当前日记删除。', topicId: 'daily', createdAt: new Date().toISOString() });
      await store.append(date, 'assistant-message', { id: 'old-question', role: 'assistant', text: 'DELETED_DETAIL那件事还让你不舒服吗？', topicId: 'daily', historyEvidence: [], createdAt: new Date().toISOString() });
      await store.append(date, 'draft-generated', { id: 'edited-base', body: f.baseBody, observations: '', baseHash: null, consumedIds: ['old-answer'], mode: 'initial',
        sourceMap: [{ paragraph: f.baseBody, sourceIds: ['old-answer'] }], diaryPath: dayPath(s.diaryFolder, date), transcriptPath: dayPath(s.transcriptFolder, date) });
      await app.refresh(); await app.save(); if (app.error) throw new Error(app.error);
    }
    const priorAnswerIds: string[] = [];
    for (const [i, [question, answer]] of f.pairs.entries()) {
      await store.append(date, 'assistant-message', { id: `${f.id}-q${i}`, role: 'assistant', text: question, topicId: 'daily', historyEvidence: [],
        conversationBasis: { bodyHash: hash(f.baseBody ?? ''), answerIds: [...priorAnswerIds] }, createdAt: new Date().toISOString() });
      const id = `${f.id}-u${i}`; priorAnswerIds.push(id);
      await store.append(date, 'user-message', { id, role: 'user', text: answer, topicId: 'daily', createdAt: new Date().toISOString() });
    }
  }
  await app.refresh();
  let result = previous?.version === PROMPT_VERSION ? previous : { caseId: f.id, date, version: PROMPT_VERSION, fixture: f, errors: [], baseline: previous?.baseline };
  try {
    if (!result.revised) {
      await app.generate(f.mode ?? 'initial');
      if (app.error || !app.state.draft?.factDocument) throw new Error(app.error || 'No fact document');
      const d = app.state.draft;
      await app.save(); if (app.error) throw new Error(app.error);
      const rows = (await readFile(resolve(root, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const writing = rows.slice().reverse().find(r => r.caseId === f.id && r.variant === 'revised' && r.input && ['write-natural', 'write-narrative'].includes(r.task));
      if (!writing) throw new Error('No actual writing input');
      if (JSON.stringify(writing.input).includes('DELETED_DETAIL')) throw new Error('Deleted detail leaked');
      result.revised = { body: d.body, factDocument: d.factDocument, sourceMap: d.sourceMap, sourceMapScope: d.sourceMapScope, input: writing.input,
        observations: d.observations, observationError: d.observationError, finalDiary: bodyOf((await vault.read(d.diaryPath))!), dialogue: app.state.messages };
      await json(file, result);
    }
    const input = result.revised.input;
    const baselineInput = { date, weekday: input.weekday, sources: input.sources, mode: input.mode };
    if (!result.baseline) {
      const raw = await model('baseline').run(s.style === 'natural' ? 'write-natural' : 'write-narrative', baselineInput);
      result.baseline = { ...validateWriting(raw, input.sources), input: baselineInput };
    }
    result.status = 'complete'; await json(file, result); console.log(`${f.id} 新旧写作完成`);
  } catch (e) { result.status = 'interrupted'; result.errors.push({ time: new Date().toISOString(), message: e instanceof Error ? e.message : 'unknown' }); await json(file, result); console.log(`${f.id} 中断，实际记录保留`); }
}
async function questionCase(f: typeof questionCases[number]) {
  const file = `questions/${f.id}.json`, previous = await old(file);
  if (previous?.version === PROMPT_VERSION && previous?.status === 'complete') return;
  await preserve(file, previous);
  const input = { date: '2026-09-20', weekday: '星期日', trigger: 'answer', topicId: 'daily', evidence: [], followUps: [], messages: [
    { id: 'q', role: 'assistant', text: f.prior }, { id: 'a', role: 'user', text: f.answer }] };
  async function response(variant: 'baseline' | 'revised') {
    const s = settings(), vault = new DiskVault(resolve(root, 'questions-vault', PROMPT_VERSION, f.id, variant, String(Date.now()))); await vault.load();
    const app = new DiaryApp(new EventStore(vault, s.transcriptFolder, `q-${variant}`), model(variant), () => s); await app.open(input.date);
    if (!app.state.messages.length) {
      await app.store.append(input.date, 'assistant-message', { id: 'q', role: 'assistant', text: f.prior, topicId: 'daily', historyEvidence: [], createdAt: new Date().toISOString() });
      await app.store.append(input.date, 'user-message', { id: 'a', role: 'user', text: f.answer, topicId: 'daily', createdAt: new Date().toISOString() });
    }
    await app.refresh(); await app.reply('answer'); if (app.error) throw new Error(app.error);
    return app.state.messages.at(-1)!.text;
  }
  const result = { version: PROMPT_VERSION, fixture: f, input, baseline: await response('baseline'), revised: await response('revised'), status: 'complete' };
  await json(file, result); console.log(`${f.id} 新旧提问完成`);
}
const selected = process.argv.find(a => a.startsWith('--only='))?.slice(7);
const jobs = [...coherenceCases.map((f, i) => ({ id: f.id, run: () => writingCase(f, i) })), ...(process.argv.includes('--writing-only') ? [] : questionCases.map(f => ({ id: f.id, run: () => questionCase(f) })))].filter(j => !selected || j.id === selected);
let next = 0;
async function worker() { while (!blockedByRate && next < jobs.length) { const job = jobs[next++]!; await context.run({ caseId: job.id, variant: 'revised' }, job.run); } }
await Promise.all([worker(), worker()]); await logTail;
await json('run-info.json', { version: PROMPT_VERSION, actualApi: true, fictionalOnly: true, model: config.modelId, requestsThisProcess: calls,
  scope: 'Ten writing cases, eight fixed-context question comparisons; manual review, not model scores or a human trial. Separate optional live conversations may follow.' });
config.apiKey = '';
