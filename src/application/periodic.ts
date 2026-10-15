import { DiaryError, type Evidence, type ModelPort, type Settings, type VaultPort } from '../domain/types';
import { ensureParent, hash, link, record, strings, validDate, within, weekday } from '../domain/util';
import { evidenceStillValid, noteDate, permitted } from '../memory/retrieval';
import { bodyOf } from './archive';
import { validateSettings } from '../domain/settings';
import { removeObservations } from '../memory/retrieval';
import { PROMPT_VERSION } from '../prompts';

export interface Period { kind: 'week' | 'month'; start: string; end: string }
export interface PeriodResult { path: string; title: string; alternate?: boolean }
const iso = (d: Date) => d.toISOString().slice(0, 10);
export function periodFor(date: string, kind: Period['kind']): Period {
  if (!validDate(date)) throw new DiaryError('date', '回顾日期无效。');
  const d = new Date(`${date}T12:00:00Z`);
  if (kind === 'month') return { kind, start: `${date.slice(0, 7)}-01`, end: iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12))) };
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  const start = iso(d); d.setUTCDate(d.getUTCDate() + 6);
  return { kind, start, end: iso(d) };
}
export function periodPath(p: Period, s: Settings): string {
  return p.kind === 'week' ? `${s.weeklyFolder}/${p.start.slice(0, 4)}/${p.start}_${p.end}.md` : `${s.monthlyFolder}/${p.start.slice(0, 4)}/${p.start.slice(0, 7)}.md`;
}
export class PeriodicService {
  constructor(private vault: VaultPort, private model: ModelPort, private settings: () => Settings) {}
  async available(asOf: string): Promise<PeriodResult[]> {
    const s = this.settings(), found: { end: string; result: PeriodResult }[] = [];
    for (const path of this.vault.list().filter(p => p.endsWith('.md') && (within(p, s.weeklyFolder) || within(p, s.monthlyFolder)))) {
      const raw = await this.vault.read(path); if (!raw) continue;
      const end = raw.match(/^结束: (\d{4}-\d{2}-\d{2})$/m)?.[1];
      if (!end || !validDate(end) || end > asOf) continue;
      const alternate = path.includes('-备选-');
      found.push({ end, result: { path, title: (raw.match(/^# (.+)$/m)?.[1] ?? path) + (alternate ? '（备选）' : ''), alternate } });
    }
    return found.sort((a, b) => a.end.localeCompare(b.end) || a.result.path.localeCompare(b.result.path)).map(r => r.result);
  }
  async generateDue(asOf: string, valid = () => true, progress: (title: string) => void = () => {}, includeRecordedEndDay = false): Promise<PeriodResult[]> {
    const s = this.settings();
    if (!s.periodicEnabled) return [];
    if (!s.historyEnabled || !s.allowedPaths.length) throw new DiaryError('permission', '请先允许参考日记目录，才能生成周记和月记。');
    const candidates = this.vault.list().filter(p => within(p, s.diaryFolder) && noteDate(p) && noteDate(p)! <= asOf);
    const dates = candidates.filter(p => permitted(p, s)).map(noteDate).filter((d): d is string => !!d);
    if (candidates.length && !dates.length) throw new DiaryError('permission', '当前日记不在允许参考范围，请在历史资料授权中包含你的日记目录。');
    const periods = new Map<string, Period>();
    for (const date of dates) for (const kind of ['week', 'month'] as const) {
      const p = periodFor(date, kind);
      if (p.end < asOf || (includeRecordedEndDay && p.end === asOf)) periods.set(periodPath(p, s), p);
    }
    const results: PeriodResult[] = [];
    for (const [path, period] of [...periods].sort((a, b) => a[1].end.localeCompare(b[1].end) || a[1].kind.localeCompare(b[1].kind))) {
      if (!valid()) throw new DiaryError('cancelled', '已停止周月回顾，已保存的笔记保留。');
      if (await this.vault.read(path) !== null) continue; // Never overwrite user edits or a synced result.
      progress(`${period.kind === 'week' ? '周记' : '月记'} ${period.start}—${period.end}`);
      results.push(await this.generate(period, valid));
    }
    return results;
  }
  async generate(period: Period, valid = () => true): Promise<PeriodResult> {
    const s = this.settings(), config = JSON.stringify(s), path = periodPath(period, s);
    validateSettings(s);
    const expected = periodFor(period.start, period.kind);
    if (period.start !== expected.start || period.end !== expected.end) throw new DiaryError('date', '周月回顾的周期范围无效。');
    const stillValid = () => valid() && JSON.stringify(this.settings()) === config;
    if (!s.periodicEnabled || !s.historyEnabled) throw new DiaryError('permission', '周记和月记需要开启回顾并允许参考日记。');
    if (await this.vault.read(path) !== null) return { path, title: period.kind === 'week' ? '已有周记' : '已有月记' };
    const currentPeriod: Evidence[] = [], history: Evidence[] = [];
    let historySize = 0;
    const paths = this.vault.list().filter(p => within(p, s.diaryFolder) && permitted(p, s) && noteDate(p) && noteDate(p)! <= period.end).sort().reverse();
    for (const file of paths) {
      if (!stillValid()) throw new DiaryError('cancelled', '已停止周月回顾，日记仍保留。');
      const date = noteDate(file)!, raw = await this.vault.read(file); if (raw === null) continue;
      const text = removeObservations(bodyOf(raw)).trim(); if (!text) continue;
      const h = hash(raw), e = { id: `p-${hash(file + h)}`, path: file, hash: h, date, weekday: weekday(date), text };
      if (date >= period.start) currentPeriod.push(e);
      else if (historySize + text.length <= 35000) { history.push(e); historySize += text.length; }
    }
    currentPeriod.reverse(); history.reverse();
    if (!currentPeriod.length) throw new DiaryError('empty', '这个周期没有获准参考的日记正文。');
    const evidence = [...history, ...currentPeriod];
    const raw = await this.model.run(period.kind === 'week' ? 'week-review' : 'month-review', {
      period, recordedDates: [...new Set(currentPeriod.map(e => e.date))], currentPeriod, history
    }, stillValid);
    if (!stillValid() || !await evidenceStillValid(this.vault, this.settings(), evidence)) throw new DiaryError('stale', '日记或授权已变化，周月回顾未写入；原记录保留。');
    if (!record(raw) || typeof raw.bodyMarkdown !== 'string' || !raw.bodyMarkdown.trim() || !strings(raw.evidenceIds) || !raw.evidenceIds.length ||
        raw.evidenceIds.some(id => !evidence.some(e => e.id === id)) || /<!--|^---\s*$|\[\[|\]\(|https?:|<[^>]+>/m.test(raw.bodyMarkdown))
      throw new DiaryError('format', '周月回顾的正文或引用不可用，日记保留，可以重试。');
    const ids = new Set(raw.evidenceIds);
    const body = raw.bodyMarkdown.trim().replace(/\[?(p-[a-f0-9]{16})\]?/g, (_whole, id: string) => {
      const e = evidence.find(e => e.id === id);
      if (!e) throw new DiaryError('format', '周月回顾含有未知引用，未写入。');
      ids.add(id); return link(e.path);
    });
    const cited = evidence.filter(e => ids.has(e.id));
    if (!cited.some(e => currentPeriod.some(c => c.id === e.id))) throw new DiaryError('format', '周月回顾没有引用本周期记录，未保存。');
    const title = period.kind === 'week' ? `周记 ${period.start}—${period.end}` : `月记 ${period.start.slice(0, 7)}`;
    const count = new Set(currentPeriod.map(e => e.date)).size;
    const days = Math.round((Date.parse(period.end) - Date.parse(period.start)) / 86400000) + 1;
    const text = `---\n类型: AI${period.kind === 'week' ? '周记' : '月记'}\n开始: ${period.start}\n结束: ${period.end}\n记录天数: ${count}\n---\n\n# ${title}\n\n> AI 综合回顾，依据已记录的 ${count}/${days} 天。理解与建议供你核对，未记录的日子没有补写。\n\n${body}\n\n## 参考日记\n\n${cited.map(e => `- ${e.date} ${e.weekday} ${link(e.path)}${e.date! < period.start ? '（历史对照）' : ''}`).join('\n')}\n\n<!-- ai-diary-period:${hash(JSON.stringify(evidence.map(e => [e.path, e.hash])))} -->\n<!-- ai-diary-prompt:${PROMPT_VERSION} -->\n`;
    await ensureParent(this.vault, path);
    // Recheck after asynchronous directory creation as Sync may have arrived.
    if (!stillValid() || !await evidenceStillValid(this.vault, this.settings(), evidence)) throw new DiaryError('stale', '资料在保存前变化，周月回顾未覆盖任何笔记。');
    try { await this.vault.create(path, text); return { path, title }; }
    catch (e) {
      if (await this.vault.read(path) === null) throw e;
      const alternate = path.replace(/\.md$/, `-备选-${hash(text)}.md`);
      if (await this.vault.read(alternate) === null) await this.vault.create(alternate, text);
      return { path: alternate, title: `${title}（备选）`, alternate: true };
    }
  }
}
