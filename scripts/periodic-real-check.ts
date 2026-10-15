import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Gateway } from '../src/ai/gateway';
import { PeriodicService, periodFor, periodPath } from '../src/application/periodic';
import { BODY_END } from '../src/application/archive';
import { DiaryError, type ModelPort } from '../src/domain/types';
import { loadSettings } from '../src/domain/settings';
import { ensureParent, hash } from '../src/domain/util';
import { DiskVault } from './fiction-vault';
// @ts-expect-error Authorized local credential reader; no key output.
import { localEvalConfig } from './local-eval-config.mjs';

// Real-file functional fault journeys; no unit/performance test or mock insight.
const root = resolve('test-results/two-months-functional'); await mkdir(root, { recursive: true });
const vault = new DiskVault(resolve(root, `vault-${Date.now()}`), true); await vault.load();
const config = localEvalConfig(), s = loadSettings({ namespace: 'fiction-functional', baseUrl: config.baseUrl, modelId: config.modelId,
  historyEnabled: true, allowedPaths: ['日记'], periodicEnabled: true });
const paths = Array.from({ length: 5 }, (_, i) => `日记/2026/07/2026-07-${String(i + 1).padStart(2, '0')}.md`);
for (const path of paths) {
  await ensureParent(vault, path); await vault.create(path, await readFile(resolve('test-results/two-months/vault', path), 'utf8'));
}
await ensureParent(vault, '未授权/私密.md'); await vault.create('未授权/私密.md', 'SYNTHETIC_PRIVATE_LONGITUDINAL_CANARY');
vault.reads.length = 0;
let requests = 0, purpose = '', afterResponse: (() => Promise<void>) | undefined;
const gateway = new Gateway(() => s, { get: () => config.apiKey }, async request => {
  assert.equal(request.body.includes('SYNTHETIC_PRIVATE_LONGITUDINAL_CANARY'), false);
  const response = await fetch(request.url, { method: 'POST', headers: request.headers, body: request.body, signal: AbortSignal.timeout(90000) });
  ++requests;
  const text = await response.text();
  await appendFile(resolve(root, 'requests.jsonl'), JSON.stringify({ time: new Date().toISOString(), purpose, status: response.status, input: JSON.parse(request.body), responseHash: hash(text) }) + '\n');
  return { status: response.status, text };
});
const model: ModelPort = { async run(task, input, valid) {
  let output;
  for (let i = 0; ; i++) {
    try { output = await gateway.run(task, input, valid); break; }
    catch (e) { if (i >= 2 || !(e instanceof DiaryError) || !['service', 'rate', 'timeout', 'network'].includes(e.code)) throw e; }
  }
  await appendFile(resolve(root, 'outputs.jsonl'), JSON.stringify({ purpose, task, input, output }) + '\n');
  if (afterResponse) await afterResponse(); return output;
} };
const service = new PeriodicService(vault, model, () => s), period = periodFor('2026-07-05', 'week');
const results: unknown[] = [];
purpose = 'concurrent-real-generation';
const concurrent = await Promise.all([service.generate(period), service.generate(period)]);
assert.equal(concurrent.length, 2); assert.equal(concurrent.filter(r => r.alternate).length, 1);
const primary = periodPath(period, s); assert.notEqual(await vault.read(primary), null);
assert.notEqual(await vault.read(concurrent.find(r => r.alternate)!.path), null);
results.push({ case: purpose, passed: true, outputs: concurrent });
purpose = 'manual-edit-and-idempotency';
await vault.process(primary, text => text + '\n人工补充：这个理解我还想再观察几天。\n');
const edited = await vault.read(primary), count = requests;
await service.generateDue('2026-07-05'); await service.generate(period);
assert.equal(await vault.read(primary), edited); assert.equal(requests, count);
results.push({ case: purpose, passed: true, additionalRequests: 0, userEditPreserved: true });
purpose = 'source-change-in-flight'; s.weeklyFolder = '资料变化周记';
afterResponse = async () => { await vault.process(paths[0]!, text => text.replace(BODY_END, `补记：保留一句新的想法。\n${BODY_END}`)); };
await assert.rejects(service.generate(period), (e: unknown) => e instanceof DiaryError && e.code === 'stale');
assert.equal(await vault.read(periodPath(period, s)), null);
results.push({ case: purpose, passed: true, staleResultNotPublished: true });
purpose = 'authorization-revoked-in-flight'; s.weeklyFolder = '撤销授权周记';
afterResponse = async () => { s.historyEnabled = false; };
await assert.rejects(service.generate(period), (e: unknown) => e instanceof DiaryError && e.code === 'stale');
assert.equal(await vault.read(periodPath(period, s)), null);
results.push({ case: purpose, passed: true, revokedResultNotPublished: true });
afterResponse = undefined;
purpose = 'permission-disabled';
const before = requests;
await assert.rejects(service.generateDue('2026-07-05'), (e: unknown) => e instanceof DiaryError && e.code === 'permission');
s.periodicEnabled = false; assert.deepEqual(await service.generateDue('2026-07-05'), []);
assert.equal(requests, before); assert.equal(vault.reads.includes('未授权/私密.md'), false);
results.push({ case: purpose, passed: true, noRequests: true, unauthorizedFileNotRead: true });
await writeFile(resolve(root, 'report.json'), JSON.stringify({ fictionalOnly: true, model: config.modelId, actualHttpRequests: requests, results,
  limitation: 'Two local concurrent generators and controlled source/config changes; not real Obsidian Sync or Android.' }, null, 2));
config.apiKey = ''; console.log(JSON.stringify({ passed: true, cases: results.length, actualHttpRequests: requests, artifacts: root }));
