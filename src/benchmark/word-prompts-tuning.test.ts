import fs from 'fs/promises';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import { rng, seededShuffle, type DecisionState } from '@/benchmark/full-maze-eval-lib';
import {
  ABLATION_VARIANTS,
  MAZE_CHECK_ARMS,
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
  ...[...TUNING_VARIANTS, ...ABLATION_VARIANTS, ...POSITIVE_VARIANTS].map((variant) => ({ variant, think: false })),
  { variant: 'lookahead-rule', think: true },
];
/** What the model reads: the messages (the envelope holds model "qwen3:1.7b" and temperature 0.2). */
const prompt = (body: Record<string, unknown>) => (body as any).messages[0].content as string;

describe('tuning requests', () => {
  it('contain no digits for any arm on any of the 100 frozen states', async () => {
    const states = await loadStates();
    expect(states).toHaveLength(100);
    for (const arm of ARMS)
      for (const state of states) {
        const order = seededShuffle(state.validActions, rng(1));
        expect(JSON.stringify((armRequest(arm, state, order, 'qwen3:1.7b') as any).messages)).not.toMatch(/\d/);
      }
  });

  it('adds the rule to the prompt for the rule variants only', async () => {
    const [state] = await loadStates();
    for (const variant of ['lookahead-rule', 'warmer-only'] as const) expect(prompt(armRequest({ variant, think: false }, state, state.validActions, 'm'))).toContain(RULE);
    expect(prompt(armRequest({ variant: 'lookahead', think: false }, state, state.validActions, 'm'))).not.toContain(RULE);
  });

  it('gives warmer-only options just the cue, without visit words', async () => {
    const states = await loadStates();
    for (const state of states.slice(0, 20)) {
      const options = prompt(armRequest({ variant: 'warmer-only', think: false }, state, state.validActions, 'm'))
        .split('\n')
        .filter((line) => /^(UP|DOWN|LEFT|RIGHT): /.test(line));
      expect(options).toHaveLength(state.validActions.length);
      for (const line of options) {
        const [label, text] = line.split(': ');
        expect(['warmer, the smell grows stronger.', 'colder, the smell grows weaker.']).toContain(text);
        expect(text.startsWith('warmer')).toBe(strongerMoves(state).includes(label.toLowerCase() as never));
        expect(text).toBe(`${warmerLine(state, label.toLowerCase() as never)}.`);
      }
    }
  });

  it('offers only legal moves, in the given shuffled order, and sets think only on the think arm', async () => {
    const [, state] = await loadStates();
    const order = seededShuffle(state.validActions, rng(5));
    const labels = prompt(armRequest({ variant: 'lookahead-rule', think: false }, state, order, 'm'))
      .split('\n')
      .filter((line) => /^(UP|DOWN|LEFT|RIGHT): /.test(line))
      .map((line) => line.split(':')[0]);
    expect(labels).toEqual(order.map((m) => m.toUpperCase()));
    expect((armRequest({ variant: 'lookahead-rule', think: true }, state, order, 'm') as any).think).toBe(true);
    expect((armRequest({ variant: 'lookahead-rule', think: false }, state, order, 'm') as any).think).toBe(false);
    expect(armId({ variant: 'warmer-only', think: true })).toBe('ollama-warmer-only-think');
  });
});

describe('ablation requests', () => {
  it('warmer-only and smell-only differ only in the option text, for every frozen state', async () => {
    expect(ABLATION_VARIANTS).toEqual(['warmer-only', 'smell-only']);
    for (const state of await loadStates()) {
      const order = seededShuffle(state.validActions, rng(9));
      const warmer = armRequest({ variant: 'warmer-only', think: false }, state, order, 'qwen3:1.7b') as any;
      const smell = armRequest({ variant: 'smell-only', think: false }, state, order, 'qwen3:1.7b') as any;
      const warmerText = JSON.stringify(warmer);
      // "warmer"/"colder" appear exactly once per option, nowhere else ...
      expect(warmerText.match(/warmer, |colder, /g)).toHaveLength(order.length);
      // ... and removing them gives the smell-only request byte for byte.
      expect(warmerText.replace(/warmer, |colder, /g, '')).toBe(JSON.stringify(smell));
      const [w, m] = [warmer, smell].map((b) => (b.messages[0].content as string).split('\n'));
      expect(m.length).toBe(w.length);
      const changed = w.map((line, i) => (line === m[i] ? null : i)).filter((i) => i !== null);
      expect(changed).toHaveLength(order.length);
      for (const i of changed) expect(m[i!]).toMatch(/^(UP|DOWN|LEFT|RIGHT): the smell grows (stronger|weaker)\.$/);
      expect({ ...smell, messages: null }).toEqual({ ...warmer, messages: null });
    }
  });
});

describe('positive-rule requests', () => {
  it('differ from warmer-only / smell-only only in the rule sentence, for every frozen state', async () => {
    expect(POSITIVE_VARIANTS).toEqual(['warmer-only-positive', 'smell-only-positive']);
    expect(POSITIVE_RULE).toBe('The cheese is where the smell is strongest. Always move in the direction where the smell grows stronger.');
    for (const state of await loadStates())
      for (const base of ['warmer-only', 'smell-only'] as const) {
        const order = seededShuffle(state.validActions, rng(9));
        const full = JSON.stringify(armRequest({ variant: base, think: false }, state, order, 'qwen3:1.7b'));
        const positive = JSON.stringify(armRequest({ variant: `${base}-positive`, think: false }, state, order, 'qwen3:1.7b'));
        // The full rule appears once, in the prompt; nothing else mentions "Never".
        expect(full.split(RULE)).toHaveLength(2);
        expect(positive).not.toContain('Never');
        expect(full.split(RULE).join(POSITIVE_RULE)).toBe(positive);
      }
  });
});

describe('maze-check arms', () => {
  it('lock in warmer/colder + full rule for Ollama', async () => {
    const [state] = await loadStates();
    const ollama = armRequest(MAZE_CHECK_ARMS['ollama-best'], state, state.validActions, 'qwen3:1.7b') as any;
    expect(ollama.messages[0].content).toContain(RULE);
    expect(ollama.messages[0].content).toMatch(/: (warmer|colder), the smell grows/);
    expect(ollama.think).toBe(false);
    expect(JSON.stringify(ollama.messages)).not.toMatch(/\d/);
  });

  it('capture the exact request each decision sends, with shuffled legal options', async () => {
    const [, state] = await loadStates();
    const captured: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: { content: JSON.stringify({ move: state.validActions[0] }) } }), { status: 200 })));
    const policy = armPolicy('ollama-best', MAZE_CHECK_ARMS['ollama-best'], { ollamaUrl: 'http://o.invalid', ollamaModel: 'm' }, (r) => captured.push(r.body));
    const decision = await policy.decide(state, rng(3));
    expect(decision.choice).toBe(state.validActions[0]);
    const labels = prompt(captured[0])
      .split('\n')
      .filter((line) => /^(UP|DOWN|LEFT|RIGHT): /.test(line))
      .map((line) => line.split(':')[0]);
    expect(labels).toEqual(decision.presented!.map((m) => m.toUpperCase()));
    expect([...decision.presented!].sort()).toEqual([...state.validActions].sort());
    vi.unstubAllGlobals();
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
