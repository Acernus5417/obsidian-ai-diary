import { describe, expect, it } from 'vitest';
import { evalCases } from '../fixtures/evals';

describe('experience evaluation material hygiene', () => {
  it('covers eighteen distinct, genuinely multi-turn scenarios', () => {
    expect(evalCases.length).toBeGreaterThanOrEqual(18);
    expect(new Set(evalCases.map(c => c.id)).size).toBe(evalCases.length);
    for (const c of evalCases) {
      expect(c.turns.length).toBeGreaterThanOrEqual(3);
      expect(c.review.trim().length).toBeGreaterThan(10);
    }
    for (const required of ['vague', 'work', 'denial', 'strong', 'facts', 'mixed', 'positive', 'ordinary', 'unknown', 'skip', 'rumination', 'change', 'history', 'interrupted', 'deleted', 'injection', 'long', 'agency']) {
      expect(evalCases.some(c => c.id === required)).toBe(true);
    }
  });
  it('every annotated experience is an exact user quotation, not a scripted inference', () => {
    for (const c of evalCases) for (const turn of c.turns) for (const note of turn.notes ?? []) {
      expect(note.text.trim().length).toBeGreaterThan(0);
      expect(turn.text, `${c.id}: ${note.text}`).toContain(note.text);
    }
  });
  it('has pause, deliberate continuation, thought, wish, change and broadening branches', () => {
    const turns = evalCases.flatMap(c => c.turns);
    for (const intent of ['pause', 'thought', 'wish', 'change', 'broaden']) expect(turns.some(t => t.intent === intent)).toBe(true);
    expect(turns.some(t => t.trigger === 'continue')).toBe(true);
    for (const turn of turns) {
      expect(turn.intent === 'pause' ? turn.question === null : !!turn.question).toBe(true);
      expect((turn.question?.match(/[?？]/g) ?? []).length).toBeLessThanOrEqual(1);
    }
  });
  it('long case exceeds the old forty-message window, and deletion has no new old content', () => {
    expect(evalCases.find(c => c.id === 'long')!.turns.length * 2).toBeGreaterThan(40);
    const deleted = evalCases.find(c => c.id === 'deleted')!;
    expect(deleted.editAfter?.body).not.toMatch(/争执|吵架/);
    for (const turn of deleted.turns.slice(deleted.editAfter!.turn)) expect(turn.text).not.toMatch(/争执|吵架/);
  });
});
