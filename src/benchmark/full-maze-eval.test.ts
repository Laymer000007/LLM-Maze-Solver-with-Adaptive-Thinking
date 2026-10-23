import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Maze } from '@/maze/maze';
import type { Move } from '@/execution/execution';
import {
  TRANSFORMS, bfsShortestPath, resolveLayaKey, buildSuiteEntry, createPolicies, layaBody, rng, runEpisode, runsCsv, runsJson, seededShuffle, stepCapFor, transformLayout, transformPosition, wilson,
  type DecisionState, type Policy,
} from './full-maze-eval';

const LAYOUT = ['#######', '#S#   #', '# # # #', '#   #G#', '#######'];
const CORRIDOR = ['#####', '#S G#', '#####'];
const NETWORK = { timeoutMs: 1000, ollamaUrl: 'http://ollama.invalid', ollamaModel: 'qwen3:1.7b', layaUrl: 'http://laya.invalid' };
const fixed = (choose: (state: DecisionState) => Move | null, failure?: 'timeout' | 'http' | 'parse'): Policy => ({ id: 'fixed-rd', deterministic: true, config: { payloadBuilder: 'test', endpoint: null, model: null, think: null, temperature: null, format: null, optionOrdering: 'test' }, decide: async (state) => ({ choice: choose(state), latencyMs: failure ? 5 : null, failure }) });

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('maze transforms', () => {
  it('moves start and goal with the layout and stays solvable', async () => {
    const original = new Maze(LAYOUT);
    const expected = { original: [{ x: 1, y: 1 }, { x: 5, y: 3 }], 'mirror-h': [{ x: 5, y: 1 }, { x: 1, y: 3 }], 'mirror-v': [{ x: 1, y: 3 }, { x: 5, y: 1 }], 'rotate-180': [{ x: 5, y: 3 }, { x: 1, y: 1 }] };
    for (const transform of TRANSFORMS) {
      const entry = buildSuiteEntry(LAYOUT, 'test.txt', transform);
      expect([entry.start, entry.goal]).toEqual(expected[transform]);
      expect(entry.start).toEqual(transformPosition(original.startPosition, original.width, original.height, transform));
      const maze = new Maze(entry.layout);
      expect(maze.startPosition).toEqual(entry.start);
      expect(maze.goalPosition).toEqual(entry.goal);
      expect(bfsShortestPath(entry.layout, entry.start, entry.goal)).toBe(entry.optimalSteps);
      expect(entry.optimalSteps).toBe(bfsShortestPath(LAYOUT, original.startPosition, original.goalPosition));
    }
  });

  it('round-trips each transform and rejects ragged rows', () => {
    for (const transform of TRANSFORMS) expect(transformLayout(transformLayout(LAYOUT, transform), transform)).toEqual(LAYOUT);
    expect(() => transformLayout(['###', '#'], 'mirror-h')).toThrow(/ragged/);
  });

  it('keeps every repository maze solvable in every orientation', async () => {
    const dir = path.resolve(__dirname, '../../mazes');
    for (const file of (await fs.readdir(dir)).filter((f) => f.endsWith('.txt'))) {
      const maze = await Maze.fromFile(path.join(dir, file));
      for (const transform of TRANSFORMS) expect(buildSuiteEntry(maze.layout, file, transform).optimalSteps).toBeGreaterThan(0);
    }
  });
});

describe('BFS', () => {
  it('finds shortest paths and reports unreachable goals', () => {
    expect(bfsShortestPath(CORRIDOR, { x: 1, y: 1 }, { x: 3, y: 1 })).toBe(2);
    expect(bfsShortestPath(LAYOUT, { x: 1, y: 1 }, { x: 5, y: 3 })).toBe(10);
    expect(bfsShortestPath(['#####', '#S#G#', '#####'], { x: 1, y: 1 }, { x: 3, y: 1 })).toBeNull();
  });
});

describe('run loop', () => {
  const entry = buildSuiteEntry(CORRIDOR, 'corridor.txt', 'original');

  it('applies the step cap rule', () => {
    expect(stepCapFor(10)).toBe(200);
    expect(stepCapFor(60)).toBe(240);
  });

  it('records wall choices as illegal, keeps the mouse in place, and counts the step', async () => {
    let calls = 0;
    const run = await runEpisode(entry, fixed(() => (++calls <= 2 ? 'up' : 'right')), 1, { sleepMs: 0 });
    expect(run.status).toBe('completed');
    expect(run.moves).toEqual(['up#wall', 'up#wall', 'right', 'right']);
    expect(run.steps).toBe(4);
    expect(run.illegalMoves).toBe(2);
    expect(run.successfulMoves).toBe(2);
    expect(run.illegalRate).toBe(0.5);
    expect(run.efficiency).toBe(0.5);
    expect(run.finalHealth).toBe(80);
  });

  it('stops at the step cap without completing', async () => {
    const run = await runEpisode(entry, fixed(() => 'up'), 1, { sleepMs: 0, stepCap: 7 });
    expect(run.status).toBe('step-cap');
    expect(run.completed).toBe(false);
    expect(run.steps).toBe(7);
    expect(run.efficiency).toBeNull();
  });

  it('aborts after three consecutive failed requests and resets the streak on success', async () => {
    const aborted = await runEpisode(entry, fixed(() => null, 'timeout'), 1, { sleepMs: 0 });
    expect(aborted.status).toBe('aborted');
    expect(aborted.steps).toBe(3);
    expect(aborted.timeouts).toBe(3);
    expect(aborted.successfulMoves).toBe(0);

    const script: Array<'fail' | Move> = ['fail', 'fail', 'left', 'fail', 'fail', 'right', 'right'];
    let i = 0;
    const flaky: Policy = { ...fixed(() => null), decide: async () => { const next = script[i++]; return next === 'fail' ? { choice: null, latencyMs: 1, failure: 'http' } : { choice: next, latencyMs: 1 }; } };
    const recovered = await runEpisode(entry, flaky, 1, { sleepMs: 0 });
    expect(recovered.status).toBe('completed');
    expect(recovered.httpFailures).toBe(4);
    expect(recovered.moves).toEqual(['!http', '!http', 'left#wall', '!http', '!http', 'right', 'right']);
  });

  it('counts revisits and immediate reversals', async () => {
    const script: Move[] = ['right', 'left', 'right', 'right'];
    let i = 0;
    const run = await runEpisode(entry, fixed(() => script[i++]), 1, { sleepMs: 0 });
    expect(run.status).toBe('completed');
    expect(run.revisits).toBe(2);
    expect(run.immediateReversals).toBe(2);
    expect(run.revisitRate).toBe(0.5);
  });
});

describe('statistics and randomness', () => {
  it('computes Wilson intervals', () => {
    const { low, high } = wilson(5, 10);
    expect(low).toBeCloseTo(0.2366, 3);
    expect(high).toBeCloseTo(0.7634, 3);
    expect(wilson(0, 10).low).toBe(0);
    expect(wilson(10, 10).high).toBeCloseTo(1, 10);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 0 });
  });

  it('shuffles deterministically per seed without losing items', () => {
    const moves: Move[] = ['up', 'down', 'left', 'right'];
    const a = seededShuffle(moves, rng(42)); const b = seededShuffle(moves, rng(42));
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([...moves].sort());
    const orders = new Set(Array.from({ length: 20 }, (_, seed) => seededShuffle(moves, rng(seed + 1)).join()));
    expect(orders.size).toBeGreaterThan(1);
  });

  it('puts shuffled options into the Laya criteria in the shuffled order', async () => {
    const maze = new Maze(['#####', '#   #', '# S #', '#  G#', '#####']);
    const { AgentMemory } = await import('@/agent/memory');
    const memory = new AgentMemory(); const perception = maze.perceive(maze.startPosition); memory.rememberPerception(perception, true);
    const state: DecisionState = { position: maze.startPosition, goal: maze.goalPosition, perception, memory: memory.snapshot(), validActions: ['up', 'down', 'left', 'right'] };
    const body = layaBody(state, 'B-constrained', ['left', 'up', 'right', 'down']) as any;
    expect(Object.keys(body.questions.move.criteria)).toEqual(['LEFT', 'UP', 'RIGHT', 'DOWN']);
  });
});

describe('credentials', () => {
  const FAKE_KEY = 'fake-laya-key-123456789';
  const entry = buildSuiteEntry(CORRIDOR, 'corridor.txt', 'original');

  const tempDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'full-maze-eval-'));

  it('fails clearly when neither LAYA_API_KEY nor the key file is available', async () => {
    vi.stubEnv('LAYA_API_KEY', '');
    vi.stubEnv('LAYA_API_KEY_FILE', path.join(await tempDir(), 'missing'));
    vi.stubGlobal('fetch', vi.fn());
    const [policy] = createPolicies(['laya-constrained'], NETWORK);
    await expect(runEpisode(entry, policy, 1, { sleepMs: 0 })).rejects.toThrow(/No Laya key: LAYA_API_KEY is not set and .*missing/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads and trims the key from LAYA_API_KEY_FILE when LAYA_API_KEY is unset', async () => {
    const dir = await tempDir(); const file = path.join(dir, 'api_key');
    await fs.writeFile(file, `  ${FAKE_KEY}\n`, { mode: 0o600 });
    vi.stubEnv('LAYA_API_KEY', '');
    vi.stubEnv('LAYA_API_KEY_FILE', file);
    expect(resolveLayaKey()).toBe(FAKE_KEY);
    const authorization: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      authorization.push((init.headers as Record<string, string>).authorization);
      return new Response(JSON.stringify({ answers: { move: { choice: 'RIGHT' } } }), { status: 200 });
    }));
    const [policy] = createPolicies(['laya-constrained'], NETWORK);
    const run = await runEpisode(entry, { ...policy, decide: async (state, random) => { const d = await policy.decide(state, random); return { ...d, error: `echo ${FAKE_KEY}` }; } }, 1, { sleepMs: 0 });
    expect(authorization).toEqual([`Bearer ${FAKE_KEY}`, `Bearer ${FAKE_KEY}`]);
    expect(run.completed).toBe(true);
    const output = runsJson({}, [run]) + runsCsv([run]);
    expect(output).not.toContain(FAKE_KEY);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('prefers LAYA_API_KEY over the key file', async () => {
    const dir = await tempDir(); const file = path.join(dir, 'api_key');
    await fs.writeFile(file, 'file-key-should-not-win', { mode: 0o600 });
    vi.stubEnv('LAYA_API_KEY', FAKE_KEY);
    vi.stubEnv('LAYA_API_KEY_FILE', file);
    expect(resolveLayaKey()).toBe(FAKE_KEY);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('never writes the key into serialised output, even when an error echoes it', async () => {
    vi.stubEnv('LAYA_API_KEY', FAKE_KEY);
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${FAKE_KEY}`);
      if (++call === 1) throw new Error(`connection reset; sent ${(init.headers as Record<string, string>).authorization}`);
      return new Response(JSON.stringify({ answers: { move: { choice: 'RIGHT' } } }), { status: 200 });
    }));
    const policies = createPolicies(['laya-constrained', 'laya-raw'], NETWORK);
    const runs = [];
    for (const policy of policies) runs.push(await runEpisode(entry, policy, 1, { sleepMs: 0 }));
    expect(runs[0].httpFailures).toBe(1);
    expect(runs.every((run) => run.completed)).toBe(true);
    const output = runsJson({ layaUrl: NETWORK.layaUrl }, runs) + runsCsv(runs);
    expect(output).not.toContain(FAKE_KEY);
    expect(output).toContain('[REDACTED]');
  });
});
