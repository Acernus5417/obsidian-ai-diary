import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DiskVault } from './fiction-vault';
import { Gateway } from '../src/ai/gateway';
import { PeriodicService } from '../src/application/periodic';
import { loadSettings } from '../src/domain/settings';
import { DiaryError, type ModelPort } from '../src/domain/types';
import { ensureParent, hash } from '../src/domain/util';
// @ts-expect-error Authorized local credential reader; no key output.
import { localEvalConfig } from './local-eval-config.mjs';

const root = resolve('test-results/two-months-functional'); await mkdir(root, { recursive: true });
const vault = new DiskVault(resolve(root, `calendar-${Date.now()}`)); await vault.load();
const config = localEvalConfig(), settings = loadSettings({ namespace: 'calendar-fiction', baseUrl: config.baseUrl, modelId: config.modelId,
  periodicEnabled: true, historyEnabled: true, allowedPaths: ['日记'] });
for (let i = 1; i <= 5; i++) {
  const path = `日记/2026/07/2026-07-${String(i).padStart(2, '0')}.md`;
  await ensureParent(vault, path); await vault.create(path, await readFile(resolve('test-results/two-months/vault', path), 'utf8'));
}
let requests = 0, scenario = '';
const gateway = new Gateway(() => settings, { get: () => config.apiKey }, async request => {
  const number = ++requests;
  try {
    const response = await fetch(request.url, { method: 'POST', headers: request.headers, body: request.body, signal: AbortSignal.timeout(90000) });
    const text = await response.text();
    await appendFile(resolve(root, 'calendar-requests.jsonl'), JSON.stringify({ number, scenario, status: response.status, input: JSON.parse(request.body), responseHash: hash(text) }) + '\n');
    return { status: response.status, text };
  } catch { await appendFile(resolve(root, 'calendar-requests.jsonl'), JSON.stringify({ number, scenario, error: 'network-or-timeout' }) + '\n'); throw new DiaryError('network', '日历场景服务请求未完成。'); }
});
const model: ModelPort = { async run(task, input, valid) {
  for (let i = 0; ; i++) {
    try { const output = await gateway.run(task, input, valid); await appendFile(resolve(root, 'calendar-outputs.jsonl'), JSON.stringify({ scenario, task, input, output }) + '\n'); return output; }
    catch (e) { if (i >= 2 || !(e instanceof DiaryError) || !['network', 'timeout', 'service', 'rate'].includes(e.code)) throw e; }
  }
} };
const service = new PeriodicService(vault, model, () => settings), results = [];
scenario = 'opening-on-sunday-before-end-of-day';
assert.deepEqual(await service.generateDue('2026-07-05'), []); assert.equal(requests, 0);
results.push({ scenario, passed: true, requests: 0 });
scenario = 'confirmed-end-day-archive';
const weekly = await service.generateDue('2026-07-05', () => true, () => {}, true);
assert.equal(weekly.length, 1); assert.ok(weekly[0]!.path.startsWith('周记/'));
results.push({ scenario, passed: true, path: weekly[0]!.path });
scenario = 'opening-on-month-end-before-recording';
const before = requests;
assert.deepEqual(await service.generateDue('2026-07-31'), []); assert.equal(requests, before);
results.push({ scenario, passed: true, additionalRequests: 0 });
scenario = 'confirmed-month-end-archive';
const monthly = await service.generateDue('2026-07-31', () => true, () => {}, true);
assert.equal(monthly.length, 1); assert.ok(monthly[0]!.path.startsWith('月记/'));
assert.ok((await vault.read(monthly[0]!.path))?.includes('5/31 天'));
results.push({ scenario, passed: true, path: monthly[0]!.path, missingDatesNotInvented: true });
scenario = 'next-day-catch-up-without-end-day-signal';
settings.monthlyFolder = '次日补生成月记';
const caughtUp = await service.generateDue('2026-08-01');
assert.equal(caughtUp.length, 1); assert.ok(caughtUp[0]!.path.startsWith('次日补生成月记/'));
results.push({ scenario, passed: true, path: caughtUp[0]!.path });
await writeFile(resolve(root, 'calendar-report.json'), JSON.stringify({ passed: true, actualHttpRequests: requests, model: config.modelId, results,
  limitation: 'Explicit virtual dates and actual API/file operations, not an operating-system scheduled background service.' }, null, 2));
config.apiKey = ''; console.log(JSON.stringify({ passed: true, cases: results.length, actualHttpRequests: requests }));
