import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { coherenceCases, questionCases } from '../tests/fixtures/coherence';
import { validateFacts } from '../src/ai/facts';
import { validateWriting } from '../src/ai/validation';
import { bodyOf } from '../src/application/archive';
import { prompts } from '../src/prompts';

// Independent actual-artifact/provenance check; no model call or semantic score.
const root = resolve('test-results/coherence');
const rows = (await readFile(resolve(root, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const questionPrompt = JSON.parse(await readFile(resolve(root, 'prompts-4.0.1.json'), 'utf8')).prompts.conversation;
assert.equal(questionPrompt, prompts.conversation);
const observations = [], questions = [];
for (const f of coherenceCases) {
  const r = JSON.parse(await readFile(resolve(root, 'writing', `${f.id}.json`), 'utf8'));
  assert.equal(r.status, 'complete');
  const call = rows.find(c => c.caseId === f.id && c.version === r.version && c.variant === 'revised' && c.output && ['write-natural', 'write-narrative'].includes(c.task) && c.output.bodyMarkdown === r.revised.body);
  assert.ok(call, f.id);
  const parsed = validateWriting(call.output, call.input.sources);
  assert.deepEqual(parsed.sourceMap, r.revised.sourceMap);
  assert.equal(parsed.sourceMapScope, r.revised.sourceMapScope);
  assert.ok(call.input.exchanges.every((e: any) => call.input.sources.some((s: any) => s.id === e.answerId && s.text === e.answer)));
  const facts = rows.find(c => c.caseId === f.id && c.version === r.version && c.variant === 'revised' && c.task === 'facts' && c.output && JSON.stringify(validateFacts(c.output, c.input.sources)) === JSON.stringify(r.revised.factDocument));
  assert.ok(facts, `${f.id} facts`);
  assert.deepEqual(call.input.factDocument, r.revised.factDocument);
  if (f.baseBody) assert.ok(rows.filter(c => c.caseId === f.id && c.variant === 'revised' && c.input).every(c => !JSON.stringify(c.input).includes('DELETED_DETAIL')));
  const formal = await readFile(resolve(root, 'vaults', r.version, f.id, `日记/${r.date.slice(0, 4)}/${r.date.slice(5, 7)}/${r.date}.md`), 'utf8');
  assert.equal(bodyOf(formal), r.revised.finalDiary);
  if (f.mode === 'append') assert.ok(bodyOf(formal).startsWith(f.baseBody!));
  observations.push({ caseId: f.id, version: r.version, factCount: r.revised.factDocument.facts.length, sourceScope: r.revised.sourceMapScope });
  const qa = f.pairs.map(([q, a]) => `预编问题：${q}\n\n预编回答：${a}`).join('\n\n');
  await writeFile(resolve(root, 'writing', `${f.id}.md`), `# ${f.id}\n\n输入问答预先编写、全部虚构；事实整理与旧新成文来自实际API。旧版3.0.5；新版${r.version}。\n\n## 输入问答\n\n${qa}\n\n## 旧正文\n\n${r.baseline.body}\n\n## 事实文档\n\n${r.revised.factDocument.facts.map((e: any) => `- ${e.text}（${e.sourceIds.join('、')}）`).join('\n')}\n\n篇章建议：${r.revised.factDocument.writingBrief ?? '无'}\n\n## 新正文\n\n${r.revised.body}\n\n事实文档、原问答、实际请求与完整来源在同名JSON。全文sourceIds是整篇范围，不能误当逐段精确证明。\n`);
}
for (const f of questionCases) {
  const r = JSON.parse(await readFile(resolve(root, 'questions', `${f.id}.json`), 'utf8'));
  assert.equal(r.status, 'complete'); assert.ok(r.revised.trim());
  assert.ok(rows.some(c => c.caseId === f.id && c.version === r.version && c.variant === 'revised' && c.task === 'conversation' && typeof c.output === 'string' && c.output.trim() === r.revised));
  questions.push({ caseId: f.id, version: r.version });
  await writeFile(resolve(root, 'questions', `${f.id}.md`), `# ${f.id}\n\n原问题：${f.prior}\n\n用户：${f.answer}\n\n## 旧版\n\n${r.baseline}\n\n## ${r.version}\n\n${r.revised}\n`);
}
const http = rows.filter(c => 'requestId' in c), versions = [...new Set(http.map(c => c.version))];
const report = { passed: true, checkedDiaries: observations.length, checkedQuestionComparisons: questions.length,
  actualRecordedOutputsMatched: true, factDocumentsAndQuestionsPresent: true, knownSourceIdsOnly: true, editedContentNotResurrected: true, appendPrefixPreserved: true, conversationPromptMatchesCurrent: true,
  diaries: observations, questions, actualRecordedHttpRequests: http.length, successfulHttp: http.filter(c => c.status >= 200 && c.status < 300).length,
  versions: versions.map(version => ({ version, requests: http.filter(c => c.version === version).length })),
  failedHttpRetained: http.filter(c => !(c.status >= 200 && c.status < 300)).map(c => ({ version: c.version, caseId: c.caseId, task: c.task, status: c.status, error: c.error })),
  finalPromptCandidate: '4.0.3', finalPromptCandidateActualRun: 'HTTP429 prevented completion; not counted among completed diary samples',
  semanticQuality: 'Not proved by these checks. See REVIEW.md for actual language, factual and question-value review.' };
await writeFile(resolve(root, 'integrity.json'), JSON.stringify(report, null, 2));
const index = ['# 十篇日记真实对照输出', '', '同一10个虚构样本，含两种文风、追加与编辑，不是全量月级测试。10篇成功记录来自4.0.2；8个提问对照来自4.0.1。代码最终候选4.0.3因HTTP429未完成实测，失败单独保留。', '',
  '- [复核与评分](REVIEW.md)', '- [结构/出处与请求计数](integrity.json)', '- [全部真实请求/响应及失败](requests.jsonl)', '', '## 日记', '',
  ...coherenceCases.map(f => `- [${f.id} · 问答/事实文档/旧新正文](writing/${f.id}.md) · [JSON](writing/${f.id}.json)`), '', '## 提问', '',
  ...questionCases.map(f => `- [${f.id}](questions/${f.id}.md) · [JSON](questions/${f.id}.json)`), '', '## 文件与版本', '',
  '- fixtures.json：实际输入样本与复核关注点；关注点不给模型作答案。', '- prompts-*.json、baseline-prompts-3.0.5.json：实际提示词。', '- variants：改前版本与4.0.3限流失败，不人工润色模型输出。', '- vaults：实际磁盘事件/问答/日记；不是用户真实仓库。', '- questions-vault：实际应用提问事件，包括原问题、用户话语、回应。', '- HTTP内容保留消息和响应，凭据在内存使用并作日志脱敏，不保存请求头。', ''];
await writeFile(resolve(root, 'README.md'), index.join('\n'));
console.log(JSON.stringify({ ...report, diaries: undefined, questions: undefined, semanticQuality: undefined }));
