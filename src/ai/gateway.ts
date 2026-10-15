import { DiaryError, type Settings, type ModelTask, type ModelPort } from '../domain/types';
import { endpoint } from '../domain/settings';
import { record } from '../domain/util';
import { prompts, repairPrompt } from '../prompts';
export interface HttpPort { (request: { url: string; headers: Record<string, string>; body: string }): Promise<{ status: number; text: string }> }
export interface SecretPort { get(name: string): string | null }
export class Gateway implements ModelPort {
  constructor(private settings: () => Settings, private secrets: SecretPort, private http: HttpPort, private timeoutMs = 90000) {}
  async test(): Promise<void> {
    await this.request([{ role: 'user', content: 'Reply with OK.' }], () => true);
  }
  async run(task: ModelTask, input: unknown, valid = () => true): Promise<unknown> {
    const data = JSON.stringify(input);
    if (data.length > 100000) throw new DiaryError('context', '本次素材较长，请先归档已有内容，再继续补记。');
    const messages = task === 'conversation' ? conversationMessages(input) : [{ role: 'system', content: prompts[task] }, { role: 'user', content: data }];
    const raw = await this.request(messages, valid);
    // Natural language is the conversation protocol. Read old JSON replies only
    // for backwards compatibility; there is no semantic repair or angle gate.
    if (task === 'conversation') {
      try { const legacy = decode(raw); if (record(legacy) && (typeof legacy.text === 'string' || typeof legacy.question === 'string')) return legacy; } catch { /* plain reply */ }
      return raw;
    }
    try { return decode(raw); } catch {
      const fixed = await this.request([...messages, { role: 'assistant', content: raw.slice(0, 50000) }, { role: 'user', content: repairPrompt }], valid);
      return decode(fixed);
    }
  }
  private async request(messages: { role: string; content: string }[], valid: () => boolean): Promise<string> {
    const s = this.settings();
    if (!s.baseUrl || !s.modelId.trim()) throw new DiaryError('configuration', '请先在插件设置中填写服务地址和模型名称。');
    const secret = this.secrets.get(s.credentialRef);
    if (!secret) throw new DiaryError('credentials', '本设备尚未配置 API Key，请在插件设置中保存凭据。');
    if (!valid()) throw new DiaryError('cancelled', '已停止等待，记录仍保留。');
    let timer: ReturnType<typeof setTimeout> | undefined, polling: ReturnType<typeof setInterval> | undefined;
    const abandoned = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DiaryError('timeout', '服务响应超时，可以重试；已保存的回答仍保留。')), this.timeoutMs);
      polling = setInterval(() => { if (!valid()) reject(new DiaryError('cancelled', '已停止等待，记录仍保留。')); }, 100);
    });
    try {
      const response = await Promise.race([this.http({
        url: endpoint(s.baseUrl), headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: s.modelId.trim(), messages, stream: false })
      }), abandoned]);
      if (!valid()) throw new DiaryError('cancelled', '已停止等待，记录仍保留。');
      if (response.status === 401 || response.status === 403) throw new DiaryError('auth', '鉴权失败，请检查本设备 API Key 和模型访问权限。');
      if (response.status === 429) throw new DiaryError('rate', '服务当前限流或额度不足，请稍后重试并检查服务额度。');
      if (response.status === 413) throw new DiaryError('context', '素材超过服务上下文限制，请先归档已有内容。');
      if (response.status < 200 || response.status >= 300) throw new DiaryError('service', `服务请求失败（HTTP ${response.status}），请检查地址、模型或稍后重试。`);
      const r: unknown = JSON.parse(response.text);
      if (!record(r) || !Array.isArray(r.choices) || !record(r.choices[0]) || !record(r.choices[0].message) || typeof r.choices[0].message.content !== 'string')
        throw new DiaryError('protocol', '服务响应不是支持的 Chat Completions 文本格式。');
      return r.choices[0].message.content;
    } catch (e) {
      if (e instanceof DiaryError) throw e;
      throw new DiaryError('network', '连接或响应读取失败，请检查服务地址和网络后重试。');
    } finally { clearTimeout(timer); clearInterval(polling); }
  }
}
function conversationMessages(input: unknown): { role: string; content: string }[] {
  const value = record(input) ? input : {};
  const messages: { role: string; content: string }[] = [{ role: 'system', content: prompts.conversation }];
  const context = { date: value.date, weekday: value.weekday, currentDiary: value.currentDiary, chosenEntry: value.chosenEntry, selectedPassage: value.selectedPassage, followUps: value.followUps, evidence: value.evidence };
  messages.push({ role: 'user', content: `以下是这次回顾的背景资料，供参考：\n${JSON.stringify(context)}` });
  for (const m of Array.isArray(value.messages) ? value.messages : [])
    if (record(m) && ['user', 'assistant'].includes(String(m.role)) && typeof m.text === 'string' && m.text.trim())
      messages.push({ role: String(m.role), content: m.text });
  const controls: Record<string, string> = {
    start: '先问我今天早上主要做了什么，再顺着回顾今天。', continue: '请接着问我。',
    rephrase: '刚才的问题换一种更容易回答的说法。', broaden: '接着回顾今天后面那段时间发生的事吧。',
    skip: '先不聊刚才这件事了，接着聊今天其他的事。',
    change: value.chosenEntry ? `我想从「${String(value.chosenEntry)}」这方面聊聊今天。` : '带我回顾今天吧。'
  };
  const control = controls[String(value.trigger)];
  if (control) messages.push({ role: 'user', content: control });
  if (record(value.repair) && typeof value.repair.instruction === 'string') messages.push({ role: 'user', content: value.repair.instruction });
  return messages;
}
function decode(text: string): unknown {
  try {
    const result: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
    if (!record(result)) throw new Error(); return result;
  } catch { throw new DiaryError('format', '模型没有返回可用格式，素材和上一版日记仍保留，请重试。'); }
}
