import { DiaryError, type Evidence, type ModelPort } from '../domain/types';
import { validateObservations } from './validation';

/** One format-only retry; interpretations themselves are never scored or rewritten here. */
export async function generateObservations(model: ModelPort, input: Record<string, unknown>, evidence: Evidence[], valid = () => true): Promise<string> {
  const output = await model.run('observations', input, valid);
  try { return validateObservations(output, evidence); }
  catch (e) {
    if (!(e instanceof DiaryError) || e.code !== 'format' || !valid()) throw e;
    const fixed = await model.run('observations', { ...input, repair: {
      invalidOutput: output,
      instruction: '上一条未通过格式或引用校验。只修复输出格式，不增加事实或改变理解。返回 understanding 和 evidenceIds；正文不输出链接、路径、HTML，引用只使用本次 evidence 的 ID。'
    } }, valid);
    return validateObservations(fixed, evidence);
  }
}
