import { DiaryError } from './types';
export function id(): string { return crypto.randomUUID(); }
// Content comparison and accidental corruption detection, not cryptographic authentication.
export function hash(text: string): string {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
export function dateKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === date;
}
export function weekday(date: string): string {
  if (!validDate(date)) throw new DiaryError('date', '记录日期无效。');
  return ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][new Date(`${date}T12:00:00Z`).getUTCDay()]!;
}
export function safePath(value: string): string {
  const p = value.trim().replace(/\\/g, '/');
  if (!p || p.startsWith('/') || p.endsWith('/') || /[<>:"|?*\x00-\x1f\[\]#^]/.test(p) ||
      p.split('/').some(s => !s || s.startsWith('.') || /[. ]$/.test(s) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)))
    throw new DiaryError('path', '请填写仓库内的普通路径，不含隐藏目录、.. 或非法字符。');
  return p;
}
export function within(path: string, parent: string): boolean { return path === parent || path.startsWith(`${parent}/`); }
export function dayPath(folder: string, date: string): string {
  if (!validDate(date)) throw new DiaryError('date', '记录日期无效。');
  return `${safePath(folder)}/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`;
}
export function link(path: string): string { return `[[${path.replace(/\.md$/, '')}]]`; }
export async function ensureParent(vault: { mkdir(path: string): Promise<void> }, path: string): Promise<void> {
  const parts = path.split('/'); parts.pop();
  for (let i = 1; i <= parts.length; i++) await vault.mkdir(parts.slice(0, i).join('/'));
}
export function record(x: unknown): x is Record<string, unknown> { return !!x && typeof x === 'object' && !Array.isArray(x); }
export function strings(x: unknown): x is string[] { return Array.isArray(x) && x.every(v => typeof v === 'string'); }
export function compactQuestion(text: string): string { return text.replace(/[\s，。！？、；：“”‘’,.!?;:"']/g, '').toLowerCase(); }
