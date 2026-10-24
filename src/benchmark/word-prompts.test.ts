import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Move } from '@/execution/execution';

import { buildSuiteEntry, runEpisode, type DecisionState } from '@/benchmark/full-maze-eval-lib';
import {
  MODELS,
  VARIANTS,
  closenessWords,
  createWordPolicy,
  feedbackWords,
  stepCapFor,
  towardStrongerSmell,
  visitWords,
  type CapturedRequest,
} from '@/benchmark/word-prompt-builders';

const NETWORK = { layaUrl: 'http://laya.invalid', ollamaUrl: 'http://ollama.invalid', ollamaModel: 'qwen3:1.7b' };
const LAYOUT = ['#######', '#S#   #', '# # # #', '# #G# #', '# ### #', '#     #', '#######'];
const entry = buildSuiteEntry(LAYOUT, 'spiral.txt', 'original');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Answers cycle through all four directions, so wall bumps, moves closer and moves further all occur. */
function stubModels(): void {
  const cycle: Move[] = ['down', 'down', 'up', 'right', 'down', 'down', 'down', 'down', 'right', 'right', 'left', 'right', 'right'];
  let i = 0;
  vi.stubEnv('LAYA_API_KEY', 'fake-laya-key-123456789');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const move = cycle[i++ % cycle.length];
      const body = url.includes('/api/chat') ? { message: { content: JSON.stringify({ move }) } } : { answers: { move: { choice: move.toUpperCase() } } };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

describe('word vocabulary', () => {
  it('maps smell to closeness using distance = 101 − smell', () => {
    expect(closenessWords(100)).toMatch(/overwhelming/);
    expect(closenessWords(99)).toMatch(/overwhelming/);
    expect(closenessWords(98)).toBe('the smell is strong');
    expect(closenessWords(96)).toBe('the smell is strong');
    expect(closenessWords(95)).toBe('the smell is noticeable');
    expect(closenessWords(91)).toBe('the smell is noticeable');
    expect(closenessWords(90)).toBe('the smell is faint');
  });

  it('describes visit counts in words', () => {
    expect([0, 1, 2, 3, 7].map(visitWords)).toEqual([
      "you haven't been there",
      "you've been there before",
      "you've been there before",
      "you've been there many times",
      "you've been there many times",
    ]);
  });

  it('describes how the last step went', () => {
    const state = (x: number, smell: number) => ({ position: { x, y: 1 }, perception: { smell } }) as unknown as DecisionState;
    expect(feedbackWords(state(1, 90), null)).toBe('You have just started.');
    expect(feedbackWords(state(2, 91), { position: { x: 1, y: 1 }, smell: 90, choice: 'right', blocked: false })).toMatch(/closer: the smell got stronger/);
    expect(feedbackWords(state(2, 89), { position: { x: 1, y: 1 }, smell: 90, choice: 'right', blocked: false })).toMatch(/further: the smell got weaker/);
    expect(feedbackWords(state(1, 90), { position: { x: 1, y: 1 }, smell: 90, choice: 'up', blocked: true })).toBe('You bumped into a wall.');
    expect(feedbackWords(state(1, 90), { position: { x: 1, y: 1 }, smell: 90, choice: null, blocked: false })).toBe('You did not move on your last turn.');
  });
});

describe('word requests', () => {
  for (const model of MODELS)
    for (const variant of VARIANTS.filter((v) => v !== 'numbers-baseline'))
      it(`${model}-${variant}: no digits anywhere in what the model reads, over a whole run`, async () => {
        stubModels();
        const requests: CapturedRequest[] = [];
        const run = await runEpisode(entry, createWordPolicy(model, variant, NETWORK, (r) => requests.push(r)), 1, { sleepMs: 0, stepCap: 40 });
        expect(requests.length).toBe(run.requests);
        for (const request of requests) {
          // Ollama's body also carries model "qwen3:1.7b" and temperature 0.2; the model reads only messages.
          const serialised = JSON.stringify(model === 'laya' ? request.body : request.body.messages);
          expect(serialised).not.toMatch(/\d/);
          expect(serialised).not.toMatch(/score|visits=|smell=/i);
        }
        const text = requests.map((r) => JSON.stringify(r.body)).join('\n');
        expect(text).toMatch(/You are a mouse in a dark maze, searching for cheese by smell\./);
        expect(text).toMatch(/smell is (faint|noticeable|strong)|overwhelming/);
        if (variant === 'words-lookahead') {
          expect(text).toMatch(/the smell grows (stronger|weaker) that way/);
          expect(text).not.toMatch(/You have just started|bumped/);
        } else {
          expect(text).not.toMatch(/grows (stronger|weaker) that way/);
          for (const phrase of ['You have just started.', 'took you closer', 'took you further', 'You bumped into a wall.']) expect(text).toContain(phrase);
        }
      });

  it('offers only legal moves, in a seeded shuffled order', async () => {
    stubModels();
    const orders = (seed: number) => {
      const seen: string[][] = [];
      return runEpisode(entry, createWordPolicy('laya', 'words-lookahead', NETWORK, (r) => seen.push(Object.keys((r.body as any).questions.move.criteria))), 1, { sleepMs: 0, stepCap: 30, rngSeed: seed }).then(() => seen);
    };
    const a = await orders(7);
    stubModels();
    expect(await orders(7)).toEqual(a);
    stubModels();
    expect(await orders(8)).not.toEqual(a);
    expect(a.some((keys) => keys.length > 1 && keys[0] !== ['UP', 'DOWN', 'LEFT', 'RIGHT'].find((k) => keys.includes(k)))).toBe(true);
  });

  it('keeps the numeric Laya baseline passing the criteria check when shuffled', async () => {
    stubModels();
    const run = await runEpisode(entry, createWordPolicy('laya', 'numbers-baseline', NETWORK), 1, { sleepMs: 0, stepCap: 30 });
    expect(run.criteriaChecked).toBeGreaterThan(10);
    expect(run.criteriaMismatches).toBe(0);
  });
});

describe('experiment rules', () => {
  it('caps steps at max(3 × optimal, 60)', () => {
    expect(stepCapFor(8)).toBe(60);
    expect(stepCapFor(30)).toBe(90);
  });

  it('counts moves toward stronger smell, walls as not toward', () => {
    const corridor = buildSuiteEntry(['#####', '#S G#', '#####'], 'c.txt', 'original');
    expect(towardStrongerSmell(corridor, ['up#wall', '!timeout', 'right', 'left', 'right', 'right'])).toEqual({ toward: 3, chosen: 5 });
  });
});
