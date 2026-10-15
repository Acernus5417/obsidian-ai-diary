import { DiaryError, type FactDocument } from '../domain/types';
import { record, strings } from '../domain/util';
import { type Source } from './validation';

/** Structure and provenance only; no emotion categories or semantic approval. */
export function validateFacts(value: unknown, sources: Source[]): FactDocument {
  if (!record(value) || !Array.isArray(value.facts)) throw new DiaryError('format', '素材整理未返回可读格式，问答和原稿仍保留，可以重试。');
  const known = new Set(sources.map(s => s.id));
  return { ...(typeof value.writingBrief === 'string' ? { writingBrief: value.writingBrief.trim() } : {}), facts: value.facts.map((f, i) => {
    if (!record(f) || typeof f.text !== 'string' || !f.text.trim() || !strings(f.sourceIds) || !f.sourceIds.length || f.sourceIds.some(id => !known.has(id)))
      throw new DiaryError('format', '素材整理的来源不可用，问答和原稿仍保留，可以重试。');
    return { id: `f-${i + 1}`, text: f.text.trim(), sourceIds: f.sourceIds };
  }) };
}
