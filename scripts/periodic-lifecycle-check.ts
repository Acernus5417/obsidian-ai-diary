import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DiskVault } from './fiction-vault';
import { DiaryApp } from '../src/application/diary';
import { EventStore } from '../src/storage/store';
import { loadSettings } from '../src/domain/settings';
import { dayPath, ensureParent } from '../src/domain/util';
import { bodyOf } from '../src/application/archive';
import { type ModelPort } from '../src/domain/types';

// Actual file lifecycle journey. A model must not be contacted after shutdown.
const root = resolve('test-results/two-months-functional'); await mkdir(root, { recursive: true });
const vault = new DiskVault(resolve(root, `lifecycle-${Date.now()}`)); await vault.load();
const s = loadSettings({ namespace: 'lifecycle-fiction', historyEnabled: true, allowedPaths: ['日记'], periodicEnabled: true });
for (let i = 1; i <= 4; i++) {
  const path = dayPath(s.diaryFolder, `2026-07-${String(i).padStart(2, '0')}`);
  await ensureParent(vault, path); await vault.create(path, await readFile(resolve('test-results/two-months/vault', path), 'utf8'));
}
let modelCalls = 0;
const monitor: ModelPort = { async run() { ++modelCalls; throw new Error('No new model operation should begin after shutdown'); } };
const store = new EventStore(vault, s.transcriptFolder, 'lifecycle-agent'), app = new DiaryApp(store, monitor, () => s);
const date = '2026-07-05'; await app.open(date);
const actual = JSON.parse(await readFile('test-results/two-months/days/2026-07-05.json', 'utf8'));
for (const m of actual.dialogue) await store.append(date, m.role === 'user' ? 'user-message' : 'assistant-message', m);
await store.append(date, 'draft-generated', { id: 'lifecycle-draft', body: actual.body, observations: actual.observations, baseHash: null,
  consumedIds: actual.dialogue.filter((m: { role: string }) => m.role === 'user').map((m: { id: string }) => m.id), mode: 'initial',
  sourceMap: actual.sourceMap, diaryPath: dayPath(s.diaryFolder, date), transcriptPath: dayPath(s.transcriptFolder, date) });
await app.refresh();
const create = vault.create.bind(vault);
vault.create = async (path, text) => { await create(path, text); if (path === dayPath(s.diaryFolder, date)) app.shutdown(); };
await app.save();
assert.equal(app.error, ''); assert.equal(modelCalls, 0);
assert.equal(bodyOf((await vault.read(dayPath(s.diaryFolder, date)))!), actual.body);
assert.ok((await vault.read(dayPath(s.transcriptFolder, date)))?.includes(actual.dialogue[0].text));
assert.ok(app.state.archivedDraftIds.includes('lifecycle-draft')); assert.equal(app.state.pending.length, 0);
await app.reviewPeriods(date); await app.reply(); assert.equal(modelCalls, 0);
await app.input('关闭前尚未发送的输入仍可刷写'); assert.equal(app.state.input, '关闭前尚未发送的输入仍可刷写');
const result = { passed: true, realFilesystem: true, archivedDiaryAndTranscriptPreserved: true, transactionCompleted: true,
  postShutdownModelCalls: modelCalls, unsentInputFlushPreserved: true, limitation: 'Controlled application shutdown during actual file archive; not a real Obsidian process shutdown.' };
await writeFile(resolve(root, 'lifecycle-report.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
