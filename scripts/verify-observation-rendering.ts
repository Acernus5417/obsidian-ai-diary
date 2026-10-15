import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateObservations } from '../src/ai/validation';
import { bodyOf } from '../src/application/archive';
import { OBS_START, OBS_END } from '../src/memory/retrieval';
import { hash } from '../src/domain/util';
import { life } from '../tests/fixtures/two-month-life';

// Actual saved-output verification, no API, unit framework or semantic rewrite.
const root = resolve('test-results/two-months');
const rows = (await readFile(resolve(root, 'requests.jsonl'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
const normalize = (text: string) => text.trim().replace(/^(?:(?:#{1,6}\s*AI\s*观察|可能的理解[：:])\s*)+/, '可能的理解：');
const checked: { date: string; outputHash: string; headingNormalized: boolean }[] = [];
for (const day of life) {
  const file = resolve(root, 'days', `${day.date}.json`);
  const saved = await readFile(file, 'utf8'), result = JSON.parse(saved);
  assert.equal(result.observationPromptVersion, '3.0.3');
  const next = normalize(result.observations);
  const candidates = rows.filter(r => r.task === 'observations' && r.input?.date === day.date && r.output && r.promptVersion === '3.0.3');
  const call = candidates.reverse().find(r => {
    try { return validateObservations(r.output, r.input.evidence) === next; } catch { return false; }
  });
  assert.ok(call, `No actual observation output matching ${day.date}`);
  const path = resolve(root, 'vault/日记', day.date.slice(0, 4), day.date.slice(5, 7), `${day.date}.md`);
  const raw = await readFile(path, 'utf8'), beforeBody = bodyOf(raw);
  const changed = next !== result.observations;
  if (changed) {
    const backup = resolve(root, 'variants/format-before'); await mkdir(backup, { recursive: true });
    try { await writeFile(resolve(backup, `${day.date}.json`), saved, { flag: 'wx' }); }
    catch (e) { if ((e as { code?: string }).code !== 'EEXIST') throw e; }
    const os = raw.indexOf(OBS_START), oe = raw.indexOf(OBS_END);
    assert.ok(os >= 0 && oe > os);
    const updated = raw.slice(0, os) + `${OBS_START}\n## AI 观察\n\n${next}\n` + raw.slice(oe);
    assert.equal(bodyOf(updated), beforeBody);
    await writeFile(path, updated, 'utf8');
    result.observations = next;
    await writeFile(file, JSON.stringify(result, null, 2), 'utf8');
  }
  checked.push({ date: day.date, outputHash: hash(JSON.stringify(call.output)), headingNormalized: changed });
}
const report = { passed: true, actualRecordedOutputsChecked: checked.length, semanticRewrite: false,
  originalDiariesUnchanged: true, normalizedDays: checked.filter(r => r.headingNormalized).map(r => r.date), checked };
await writeFile(resolve(root, 'formatted-output-check.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ ...report, checked: undefined }));
