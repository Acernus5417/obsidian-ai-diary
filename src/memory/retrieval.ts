import { type Settings, type Evidence, type VaultPort, type Thread } from '../domain/types';
import { safePath, within, hash, validDate, weekday } from '../domain/util';
export function permitted(path: string, s: Settings): boolean {
  if (!s.historyEnabled || !path.endsWith('.md') || within(path, s.transcriptFolder) || within(path, s.weeklyFolder) || within(path, s.monthlyFolder)) return false;
  try { safePath(path); return s.allowedPaths.some(p => within(path, safePath(p))); } catch { return false; }
}
export const OBS_START = '<!-- ai-diary-observations:start -->';
export const OBS_END = '<!-- ai-diary-observations:end -->';
export function removeObservations(text: string): string {
  const i = text.indexOf(OBS_START);
  if (i >= 0) {
    const end = text.indexOf(OBS_END, i);
    text = end < 0 ? text.slice(0, i) : text.slice(0, i) + text.slice(end + OBS_END.length);
  }
  // Do not treat manually retained unmarked AI-observation sections as user facts.
  text = text.replace(/^#{1,6}\s*AI\s*观察[\s\S]*$/im, '');
  return text.replace(/<!--[^]*?-->/g, '').replace(/^---\r?\n[^]*?\r?\n---\r?\n/, '');
}
export function mentions(text: string, t: Thread): boolean {
  return [...t.aliases, t.title].some(a => a.trim().length >= 3 && text.includes(a.trim()));
}
export async function retrieve(vault: VaultPort, s: Settings, query: string, date: string, suppressed: Thread[], valid = () => true): Promise<Evidence[]> {
  const terms = [...new Set((query.match(/[\p{L}\p{N}]{2,}/gu) ?? []).flatMap(w => w.length > 4 ? [w, ...Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2))] : [w]))].slice(0, 80);
  const results: { e: Evidence; score: number }[] = [];
  // Enumerate path metadata first; never read a file outside the whitelist.
  for (const path of vault.list().filter(p => permitted(p, s) && !p.endsWith(`/${date}.md`) && (!noteDate(p) || noteDate(p)! < date)).sort().reverse().slice(0, 300)) {
    if (!valid()) break;
    const raw = await vault.read(path);
    if (raw === null || !valid()) continue;
    if (raw.includes('<!-- ai-diary-period:')) continue;
    const clean = removeObservations(raw);
    const chunks = clean.split(/\n\s*\n/).filter(p => p.trim() && !suppressed.some(t => mentions(p, t)));
    const ranked = chunks.map(text => ({ text, score: terms.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score);
    const selected = ranked.slice(0, 3);
    const text = selected.map(p => p.text).join('\n\n').slice(0, 2200);
    if (!text) continue;
    const h = hash(raw), found = path.match(/(\d{4}-\d{2}-\d{2})/);
    results.push({ e: { id: `e-${hash(path + h + text)}`, path, hash: h, text, date: found?.[1] && validDate(found[1]) ? found[1] : null }, score: selected.reduce((n, p) => n + p.score, 0) });
  }
  return results.sort((a, b) => b.score - a.score || b.e.path.localeCompare(a.e.path)).slice(0, 6).map(r => r.e);
}
export function noteDate(path: string): string | null {
  const date = path.match(/(?:^|\/)(\d{4}-\d{2}-\d{2})\.md$/)?.[1];
  return date && validDate(date) ? date : null;
}

/** Chronological firsthand background. No emotion labels or inferred memory.
 * Complete short diaries fit; larger histories retain recent and spaced dates. */
export async function observationContext(vault: VaultPort, s: Settings, query: string, date: string, suppressed: Thread[], valid = () => true): Promise<{ evidence: Evidence[] }> {
  const related = await retrieve(vault, s, query, date, suppressed, valid);
  const paths = vault.list().filter(p => permitted(p, s) && within(p, s.diaryFolder) && noteDate(p) && noteDate(p)! < date).sort();
  const recent = paths.slice(-90);
  const earlier = paths.slice(0, -90);
  const spaced = earlier.filter((_, i) => i % Math.max(1, Math.ceil(earlier.length / 24)) === 0);
  const evidence = new Map(related.map(e => [e.path, e]));
  for (const path of [...spaced, ...recent]) {
    if (!valid()) break;
    const raw = await vault.read(path); if (raw === null) continue;
    const marker = '<!-- ai-diary-body:start -->';
    const begin = raw.indexOf(marker), end = raw.indexOf('<!-- ai-diary-body:end -->');
    const body = begin >= 0 && end > begin ? raw.slice(begin + marker.length, end).trim() : removeObservations(raw).trim();
    const text = body.split(/\n\s*\n/).filter(p => !suppressed.some(t => mentions(p, t))).join('\n\n');
    if (!text) continue;
    const h = hash(raw);
    evidence.set(path, { id: `e-${hash(path + h + text)}`, path, hash: h, text, date: noteDate(path), weekday: weekday(noteDate(path)!) });
  }
  // Technical context budget, not a semantic selection or emotional gate.
  const ordered = [...evidence.values()].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  let used = 0;
  const priority = [...ordered.slice(-14).reverse(), ...ordered.slice(0, 3), ...ordered.filter((_, i) => i % Math.max(1, Math.ceil(ordered.length / 24)) === 0), ...ordered.slice().reverse()];
  const seen = new Set<string>();
  const selected = priority.filter(e => {
    if (seen.has(e.path)) return false; seen.add(e.path);
    if (used + e.text.length > 55000) return false; used += e.text.length; return true;
  }).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  return { evidence: selected };
}
export async function evidenceStillValid(vault: VaultPort, s: Settings, evidence: Evidence[]): Promise<boolean> {
  for (const e of evidence) {
    if (!permitted(e.path, s)) return false;
    const text = await vault.read(e.path);
    if (text === null || hash(text) !== e.hash) return false;
  }
  return true;
}
