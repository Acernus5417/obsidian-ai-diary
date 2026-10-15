import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateObservations, validateWriting } from '../src/ai/validation';

const root = resolve('test-results/two-months-targeted');
const phases = [root, resolve(root, 'negation-3-0-5')];
const checked = [], http = [];
for (const phase of phases) {
  const rows = (await readFile(resolve(phase, 'requests.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
  http.push(...rows.filter(r => 'http' in r));
  for (const name of await readdir(resolve(phase, 'days'))) {
    if (!name.endsWith('.json')) continue;
    const r = JSON.parse(await readFile(resolve(phase, 'days', name), 'utf8'));
    const baseline = JSON.parse(await readFile(resolve('test-results/two-months/days', name), 'utf8'));
    const { previousInterpretations: _oldHypotheses, ...facts } = baseline.observationInput;
    assert.deepEqual(r.input, facts);
    assert.ok(!('previousInterpretations' in r.input));
    assert.ok(r.input.evidence.every((e: any) => e.date < r.date));
    assert.ok(rows.some(call => {
      if (call.task !== 'observations' || call.date !== r.date || !call.output) return false;
      try { return validateObservations(call.output, call.input.evidence) === r.observation; } catch { return false; }
    }));
    checked.push({ date: r.date, version: r.version });
  }
}
assert.equal(checked.filter(r => r.version === '3.0.4').length, 14);
assert.equal(checked.filter(r => r.version === '3.0.5').length, 4);
const other = await readdir(resolve(root, 'other'));
assert.equal(other.filter(p => p.endsWith('.json')).length, 3);
const writing = JSON.parse(await readFile(resolve(root, 'other/2026-08-05-write-natural.json'), 'utf8'));
validateWriting(writing.output, writing.input.sources);
const periods = [];
for (const folder of ['周记', '月记']) {
  for (const name of await readdir(resolve(root, 'vault', folder, '2026'))) {
    const note = await readFile(resolve(root, 'vault', folder, '2026', name), 'utf8');
    assert.ok(note.includes('<!-- ai-diary-prompt:3.0.4 -->'));
    assert.ok(!/\bp-[a-f0-9]{16}\b/.test(note));
    periods.push(`${folder}/2026/${name}`);
  }
}
assert.equal(periods.length, 4);
const report = { passed: true, checkedObservationRuns: checked, sameFirsthandFactsVerified: true, oldAIHypothesesExcluded: true,
  actualRecordedModelOutputsMatched: true, otherRuns: other.filter(p => p.endsWith('.json')), periods,
  actualRecordedHttpRequests: http.length, successfulHttp: http.filter(r => r.status >= 200 && r.status < 300).length,
  failedHttpRetained: http.filter(r => !(r.status >= 200 && r.status < 300)).map(r => ({ date: r.date, task: r.task, status: r.status, error: r.error })),
  limitation: 'Artifact/source/format checks only. Semantic quality and regression limitations are in AGENT-REVIEW.md.' };
await writeFile(resolve(root, 'integrity.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ ...report, checkedObservationRuns: checked.length, periods: periods.length, otherRuns: other.length }));
