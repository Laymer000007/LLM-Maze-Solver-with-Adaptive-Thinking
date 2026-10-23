import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';

import { AgentMemory, type AgentMemoryState } from '@/agent/memory';
import { MOVES, type Move } from '@/execution/execution';
import { Maze, type LocalPerception, type Position } from '@/maze/maze';

// End-to-end maze completion harness. Payload builders are copied from benchmark.ts (importing it would run its main()).

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
export type PolicyId =
  | 'scorer'
  | 'fixed-rd'
  | 'random-legal'
  | 'laya-constrained'
  | 'laya-constrained-shuffled'
  | 'laya-raw'
  | 'ollama-constrained'
  | 'ollama-raw'
  | 'ollama-constrained-think';
export const DEFAULT_POLICIES: PolicyId[] = [
  'scorer',
  'fixed-rd',
  'random-legal',
  'laya-constrained',
  'laya-constrained-shuffled',
  'laya-raw',
  'ollama-constrained',
  'ollama-raw',
];
export const ALL_POLICIES: PolicyId[] = [...DEFAULT_POLICIES, 'ollama-constrained-think'];
export type FailureKind = 'timeout' | 'http' | 'parse';
export type DecisionState = { position: Position; goal: Position; perception: LocalPerception; memory: AgentMemoryState; validActions: Move[] };
/** latencyMs is null for policies that make no request. presented is the option order shown to a model. */
export type Decision = { choice: Move | null; latencyMs: number | null; failure?: FailureKind; error?: string; presented?: Move[] };
export type PolicyConfig = {
  payloadBuilder: string;
  endpoint: string | null;
  model: string | null;
  think: boolean | null;
  temperature: number | null;
  format: string | null;
  optionOrdering: string;
  notes?: string;
};
export type Policy = { id: PolicyId; deterministic: boolean; config: PolicyConfig; decide(state: DecisionState, random: () => number): Promise<Decision> };
export type RunStatus = 'completed' | 'step-cap' | 'aborted';
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
  steps: number;
  stepCap: number;
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
export type EpisodeOptions = { sleepMs?: number; maxConsecutiveFailures?: number; stepCap?: number; rngSeed?: number };
type Mode = 'smoke' | 'full';
type HarnessConfig = {
  mode: Mode;
  policies: PolicyId[];
  seed: number;
  withThinking: boolean;
  outputDir: string;
  mazes: string[] | null;
  timeoutMs: number;
  ollamaUrl: string;
  ollamaModel: string;
  layaUrl: string;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MOVES4 = [...MOVES] as Move[];
const FIXED_ORDER: Move[] = ['right', 'down', 'up', 'left'];
export const TIMEOUT_MS = 45_000;
export const SLEEP_MS = 10;
export const MAX_CONSECUTIVE_FAILURES = 3;
export const REPETITIONS = 3;
const SMOKE_MAZE = 'mazes/7x7_corridor_branch.txt';
const SMOKE_TRANSFORMS: Transform[] = ['original', 'rotate-180'];
const OLLAMA_TEMPERATURE = 0.2;
const key = (p: Position) => `${p.x},${p.y}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

export const stepCapFor = (optimalSteps: number) => Math.max(4 * optimalSteps, 200);

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
async function buildSuite(): Promise<SuiteEntry[]> {
  const files = (await fs.readdir(path.join(ROOT, 'mazes'))).filter((file) => file.endsWith('.txt')).sort();
  const entries: SuiteEntry[] = [];
  for (const file of files) {
    const maze = await Maze.fromFile(path.join(ROOT, 'mazes', file));
    for (const transform of TRANSFORMS) entries.push(buildSuiteEntry(maze.layout, `mazes/${file}`, transform));
  }
  return entries;
}
/** The suite is frozen on first use; later runs must reproduce it exactly. */
async function freezeSuite(outputDir: string, suite: SuiteEntry[]): Promise<void> {
  const file = path.join(outputDir, 'suite.json');
  const body = JSON.stringify({ stepCapRule: 'max(4 * optimalSteps, 200)', entries: suite }, null, 2);
  const existing = await fs.readFile(file, 'utf-8').catch(() => null);
  if (existing === null) {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(file, body);
    return;
  }
  if (existing !== body) throw new Error(`${file} differs from the suite generated from mazes/. Move it aside to refreeze.`);
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
function choose<T>(random: () => number, values: T[]): T {
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
function nextPosition(position: Position, move: Move): Position {
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
export function layaBody(state: DecisionState, experiment: 'A-raw' | 'B-constrained', order?: Move[]): Record<string, unknown> {
  const legal = experiment === 'A-raw' ? MOVES4 : (order ?? state.validActions);
  const descriptions = Object.fromEntries(
    legal.map((move) => [
      move.toUpperCase(),
      experiment === 'A-raw'
        ? `${move} movement; local state ${state.perception.directions[move]}, smell ${state.perception.directionSmell[move]}`
        : `${move} movement; existing expected sensor score ${state.memory.actionEffects[move]?.totalExpectedEiLDelta}; visited ${state.memory.visitCounts[key(nextPosition(state.position, move))] ?? 0}`,
    ]),
  );
  const prompt = experiment === 'A-raw' ? rawPrompt(state) : constrainedPrompt(state, legal);
  return {
    state: { body: prompt },
    questions: { move: { type: 'choice', instructions: 'Choose exactly one movement direction. Return the direction label.', criteria: descriptions } },
  };
}
export function parseMove(value: unknown): Move | null {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const match = text?.match(/\b(up|down|left|right)\b/i);
  return match ? (match[1].toLowerCase() as Move) : null;
}

// ---------- Secrets ----------

const layaKeyFile = () => process.env.LAYA_API_KEY_FILE || path.join(os.homedir(), '.config', 'laya', 'api_key');
/** LAYA_API_KEY, else the trimmed contents of LAYA_API_KEY_FILE (default ~/.config/laya/api_key). Never logged or serialised. */
export function resolveLayaKey(): string | null {
  if (process.env.LAYA_API_KEY) return process.env.LAYA_API_KEY;
  try {
    return readFileSync(layaKeyFile(), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}
export function redactSecrets(text: string): string {
  const secret = resolveLayaKey();
  return secret && secret.length >= 4 ? text.split(secret).join('[REDACTED]') : text;
}
function requireLayaKey(): string {
  const value = resolveLayaKey();
  if (!value)
    throw new Error(
      `No Laya key: LAYA_API_KEY is not set and ${layaKeyFile()} is missing, unreadable or empty. Set one before running Laya policies; there is no fallback.`,
    );
  return value;
}

// ---------- Model calls ----------

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<Decision & { json?: any }> {
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
    if (!response.ok) return { choice: null, latencyMs, failure: 'http', error: redactSecrets(`HTTP ${response.status}`) };
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
      error: redactSecrets(error instanceof Error ? `${error.message}${error.cause ? ` (${String(error.cause)})` : ''}` : String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}
async function callLaya(layaUrl: string, body: Record<string, unknown>, timeoutMs: number): Promise<Decision> {
  const secret = requireLayaKey();
  const result = await postJson(`${layaUrl}/v1/systemone`, { authorization: `Bearer ${secret}` }, body, timeoutMs);
  if (result.failure) return result;
  const choice = parseMove(result.json?.answers?.move?.choice);
  return choice
    ? { choice, latencyMs: result.latencyMs }
    : { choice: null, latencyMs: result.latencyMs, failure: 'parse', error: 'No movement in answers.move.choice.' };
}
async function callOllama(ollamaUrl: string, model: string, prompt: string, think: boolean, timeoutMs: number): Promise<Decision> {
  const result = await postJson(
    `${ollamaUrl}/api/chat`,
    {},
    { model, messages: [{ role: 'user', content: prompt }], stream: false, format: 'json', think, options: { temperature: OLLAMA_TEMPERATURE } },
    timeoutMs,
  );
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
export function createPolicies(ids: PolicyId[], config: Pick<HarnessConfig, 'timeoutMs' | 'ollamaUrl' | 'ollamaModel' | 'layaUrl'>): Policy[] {
  const laya = `${config.layaUrl}/v1/systemone`;
  const ollama = `${config.ollamaUrl}/api/chat`;
  const baseline = (optionOrdering: string, notes?: string): PolicyConfig => ({
    payloadBuilder: 'none',
    endpoint: null,
    model: null,
    think: null,
    temperature: null,
    format: null,
    optionOrdering,
    notes,
  });
  const layaConfig = (payloadBuilder: string, optionOrdering: string): PolicyConfig => ({
    payloadBuilder,
    endpoint: laya,
    model: null,
    think: null,
    temperature: null,
    format: 'systemone choice question',
    optionOrdering,
  });
  const ollamaConfig = (payloadBuilder: string, think: boolean, optionOrdering: string): PolicyConfig => ({
    payloadBuilder,
    endpoint: ollama,
    model: config.ollamaModel,
    think,
    temperature: OLLAMA_TEMPERATURE,
    format: 'json',
    optionOrdering,
  });
  const table: Record<PolicyId, Omit<Policy, 'id'>> = {
    scorer: {
      deterministic: true,
      config: baseline('n/a', 'argmax totalExpectedEiLDelta over legal moves; ties broken by seeded RNG'),
      decide: async (state, random) => {
        const best = scorerOptimal(state);
        return { choice: choose(random, best.length ? best : MOVES4), latencyMs: null };
      },
    },
    'fixed-rd': {
      deterministic: true,
      config: baseline('first legal of RIGHT, DOWN, UP, LEFT'),
      decide: async (state) => ({ choice: FIXED_ORDER.find((move) => state.validActions.includes(move)) ?? 'right', latencyMs: null }),
    },
    'random-legal': {
      deterministic: false,
      config: baseline('uniform over legal moves, seeded'),
      decide: async (state, random) => ({ choice: choose(random, state.validActions.length ? state.validActions : MOVES4), latencyMs: null }),
    },
    'laya-constrained': {
      deterministic: false,
      config: layaConfig('benchmark.ts layaBody(B-constrained)', 'legal moves in up,down,left,right order'),
      decide: async (state) => ({ ...(await callLaya(config.layaUrl, layaBody(state, 'B-constrained'), config.timeoutMs)), presented: state.validActions }),
    },
    'laya-constrained-shuffled': {
      deterministic: false,
      config: layaConfig(
        'benchmark.ts layaBody(B-constrained) with shuffled order',
        'legal moves, seeded shuffle per request (criteria keys and prompt-body list use the same order)',
      ),
      decide: async (state, random) => {
        const order = seededShuffle(state.validActions, random);
        return { ...(await callLaya(config.layaUrl, layaBody(state, 'B-constrained', order), config.timeoutMs)), presented: order };
      },
    },
    'laya-raw': {
      deterministic: false,
      config: layaConfig('benchmark.ts layaBody(A-raw)', 'all four directions in up,down,left,right order'),
      decide: async (state) => ({ ...(await callLaya(config.layaUrl, layaBody(state, 'A-raw'), config.timeoutMs)), presented: MOVES4 }),
    },
    'ollama-constrained': {
      deterministic: false,
      config: ollamaConfig('benchmark.ts constrainedPrompt()', false, 'legal moves in up,down,left,right order'),
      decide: async (state) => ({
        ...(await callOllama(config.ollamaUrl, config.ollamaModel, constrainedPrompt(state), false, config.timeoutMs)),
        presented: state.validActions,
      }),
    },
    'ollama-raw': {
      deterministic: false,
      config: ollamaConfig('benchmark.ts rawPrompt()', false, 'all four directions in up,down,left,right order'),
      decide: async (state) => ({ ...(await callOllama(config.ollamaUrl, config.ollamaModel, rawPrompt(state), false, config.timeoutMs)), presented: MOVES4 }),
    },
    'ollama-constrained-think': {
      deterministic: false,
      config: ollamaConfig('benchmark.ts constrainedPrompt()', true, 'legal moves in up,down,left,right order'),
      decide: async (state) => ({
        ...(await callOllama(config.ollamaUrl, config.ollamaModel, constrainedPrompt(state), true, config.timeoutMs)),
        presented: state.validActions,
      }),
    },
  };
  return ids.map((id) => ({ id, ...table[id] }));
}

// ---------- Episode loop ----------

function percentile(sorted: number[], fraction: number): number | null {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : null;
}

/**
 * Replicates the memory-update order of ObservableMazeSolver.run() (src/gui/solver.ts) for one-cell moves:
 * perceive → rememberPerception(start visit on the first physical attempt) → decide → evaluate(from) →
 * rememberAction → (on success) rememberPerception(entered). No cheese travel, no adaptive thinking, and
 * health reaching 0 is recorded but does not end the run.
 */
export async function runEpisode(entry: SuiteEntry, policy: Policy, seed: number, options: EpisodeOptions = {}): Promise<RunRecord> {
  const sleepMs = options.sleepMs ?? SLEEP_MS;
  const maxFailures = options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES;
  const stepCap = options.stepCap ?? stepCapFor(entry.optimalSteps);
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
  const checkHealth = () => {
    if (healthDepletedAtStep === null && memory.snapshot().health <= 0) healthDepletedAtStep = steps;
  };
  while (steps < stepCap) {
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
      if (decision.error && errors.length < 10) errors.push(redactSecrets(decision.error));
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
    steps,
    stepCap,
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
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
};
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const sum = (runs: RunRecord[], pick: (run: RunRecord) => number) => runs.reduce((total, run) => total + pick(run), 0);
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
function groupBy<T>(values: T[], pick: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) groups.set(pick(value), [...(groups.get(pick(value)) ?? []), value]);
  return groups;
}

// ---------- Output ----------

const CSV_HEADERS: (keyof RunRecord)[] = [
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
  'steps',
  'stepCap',
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
  return redactSecrets(
    [CSV_HEADERS.join(','), ...runs.map((run) => CSV_HEADERS.map((header) => JSON.stringify(run[header] ?? '')).join(','))].join('\n') + '\n',
  );
}
export function runsJson(metadata: Record<string, unknown>, runs: RunRecord[]): string {
  return redactSecrets(JSON.stringify({ metadata, runs }, null, 2));
}

const pct = (value: number | null | undefined, digits = 1) => (value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(digits)}%`);
const num = (value: number | null | undefined, digits = 0) => (value === null || value === undefined ? 'n/a' : value.toFixed(digits));
const duration = (ms: number) =>
  ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`;
const completionCell = (a: ReturnType<typeof aggregate>) => `${a.completed}/${a.runs} (${pct(a.completionRate, 0)}, ${pct(a.ciLow, 0)}–${pct(a.ciHigh, 0)})`;

export const SOLVER_SHORTCUTS = [
  '**CHEESE DIRECT TRAVEL** (`solver.ts:349-360, 394-396`): if the model answers `cheese` and the goal is visible with a clear straight line, the mouse walks the whole `Maze.directPath()` trace to the goal from one decision, including diagonal steps. Not applied here; no policy is offered `cheese`.',
  '**Adaptive thinking** (`solver.ts:386, 412, 434`; `adaptive-thinking.ts`): an EiL drop of ≥100 in one event (e.g. a wall hit, −110) switches Ollama to `think: true` for the next decisions. It changes the model config, not the position. Not applied; every policy here has a fixed config.',
  '**Health death** (`solver.ts:283, 418, 436, 456`): the GUI loop stops when health reaches 0 (−10 per wall hit or invalid answer, −5 per 20 moves, −33 at EiL thresholds). Here it is recorded as `healthDepletedAtStep` and the run continues to the step cap.',
  '**Request errors** (`solver.ts:328-341`): the GUI stops on the first HTTP error or timeout. Here a failed request counts as a step and the run aborts after 3 in a row.',
  '**Corridor auto-advance**: `isDecisionPoint()` is checked in the move loop (`solver.ts:451`), but `planned` holds a single cell unless cheese travel is active, so it never moves the mouse further. No effect.',
  'The GUI\'s Laya prompts (`buildRawLayaPrompt`, `buildConstrainedLayaPrompt`) and `LayaClient` criteria (`"<move> movement"`) differ from the `benchmark.ts` payloads used here.',
];

function fullRunEstimate(suite: SuiteEntry[], runs: RunRecord[], policies: Policy[]): string[] {
  const lines = [
    '## Full-run estimate (from this smoke run)',
    '',
    'Full mode: every suite entry, deterministic baselines once, other policies 3 seeds. Point estimate assumes each policy completes at its smoke rate and efficiency; otherwise it runs to the step cap. Time = requests × (smoke mean latency + 10 ms).',
    '',
    '| Policy | Runs | Requests min (optimal) | Requests point est. | Requests max (cap) | Time point est. | Time max |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  let totalPoint = 0;
  let totalMax = 0;
  let requestsPoint = 0;
  let requestsMax = 0;
  for (const policy of policies) {
    const smoke = aggregate(runs.filter((run) => run.policy === policy.id));
    const reps = policy.deterministic ? 1 : REPETITIONS;
    const model = policy.config.endpoint !== null;
    const minimum = reps * suite.reduce((t, e) => t + e.optimalSteps, 0);
    const maximum = reps * suite.reduce((t, e) => t + stepCapFor(e.optimalSteps), 0);
    const point =
      reps *
      suite.reduce(
        (t, e) =>
          t +
          smoke.completionRate * Math.min(stepCapFor(e.optimalSteps), e.optimalSteps / (smoke.meanEfficiency || 1)) +
          (1 - smoke.completionRate) * stepCapFor(e.optimalSteps),
        0,
      );
    const perRequest = (smoke.meanLatencyMs ?? 0) + SLEEP_MS;
    if (model) {
      totalPoint += point * perRequest;
      totalMax += maximum * perRequest;
      requestsPoint += point;
      requestsMax += maximum;
    }
    lines.push(
      `| ${policy.id} | ${reps * suite.length} | ${model ? minimum : 0} | ${model ? Math.round(point) : 0} | ${model ? maximum : 0} | ${model ? duration(point * perRequest) : '<1 s'} | ${model ? duration(maximum * perRequest) : '<1 s'} |`,
    );
  }
  lines.push(
    `| **total (model policies)** | | | **${Math.round(requestsPoint)}** | **${requestsMax}** | **${duration(totalPoint)}** | **${duration(totalMax)}** |`,
    '',
  );
  return lines;
}

function markdown(
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
    '## Setup',
    '',
    `- Timestamp: ${metadata.timestamp}`,
    `- Git commit: ${metadata.gitCommit}${metadata.gitDirty ? ' (working tree dirty)' : ''}`,
    `- Mode: ${config.mode}; base seed ${config.seed}; seeds ${metadata.seeds.join(', ')}`,
    `- Mazes: ${entries.length} maze/orientation entries from ${new Set(entries.map((e) => e.sourceFile)).size} files (suite has ${suite.length})`,
    `- Runs: ${runs.length}`,
    `- Step cap: ${metadata.stepCapRule}; request timeout ${config.timeoutMs / 1000} s; abort after ${MAX_CONSECUTIVE_FAILURES} consecutive failed requests; ${SLEEP_MS} ms sleep after each request; sequential`,
    `- Laya: ${config.layaUrl}/v1/systemone · Ollama: ${config.ollamaModel} at ${config.ollamaUrl}`,
    '- A step is one policy decision. Wall choices are never corrected: the attempt is recorded, the mouse stays, the step counts. A failed request (timeout, HTTP, unparseable answer) also counts as a step with the mouse staying put; an unparseable answer is fed to memory as an invalid action like the GUI does.',
    '- Memory sequence follows `ObservableMazeSolver.run()`: perceive → rememberPerception → decide → evaluate(from) → rememberAction → rememberPerception(entered).',
    '- Revisit rate = successful moves landing on an already-visited cell / successful moves. Illegal rate = wall choices / steps. Loop = any cell entered ≥5 times. Scorer agreement = decisions that picked an argmax-score legal move.',
    '',
    '| Policy | Payload | Model | think | temp | Option order | Reps |',
    '|---|---|---|---|---|---|---:|',
    ...ordered.map(
      (p) =>
        `| ${p.id} | ${p.config.payloadBuilder}${p.config.notes ? ` (${p.config.notes})` : ''} | ${p.config.model ?? (p.config.endpoint ? 'Laya router' : '—')} | ${p.config.think ?? '—'} | ${p.config.temperature ?? '—'} | ${p.config.optionOrdering} | ${p.deterministic ? 1 : metadata.seeds.length} |`,
    ),
    '',
    '## Per-policy results',
    '',
    '| Policy | Completed (95% CI) | Aborted | Median steps (completed) | Mean efficiency | Illegal % | Revisit % | Reversals/run | Loop runs % | Scorer agreement % | Requests | Failed req. | Mean latency ms | Total time |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const policy of ordered) {
    const a = aggregate(byPolicy.get(policy.id)!);
    lines.push(
      `| ${policy.id} | ${completionCell(a)} | ${a.aborted} | ${num(a.medianStepsCompleted)} | ${num(a.meanEfficiency, 2)} | ${pct(a.illegalRate)} | ${pct(a.revisitRate)} | ${num(a.reversalsPerRun, 1)} | ${pct(a.loopRate, 0)} | ${pct(a.scorerAgreement)} | ${a.requests} | ${a.failures} | ${num(a.meanLatencyMs)} | ${duration(a.totalWallClockMs)} |`,
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
  const plain = byPolicy.get('laya-constrained');
  const shuffled = byPolicy.get('laya-constrained-shuffled');
  lines.push('## laya-constrained vs laya-constrained-shuffled', '');
  if (plain && shuffled) {
    const a = aggregate(plain);
    const b = aggregate(shuffled);
    const overlap = a.ciLow <= b.ciHigh && b.ciLow <= a.ciHigh;
    lines.push(
      `- Completion: fixed order ${completionCell(a)} vs shuffled ${completionCell(b)}. ${overlap ? 'The 95% intervals overlap, so no completion difference is detectable at this sample size.' : 'The 95% intervals do not overlap.'}`,
      `- First-listed option chosen: fixed ${pct(a.firstOptionRate, 0)} vs shuffled ${pct(b.firstOptionRate, 0)}. Scorer agreement: ${pct(a.scorerAgreement)} vs ${pct(b.scorerAgreement)}. Illegal: ${pct(a.illegalRate)} vs ${pct(b.illegalRate)}.`,
      `- If the fixed-order first-listed rate is high but falls under shuffling while agreement holds, Laya follows the scores; if agreement falls with the order, it follows position.`,
    );
  } else lines.push('- Not run (both policies are needed).');
  lines.push(
    '',
    '## Shortcuts in `src/gui/solver.ts` (none applied here)',
    '',
    ...SOLVER_SHORTCUTS.map((s) => `- ${s}`),
    '',
    '## Limitations',
    '',
    '- Smell is `101 − BFS distance to the goal`, so every policy that sees smell or the score (which includes a ±10 smell term) receives a goal-distance gradient. Beyond 101 cells (parts of the 50×50 maze) smell is 0 and the gradient vanishes.',
    '- Ollama is not seeded (the payload matches `benchmark.ts`, which sends no seed); its repetitions are independent samples at temperature 0.2. Laya repetitions differ only if Laya is non-deterministic, except for the shuffled policy.',
    '- Latency is client-observed HTTP time on a shared CPU-only server, not internal inference time. A warm-up request per model is sent before runs and not recorded.',
    '- Health reaching 0 does not end a run here, unlike the GUI; see `healthDepletedAtStep` in runs.csv.',
    '- The 32 source mazes are small and hand-built; orientations reuse them, so runs on one maze are not independent. Wilson intervals treat runs as independent and are therefore optimistic.',
    '',
  );
  if (config.mode === 'smoke') lines.push(...fullRunEstimate(suite, runs, policies));
  return redactSecrets(lines.join('\n') + '\n');
}

// ---------- CLI ----------

function parseArgs(argv: string[]): HarnessConfig {
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const mode = (get('--mode') ?? 'smoke') as Mode;
  if (!['smoke', 'full'].includes(mode)) throw new Error(`Unknown --mode ${mode}; use smoke or full.`);
  const withThinking = argv.includes('--with-thinking');
  const policies = (get('--policies')
    ?.split(',')
    .map((p) => p.trim())
    .filter(Boolean) ?? [...DEFAULT_POLICIES, ...(withThinking ? ['ollama-constrained-think'] : [])]) as PolicyId[];
  const unknown = policies.filter((p) => !ALL_POLICIES.includes(p));
  if (unknown.length) throw new Error(`Unknown policies: ${unknown.join(', ')}. Known: ${ALL_POLICIES.join(', ')}.`);
  if (policies.includes('ollama-constrained-think') && !withThinking) throw new Error('ollama-constrained-think requires --with-thinking.');
  const seed = Number(get('--seed') ?? '20261023');
  if (!Number.isInteger(seed)) throw new Error('--seed must be an integer.');
  return {
    mode,
    policies,
    seed,
    withThinking,
    outputDir: path.resolve(get('--output-dir') ?? path.join(ROOT, 'benchmark-results', 'full-maze-eval')),
    mazes:
      get('--mazes')
        ?.split(',')
        .map((m) => m.trim())
        .filter(Boolean) ?? null,
    timeoutMs: TIMEOUT_MS,
    ollamaUrl: process.env.OLLAMA_URL ?? 'http://192.168.88.100:11434',
    ollamaModel: process.env.OLLAMA_MODEL ?? 'qwen3:1.7b',
    layaUrl: process.env.LAYA_URL ?? 'http://192.168.88.100:8000',
  };
}
function git(command: string): string {
  try {
    return execSync(command, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

async function preflight(config: HarnessConfig, policies: Policy[]): Promise<void> {
  const ollamaModes = [...new Set(policies.filter((p) => p.id.startsWith('ollama')).map((p) => p.config.think as boolean))];
  if (ollamaModes.length) {
    const tags = await fetch(`${config.ollamaUrl}/api/tags`).then((r) => r.json() as Promise<{ models?: { name: string }[] }>);
    if (!tags.models?.some((m) => m.name === config.ollamaModel)) throw new Error(`Ollama at ${config.ollamaUrl} does not list ${config.ollamaModel}.`);
  }
  const dummy = buildSuiteEntry(['#####', '#S G#', '#####'], 'preflight', 'original');
  const maze = new Maze(dummy.layout);
  const memory = new AgentMemory();
  const perception = maze.perceive(maze.startPosition);
  memory.rememberPerception(perception, true);
  const state: DecisionState = {
    position: maze.startPosition,
    goal: maze.goalPosition,
    perception,
    memory: memory.snapshot(),
    validActions: MOVES4.filter((m) => perception.directions[m] !== 'wall'),
  };
  if (policies.some((p) => p.id.startsWith('laya'))) {
    const r = await callLaya(config.layaUrl, layaBody(state, 'B-constrained'), config.timeoutMs);
    console.log(`warm-up laya: ${r.failure ?? r.choice} ${Math.round(r.latencyMs ?? 0)} ms`);
    if (r.failure === 'http') throw new Error(`Laya warm-up failed: ${r.error}`);
  }
  for (const think of ollamaModes) {
    const r = await callOllama(config.ollamaUrl, config.ollamaModel, constrainedPrompt(state), think, config.timeoutMs);
    console.log(`warm-up ollama think=${think}: ${r.failure ?? r.choice} ${Math.round(r.latencyMs ?? 0)} ms`);
    if (r.failure === 'http') throw new Error(`Ollama warm-up failed: ${r.error}`);
  }
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  if (config.policies.some((p) => p.startsWith('laya'))) requireLayaKey();
  const suite = await buildSuite();
  await freezeSuite(config.outputDir, suite);
  let entries = config.mode === 'smoke' ? suite.filter((e) => e.sourceFile === SMOKE_MAZE && SMOKE_TRANSFORMS.includes(e.transform)) : suite;
  if (config.mazes) entries = entries.filter((e) => config.mazes!.some((m) => e.id.includes(m)));
  if (!entries.length) throw new Error('No suite entries selected.');
  const seeds = config.mode === 'smoke' ? [config.seed] : Array.from({ length: REPETITIONS }, (_, i) => config.seed + i);
  const policies = createPolicies(config.policies, config);
  const jobs = entries.flatMap((entry) =>
    policies.flatMap((policy) => (policy.deterministic ? seeds.slice(0, 1) : seeds).map((seed) => ({ entry, policy, seed }))),
  );
  const timestamp = now();
  const runDir = path.join(config.outputDir, `${timestamp.replace(/[:.]/g, '-')}-${config.mode}`);
  await fs.mkdir(runDir, { recursive: true });
  const metadata = {
    timestamp,
    mode: config.mode,
    gitCommit: git('git rev-parse HEAD'),
    gitBranch: git('git rev-parse --abbrev-ref HEAD'),
    gitDirty: git('git status --porcelain') !== '',
    baseSeed: config.seed,
    seeds,
    runSeedRule: 'runSeed(seed, mazeId, policy) — FNV-1a mix; drives scorer ties, random-legal and shuffling',
    stepCapRule: 'max(4 * optimalSteps, 200)',
    timeoutMs: config.timeoutMs,
    maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
    sleepMs: SLEEP_MS,
    layaUrl: `${config.layaUrl}/v1/systemone`,
    ollamaUrl: config.ollamaUrl,
    ollamaModel: config.ollamaModel,
    entries: entries.map((e) => e.id),
    policies: policies.map((p) => ({ id: p.id, deterministic: p.deterministic, ...p.config })),
    complete: false,
  };
  console.log(`${config.mode}: ${entries.length} entries × ${policies.length} policies → ${jobs.length} runs. Output: ${runDir}`);
  await preflight(config, policies);
  const runs: RunRecord[] = [];
  const started = performance.now();
  for (const [index, job] of jobs.entries()) {
    const run = await runEpisode(job.entry, job.policy, job.seed, { rngSeed: runSeed(job.seed, job.entry.id, job.policy.id) });
    runs.push(run);
    await fs.appendFile(path.join(runDir, 'runs.jsonl'), redactSecrets(JSON.stringify(run)) + '\n');
    console.log(
      `[${index + 1}/${jobs.length}] ${run.runId} → ${run.status} in ${run.steps}/${run.stepCap} steps (optimal ${run.optimalSteps}), illegal ${run.illegalMoves}, failed ${run.timeouts + run.httpFailures + run.parseFailures}, ${duration(run.wallClockMs)} · elapsed ${duration(performance.now() - started)}`,
    );
  }
  const finalMetadata = { ...metadata, complete: true, totalWallClockMs: Math.round(performance.now() - started) };
  const outputs: Record<string, string> = {
    'runs.json': runsJson(finalMetadata, runs),
    'runs.csv': runsCsv(runs),
    'report.md': markdown(config, finalMetadata, suite, entries, policies, runs),
  };
  const latest = path.join(config.outputDir, 'latest');
  await fs.rm(latest, { recursive: true, force: true });
  await fs.mkdir(latest, { recursive: true });
  for (const [name, body] of Object.entries(outputs)) {
    await fs.writeFile(path.join(runDir, name), body);
    await fs.writeFile(path.join(latest, name), body);
  }
  await fs.writeFile(path.join(latest, 'SOURCE'), `${path.basename(runDir)}\n`);
  console.log(`Done in ${duration(performance.now() - started)}. Report: ${path.join(runDir, 'report.md')}`);
}
if (!process.env.VITEST)
  main().catch((error) => {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
