import { DiaryError, type Settings, type Topic } from './types';
import { id, record, safePath, within } from './util';
export const defaultTopics: Topic[] = [
  { id: 'work', name: '工作学习', enabled: true }, { id: 'relationships', name: '人际相处', enabled: true },
  { id: 'daily', name: '日常小事', enabled: true }, { id: 'mood', name: '心情', enabled: true }
];
export function loadSettings(raw: unknown): Settings {
  const r = record(raw) ? raw : {};
  const namespace = typeof r.namespace === 'string' && /^[a-z0-9-]{8,80}$/.test(r.namespace) ? r.namespace : id();
  const str = (k: string, fallback: string) => typeof r[k] === 'string' ? r[k] as string : fallback;
  const diaryFolder = str('diaryFolder', '日记'), transcriptFolder = str('transcriptFolder', '原始问答');
  const vacant = (name: string, taken: string[]) => {
    let candidate = name;
    const occupied = taken.map(p => p.trim().replace(/\\/g, '/').toLowerCase());
    while (occupied.some(p => within(p, candidate.toLowerCase()) || within(candidate.toLowerCase(), p))) candidate += '_回顾';
    return candidate;
  };
  const weeklyFolder = str('weeklyFolder', vacant('周记', [diaryFolder, transcriptFolder]));
  const monthlyFolder = str('monthlyFolder', vacant('月记', [diaryFolder, transcriptFolder, weeklyFolder]));
  const topics = Array.isArray(r.topics) ? r.topics.filter((t): t is Topic => record(t) && typeof t.id === 'string' && /^[\w-]{1,80}$/.test(t.id) && typeof t.name === 'string' && !!t.name.trim() && typeof t.enabled === 'boolean').map(t => ({ id: t.id, name: t.name, enabled: t.enabled })) : defaultTopics.map(t => ({ ...t }));
  return {
    version: 1, namespace, baseUrl: str('baseUrl', ''), modelId: str('modelId', ''),
    credentialRef: str('credentialRef', `ai-diary-${namespace}`),
    style: r.style === 'narrative' ? 'narrative' : 'natural', diaryFolder,
    transcriptFolder, topics,
    periodicEnabled: r.periodicEnabled === true, weeklyFolder, monthlyFolder,
    historyEnabled: r.historyEnabled === true,
    allowedPaths: Array.isArray(r.allowedPaths) ? r.allowedPaths.filter((p): p is string => typeof p === 'string') : []
  };
}
export function validateSettings(s: Settings): void {
  const folders = [s.diaryFolder, s.transcriptFolder, s.weeklyFolder, s.monthlyFolder].map(p => safePath(p).toLowerCase());
  if (folders.some((a, i) => folders.some((b, j) => i !== j && within(a, b))))
    throw new DiaryError('path', '日记、原始问答、周记和月记目录必须分开，不能互相包含。');
  s.allowedPaths.forEach(safePath);
  if (new Set(s.topics.map(t => t.id)).size !== s.topics.length) throw new DiaryError('settings', '入口 ID 重复。');
  if (s.baseUrl) endpoint(s.baseUrl);
  if (!/^[a-z0-9-]+$/.test(s.credentialRef)) throw new DiaryError('settings', '凭据名称只能包含小写字母、数字和短横线。');
}
export function endpoint(base: string): string {
  let u: URL;
  try { u = new URL(base.trim()); } catch { throw new DiaryError('url', '请填写完整的 API 根地址，例如 https://服务地址/v1。'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    throw new DiaryError('url', '服务地址需为 HTTP/HTTPS API 根地址，不能包含密钥、查询或片段。');
  const path = u.pathname.replace(/\/+$/, '');
  u.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  return u.toString();
}
