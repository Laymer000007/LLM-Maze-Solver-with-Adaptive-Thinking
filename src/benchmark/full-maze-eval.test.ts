import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Maze, type LocalPerception, type Position } from '@/maze/maze';
import { MOVES } from '@/execution/execution';
import type { AgentMemoryState } from '@/agent/memory';
import type { Move } from '@/execution/execution';
import {
  TRANSFORMS, bfsShortestPath, resolveLayaKey, layaBody as buildLayaBody, ollamaRequestBody, rawNoSmellPrompt, seedCount, stuckWindowFor, buildSuiteEntry, createPolicies, layaBody, rng, runEpisode, runsCsv, runsJson, seededShuffle, stepCapFor, transformLayout, transformPosition, wilson,
  type DecisionState, type Policy,
} from '@/benchmark/full-maze-eval-lib';

const LAYOUT = ['#######', '#S#   #', '# # # #', '#   #G#', '#######'];
const CORRIDOR = ['#####', '#S G#', '#####'];
const NETWORK = { timeoutMs: 1000, ollamaUrl: 'http://ollama.invalid', ollamaModel: 'qwen3:1.7b', layaUrl: 'http://laya.invalid' };
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
    for (const text of [JSON.stringify(buildLayaBody(state, 'A-raw-nosmell')), rawNoSmellPrompt(state), JSON.stringify((ollamaRequestBody('m', rawNoSmellPrompt(state), false) as any).messages)]) {
      expect(text).not.toMatch(/smell|score/i);
      for (const number of text.match(/-?\d+/g) ?? []) expect(allowed.has(number)).toBe(true);
      for (const value of [...smells, ...scores.filter((v) => !allowed.has(String(v)))]) expect(text).not.toMatch(new RegExp(`(^|\\D)${value}(\\D|$)`));
      expect(text).toMatch(/wall/);
      expect(text).toMatch(/visits=2|visits=1/);
      expect(text.includes(`(${position.x},${position.y})`) || text.includes(`(${position.x},${position.y})`.replace(/"/g, ''))).toBe(true);
    }
    expect(Object.keys((buildLayaBody(state, 'A-raw-nosmell') as any).questions.move.criteria)).toEqual(['UP', 'DOWN', 'LEFT', 'RIGHT']);
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

describe('seed counts', () => {
  it('runs Laya once only when the determinism check passed, random-legal three times and Ollama once', () => {
    const [scorer, random, laya, ollama] = createPolicies(['scorer', 'random-legal', 'laya-constrained-shuffled', 'ollama-raw-nosmell'], NETWORK);
    expect([scorer, random, laya, ollama].map((p) => seedCount(p, 'tier-a', true))).toEqual([1, 3, 1, 1]);
    expect(seedCount(laya, 'tier-a', false)).toBe(3);
    expect(seedCount(random, 'smoke', true)).toBe(1);
  });
});

describe('criteria check', () => {
  const maze = ['#######', '#S    #', '# ### #', '#    G#', '#######'];
  it('finds no mismatches in the real laya-constrained payload and flags a tampered one', async () => {
    vi.stubEnv('LAYA_API_KEY', 'fake-laya-key-123456789');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ answers: { move: { choice: 'RIGHT' } } }), { status: 200 })));
    const entry = buildSuiteEntry(maze, 'm.txt', 'original');
    const [policy] = createPolicies(['laya-constrained'], NETWORK);
    const run = await runEpisode(entry, policy, 1, { sleepMs: 0, stepCap: 20 });
    expect(run.criteriaChecked).toBeGreaterThan(5);
    expect(run.criteriaMismatches).toBe(0);
    const tampered: Policy = { ...policy, decide: async (state, random) => { const d = await policy.decide(state, random); return { ...d, criteria: Object.fromEntries(Object.entries(d.criteria!).map(([k, v]) => [k, v.replace(/visited (\d+)$/, (_, n) => `visited ${Number(n) + 1}`)])) }; } };
    const bad = await runEpisode(entry, tampered, 1, { sleepMs: 0, stepCap: 3 });
    expect(bad.criteriaMismatches).toBe(bad.criteriaChecked);
    expect(bad.errors[0]).toMatch(/criteria mismatch/);
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

// Verbatim copy of the benchmark.ts builders (importing benchmark.ts would run its main()).
namespace reference {
  type FrozenState = { position: Position; goal: Position; perception: LocalPerception; memory: AgentMemoryState; validActions: Move[] };
  type Experiment = 'A-raw' | 'B-constrained' | 'C-repeated';
  const MOVES4 = [...MOVES] as Move[];
  const key = (p: Position) => `${p.x},${p.y}`;
  function nextPosition(position: Position, move: Move): Position { return move === 'up' ? { x: position.x, y: position.y - 1 } : move === 'down' ? { x: position.x, y: position.y + 1 } : move === 'left' ? { x: position.x - 1, y: position.y } : { x: position.x + 1, y: position.y }; }
  function rawPrompt(state: FrozenState): string {
    const p = state.perception; const directions = MOVES4.map((move) => `${move.toUpperCase()}: ${p.directions[move]}; smell=${p.directionSmell[move]}; ${p.directions[move] === 'wall' ? 'blocked' : 'open'}; visits=${state.memory.visitCounts[key(nextPosition(state.position, move))] ?? 0}`).join('\n');
    return ['You control a mouse navigating a maze.', `Current position: (${state.position.x},${state.position.y})`, `Goal position: (${state.goal.x},${state.goal.y})`, `Current smell: ${p.smell}`, 'Choose exactly one movement label: UP, DOWN, LEFT, RIGHT.', directions, 'Return only JSON: {"move":"up|down|left|right"}.'].join('\n');
  }
  function constrainedPrompt(state: FrozenState): string {
    const choices = state.validActions.map((move) => `${move.toUpperCase()}: score=${state.memory.actionEffects[move]?.totalExpectedEiLDelta ?? 'n/a'}; visits=${state.memory.visitCounts[key(nextPosition(state.position, move))] ?? 0}; smell=${state.perception.directionSmell[move]}`).join('\n');
    return ['Choose the best legal movement for a maze mouse.', `Current position: (${state.position.x},${state.position.y})`, `Goal position: (${state.goal.x},${state.goal.y})`, 'Only these legal choices are available:', choices, 'Return only JSON: {"move":"up|down|left|right"}.'].join('\n');
  }
  export function layaBody(state: FrozenState, experiment: Experiment): Record<string, unknown> {
    const legal = experiment === 'A-raw' ? MOVES4 : state.validActions; const descriptions = Object.fromEntries(legal.map((move) => [move.toUpperCase(), experiment === 'A-raw' ? `${move} movement; local state ${state.perception.directions[move]}, smell ${state.perception.directionSmell[move]}` : `${move} movement; existing expected sensor score ${state.memory.actionEffects[move]?.totalExpectedEiLDelta}; visited ${state.memory.visitCounts[key(nextPosition(state.position, move))] ?? 0}`]));
    const prompt = experiment === 'A-raw' ? rawPrompt(state) : constrainedPrompt(state);
    return { state: { body: prompt }, questions: { move: { type: 'choice', instructions: 'Choose exactly one movement direction. Return the direction label.', criteria: descriptions } } };
  }
}

describe('Laya payload parity with benchmark.ts', () => {
  it('builds byte-identical bodies for the frozen dataset states', async () => {
    const file = path.resolve(__dirname, '../../benchmark-results/frozen-dataset.json');
    const { states } = JSON.parse(await fs.readFile(file, 'utf-8')) as { states: DecisionState[] };
    expect(states.length).toBeGreaterThanOrEqual(10);
    for (const state of states) {
      expect(JSON.stringify(layaBody(state, 'B-constrained'))).toBe(JSON.stringify(reference.layaBody(state, 'B-constrained')));
      expect(JSON.stringify(layaBody(state, 'A-raw'))).toBe(JSON.stringify(reference.layaBody(state, 'A-raw')));
    }
  });
});
