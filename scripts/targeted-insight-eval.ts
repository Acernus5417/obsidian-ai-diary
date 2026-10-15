import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Gateway } from '../src/ai/gateway';
import { generateObservations } from '../src/ai/observations';
import { validateWriting } from '../src/ai/validation';
import { PeriodicService, periodFor } from '../src/application/periodic';
import { DiaryError, type ModelPort } from '../src/domain/types';
import { loadSettings } from '../src/domain/settings';
import { ensureParent, hash } from '../src/domain/util';
import { DiskVault } from './fiction-vault';
import { PROMPT_VERSION, prompts } from '../src/prompts';
import { life } from '../tests/fixtures/two-month-life';
// @ts-expect-error Previously authorized fictional test only; key never emitted.
import { localEvalConfig } from './local-eval-config.mjs';

const variant = process.argv.find(a => a.startsWith('--variant='))?.slice(10);
if (variant && !/^[a-z0-9-]+$/.test(variant)) throw new Error('Invalid variant');
const root = resolve('test-results/two-months-targeted', variant ?? ''); await mkdir(root, { recursive: true });
const config = localEvalConfig(), settings = loadSettings({ namespace: 'fiction-targeted', baseUrl: config.baseUrl, modelId: config.modelId,
  historyEnabled: true, allowedPaths: ['日记'], periodicEnabled: true });
let date = '', task = '', httpCalls = 0;
const log = (row: unknown) => appendFile(resolve(root, 'requests.jsonl'), JSON.stringify({ time: new Date().toISOString(), date, task, promptVersion: PROMPT_VERSION, ...row as object }) + '\n');
const gateway = new Gateway(() => settings, { get: () => config.apiKey }, async request => {
  ++httpCalls;
  try {
    const r = await fetch(request.url, { method: 'POST', headers: request.headers, body: request.body, signal: AbortSignal.timeout(90000) });
    const text = await r.text(); await log({ http: httpCalls, status: r.status, requestHash: hash(request.body), responseHash: hash(text) });
    return { status: r.status, text };
  } catch { await log({ http: httpCalls, error: 'network-or-timeout' }); throw new DiaryError('network', '真实 API 测试连接失败。'); }
});
const model: ModelPort = { async run(kind, input, valid) {
  task = kind;
  for (let attempt = 0; ; attempt++) {
    try { const output = await gateway.run(kind, input, valid); await log({ attempt, input, output }); return output; }
    catch (e) {
      const code = e instanceof DiaryError ? e.code : 'unknown'; await log({ attempt, error: code });
      if (attempt >= 2 || !['network', 'timeout', 'service', 'rate'].includes(code)) throw e;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
} };
await writeFile(resolve(root, `prompts-${PROMPT_VERSION}.json`), JSON.stringify({ version: PROMPT_VERSION, prompts }, null, 2));
await mkdir(resolve(root, 'days'), { recursive: true });
const chosen = process.argv.find(a => a.startsWith('--dates='))?.slice(8).split(',');
const selected = chosen ?? ['2026-07-05', '2026-07-12', '2026-07-19', '2026-07-20', '2026-07-23', '2026-07-28', '2026-08-01', '2026-08-03', '2026-08-08', '2026-08-12', '2026-08-16', '2026-08-18', '2026-08-23', '2026-08-31'];
if (selected.some(d => !life.some(day => day.date === d))) throw new Error('Invalid date selection');
for (date of selected) {
  const file = resolve(root, 'days', `${date}.json`);
  try { if (JSON.parse(await readFile(file, 'utf8')).version === PROMPT_VERSION) continue; } catch { /* first attempt */ }
  const baseline = JSON.parse(await readFile(resolve('test-results/two-months/days', `${date}.json`), 'utf8'));
  if (baseline.observationPromptVersion !== '3.0.3') throw new Error(`Baseline not ready: ${date}`);
  const { previousInterpretations: _prior, ...input } = baseline.observationInput;
  const observation = await generateObservations(model, input, input.evidence);
  const result = { date, version: PROMPT_VERSION, baselineVersion: baseline.observationPromptVersion,
    sameFirsthandFacts: true, priorAIHypothesesRemoved: true, input, baseline: baseline.observations, observation,
    actualAnswers: baseline.dialogue.filter((m: any) => m.role === 'user'), body: baseline.body };
  await writeFile(file, JSON.stringify(result, null, 2), 'utf8');
  await writeFile(file.replace(/\.json$/, '.md'), `# ${date} 定向复测\n\n事实材料相同，删除先前AI假说，提示词 ${PROMPT_VERSION}。不是全量重跑或独立统计实验。\n\n## 3.0.3\n\n${result.baseline}\n\n## ${PROMPT_VERSION}\n\n${observation}\n`);
  console.log(`${date} 定向真实观察完成`);
}
const baselineCalls = (await readFile(resolve('test-results/two-months/requests.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
await mkdir(resolve(root, 'other'), { recursive: true });
for (const [caseDate, kind] of (process.argv.includes('--skip-other') ? [] : [['2026-08-05', 'write-natural'], ['2026-08-26', 'conversation'], ['2026-08-30', 'conversation']]) as (readonly [string, 'write-natural' | 'conversation'])[]) {
  date = caseDate; const file = resolve(root, 'other', `${date}-${kind}.json`);
  try { if (JSON.parse(await readFile(file, 'utf8')).version === PROMPT_VERSION) continue; } catch { /* first attempt */ }
  const original = baselineCalls.slice().reverse().find(r => r.task === kind && r.input?.date === date && r.output &&
    (date !== '2026-08-30' || r.input.messages?.filter((m: any) => m.role === 'user').at(-1)?.text.includes('不一定要我')));
  if (!original) throw new Error(`Missing actual baseline input: ${date} ${kind}`);
  const output = await model.run(kind, original.input);
  if (kind === 'write-natural') validateWriting(output, original.input.sources);
  await writeFile(file, JSON.stringify({ date, version: PROMPT_VERSION, task: kind, input: original.input, baseline: original.output, output }, null, 2));
  console.log(`${date} ${kind} 定向真实复测完成`);
}
const vault = new DiskVault(resolve(root, 'vault')); await vault.load();
for (const day of life) {
  const path = `日记/${day.date.slice(0, 4)}/${day.date.slice(5, 7)}/${day.date}.md`;
  if (await vault.read(path) === null) { await ensureParent(vault, path); await vault.create(path, await readFile(resolve('test-results/two-months/vault', path), 'utf8')); }
}
const service = new PeriodicService(vault, model, () => settings), periods = [];
for (const [end, kind] of (process.argv.includes('--skip-periods') ? [] : [['2026-07-05', 'week'], ['2026-08-30', 'week'], ['2026-07-31', 'month'], ['2026-08-31', 'month']]) as (readonly [string, 'week' | 'month'])[]) {
  date = end; const result = await service.generate(periodFor(end, kind)); periods.push(result);
  console.log(`${result.path} 定向真实回顾完成`);
}
await writeFile(resolve(root, 'summary.json'), JSON.stringify({ completed: true, model: settings.modelId, version: PROMPT_VERSION,
  targetedDays: selected, periods, actualHttpRequestsThisProcess: httpCalls,
  method: 'Same firsthand facts, updated prompt and removal of prior AI hypotheses; selected counterexamples, not a full rerun or a statistical controlled study. Manual Agent review required.' }, null, 2));
config.apiKey = '';
