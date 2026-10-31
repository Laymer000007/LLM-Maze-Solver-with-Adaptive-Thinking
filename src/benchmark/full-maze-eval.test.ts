import fs from 'fs/promises';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Maze } from '@/maze/maze';
import type { Move } from '@/execution/execution';
import {
  TRANSFORMS, bfsShortestPath, ollamaRequestBody, rawNoSmellPrompt, seedCount, stuckWindowFor, buildSuiteEntry, createPolicies, rng, runEpisode, runsCsv, runsJson, seededShuffle, stepCapFor, transformLayout, transformPosition, wilson,
  type DecisionState, type Policy,
} from '@/benchmark/full-maze-eval-lib';

const LAYOUT = ['#######', '#S#   #', '# # # #', '#   #G#', '#######'];
const CORRIDOR = ['#####', '#S G#', '#####'];
const NETWORK = { timeoutMs: 1000, ollamaUrl: 'http://ollama.invalid', ollamaModel: 'qwen3:1.7b' };
const fixed = (choose: (state: DecisionState) => Move | null, failure?: 'timeout' | 'http' | 'parse'): Policy => ({ id: 'fixed-rd', kind: 'baseline', deterministic: true, config: { payloadBuilder: 'test', endpoint: null, model: null, think: null, temperature: null, format: null, optionOrdering: 'test', sees: 'test' }, decide: async (state) => ({ choice: choose(state), latencyMs: failure ? 5 : null, failure }) });

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

describe('stuck rule', () => {
  const corridor = buildSuiteEntry(['#######', '#S    #', '##### #', '#G    #', '#######'], 'long.txt', 'original');

  it('uses max(50, 2 × optimalSteps)', () => {
    expect(stuckWindowFor(10)).toBe(50);
    expect(stuckWindowFor(60)).toBe(120);
  });

  it('ends an oscillating run as stuck once no new cell has been visited for the window', async () => {
    let i = 0;
    const run = await runEpisode(corridor, fixed(() => (i++ % 2 === 0 ? 'right' : 'left')), 1, { sleepMs: 0 });
    expect(run.status).toBe('stuck');
    expect(run.stuck).toBe(true);
    expect(run.completed).toBe(false);
    expect(run.lastNewCellStep).toBe(1);
    expect(run.steps).toBe(1 + run.stuckWindow);
  });

  it('ends a run that keeps hitting the same wall as stuck, not step-cap', async () => {
    const run = await runEpisode(corridor, fixed(() => 'up'), 1, { sleepMs: 0 });
    expect(run.status).toBe('stuck');
    expect(run.lastNewCellStep).toBe(0);
    expect(run.steps).toBe(run.stuckWindow);
    expect(run.illegalMoves).toBe(run.stuckWindow);
  });

  it('resets the window whenever a new cell is visited', async () => {
    const script: Move[] = ['right', 'left', 'right', 'right', 'left', 'right', 'right'];
    let i = 0;
    const run = await runEpisode(corridor, fixed(() => script[i++] ?? 'left'), 1, { sleepMs: 0, stuckWindow: 4 });
    expect(run.lastNewCellStep).toBe(7);
    expect(run.status).toBe('stuck');
    expect(run.steps).toBe(11);
  });

  it('does not override completion or the step cap when the cap comes first', async () => {
    const reached = await runEpisode(buildSuiteEntry(CORRIDOR, 'c.txt', 'original'), fixed(() => 'right'), 1, { sleepMs: 0, stuckWindow: 1 });
    expect(reached.status).toBe('completed');
    const capped = await runEpisode(corridor, fixed(() => 'up'), 1, { sleepMs: 0, stepCap: 10 });
    expect(capped.status).toBe('step-cap');
  });
});

describe('smell-free payloads', () => {
  it('serialise without any smell or score value, keeping walls, visits and coordinates', async () => {
    const maze = new Maze(['#########', '#S      #', '# ##### #', '#     #G#', '#########']);
    const { AgentMemory } = await import('@/agent/memory');
    const memory = new AgentMemory();
    let position = maze.startPosition;
    for (const move of ['right', 'right', 'left'] as Move[]) {
      const perception = maze.perceive(position);
      memory.rememberPerception(perception, position === maze.startPosition);
      const target = { x: position.x + (move === 'right' ? 1 : -1), y: position.y };
      memory.rememberAction({ from: position, move, succeeded: true, to: target, message: 'move', effects: memory.evaluate(perception, move) });
      position = target;
    }
    const perception = maze.perceive(position);
    memory.rememberPerception(perception);
    const snapshot = memory.snapshot();
    const state: DecisionState = { position, goal: maze.goalPosition, perception, memory: snapshot, validActions: ['left', 'right'] };
    const smells = [perception.smell, ...(['up', 'down', 'left', 'right'] as Move[]).filter((m) => perception.directions[m] !== 'wall').map((m) => perception.directionSmell[m])];
    const scores = Object.values(snapshot.actionEffects).map((e) => e!.totalExpectedEiLDelta);
    expect(smells.every((v) => v > 9)).toBe(true);
    const allowed = new Set([0, position.x, position.y, maze.goalPosition.x, maze.goalPosition.y, ...Object.values(snapshot.visitCounts)].map(String));
    for (const text of [rawNoSmellPrompt(state), JSON.stringify((ollamaRequestBody('m', rawNoSmellPrompt(state), false) as any).messages)]) {
      expect(text).not.toMatch(/smell|score/i);
      for (const number of text.match(/-?\d+/g) ?? []) expect(allowed.has(number)).toBe(true);
      for (const value of [...smells, ...scores.filter((v) => !allowed.has(String(v)))]) expect(text).not.toMatch(new RegExp(`(^|\\D)${value}(\\D|$)`));
      expect(text).toMatch(/wall/);
      expect(text).toMatch(/visits=2|visits=1/);
      expect(text.includes(`(${position.x},${position.y})`) || text.includes(`(${position.x},${position.y})`.replace(/"/g, ''))).toBe(true);
    }
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
});

describe('seed counts', () => {
  it('runs scorer once, random-legal three times and Ollama once in a tier, and everything once in smoke', () => {
    const [scorer, random, ollama] = createPolicies(['scorer', 'random-legal', 'ollama-raw-nosmell'], NETWORK);
    expect([scorer, random, ollama].map((p) => seedCount(p, 'tier-a'))).toEqual([1, 3, 1]);
    expect(seedCount(random, 'smoke')).toBe(1);
  });
});
