import { describe, expect, it } from 'vitest';
import { buildPrompt } from '@/benchmark/laya-prompt-accuracy';

const state: any = { position: { x: 5, y: 6 }, goal: { x: 9, y: 9 }, validActions: ['left', 'right'], perception: { smell: 20, directionSmell: { left: 21, right: 10 } }, memory: { visitCounts: { '4,6': 0, '6,6': 2 }, actionEffects: { left: { totalExpectedEiLDelta: 15, sight: 'New', smell: 'Increase Smell', experience: 'ATTRACTIVE' }, right: { totalExpectedEiLDelta: 8, sight: 'Already Seen', smell: 'Decrease Smell', experience: 'NEUTRAL' } } } };

describe('Laya prompt formats', () => {
  it('keeps scores out of words-only prompts', () => {
    expect(buildPrompt(state, 'words')).not.toContain('15');
    expect(buildPrompt(state, 'numbers')).toContain('LEFT: 15');
  });
  it('keeps structured prompts compact and score-bearing', () => {
    const prompt = buildPrompt(state, 'structured');
    expect(prompt).toContain('position=(5,6)');
    expect(prompt).toContain('LEFT: score=15');
  });
});
