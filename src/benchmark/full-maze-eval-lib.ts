import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';

import { AgentMemory, type AgentMemoryState } from '@/agent/memory';
import { MOVES, type Move } from '@/execution/execution';
import { Maze, type LocalPerception, type Position } from '@/maze/maze';

// Full-maze evaluation harness: maze suite, payload builders, model calls, policies, run loop, aggregation and
// report generation. Side-effect free: the CLI lives in full-maze-eval.ts, which nothing imports. Payload builders
// are copied from benchmark.ts (importing it would run its main()).

export type Transform = 'original' | 'mirror-h' | 'mirror-v' | 'rotate-180';
export const TRANSFORMS: Transform[] = ['original', 'mirror-h', 'mirror-v', 'rotate-180'];
export type SuiteEntry = {
  id: string;
  sourceFile: string;
  transform: Transform;
  width: number;
  height: number;
  layout: string[];
  start: Position;
  goal: Position;
  optimalSteps: number;
};
export type PolicyId = 'scorer' | 'fixed-rd' | 'random-legal' | 'ollama-constrained' | 'ollama-raw' | 'ollama-raw-nosmell' | 'ollama-constrained-think';
export const DEFAULT_POLICIES: PolicyId[] = ['scorer', 'fixed-rd', 'random-legal', 'ollama-constrained', 'ollama-raw', 'ollama-raw-nosmell'];
export const ALL_POLICIES: PolicyId[] = [...DEFAULT_POLICIES, 'ollama-constrained-think'];
export const TIER_A_POLICIES: PolicyId[] = ['scorer', 'fixed-rd', 'random-legal'];
export const TIER_B_POLICIES: PolicyId[] = ['ollama-constrained', 'ollama-raw', 'ollama-raw-nosmell'];
/** Stratified Tier B subset: sizes 5–50, both open_detour sizes, both spiral sizes, plus dead-end, loop and the 50×50. */
export const TIER_B_MAZES = [
  'mazes/5x5_open_empty.txt',
  'mazes/7x7_corridor_spiral.txt',
  'mazes/7x7_open_detour.txt',
  'mazes/11x11_corridor_dead-end.txt',
  'mazes/11x11_corridor_loop.txt',
  'mazes/15x15_corridor_spiral.txt',
  'mazes/15x15_open_detour.txt',
  'mazes/50x50_exploration.txt',
];
export type FailureKind = 'timeout' | 'http' | 'parse';
export type DecisionState = { position: Position; goal: Position; perception: LocalPerception; memory: AgentMemoryState; validActions: Move[] };
/** latencyMs is null for policies that make no request. presented is the option order shown to a model. */
export type Decision = {
  choice: Move | null;
  latencyMs: number | null;
  failure?: FailureKind;
  error?: string;
  presented?: Move[];
};
export type PolicyConfig = {
  payloadBuilder: string;
  endpoint: string | null;
  model: string | null;
  think: boolean | null;
  temperature: number | null;
  format: string | null;
  optionOrdering: string;
  /** What the policy is shown that carries goal-distance information. */
  sees: string;
  notes?: string;
};
export type PolicyKind = 'baseline' | 'ollama';
/** deterministic: run with one seed regardless of mode. */
export type Policy = {
  id: PolicyId;
  kind: PolicyKind;
  deterministic: boolean;
  config: PolicyConfig;
  decide(state: DecisionState, random: () => number): Promise<Decision>;
};
export type RunStatus = 'completed' | 'step-cap' | 'stuck' | 'aborted';
export type RunRecord = {
  runId: string;
  mazeId: string;
  sourceFile: string;
  transform: Transform;
  policy: PolicyId;
  seed: number;
  rngSeed: number;
  status: RunStatus;
  completed: boolean;
  aborted: boolean;
  stuck: boolean;
  steps: number;
  stepCap: number;
  stuckWindow: number;
  lastNewCellStep: number;
  optimalSteps: number;
  efficiency: number | null;
  successfulMoves: number;
  illegalMoves: number;
  illegalRate: number;
  revisits: number;
  revisitRate: number;
  immediateReversals: number;
  maxCellVisits: number;
  loopDetected: boolean;
  requests: number;
  timeouts: number;
  httpFailures: number;
  parseFailures: number;
  totalInferenceMs: number;
  wallClockMs: number;
  meanLatencyMs: number | null;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  dirUp: number;
  dirDown: number;
  dirLeft: number;
  dirRight: number;
  multiOptionDecisions: number;
  firstOptionChosen: number;
  scorerAgreement: number;
  healthDepletedAtStep: number | null;
  finalHealth: number;
  finalEiL: number;
  errors: string[];
  moves: string[];
};
export type EpisodeOptions = { sleepMs?: number; maxConsecutiveFailures?: number; stepCap?: number; stuckWindow?: number; rngSeed?: number };
export type Mode = 'smoke' | 'tier-a' | 'tier-b';
export type HarnessConfig = {
  mode: Mode;
  policies: PolicyId[];
  seed: number;
  withThinking: boolean;
  outputDir: string;
  mazes: string[] | null;
  timeoutMs: number;
  ollamaUrl: string;
  ollamaModel: string;
};

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MOVES4 = [...MOVES] as Move[];
export const FIXED_ORDER: Move[] = ['right', 'down', 'up', 'left'];
export const TIMEOUT_MS = 45_000;
export const SLEEP_MS = 10;
export const MAX_CONSECUTIVE_FAILURES = 3;
export const REPETITIONS = 3;
export const SMOKE_MAZE = 'mazes/7x7_corridor_branch.txt';
export const SMOKE_TRANSFORMS: Transform[] = ['original', 'rotate-180'];
export const OLLAMA_TEMPERATURE = 0.2;
export const key = (p: Position) => `${p.x},${p.y}`;
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const now = () => new Date().toISOString();

export const stepCapFor = (optimalSteps: number) => Math.max(4 * optimalSteps, 200);
/** A run is stuck when no new cell has been visited in this many steps. Applied identically to every policy. */
export const stuckWindowFor = (optimalSteps: number) => Math.max(50, 2 * optimalSteps);

// ---------- Maze suite ----------

export function transformLayout(layout: string[], transform: Transform): string[] {
  const width = layout[0]?.length ?? 0;
  if (layout.some((row) => row.length !== width)) throw new Error('Cannot transform a maze with ragged rows.');
  const flipX = transform === 'mirror-h' || transform === 'rotate-180';
  const flipY = transform === 'mirror-v' || transform === 'rotate-180';
  const rows = flipY ? [...layout].reverse() : [...layout];
  return flipX ? rows.map((row) => [...row].reverse().join('')) : rows;
}
export function transformPosition(position: Position, width: number, height: number, transform: Transform): Position {
  const flipX = transform === 'mirror-h' || transform === 'rotate-180';
  const flipY = transform === 'mirror-v' || transform === 'rotate-180';
  return { x: flipX ? width - 1 - position.x : position.x, y: flipY ? height - 1 - position.y : position.y };
}
export function bfsShortestPath(layout: string[], start: Position, goal: Position): number | null {
  const walkable = (p: Position) => p.y >= 0 && p.y < layout.length && p.x >= 0 && p.x < layout[p.y].length && layout[p.y][p.x] !== '#';
  const distances = new Map<string, number>([[key(start), 0]]);
  const queue: Position[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    const distance = distances.get(key(current))!;
    if (current.x === goal.x && current.y === goal.y) return distance;
    for (const move of MOVES4) {
      const next = nextPosition(current, move);
      if (walkable(next) && !distances.has(key(next))) {
        distances.set(key(next), distance + 1);
        queue.push(next);
      }
    }
  }
  return null;
}
export function buildSuiteEntry(layout: string[], sourceFile: string, transform: Transform): SuiteEntry {
  const original = new Maze(layout);
  const transformed = new Maze(transformLayout(layout, transform));
  const expectedStart = transformPosition(original.startPosition, original.width, original.height, transform);
  const expectedGoal = transformPosition(original.goalPosition, original.width, original.height, transform);
  if (key(expectedStart) !== key(transformed.startPosition) || key(expectedGoal) !== key(transformed.goalPosition))
    throw new Error(`${sourceFile}@${transform}: start/goal did not move with the layout.`);
  const optimalSteps = bfsShortestPath(transformed.layout, transformed.startPosition, transformed.goalPosition);
  if (optimalSteps === null) throw new Error(`${sourceFile}@${transform}: goal is unreachable.`);
  return {
    id: `${path.basename(sourceFile, '.txt')}@${transform}`,
    sourceFile,
    transform,
    width: transformed.width,
    height: transformed.height,
    layout: transformed.layout,
    start: transformed.startPosition,
    goal: transformed.goalPosition,
    optimalSteps,
  };
}
export async function buildSuite(): Promise<SuiteEntry[]> {
  const files = (await fs.readdir(path.join(ROOT, 'mazes'))).filter((file) => file.endsWith('.txt')).sort();
  const entries: SuiteEntry[] = [];
  for (const file of files) {
    const maze = await Maze.fromFile(path.join(ROOT, 'mazes', file));
    for (const transform of TRANSFORMS) entries.push(buildSuiteEntry(maze.layout, `mazes/${file}`, transform));
  }
  return entries;
}
export function tierBEntries(suite: SuiteEntry[]): SuiteEntry[] {
  return suite.filter((e) => TIER_B_MAZES.includes(e.sourceFile));
}
/**
 * The suite is frozen on first use; later runs must reproduce the same entries exactly. The rules and the
 * Tier B subset are rewritten alongside them, so adding a subset never changes an existing entry.
 */
export async function freezeSuite(outputDir: string, suite: SuiteEntry[]): Promise<void> {
  const file = path.join(outputDir, 'suite.json');
  const tierB = tierBEntries(suite);
  if (tierB.length !== TIER_B_MAZES.length * TRANSFORMS.length) throw new Error('Tier B subset does not match the maze files.');
  const body = JSON.stringify(
    {
      stepCapRule: 'max(4 * optimalSteps, 200)',
      stuckRule: 'stuck when no new cell visited in the last max(50, 2 * optimalSteps) steps',
      tierB: { rule: '1 seed, Ollama policies, 8 mazes × 4 orientations', mazes: TIER_B_MAZES, entryIds: tierB.map((e) => e.id) },
      entries: suite,
    },
    null,
    2,
  );
  const existing = await fs.readFile(file, 'utf-8').catch(() => null);
  if (existing !== null && JSON.stringify(JSON.parse(existing).entries) !== JSON.stringify(suite))
    throw new Error(`${file} entries differ from the suite generated from mazes/. Move it aside to refreeze.`);
  if (existing === body) return;
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(file, body);
}

// ---------- Seeded randomness ----------

export function rng(seed: number): () => number {
  let value = seed >>> 0 || 1;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 0x100000000;
  };
}
export function choose<T>(random: () => number, values: T[]): T {
  return values[Math.floor(random() * values.length) % values.length];
}
export function seededShuffle<T>(values: T[], random: () => number): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
export function runSeed(base: number, ...parts: string[]): number {
  let hash = 0x811c9dc5 ^ (base >>> 0);
  for (const char of parts.join('|')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0 || 1;
}
export function nextPosition(position: Position, move: Move): Position {
  return move === 'up'
    ? { x: position.x, y: position.y - 1 }
    : move === 'down'
      ? { x: position.x, y: position.y + 1 }
      : move === 'left'
        ? { x: position.x - 1, y: position.y }
        : { x: position.x + 1, y: position.y };
}

// ---------- Payload builders (copied from benchmark.ts; `order` only differs for the shuffled policy) ----------

export function rawPrompt(state: DecisionState): string {
  const p = state.perception;
  const directions = MOVES4.map(
    (move) =>
      `${move.toUpperCase()}: ${p.directions[move]}; smell=${p.directionSmell[move]}; ${p.directions[move] === 'wall' ? 'blocked' : 'open'}; visits=${state.memory.visitCounts[key(nextPosition(state.position, move))] ?? 0}`,
  ).join('\n');
  return [
    'You control a mouse navigating a maze.',
    `Current position: (${state.position.x},${state.position.y})`,
    `Goal position: (${state.goal.x},${state.goal.y})`,
    `Current smell: ${p.smell}`,
    'Choose exactly one movement label: UP, DOWN, LEFT, RIGHT.',
    directions,
    'Return only JSON: {"move":"up|down|left|right"}.',
  ].join('\n');
}
export function constrainedPrompt(state: DecisionState, order: Move[] = state.validActions): string {
  const choices = order
    .map(
      (move) =>
        `${move.toUpperCase()}: score=${state.memory.actionEffects[move]?.totalExpectedEiLDelta ?? 'n/a'}; visits=${state.memory.visitCounts[key(nextPosition(state.position, move))] ?? 0}; smell=${state.perception.directionSmell[move]}`,
    )
    .join('\n');
  return [
    'Choose the best legal movement for a maze mouse.',
    `Current position: (${state.position.x},${state.position.y})`,
    `Goal position: (${state.goal.x},${state.goal.y})`,
    'Only these legal choices are available:',
    choices,
    'Return only JSON: {"move":"up|down|left|right"}.',
  ].join('\n');
}
/** rawPrompt() with every smell value removed; walls, visit counts, position and goal stay. Not in benchmark.ts. */
export function rawNoSmellPrompt(state: DecisionState): string {
  const p = state.perception;
  const directions = MOVES4.map(
    (move) =>
      `${move.toUpperCase()}: ${p.directions[move]}; ${p.directions[move] === 'wall' ? 'blocked' : 'open'}; visits=${state.memory.visitCounts[key(nextPosition(state.position, move))] ?? 0}`,
  ).join('\n');
  return [
    'You control a mouse navigating a maze.',
    `Current position: (${state.position.x},${state.position.y})`,
    `Goal position: (${state.goal.x},${state.goal.y})`,
    'Choose exactly one movement label: UP, DOWN, LEFT, RIGHT.',
    directions,
    'Return only JSON: {"move":"up|down|left|right"}.',
  ].join('\n');
}
export function parseMove(value: unknown): Move | null {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const match = text?.match(/\b(up|down|left|right)\b/i);
  return match ? (match[1].toLowerCase() as Move) : null;
}

// ---------- Model calls ----------

export async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<Decision & { json?: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const latencyMs = performance.now() - started;
    if (!response.ok) return { choice: null, latencyMs, failure: 'http', error: `HTTP ${response.status}` };
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { choice: null, latencyMs, failure: 'parse', error: 'Response body is not JSON.' };
    }
    return { choice: null, latencyMs, json };
  } catch (error) {
    const timeout = error instanceof Error && error.name === 'AbortError';
    return {
      choice: null,
      latencyMs: timeout ? timeoutMs : performance.now() - started,
      failure: timeout ? 'timeout' : 'http',
      error: error instanceof Error ? `${error.message}${error.cause ? ` (${String(error.cause)})` : ''}` : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
export function ollamaRequestBody(model: string, prompt: string, think: boolean): Record<string, unknown> {
  return { model, messages: [{ role: 'user', content: prompt }], stream: false, format: 'json', think, options: { temperature: OLLAMA_TEMPERATURE } };
}
/** Like callOllama, but returns message.content unparsed, for answer formats that are not direction words. */
export async function callOllamaRaw(
  ollamaUrl: string,
  model: string,
  prompt: string,
  timeoutMs: number,
): Promise<{ content: string | null; latencyMs: number; failure?: FailureKind; error?: string; promptTokens: number | null }> {
  const result = await postJson(`${ollamaUrl}/api/chat`, {}, ollamaRequestBody(model, prompt, false), timeoutMs);
  if (result.failure) return { content: null, latencyMs: result.latencyMs ?? 0, failure: result.failure, error: result.error, promptTokens: null };
  const content = result.json?.message?.content;
  const promptTokens = typeof result.json?.prompt_eval_count === 'number' ? result.json.prompt_eval_count : null;
  return typeof content === 'string'
    ? { content, latencyMs: result.latencyMs ?? 0, promptTokens }
    : { content: null, latencyMs: result.latencyMs ?? 0, failure: 'parse', error: 'No message.content.', promptTokens };
}
export async function callOllama(ollamaUrl: string, model: string, prompt: string, think: boolean, timeoutMs: number): Promise<Decision> {
  const result = await postJson(`${ollamaUrl}/api/chat`, {}, ollamaRequestBody(model, prompt, think), timeoutMs);
  if (result.failure) return result;
  let parsed: any = null;
  try {
    parsed = JSON.parse(result.json?.message?.content ?? '');
  } catch {
    parsed = null;
  }
  const choice = parseMove(parsed?.move);
  return choice
    ? { choice, latencyMs: result.latencyMs }
    : { choice: null, latencyMs: result.latencyMs, failure: 'parse', error: 'No movement in message.content JSON.' };
}

// ---------- Policies ----------

export function scorerOptimal(state: DecisionState): Move[] {
  const score = (move: Move) => state.memory.actionEffects[move]?.totalExpectedEiLDelta ?? -Infinity;
  const best = Math.max(...state.validActions.map(score));
  return state.validActions.filter((move) => score(move) === best);
}
export function createPolicies(ids: PolicyId[], config: Pick<HarnessConfig, 'timeoutMs' | 'ollamaUrl' | 'ollamaModel'>): Policy[] {
  const ollama = `${config.ollamaUrl}/api/chat`;
  const baseline = (optionOrdering: string, sees: string, notes?: string): PolicyConfig => ({
    payloadBuilder: 'none',
    endpoint: null,
    model: null,
    think: null,
    temperature: null,
    format: null,
    optionOrdering,
    sees,
    notes,
  });
  const ollamaConfig = (payloadBuilder: string, think: boolean, optionOrdering: string, sees: string): PolicyConfig => ({
    payloadBuilder,
    endpoint: ollama,
    model: config.ollamaModel,
    think,
    temperature: OLLAMA_TEMPERATURE,
    format: 'json',
    optionOrdering,
    sees,
  });
  const askOllama = async (prompt: string, think: boolean, presented: Move[]): Promise<Decision> => ({
    ...(await callOllama(config.ollamaUrl, config.ollamaModel, prompt, think, config.timeoutMs)),
    presented,
  });
  const LEGAL = 'legal moves in up,down,left,right order';
  const ALL4 = 'all four directions in up,down,left,right order';
  const SCORES = 'scores (incl. ±10 smell term), visits, smell';
  const SMELL = 'smell, walls, visits';
  const NO_SMELL = 'walls, visits, coordinates only';
  const table: Record<PolicyId, Omit<Policy, 'id'>> = {
    scorer: {
      kind: 'baseline',
      deterministic: true,
      config: baseline('n/a', 'scores (incl. ±10 smell term)', 'argmax totalExpectedEiLDelta over legal moves; ties broken by seeded RNG'),
      decide: async (state, random) => {
        const best = scorerOptimal(state);
        return { choice: choose(random, best.length ? best : MOVES4), latencyMs: null };
      },
    },
    'fixed-rd': {
      kind: 'baseline',
      deterministic: true,
      config: baseline('first legal of RIGHT, DOWN, UP, LEFT', 'walls only'),
      decide: async (state) => ({ choice: FIXED_ORDER.find((move) => state.validActions.includes(move)) ?? 'right', latencyMs: null }),
    },
    'random-legal': {
      kind: 'baseline',
      deterministic: false,
      config: baseline('uniform over legal moves, seeded', 'walls only'),
      decide: async (state, random) => ({ choice: choose(random, state.validActions.length ? state.validActions : MOVES4), latencyMs: null }),
    },
    'ollama-constrained': {
      kind: 'ollama',
      deterministic: false,
      config: ollamaConfig('benchmark.ts constrainedPrompt()', false, LEGAL, SCORES),
      decide: async (state) => askOllama(constrainedPrompt(state), false, state.validActions),
    },
    'ollama-raw': {
      kind: 'ollama',
      deterministic: false,
      config: ollamaConfig('benchmark.ts rawPrompt()', false, ALL4, SMELL),
      decide: async (state) => askOllama(rawPrompt(state), false, MOVES4),
    },
    'ollama-raw-nosmell': {
      kind: 'ollama',
      deterministic: false,
      config: ollamaConfig('rawPrompt() with smell removed', false, ALL4, NO_SMELL),
      decide: async (state) => askOllama(rawNoSmellPrompt(state), false, MOVES4),
    },
    'ollama-constrained-think': {
      kind: 'ollama',
      deterministic: false,
      config: ollamaConfig('benchmark.ts constrainedPrompt()', true, LEGAL, SCORES),
      decide: async (state) => askOllama(constrainedPrompt(state), true, state.validActions),
    },
  };
  return ids.map((id) => ({ id, ...table[id] }));
}

// ---------- Episode loop ----------

export function percentile(sorted: number[], fraction: number): number | null {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : null;
}

/**
 * Replicates the memory-update order of ObservableMazeSolver.run() (src/gui/solver.ts) for one-cell moves:
 * perceive → rememberPerception(start visit on the first physical attempt) → decide → evaluate(from) →
 * rememberAction → (on success) rememberPerception(entered). No cheese travel, no adaptive thinking, and
 * health reaching 0 is recorded but does not end the run. Ends as completed, aborted (3 failed requests in a
 * row), stuck (no new cell for stuckWindow steps) or step-cap.
 */
export async function runEpisode(entry: SuiteEntry, policy: Policy, seed: number, options: EpisodeOptions = {}): Promise<RunRecord> {
  const sleepMs = options.sleepMs ?? SLEEP_MS;
  const maxFailures = options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES;
  const stepCap = options.stepCap ?? stepCapFor(entry.optimalSteps);
  const stuckWindow = options.stuckWindow ?? stuckWindowFor(entry.optimalSteps);
  const maze = new Maze(entry.layout);
  const memory = new AgentMemory();
  const rngSeed = options.rngSeed ?? seed;
  const random = rng(rngSeed);
  const started = performance.now();
  let position = { ...maze.startPosition };
  let status: RunStatus = 'step-cap';
  const visits = new Map<string, number>([[key(position), 1]]);
  const trail: Position[] = [{ ...position }];
  const moves: string[] = [];
  const latencies: number[] = [];
  const errors: string[] = [];
  const failures: Record<FailureKind, number> = { timeout: 0, http: 0, parse: 0 };
  const directions: Record<Move, number> = { up: 0, down: 0, left: 0, right: 0 };
  let steps = 0;
  let physicalAttempts = 0;
  let consecutiveFailures = 0;
  let illegal = 0;
  let successful = 0;
  let revisits = 0;
  let reversals = 0;
  let multiOption = 0;
  let firstChosen = 0;
  let agreement = 0;
  let healthDepletedAtStep: number | null = null;
  let lastNewCellStep = 0;
  const checkHealth = () => {
    if (healthDepletedAtStep === null && memory.snapshot().health <= 0) healthDepletedAtStep = steps;
  };
  while (steps < stepCap) {
    if (steps - lastNewCellStep >= stuckWindow) {
      status = 'stuck';
      break;
    }
    const perception = maze.perceive(position);
    memory.rememberPerception(perception, physicalAttempts === 0);
    const snapshot = memory.snapshot();
    const state: DecisionState = {
      position: { ...position },
      goal: { ...maze.goalPosition },
      perception,
      memory: snapshot,
      validActions: MOVES4.filter((move) => perception.directions[move] !== 'wall'),
    };
    const decision = await policy.decide(state, random);
    steps++;
    if (decision.latencyMs !== null) {
      latencies.push(decision.latencyMs);
      if (sleepMs) await sleep(sleepMs);
    }
    if (decision.failure || !decision.choice) {
      const kind = decision.failure ?? 'parse';
      failures[kind]++;
      moves.push(`!${kind}`);
      if (decision.error && errors.length < 10) errors.push(decision.error);
      // The GUI records an unparseable answer as an invalid action; transport failures have no GUI equivalent (it stops).
      if (kind === 'parse')
        memory.rememberAction({
          from: { ...position },
          move: 'up',
          actionLabel: 'invalid-action',
          succeeded: false,
          to: { ...position },
          message: 'Invalid action.',
        });
      checkHealth();
      if (++consecutiveFailures >= maxFailures) {
        status = 'aborted';
        break;
      }
      continue;
    }
    consecutiveFailures = 0;
    const move = decision.choice;
    directions[move]++;
    if (scorerOptimal(state).includes(move)) agreement++;
    if (decision.presented && decision.presented.length >= 2) {
      multiOption++;
      if (decision.presented[0] === move) firstChosen++;
    }
    const from = { ...position };
    const target = nextPosition(from, move);
    const succeeded = maze.isWalkable(target);
    const effects = memory.evaluate(maze.perceive(from), move);
    physicalAttempts++;
    if (!succeeded) {
      // Never corrected: the wall attempt is recorded, the mouse stays, the step counts.
      illegal++;
      moves.push(`${move}#wall`);
      memory.rememberAction({ from, move, succeeded: false, to: from, message: `WALL COLLISION: You attempted ${move} but hit a wall.`, effects });
      checkHealth();
      continue;
    }
    const targetKey = key(target);
    const revisited = (visits.get(targetKey) ?? 0) > 0;
    const goalReached = targetKey === key(maze.goalPosition);
    if (revisited) revisits++;
    else lastNewCellStep = steps;
    visits.set(targetKey, (visits.get(targetKey) ?? 0) + 1);
    if (trail.length >= 2 && key(trail[trail.length - 2]) === targetKey) reversals++;
    trail.push({ ...target });
    const message = goalReached
      ? 'You reached the goal.'
      : revisited
        ? `You moved ${move} and returned to a previously visited location.`
        : `You moved ${move} successfully.`;
    memory.rememberAction({ from, move, succeeded: true, to: target, message, goalReached, effects });
    position = target;
    successful++;
    moves.push(move);
    memory.rememberPerception(maze.perceive(target));
    checkHealth();
    if (goalReached) {
      status = 'completed';
      break;
    }
  }
  if (status === 'step-cap' && steps - lastNewCellStep >= stuckWindow) status = 'stuck';
  const final = memory.snapshot();
  const sorted = [...latencies].sort((a, b) => a - b);
  const maxCellVisits = Math.max(...visits.values());
  const round = (value: number | null) => (value === null ? null : Math.round(value));
  return {
    runId: `${entry.id}/${policy.id}/${seed}`,
    mazeId: entry.id,
    sourceFile: entry.sourceFile,
    transform: entry.transform,
    policy: policy.id,
    seed,
    rngSeed,
    status,
    completed: status === 'completed',
    aborted: status === 'aborted',
    stuck: status === 'stuck',
    steps,
    stepCap,
    stuckWindow,
    lastNewCellStep,
    optimalSteps: entry.optimalSteps,
    efficiency: status === 'completed' ? entry.optimalSteps / steps : null,
    successfulMoves: successful,
    illegalMoves: illegal,
    illegalRate: steps ? illegal / steps : 0,
    revisits,
    revisitRate: successful ? revisits / successful : 0,
    immediateReversals: reversals,
    maxCellVisits,
    loopDetected: maxCellVisits >= 5,
    requests: latencies.length,
    timeouts: failures.timeout,
    httpFailures: failures.http,
    parseFailures: failures.parse,
    totalInferenceMs: Math.round(latencies.reduce((a, b) => a + b, 0)),
    wallClockMs: Math.round(performance.now() - started),
    meanLatencyMs: round(sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null),
    medianLatencyMs: round(percentile(sorted, 0.5)),
    p95LatencyMs: round(percentile(sorted, 0.95)),
    dirUp: directions.up,
    dirDown: directions.down,
    dirLeft: directions.left,
    dirRight: directions.right,
    multiOptionDecisions: multiOption,
    firstOptionChosen: firstChosen,
    scorerAgreement: agreement,
    healthDepletedAtStep,
    finalHealth: final.health,
    finalEiL: final.eil.score,
    errors,
    moves,
  };
}

// ---------- Aggregation ----------

export function wilson(successes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}
export const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
};
export const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
export const sum = (runs: RunRecord[], pick: (run: RunRecord) => number) => runs.reduce((total, run) => total + pick(run), 0);
export function aggregate(runs: RunRecord[]) {
  const completed = runs.filter((run) => run.completed);
  const steps = sum(runs, (run) => run.steps);
  const moves = sum(runs, (run) => run.successfulMoves);
  const requests = sum(runs, (run) => run.requests);
  const ci = wilson(completed.length, runs.length);
  const multi = sum(runs, (run) => run.multiOptionDecisions);
  const decided = sum(runs, (run) => run.dirUp + run.dirDown + run.dirLeft + run.dirRight);
  return {
    runs: runs.length,
    completed: completed.length,
    completionRate: runs.length ? completed.length / runs.length : 0,
    ciLow: ci.low,
    ciHigh: ci.high,
    aborted: runs.filter((run) => run.aborted).length,
    stuck: runs.filter((run) => run.stuck).length,
    stepCapped: runs.filter((run) => run.status === 'step-cap').length,
    medianStepsCompleted: median(completed.map((run) => run.steps)),
    meanEfficiency: mean(completed.map((run) => run.efficiency ?? 0)),
    illegalRate: steps ? sum(runs, (run) => run.illegalMoves) / steps : 0,
    revisitRate: moves ? sum(runs, (run) => run.revisits) / moves : 0,
    reversalsPerRun: runs.length ? sum(runs, (run) => run.immediateReversals) / runs.length : 0,
    loopRate: runs.length ? runs.filter((run) => run.loopDetected).length / runs.length : 0,
    scorerAgreement: decided ? sum(runs, (run) => run.scorerAgreement) / decided : 0,
    firstOptionRate: multi ? sum(runs, (run) => run.firstOptionChosen) / multi : null,
    requests,
    failures: sum(runs, (run) => run.timeouts + run.httpFailures + run.parseFailures),
    timeouts: sum(runs, (run) => run.timeouts),
    meanLatencyMs: requests ? sum(runs, (run) => run.totalInferenceMs) / requests : null,
    totalWallClockMs: sum(runs, (run) => run.wallClockMs),
    directions: {
      up: sum(runs, (run) => run.dirUp),
      down: sum(runs, (run) => run.dirDown),
      left: sum(runs, (run) => run.dirLeft),
      right: sum(runs, (run) => run.dirRight),
    },
    healthDepletedRuns: runs.filter((run) => run.healthDepletedAtStep !== null).length,
  };
}
export function groupBy<T>(values: T[], pick: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) groups.set(pick(value), [...(groups.get(pick(value)) ?? []), value]);
  return groups;
}

// ---------- Output ----------

export const CSV_HEADERS: (keyof RunRecord)[] = [
  'runId',
  'mazeId',
  'sourceFile',
  'transform',
  'policy',
  'seed',
  'rngSeed',
  'status',
  'completed',
  'aborted',
  'stuck',
  'steps',
  'stepCap',
  'stuckWindow',
  'lastNewCellStep',
  'optimalSteps',
  'efficiency',
  'successfulMoves',
  'illegalMoves',
  'illegalRate',
  'revisits',
  'revisitRate',
  'immediateReversals',
  'maxCellVisits',
  'loopDetected',
  'requests',
  'timeouts',
  'httpFailures',
  'parseFailures',
  'totalInferenceMs',
  'wallClockMs',
  'meanLatencyMs',
  'medianLatencyMs',
  'p95LatencyMs',
  'dirUp',
  'dirDown',
  'dirLeft',
  'dirRight',
  'multiOptionDecisions',
  'firstOptionChosen',
  'scorerAgreement',
  'healthDepletedAtStep',
  'finalHealth',
  'finalEiL',
];
export function runsCsv(runs: RunRecord[]): string {
  return [CSV_HEADERS.join(','), ...runs.map((run) => CSV_HEADERS.map((header) => JSON.stringify(run[header] ?? '')).join(','))].join('\n') + '\n';
}
export function runsJson(metadata: Record<string, unknown>, runs: RunRecord[]): string {
  return JSON.stringify({ metadata, runs }, null, 2);
}

export const pct = (value: number | null | undefined, digits = 1) => (value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(digits)}%`);
export const num = (value: number | null | undefined, digits = 0) => (value === null || value === undefined ? 'n/a' : value.toFixed(digits));
export const duration = (ms: number) =>
  ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`;
export const completionCell = (a: ReturnType<typeof aggregate>) =>
  `${a.completed}/${a.runs} (${pct(a.completionRate, 0)}, ${pct(a.ciLow, 0)}–${pct(a.ciHigh, 0)})`;

export const SOLVER_SHORTCUTS = [
  '**CHEESE DIRECT TRAVEL** (`solver.ts:349-360, 394-396`): if the model answers `cheese` and the goal is visible with a clear straight line, the mouse walks the whole `Maze.directPath()` trace to the goal from one decision, including diagonal steps. Not applied here; no policy is offered `cheese`.',
  '**Adaptive thinking** (`solver.ts:386, 412, 434`; `adaptive-thinking.ts`): an EiL drop of ≥100 in one event (e.g. a wall hit, −110) switches Ollama to `think: true` for the next decisions. It changes the model config, not the position. Not applied; every policy here has a fixed config.',
  '**Health death** (`solver.ts:283, 418, 436, 456`): the GUI loop stops when health reaches 0 (−10 per wall hit or invalid answer, −5 per 20 moves, −33 at EiL thresholds). Here it is recorded as `healthDepletedAtStep` and the run continues to the step cap.',
  '**Request errors** (`solver.ts:328-341`): the GUI stops on the first HTTP error or timeout. Here a failed request counts as a step and the run aborts after 3 in a row.',
  '**Corridor auto-advance**: `isDecisionPoint()` is checked in the move loop (`solver.ts:451`), but `planned` holds a single cell unless cheese travel is active, so it never moves the mouse further. No effect.',
];

/** Seeds per policy: smoke 1; scorer/fixed-rd 1; random-legal 3; Ollama (Tier B) 1. */
export function seedCount(policy: Policy, mode: Mode): number {
  if (mode === 'smoke' || policy.deterministic || policy.kind === 'ollama') return 1;
  return REPETITIONS;
}
/** Smoke-based request estimate for one entry: each smoke run's steps, relative to its own outcome's reference, mapped onto the entry. */
export function expectedSteps(smokeRuns: RunRecord[], entry: SuiteEntry): number {
  const cap = stepCapFor(entry.optimalSteps);
  if (!smokeRuns.length) return cap;
  const scaled = smokeRuns.map((run) => {
    const [reference, target] = run.completed
      ? [run.optimalSteps, entry.optimalSteps]
      : run.stuck
        ? [run.stuckWindow, stuckWindowFor(entry.optimalSteps)]
        : [run.stepCap, cap];
    return Math.min(cap, (run.steps / reference) * target);
  });
  return scaled.reduce((a, b) => a + b, 0) / scaled.length;
}
export function tierEstimate(title: string, tierEntries: SuiteEntry[], tierPolicies: Policy[], runs: RunRecord[]): string[] {
  const lines = [
    `### ${title}: ${tierEntries.length} entries`,
    '',
    '| Policy | Seeds | Runs | Requests min (optimal) | Requests point est. | Requests max (cap) | Time point est. | Time max |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  let point = 0;
  let maximum = 0;
  let pointMs = 0;
  let maximumMs = 0;
  let runCount = 0;
  for (const policy of tierPolicies) {
    const seeds = seedCount(policy, 'tier-a');
    const smoke = runs.filter((run) => run.policy === policy.id);
    const model = policy.kind !== 'baseline';
    const perRequest = (aggregate(smoke).meanLatencyMs ?? 0) + SLEEP_MS;
    const min = model ? seeds * tierEntries.reduce((t, e) => t + e.optimalSteps, 0) : 0;
    const est = model ? seeds * tierEntries.reduce((t, e) => t + expectedSteps(smoke, e), 0) : 0;
    const max = model ? seeds * tierEntries.reduce((t, e) => t + stepCapFor(e.optimalSteps), 0) : 0;
    point += est;
    maximum += max;
    pointMs += est * perRequest;
    maximumMs += max * perRequest;
    runCount += seeds * tierEntries.length;
    lines.push(
      `| ${policy.id} | ${seeds} | ${seeds * tierEntries.length} | ${min} | ${Math.round(est)} | ${max} | ${model ? duration(est * perRequest) : '<1 s'} | ${model ? duration(max * perRequest) : '<1 s'} |`,
    );
  }
  lines.push(`| **total** | | **${runCount}** | | **${Math.round(point)}** | **${maximum}** | **${duration(pointMs)}** | **${duration(maximumMs)}** |`, '');
  return lines;
}
export function tierEstimates(suite: SuiteEntry[], runs: RunRecord[], config: HarnessConfig): string[] {
  return [
    '## Tier estimates (from this smoke run)',
    '',
    `Point estimate: each smoke run's length relative to its outcome (optimal steps if completed, stuck window if stuck, cap otherwise), averaged per policy and mapped onto every entry; capped at the step cap. Time = requests × (smoke mean latency + ${SLEEP_MS} ms), sequential. The smoke maze is small, so the point estimate is rough.`,
    '',
    ...tierEstimate('Tier A', suite, createPolicies(TIER_A_POLICIES, config), runs),
    ...tierEstimate(
      'Tier B',
      tierBEntries(suite),
      createPolicies([...TIER_B_POLICIES, ...(config.withThinking ? (['ollama-constrained-think'] as PolicyId[]) : [])], config),
      runs,
    ),
  ];
}

export function markdown(
  config: HarnessConfig,
  metadata: Record<string, any>,
  suite: SuiteEntry[],
  entries: SuiteEntry[],
  policies: Policy[],
  runs: RunRecord[],
): string {
  const byPolicy = groupBy(runs, (run) => run.policy);
  const ordered = policies.filter((policy) => byPolicy.has(policy.id));
  const lines = [
    `# Full-maze evaluation (${config.mode})`,
    '',
    '## Read this first: smell is the goal gradient',
    '',
    '**Smell = 101 − BFS distance to the goal** (`Maze.smellAt`, `src/maze/maze.ts`). Every policy that is shown smell, or the scorer score (which includes a ±10 term for whether smell rises), is handed the shortest-path gradient to the goal and only has to follow it. Those results measure gradient following, not navigation. **The `*-nosmell` policies are the real navigation test:** they see walls, visit counts and the start/goal coordinates, and nothing derived from the BFS. (Beyond 101 cells from the goal, parts of the 50×50 maze, smell is 0 and the gradient vanishes for everyone.)',
    '',
    '| Policy | Goal information shown |',
    '|---|---|',
    ...ordered.map((p) => `| ${p.id} | ${p.config.sees} |`),
    '',
    '## Setup',
    '',
    `- Timestamp: ${metadata.timestamp}`,
    `- Git commit: ${metadata.gitCommit}${metadata.gitDirty ? ' (working tree dirty)' : ''}`,
    `- Mode: ${config.mode}; base seed ${config.seed}; seeds per policy as in the table below (${metadata.seedRule})`,
    `- Mazes: ${entries.length} maze/orientation entries from ${new Set(entries.map((e) => e.sourceFile)).size} files (suite has ${suite.length})`,
    `- Runs: ${runs.length}`,
    `- Stop rules, in order: goal reached → completed; ${MAX_CONSECUTIVE_FAILURES} consecutive failed requests → aborted; no new cell visited in the last ${metadata.stuckRule} steps → stuck; ${metadata.stepCapRule} steps → step-cap. The same rules apply to every policy.`,
    `- Request timeout ${config.timeoutMs / 1000} s; ${SLEEP_MS} ms sleep after each request; sequential`,
    `- Ollama: ${config.ollamaModel} at ${config.ollamaUrl}`,
    '- A step is one policy decision. Wall choices are never corrected: the attempt is recorded, the mouse stays, the step counts. A failed request (timeout, HTTP, unparseable answer) also counts as a step with the mouse staying put; an unparseable answer is fed to memory as an invalid action like the GUI does.',
    '- Memory sequence follows `ObservableMazeSolver.run()`: perceive → rememberPerception → decide → evaluate(from) → rememberAction → rememberPerception(entered).',
    '- Revisit rate = successful moves landing on an already-visited cell / successful moves. Illegal rate = wall choices / steps. Loop = any cell entered ≥5 times. Scorer agreement = decisions that picked an argmax-score legal move.',
    '',
    '| Policy | Payload | Model | think | temp | Option order | Seeds |',
    '|---|---|---|---|---|---|---:|',
    ...ordered.map(
      (p) =>
        `| ${p.id} | ${p.config.payloadBuilder}${p.config.notes ? ` (${p.config.notes})` : ''} | ${p.config.model ?? '—'} | ${p.config.think ?? '—'} | ${p.config.temperature ?? '—'} | ${p.config.optionOrdering} | ${new Set(byPolicy.get(p.id)!.map((run) => run.seed)).size} |`,
    ),
    '',
    '## Per-policy results',
    '',
    '| Policy | Completed (95% CI) | Stuck | Step-cap | Aborted | Median steps (completed) | Mean efficiency | Illegal % | Revisit % | Reversals/run | Scorer agreement % | Requests | Failed req. | Mean latency ms | Total time |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const policy of ordered) {
    const a = aggregate(byPolicy.get(policy.id)!);
    lines.push(
      `| ${policy.id} | ${completionCell(a)} | ${a.stuck} | ${a.stepCapped} | ${a.aborted} | ${num(a.medianStepsCompleted)} | ${num(a.meanEfficiency, 2)} | ${pct(a.illegalRate)} | ${pct(a.revisitRate)} | ${num(a.reversalsPerRun, 1)} | ${pct(a.scorerAgreement)} | ${a.requests} | ${a.failures} | ${num(a.meanLatencyMs)} | ${duration(a.totalWallClockMs)} |`,
    );
  }
  const transforms = TRANSFORMS.filter((t) => entries.some((e) => e.transform === t));
  lines.push(
    '',
    '## Completion by orientation',
    '',
    'Original mazes mostly put the goal down-right of the start; mirror-h moves it down-left, mirror-v up-right, rotate-180 up-left. A direction-biased policy should drop off on the transformed orientations.',
    '',
    `| Policy | ${transforms.join(' | ')} |`,
    `|---|${transforms.map(() => '---').join('|')}|`,
  );
  for (const policy of ordered)
    lines.push(
      `| ${policy.id} | ${transforms.map((t) => completionCell(aggregate(byPolicy.get(policy.id)!.filter((run) => run.transform === t)))).join(' | ')} |`,
    );
  lines.push(
    '',
    '## Direction distribution (all chosen moves, including wall choices)',
    '',
    '| Policy | Up | Down | Left | Right | Decisions | First-listed option chosen |',
    '|---|---:|---:|---:|---:|---:|---:|',
  );
  for (const policy of ordered) {
    const a = aggregate(byPolicy.get(policy.id)!);
    const d = a.directions;
    const total = d.up + d.down + d.left + d.right;
    const share = (v: number) => (total ? pct(v / total, 0) : 'n/a');
    lines.push(`| ${policy.id} | ${share(d.up)} | ${share(d.down)} | ${share(d.left)} | ${share(d.right)} | ${total} | ${pct(a.firstOptionRate, 0)} |`);
  }
  lines.push('', 'First-listed = the first option in the order shown to the model, counted only when ≥2 options were shown.', '');
  lines.push(
    '',
    '## Shortcuts in `src/gui/solver.ts` (none applied here)',
    '',
    ...SOLVER_SHORTCUTS.map((s) => `- ${s}`),
    '',
    '## Limitations',
    '',
    '- See "Read this first": smell-aware results are gradient following. Only the `*-nosmell` policies and the walls-only baselines are free of the BFS gradient.',
    '- Ollama is not seeded (the payload matches `benchmark.ts`, which sends no seed) and Tier B runs it once per entry, so Ollama results carry sampling noise at temperature 0.2.',
    '- Latency is client-observed HTTP time on a shared CPU-only server, not internal inference time. A warm-up request per model is sent before runs and not recorded.',
    '- Health reaching 0 does not end a run here, unlike the GUI; see `healthDepletedAtStep` in runs.csv.',
    '- The 32 source mazes are small and hand-built; orientations reuse them, so runs on one maze are not independent. Wilson intervals treat runs as independent and are therefore optimistic.',
    '',
  );
  if (config.mode === 'smoke') lines.push(...tierEstimates(suite, runs, config));
  return lines.join('\n') + '\n';
}
