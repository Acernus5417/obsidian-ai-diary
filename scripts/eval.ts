import { mkdir, writeFile } from 'node:fs/promises';
import { evalCases, type EvalCase, type EvalTurn } from '../tests/fixtures/evals';
import { MemoryVault } from '../tests/fixtures/helpers';
import { Gateway } from '../src/ai/gateway';
import { DiaryApp } from '../src/application/diary';
import { EventStore } from '../src/storage/store';
import { loadSettings } from '../src/domain/settings';
import { type Message, type ModelPort, type ModelTask, type Style } from '../src/domain/types';
import { type Source } from '../src/ai/validation';
import { PROMPT_VERSION } from '../src/prompts';

// No local config, vault, secret storage or model cache is read by this script.
const real = process.argv.includes('--real');
const option = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const selected = option('case'), runs = Number(option('runs') ?? 1);
if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new Error('--runs must be an integer from 1 to 5');
const cases = evalCases.filter(c => !selected || c.id === selected);
let realHttpRequests = 0, realHttpResponses = 0;
if (!cases.length) throw new Error('No matching evaluation case');
if (real && (!process.env.AI_DIARY_BASE_URL || !process.env.AI_DIARY_MODEL || !process.env.AI_DIARY_API_KEY)) {
  console.error('未请求真实服务。--real 需显式提供 AI_DIARY_BASE_URL / AI_DIARY_MODEL / AI_DIARY_API_KEY。不会读取本机凭据。');
  process.exit(2);
}
interface RecordedCall { task: ModelTask; input: unknown; output?: unknown; errorCode?: string }
interface ConversationInput { topicId: string; trigger: string; messages: Message[] }
/** A deliberately scripted transport fixture. Its language is never scored. */
class ScriptedContracts implements ModelPort {
  turn?: EvalTurn;
  async run(task: ModelTask, input: unknown): Promise<unknown> {
    if (task === 'observations') return { understanding: '', patterns: [] };
    if (task === 'facts') {
      const value = input as { sources: Source[] };
      return { facts: value.sources.map(s => ({ text: s.text, sourceIds: [s.id] })) };
    }
    if (task !== 'conversation') {
      const sources = (input as { sources: Source[] }).sources.filter(s => s.text.trim());
      const rows = sources.flatMap(s => s.text.split(/\n\s*\n/).filter(p => p.trim()).map(paragraph => ({ paragraph, sourceIds: [s.id] })));
      return { bodyMarkdown: rows.map(r => r.paragraph).join('\n\n'), sourceMap: rows };
    }
    const data = input as ConversationInput, turn = this.turn!;
    const user = [...data.messages].reverse().find(m => m.role === 'user');
    const ids = user ? [user.id] : [];
    const broad = ['recall', 'broaden'].includes(turn.intent);
    const momentId = broad ? null : `eval-${turn.moment}`;
    const noteRows = (turn.notes ?? []).map(n => ({ ...n, sourceId: user?.id, when: n.when ?? 'unspecified' }));
    return {
      action: turn.question ? (turn.intent === 'broaden' ? 'transition' : 'ask') : 'acknowledge',
      text: turn.response ?? '', question: turn.question, topicId: data.topicId,
      threadId: null,
      thread: turn.threadAlias && user ? { title: turn.threadAlias, aliases: [turn.threadAlias], sourceIds: ids } : null,
      reflection: { intent: turn.intent, dimension: turn.dimension, momentId, sourceIds: ids },
      moments: user && turn.text && !broad ? [{ id: momentId, title: user.text.slice(0, 30), sourceIds: ids, notes: noteRows }] : []
    };
  }
}
class Recorder implements ModelPort {
  calls: RecordedCall[] = [];
  constructor(readonly inner: ModelPort) {}
  async run(task: ModelTask, input: unknown, valid?: () => boolean): Promise<unknown> {
    const call: RecordedCall = { task, input }; this.calls.push(call);
    try { call.output = await this.inner.run(task, input, valid); return call.output; }
    catch (e) { call.errorCode = typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : 'request_failed'; throw e; }
  }
}
type JsonObject = Record<string, unknown>;
function object(x: unknown): JsonObject { return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as JsonObject : {}; }
function asText(x: unknown): string { return typeof x === 'string' ? x : ''; }
interface TurnResult {
  index: number; trigger: string; user: string; contractPassed: boolean; error?: string;
  assistant?: string; reflection?: unknown; rawOutput?: unknown;
  reviewFlags: string[];
}
interface Metric { status: 'pending-human-review'; observations: string[] }
const metricsFor = (turns: TurnResult[], calls: RecordedCall[]): Record<string, Metric> => {
  const replies = turns.map(t => object(t.rawOutput)), decisions = replies.map(r => object(r.reflection));
  const questionCount = replies.filter(r => asText(r.question)).length;
  const pauseCount = replies.filter(r => r.action === 'acknowledge').length;
  const anchored = decisions.filter(r => Array.isArray(r.sourceIds) && r.sourceIds.length > 0).length;
  const allMoments = new Set(calls.filter(c => c.task === 'conversation').flatMap(c => {
    const map = object(object(c.input).dayMap); return Array.isArray(map.moments) ? map.moments.map(m => asText(object(m).id)) : [];
  }));
  const pending = (observations: string[]): Metric => ({ status: 'pending-human-review', observations });
  return {
    specificity: pending([`${anchored}/${decisions.length} 轮带来源 ID；这不证明问句与材料存在语义联系。`]),
    newInformation: pending(['逐轮比较问题目标与此前答案。新增消息数、情绪词数量均不作为新信息质量分。']),
    burden: pending([`${questionCount} 轮有问题，${pauseCount} 轮只回应；问句长度与问数仅供定位，不能证明轻松。`]),
    wholeDay: pending([`模型输入曾包含 ${allMoments.size} 个不同来源片段标识；需复核是否自然拓宽并连接体验变化。`]),
    restraint: pending([`共有 ${turns.reduce((n, t) => n + t.reviewFlags.length, 0)} 条词面复核提示；零提示不等于没有预设或过度解读。`]),
    agency: pending([`${turns.filter(t => t.trigger === 'continue').length} 次主动继续；复核纠正、停止、换向是否被尊重。`])
  };
};
async function evaluate(c: EvalCase, style: Style, run: number) {
  const settings = loadSettings({
    namespace: 'synthetic-eval', style,
    baseUrl: real ? process.env.AI_DIARY_BASE_URL : 'https://example.invalid/v1',
    modelId: real ? process.env.AI_DIARY_MODEL : 'scripted-contract-fixture',
    historyEnabled: !!c.history?.length, allowedPaths: c.history?.map(h => h.path) ?? []
  });
  const scripted = new ScriptedContracts();
  const model = new Recorder(real ? new Gateway(() => settings, { get: () => process.env.AI_DIARY_API_KEY ?? null }, async r => {
    ++realHttpRequests;
    const response = await fetch(r.url, { method: 'POST', headers: r.headers, body: r.body });
    ++realHttpResponses;
    return { status: response.status, text: await response.text() };
  }) : scripted);
  const vault = new MemoryVault();
  for (const h of c.history ?? []) vault.files.set(h.path, h.text);
  vault.files.set('未授权资料/不可读取.md', 'SYNTHETIC_PRIVATE_SENTINEL');
  const store = new EventStore(vault, settings.transcriptFolder, `eval-${c.id}-${style}-${run}`);
  const app = new DiaryApp(store, model, () => settings); app.date = '2026-10-12';
  await app.refresh();
  const turns: TurnResult[] = [];
  for (const [index, turn] of c.turns.entries()) {
    scripted.turn = turn;
    const before = model.calls.length;
    if (turn.trigger === 'continue') await app.reply('continue');
    else if (turn.trigger === 'skip') await app.skip();
    else await app.send(turn.text);
    const call = model.calls.slice(before).find(call => call.task === 'conversation');
    const reply = object(call?.output);
    const display = [asText(reply.text), asText(reply.question)].filter(Boolean).join('\n\n');
    turns.push({
      index: index + 1, trigger: turn.trigger ?? 'answer', user: turn.text,
      contractPassed: !!call && !app.error, error: app.error || call?.errorCode,
      assistant: display, reflection: reply.reflection, rawOutput: call?.output,
      reviewFlags: c.forbidden.filter(word => display.includes(word)).map(word => `词面命中「${word}」，需在语境中人工判断。`)
    });
    if (c.editAfter?.turn === index + 1) {
      await app.generate();
      if (app.error || !app.state.draft) break;
      await app.editDraft(c.editAfter.body, '');
    }
  }
  const beforeWriting = model.calls.length;
  await app.generate(c.editAfter ? 'reintegrate' : 'initial');
  const finalCalls = model.calls.slice(beforeWriting);
  const writingCall = finalCalls.find(c => c.task === 'write-natural' || c.task === 'write-narrative');
  const writing = object(writingCall?.output), sources = (object(writingCall?.input).sources ?? []) as Source[];
  const bannedBody = c.forbidden.filter(word => asText(writing.bodyMarkdown).includes(word));
  const privateRead = vault.reads.some(p => p.startsWith('未授权资料/'));
  const deletionResurrected = !!c.editAfter && sources.some(s => c.forbidden.some(word => s.text.includes(word)));
  const deletionRestoredInOutput = !!c.editAfter && bannedBody.length > 0;
  const writingPassed = !!writingCall && !app.error && !!app.state.draft;
  return {
    case: c.id, title: c.title, style, run, reviewFocus: c.review,
    contractPassed: turns.length === c.turns.length && turns.every(t => t.contractPassed) && writingPassed && !privateRead && !deletionResurrected && !deletionRestoredInOutput,
    turns, writing: { contractPassed: writingPassed, error: app.error || undefined, body: writing.bodyMarkdown, sourceMap: writing.sourceMap,
      sourceIds: sources.map(s => s.id), forbiddenContentReview: bannedBody, deletionResurrected, deletionRestoredInOutput },
    permissionBoundary: { privateFileRead: privateRead },
    orthogonalMetrics: metricsFor(turns, model.calls),
    humanReview: { status: 'pending', scores: null, accepted: false },
    trace: model.calls
  };
}
const results: Awaited<ReturnType<typeof evaluate>>[] = [];
for (const c of cases) for (const style of ['natural', 'narrative'] as const) for (let run = 1; run <= runs; run++) {
  results.push(await evaluate(c, style, run));
  console.log(`${real ? '真实服务' : '合成契约'} ${c.id} ${style} ${run}: ${results.at(-1)!.contractPassed ? 'contract passed' : 'contract failed'}；体验待人工复核。`);
}
const output = real ? 'eval-real' : 'eval-contract';
await mkdir('test-results', { recursive: true });
const report = {
  schemaVersion: 2, mode: real ? 'real-service-contract-with-pending-human-review' : 'scripted-multi-turn-contract-checks',
  realModelExecuted: real && results.some(r => r.trace.some(call => call.output !== undefined)),
  realHttpRequests, realHttpResponses, subjectiveExperienceAccepted: false,
  model: real ? process.env.AI_DIARY_MODEL : 'scripted-contract-fixture', promptVersion: PROMPT_VERSION,
  timestamp: new Date().toISOString(), scenarioCount: cases.length, runs, results,
  limitations: [
    '默认输出为手工编写的合成契约样例，不能证明问题有趣、有新信息或更愿意表达。',
    '真实模式是固定用户多轮回放，用户回答不会随模型提问变化；需人工复核对话衔接，不能替代真人试用。',
    '词面提示不是语义忠实证明。六个体验维度没有由模型自评或规则自动给分。',
    '只有合成内存仓库与标准 HTTP；不代表实际 Obsidian、Android、官方 Sync 已验收。'
  ]
};
await writeFile(`test-results/${output}.json`, JSON.stringify(report, null, 2), 'utf8');
// Retain the historic report path for tooling, without retaining its old meaning.
await writeFile('test-results/eval.json', JSON.stringify(report, null, 2), 'utf8');
const review = [
  '# 问答体验人工复核表', '', `模式：${report.mode}。提示词版本：${PROMPT_VERSION}。`,
  '每项 1–5 分；未阅读实际逐轮文本时留空。每项记录具体回合证据，不平均掩盖越界。',
  '合成契约模式的文本来自手工脚本，不能用它宣称真实模型质量通过。', ''
];
for (const r of results) review.push(`## ${r.case} / ${r.style} / ${r.run}`, '', r.reviewFocus, '',
  '| 维度 | 分数（待填写） | 回合与依据 |', '| --- | --- | --- |',
  ...['具体性', '新信息', '轻负担', '全天视野', '克制', '自主性'].map(d => `| ${d} | | |`), '',
  '硬失败复核：编造事实或情绪 / 忽视明确拒绝 / 历史写成今日 / 恢复已删正文 / 越权读取。',
  '日记回看价值与本人语气：待真人试用。', '最终结论：待人工复核。', '');
await writeFile(`test-results/${output}-review.md`, review.join('\n'), 'utf8');
const passed = results.filter(r => r.contractPassed).length;
console.log(`${passed}/${results.length} 个场景×风格×轮次契约通过；六维体验均待人工复核。报告：test-results/${output}.json`);
if (passed !== results.length) process.exitCode = 1;
