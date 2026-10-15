import { mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bodyOf } from '../src/application/archive';
import { parseEvents, mergeEvents } from '../src/storage/events';
import { session } from '../src/storage/projections';
import { questionAnswerPairs } from '../src/ai/context';
import { validateFacts } from '../src/ai/facts';
import { validateWriting, type Source } from '../src/ai/validation';
import { hash, weekday, validDate } from '../src/domain/util';
import { loadSettings } from '../src/domain/settings';
import { Gateway } from '../src/ai/gateway';
import { PROMPT_VERSION, prompts } from '../src/prompts';
// @ts-expect-error Explicit one-vault credential selection, never emitted.
import { localEvalConfig } from './local-eval-config.mjs';

const option = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const vault = option('vault'), date = option('date');
if (!vault || !date || !validDate(date)) throw new Error('Provide an explicit vault and valid date');
const root = resolve('private-rewrites', date); await mkdir(root, { recursive: true });
const diaryPath = resolve(vault, '日记', date.slice(0, 4), date.slice(5, 7), `${date}.md`);
const transcriptPath = resolve(vault, '原始问答', date.slice(0, 4), date.slice(5, 7), `${date}.md`);
const original = await readFile(diaryPath, 'utf8'), transcript = await readFile(transcriptPath, 'utf8'), body = bodyOf(original);
const dataPath = resolve(vault, '原始问答/_数据', date.slice(0, 4), date.slice(5, 7), date);
const events = [];
for (const name of await readdir(dataPath)) if (name.endsWith('.md')) {
  const parsed = parseEvents(await readFile(resolve(dataPath, name), 'utf8'));
  if (parsed.issues.length) throw new Error('Selected day has event recovery issues; original files untouched');
  events.push(...parsed.events);
}
const merged = mergeEvents(events); if (merged.issues.length) throw new Error('Selected day has unresolved events');
const state = session(merged.events, date);
const prepared = merged.events.filter(e => e.sessionKey === `day:${date}` && e.type === 'archive-prepared').at(-1);
const unchanged = !!prepared && bodyOf((prepared.payload as { target: string }).target).trim() === body.trim();
const sources: Source[] = [{ id: 'current-body', kind: 'current-body', text: body }];
// One-off explicitly selected rewrite, not the automatic supplement path.
// Original answers are selectable only if no manual body changes are found.
if (unchanged) sources.push(...state.messages.filter(m => m.role === 'user').map(m => ({ id: m.id, kind: 'new-answer' as const, text: m.text })));
const input = { date, weekday: weekday(date), mode: 'reintegrate', sources, exchanges: unchanged ? questionAnswerPairs(state.messages) : [] };
const metadata = { date, originalDiary: diaryPath, originalTranscript: transcriptPath, originalHash: hash(original), transcriptHash: hash(transcript),
  bodyMatchesLastArchive: unchanged, userAnswers: state.messages.filter(m => m.role === 'user').length, promptVersion: PROMPT_VERSION,
  sourcePolicy: unchanged ? 'Explicit single-day rewrite: current body and original user answers; AI observation excluded' : 'Manual body changes: current body only, old answers not restored',
  privateOutput: true, excludedFromPublicTestPackages: true };
await writeFile(resolve(root, 'input.json'), JSON.stringify({ metadata, input }, null, 2));
await writeFile(resolve(root, 'original.md'), original);
if (process.argv.includes('--prepare-only')) { console.log(JSON.stringify(metadata)); process.exit(0); }

const config = localEvalConfig(vault), settings = loadSettings({ baseUrl: config.baseUrl, modelId: config.modelId });
let task = 'facts', requests = 0;
async function log(row: object) {
  await appendFile(resolve(root, 'api-requests.jsonl'), JSON.stringify({ time: new Date().toISOString(), date, task, promptVersion: PROMPT_VERSION, ...row }).replaceAll(config.apiKey, '[credential omitted]') + '\n');
}
const gateway = new Gateway(() => settings, { get: () => config.apiKey }, async req => {
  ++requests;
  try {
    const response = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(90000) });
    const text = await response.text();
    await log({ request: requests, status: response.status, requestBody: JSON.parse(req.body), response: text });
    return { status: response.status, text: text.replaceAll(config.apiKey, '[credential omitted]') };
  } catch { await log({ request: requests, error: 'network-or-timeout' }); throw new Error('API network/timeout'); }
});
try {
  if (hash(await readFile(diaryPath, 'utf8')) !== metadata.originalHash || hash(await readFile(transcriptPath, 'utf8')) !== metadata.transcriptHash) throw new Error('Source changed; restart selected-day rewrite');
  const rawFacts = await gateway.run('facts', input); await log({ input, output: rawFacts });
  const factDocument = validateFacts(rawFacts, sources);
  await writeFile(resolve(root, 'api-facts.json'), JSON.stringify(factDocument, null, 2));
  task = 'write-natural';
  const writingInput = { ...input, factDocument };
  const rawWriting = await gateway.run('write-natural', writingInput); await log({ input: writingInput, output: rawWriting });
  const writing = validateWriting(rawWriting, sources);
  if (hash(await readFile(diaryPath, 'utf8')) !== metadata.originalHash || hash(await readFile(transcriptPath, 'utf8')) !== metadata.transcriptHash) throw new Error('Source changed; candidate not adopted');
  await writeFile(resolve(root, 'api-rewrite.md'), `# ${date} · 插件API重写预览\n\n${writing.body}\n\n---\n来源：指定日记与同日问答；原文件未覆盖。\n`);
  await writeFile(resolve(root, 'api-result.json'), JSON.stringify({ ...metadata, status: 'complete', requests, model: config.modelId, factDocument, ...writing }, null, 2));
  console.log(JSON.stringify({ date, status: 'complete', requests, output: resolve(root, 'api-rewrite.md') }));
} catch (e) {
  const message = e instanceof Error ? e.message : 'Unknown failure';
  await writeFile(resolve(root, 'api-result.json'), JSON.stringify({ ...metadata, status: 'interrupted', requests, error: message }, null, 2));
  console.log(JSON.stringify({ date, status: 'interrupted', requests, error: message }));
} finally { config.apiKey = ''; }
