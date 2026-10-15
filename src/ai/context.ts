import { DiaryError, type Evidence, type Message, type Settings, type VaultPort } from '../domain/types';
import { hash } from '../domain/util';
import { permitted } from '../memory/retrieval';

/** Context is explanatory, not an additional source of diary facts. */
export async function authorizedDialogue(vault: VaultPort, settings: Settings, messages: Message[], answerIds: Set<string>, body: string, hasConsumed: boolean, valid: () => boolean) {
  const safe: Message[] = [], dependencies = new Map<string, Evidence>(), versions = new Map<string, string | null>();
  for (const message of messages) {
    if (!valid()) throw new DiaryError('stale', '资料或会话已变化，请重新请求；已有记录保留。');
    if (message.role === 'user') { if (answerIds.has(message.id)) safe.push(message); continue; }
    if (!message.historyEvidence) continue; // Unknown legacy history stays local.
    const basis = message.conversationBasis;
    if (hasConsumed && !basis) continue;
    if (basis && (basis.bodyHash !== hash(body) || basis.answerIds.some(id => !answerIds.has(id)))) continue;
    let allowed = true;
    for (const e of message.historyEvidence) {
      if (!permitted(e.path, settings)) { allowed = false; break; }
      if (!versions.has(e.path)) { const text = await vault.read(e.path); versions.set(e.path, text === null ? null : hash(text)); }
      if (versions.get(e.path) !== e.hash) { allowed = false; break; }
    }
    if (!allowed) continue;
    safe.push(message);
    for (const e of message.historyEvidence) dependencies.set(e.path, { ...e, id: `context-${hash(e.path + e.hash)}`, text: '', date: null });
  }
  return { messages: safe, dependencies: [...dependencies.values()] };
}

export function questionAnswerPairs(messages: Message[]) {
  let question: string | undefined;
  return messages.flatMap(m => {
    if (m.role === 'assistant') { question = m.text; return []; }
    const pair = { answerId: m.id, ...(question ? { questionContext: question } : {}), answer: m.text };
    question = undefined; return [pair];
  });
}
