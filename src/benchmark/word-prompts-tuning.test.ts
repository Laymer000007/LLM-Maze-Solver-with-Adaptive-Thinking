import fs from 'fs/promises';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { rng, seededShuffle, type DecisionState } from '@/benchmark/full-maze-eval';
import {
  RULE,
  TUNING_VARIANTS,
  armId,
  armRequest,
  bestArm,
  strongerMoves,
  summarise,
  warmerLine,
  type Arm,
} from '@/benchmark/word-prompts-tuning';

const loadStates = async () =>
  (JSON.parse(await fs.readFile(path.resolve(__dirname, '../../benchmark-results/frozen-dataset.json'), 'utf-8')) as { states: (DecisionState & { id: string })[] }).states;
const ARMS: Arm[] = [
  ...(['laya', 'ollama'] as const).flatMap((model) => TUNING_VARIANTS.map((variant) => ({ model, variant, think: false }))),
  { model: 'ollama', variant: 'lookahead-rule', think: true },
];
/** What the model reads: the whole Laya body, or the Ollama messages (the envelope holds model "qwen3:1.7b" and temperature 0.2). */
const readByModel = (arm: Arm, body: Record<string, unknown>) => JSON.stringify(arm.model === 'laya' ? body : body.messages);

describe('tuning requests', () => {
  it('contain no digits for any arm on any of the 100 frozen states', async () => {
    const states = await loadStates();
    expect(states).toHaveLength(100);
    for (const arm of ARMS)
      for (const state of states) {
        const order = seededShuffle(state.validActions, rng(1));
        expect(readByModel(arm, armRequest(arm, state, order, 'qwen3:1.7b'))).not.toMatch(/\d/);
      }
  });

  it('adds the rule to the body and, for Laya, to the question instructions', async () => {
    const [state] = await loadStates();
    for (const variant of ['lookahead-rule', 'warmer-only'] as const) {
      const laya = armRequest({ model: 'laya', variant, think: false }, state, state.validActions, 'm') as any;
      expect(laya.state.body).toContain(RULE);
      expect(laya.questions.move.instructions).toContain(RULE);
      expect((armRequest({ model: 'ollama', variant, think: false }, state, state.validActions, 'm') as any).messages[0].content).toContain(RULE);
    }
    const control = armRequest({ model: 'laya', variant: 'lookahead', think: false }, state, state.validActions, 'm') as any;
    expect(JSON.stringify(control)).not.toContain(RULE);
  });

  it('gives warmer-only options just the cue, without visit words', async () => {
    const states = await loadStates();
    for (const state of states.slice(0, 20)) {
      const criteria = (armRequest({ model: 'laya', variant: 'warmer-only', think: false }, state, state.validActions, 'm') as any).questions.move.criteria as Record<string, string>;
      for (const [label, text] of Object.entries(criteria)) {
        expect(['warmer, the smell grows stronger', 'colder, the smell grows weaker']).toContain(text);
        expect(text.startsWith('warmer')).toBe(strongerMoves(state).includes(label.toLowerCase() as never));
        expect(text).toBe(warmerLine(state, label.toLowerCase() as never));
      }
    }
  });

  it('offers only legal moves, in the given shuffled order, and sets think only on the think arm', async () => {
    const [, state] = await loadStates();
    const order = seededShuffle(state.validActions, rng(5));
    expect(Object.keys((armRequest({ model: 'laya', variant: 'lookahead-rule', think: false }, state, order, 'm') as any).questions.move.criteria)).toEqual(order.map((m) => m.toUpperCase()));
    expect((armRequest({ model: 'ollama', variant: 'lookahead-rule', think: true }, state, order, 'm') as any).think).toBe(true);
    expect((armRequest({ model: 'ollama', variant: 'lookahead-rule', think: false }, state, order, 'm') as any).think).toBe(false);
    expect(armId({ model: 'ollama', variant: 'warmer-only', think: true })).toBe('ollama-warmer-only-think');
  });
});

describe('scoring', () => {
  it('every frozen state has a stronger legal direction', async () => {
    for (const state of await loadStates()) expect(strongerMoves(state).length).toBeGreaterThan(0);
  });

  it('summarises rates and ranks arms by toward, then legal, then latency', () => {
    const row = (toward: boolean, legal: boolean, latencyMs: number) => ({ arm: 'a', stateId: 's', choice: null, legal, toward, latencyMs, failure: null, order: [] });
    const s = summarise([row(true, true, 100), row(false, true, 300), row(false, false, 200)]);
    expect(s).toMatchObject({ states: 3, failures: 0, meanLatencyMs: 200 });
    expect(s.towardRate).toBeCloseTo(1 / 3);
    expect(s.legalRate).toBeCloseTo(2 / 3);
    const m = (towardRate: number, legalRate: number, meanLatencyMs: number) => ({ towardRate, legalRate, meanLatencyMs });
    expect(bestArm([['a', m(0.5, 1, 100)], ['b', m(0.7, 0.9, 900)]])).toBe('b');
    expect(bestArm([['a', m(0.7, 0.9, 100)], ['b', m(0.7, 1, 900)]])).toBe('b');
    expect(bestArm([['a', m(0.7, 1, 300)], ['b', m(0.7, 1, 200)]])).toBe('b');
  });
});
