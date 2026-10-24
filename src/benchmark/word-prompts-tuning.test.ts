import fs from 'fs/promises';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import { callLaya, rng, seededShuffle, type DecisionState } from '@/benchmark/full-maze-eval-lib';
import { LAYA_INSTRUCTIONS } from '@/benchmark/word-prompt-builders';
import {
  ABLATION_VARIANTS,
  MAZE_CHECK_ARMS,
  PLACEMENT_VARIANTS,
  POSITIVE_RULE,
  POSITIVE_VARIANTS,
  RULE,
  TUNING_VARIANTS,
  armId,
  allColder,
  armPolicy,
  armRequest,
  bestArm,
  strongerMoves,
  summarise,
  warmerLine,
  type Arm,
} from '@/benchmark/word-prompt-builders';

const loadStates = async () =>
  (JSON.parse(await fs.readFile(path.resolve(__dirname, '../../benchmark-results/frozen-dataset.json'), 'utf-8')) as { states: (DecisionState & { id: string })[] }).states;
const ARMS: Arm[] = [
  ...(['laya', 'ollama'] as const).flatMap((model) => [...TUNING_VARIANTS, ...ABLATION_VARIANTS, ...POSITIVE_VARIANTS].map((variant) => ({ model, variant, think: false }))),
  { model: 'ollama', variant: 'lookahead-rule', think: true },
  ...PLACEMENT_VARIANTS.map((variant) => ({ model: 'laya' as const, variant, think: false })),
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

describe('ablation requests', () => {
  it('warmer-only and smell-only differ only in the option text, for every frozen state and both models', async () => {
    expect(ABLATION_VARIANTS).toEqual(['warmer-only', 'smell-only']);
    for (const state of await loadStates())
      for (const model of ['laya', 'ollama'] as const) {
        const order = seededShuffle(state.validActions, rng(9));
        const warmer = armRequest({ model, variant: 'warmer-only', think: false }, state, order, 'qwen3:1.7b') as any;
        const smell = armRequest({ model, variant: 'smell-only', think: false }, state, order, 'qwen3:1.7b') as any;
        const warmerText = JSON.stringify(warmer);
        // "warmer"/"colder" appear exactly once per option, nowhere else ...
        expect(warmerText.match(/warmer, |colder, /g)).toHaveLength(order.length);
        // ... and removing them gives the smell-only request byte for byte.
        expect(warmerText.replace(/warmer, |colder, /g, '')).toBe(JSON.stringify(smell));
        if (model === 'laya') {
          expect(smell.state).toEqual(warmer.state);
          expect(smell.questions.move.instructions).toBe(warmer.questions.move.instructions);
          expect(Object.keys(smell.questions.move.criteria)).toEqual(Object.keys(warmer.questions.move.criteria));
          for (const text of Object.values(smell.questions.move.criteria)) expect(['the smell grows stronger', 'the smell grows weaker']).toContain(text);
        } else {
          const [w, m] = [warmer, smell].map((b) => (b.messages[0].content as string).split('\n'));
          expect(m.length).toBe(w.length);
          const changed = w.map((line, i) => (line === m[i] ? null : i)).filter((i) => i !== null);
          expect(changed).toHaveLength(order.length);
          for (const i of changed) expect(m[i!]).toMatch(/^(UP|DOWN|LEFT|RIGHT): the smell grows (stronger|weaker)\.$/);
          expect({ ...smell, messages: null }).toEqual({ ...warmer, messages: null });
        }
      }
  });
});

describe('positive-rule requests', () => {
  it('differ from warmer-only / smell-only only in the rule sentence, for every frozen state and both models', async () => {
    expect(POSITIVE_VARIANTS).toEqual(['warmer-only-positive', 'smell-only-positive']);
    expect(POSITIVE_RULE).toBe('The cheese is where the smell is strongest. Always move in the direction where the smell grows stronger.');
    for (const state of await loadStates())
      for (const model of ['laya', 'ollama'] as const)
        for (const base of ['warmer-only', 'smell-only'] as const) {
          const order = seededShuffle(state.validActions, rng(9));
          const full = JSON.stringify(armRequest({ model, variant: base, think: false }, state, order, 'qwen3:1.7b'));
          const positive = JSON.stringify(armRequest({ model, variant: `${base}-positive`, think: false }, state, order, 'qwen3:1.7b'));
          // The full rule appears in the body, and for Laya in the instructions too; nothing else mentions "Never".
          expect(full.split(RULE)).toHaveLength(model === 'laya' ? 3 : 2);
          expect(positive).not.toContain('Never');
          expect(full.split(RULE).join(POSITIVE_RULE)).toBe(positive);
        }
  });
});

describe('maze-check arms', () => {
  it('lock in warmer/colder + positive rule for Laya and warmer/colder + full rule for Ollama', async () => {
    const [state] = await loadStates();
    const laya = JSON.stringify(armRequest(MAZE_CHECK_ARMS['laya-best'], state, state.validActions, 'qwen3:1.7b'));
    const ollama = armRequest(MAZE_CHECK_ARMS['ollama-best'], state, state.validActions, 'qwen3:1.7b') as any;
    expect(laya).toContain(POSITIVE_RULE);
    expect(laya).not.toContain('Never');
    expect(laya).toMatch(/warmer, the smell grows stronger|colder, the smell grows weaker/);
    expect(ollama.messages[0].content).toContain(RULE);
    expect(ollama.messages[0].content).toMatch(/: (warmer|colder), the smell grows/);
    expect(ollama.think).toBe(false);
    expect(laya + JSON.stringify(ollama.messages)).not.toMatch(/\d/);
  });

  it('capture the exact request each decision sends, with shuffled legal options', async () => {
    const [, state] = await loadStates();
    const captured: Record<string, unknown>[] = [];
    vi.stubEnv('LAYA_API_KEY', 'fake-laya-key-123456789');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ answers: { move: { choice: state.validActions[0].toUpperCase() } } }), { status: 200 })));
    const policy = armPolicy('laya-best', MAZE_CHECK_ARMS['laya-best'], { layaUrl: 'http://laya.invalid', ollamaUrl: 'http://o.invalid', ollamaModel: 'm' }, (r) => captured.push(r.body));
    const decision = await policy.decide(state, rng(3));
    expect(decision.choice).toBe(state.validActions[0]);
    expect(Object.keys((captured[0] as any).questions.move.criteria)).toEqual(decision.presented!.map((m) => m.toUpperCase()));
    expect([...decision.presented!].sort()).toEqual([...state.validActions].sort());
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('flags a step as all-colder only when no legal direction smells stronger', async () => {
    const states = await loadStates();
    for (const state of states) expect(allColder(state)).toBe(false);
    const [state] = states;
    const deadEnd = { ...state, validActions: state.validActions.filter((m) => state.perception.directionSmell[m] <= state.perception.smell) };
    expect(deadEnd.validActions.length).toBeGreaterThan(0);
    expect(allColder(deadEnd)).toBe(true);
    expect(allColder({ ...state, validActions: [] })).toBe(false);
  });
});

describe('rule-placement requests (Laya)', () => {
  it('differ from rule-both only by the removed rule sentence, for every frozen state', async () => {
    expect(PLACEMENT_VARIANTS).toEqual(['warmer-only-positive', 'rule-instructions-only', 'rule-state-only']);
    for (const state of await loadStates()) {
      const order = seededShuffle(state.validActions, rng(9));
      const request = (variant: (typeof PLACEMENT_VARIANTS)[number]) => armRequest({ model: 'laya', variant, think: false }, state, order, 'm') as any;
      const both = request('warmer-only-positive');
      expect(both.state.body.split(POSITIVE_RULE)).toHaveLength(2);
      expect(both.questions.move.instructions).toBe(`${POSITIVE_RULE} ${LAYA_INSTRUCTIONS}`);
      const instructionsOnly = request('rule-instructions-only');
      expect(instructionsOnly.state.body).not.toContain(POSITIVE_RULE);
      expect(instructionsOnly).toEqual({ ...both, state: { body: both.state.body.replace(`${POSITIVE_RULE}\n`, '') } });
      const stateOnly = request('rule-state-only');
      expect(stateOnly.questions.move.instructions).toBe(LAYA_INSTRUCTIONS);
      expect(stateOnly).toEqual({ ...both, questions: { move: { ...both.questions.move, instructions: LAYA_INSTRUCTIONS } } });
    }
  });

  it('are refused for Ollama', async () => {
    const [state] = await loadStates();
    expect(() => armRequest({ model: 'ollama', variant: 'rule-state-only', think: false }, state, state.validActions, 'm')).toThrow(/Laya-only/);
  });

  it("pass Laya's usage object through callLaya", async () => {
    vi.stubEnv('LAYA_API_KEY', 'fake-laya-key-123456789');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ answers: { move: { choice: 'UP' } }, usage: { input_tokens: 123, output_tokens: 1 } }), { status: 200 })));
    expect(await callLaya('http://laya.invalid', {}, 1000)).toMatchObject({ choice: 'up', usage: { input_tokens: 123 } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ answers: { move: { choice: 'UP' } } }), { status: 200 })));
    expect((await callLaya('http://laya.invalid', {}, 1000)).usage).toBeUndefined();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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
