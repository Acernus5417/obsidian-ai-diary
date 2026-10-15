import { DiaryScreen } from '../../src/ui/screen';
import { fixture } from './helpers';
const f = fixture(); await f.app.refresh();
const replay = new URLSearchParams(location.search).get('replay');
if (replay) {
  // Rendering replay of real API output from fictional material, no live API or
  // credential access in the browser. The service journey runs in real-recall.ts.
  const report = await fetch('/real-result.json').then(r => r.json());
  const result = report.results.find((r: { id: string }) => r.id === replay);
  if (!result?.diary) throw new Error('No completed fictional replay');
  await f.app.open(result.date ?? '2026-10-13');
  if (report.longitudinal) {
    f.s.periodicEnabled = true; f.s.historyEnabled = true; f.s.allowedPaths = ['日记'];
    for (const [path, text] of Object.entries(report.files)) f.vault.files.set(path, String(text));
    f.app.reviewFiles = report.reviews;
  }
  const userIds: string[] = [];
  for (const [index, m] of result.dialogue.entries()) {
    const id = `replay-${index}`;
    if (m.role === 'user') userIds.push(id);
    await f.store.append(f.app.date, m.role === 'user' ? 'user-message' : 'assistant-message', {
      id, role: m.role, text: m.text, topicId: 'daily', historyEvidence: [], createdAt: new Date().toISOString()
    });
  }
  await f.store.append(f.app.date, 'draft-generated', { id: 'replay-draft', body: result.diary, observations: result.observations ?? '',
    baseHash: null, consumedIds: userIds, mode: 'initial', sourceMap: [{ paragraph: result.diary, sourceIds: userIds }],
    diaryPath: `日记/${f.app.date.slice(0,4)}/${f.app.date.slice(5,7)}/${f.app.date}.md`, transcriptPath: `原始问答/${f.app.date.slice(0,4)}/${f.app.date.slice(5,7)}/${f.app.date}.md` });
  await f.app.refresh();
}
new DiaryScreen(document.querySelector('#app')!, f.app, { settings() {}, openFile(path) { (window as any).lastOpenedFile = path; } });
(window as unknown as { testDiary: unknown }).testDiary = f.app;
