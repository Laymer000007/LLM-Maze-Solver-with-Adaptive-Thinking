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
  | 'laya-raw-nosmell'
  | 'ollama-constrained'
  | 'ollama-raw'
  | 'ollama-raw-nosmell'
  | 'ollama-constrained-think';
export const DEFAULT_POLICIES: PolicyId[] = [
  'scorer',
  'fixed-rd',
  'random-legal',
  'laya-constrained',
  'laya-constrained-shuffled',
  'laya-raw',
  'laya-raw-nosmell',
  'ollama-constrained',
  'ollama-raw',
  'ollama-raw-nosmell',
];
export const ALL_POLICIES: PolicyId[] = [...DEFAULT_POLICIES, 'ollama-constrained-think'];
export const TIER_A_POLICIES: PolicyId[] = [
  'scorer',
  'fixed-rd',
  'random-legal',
  'laya-constrained',
  'laya-constrained-shuffled',
  'laya-raw',
  'laya-raw-nosmell',
];
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
export const DETERMINISM_ENTRIES = [
  '7x7_open_detour@original',
  '11x11_corridor_loop@mirror-h',
  '15x15_corridor_spiral@mirror-v',
  'v212_open_goal_8_2@rotate-180',
];
export type FailureKind = 'timeout' | 'http' | 'parse';
export type DecisionState = { position: Position; goal: Position; perception: LocalPerception; memory: AgentMemoryState; validActions: Move[] };
/**
 * latencyMs is null for policies that make no request. presented is the option order shown to a model.
 * criteria is the score-bearing Laya criteria actually sent, checked against the maze by runEpisode.
 */
export type Decision = {
  choice: Move | null;
  latencyMs: number | null;
  failure?: FailureKind;
  error?: string;
  presented?: Move[];
  criteria?: Record<string, string>;
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
export type PolicyKind = 'baseline' | 'laya' | 'ollama';
/** deterministic: run with one seed regardless of mode (Laya's seed count is decided by the determinism check). */
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
  criteriaChecked: number;
  criteriaMismatches: number;
  healthDepletedAtStep: number | null;
  finalHealth: number;
  finalEiL: number;
  errors: string[];
  moves: string[];
};
export type EpisodeOptions = { sleepMs?: number; maxConsecutiveFailures?: number; stepCap?: number; stuckWindow?: number; rngSeed?: number };
type Mode = 'smoke' | 'tier-a' | 'tier-b' | 'validate-frozen' | 'determinism';
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
/** A run is stuck when no new cell has been visited in this many steps. Applied identically to every policy. */
export const stuckWindowFor = (optimalSteps: number) => Math.max(50, 2 * optimalSteps);
const EXPERIENCE_BY_VISITS = [2, 0, -2, -4, -8, -16, -32, -64, -128];

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
export function tierBEntries(suite: SuiteEntry[]): SuiteEntry[] {
  return suite.filter((e) => TIER_B_MAZES.includes(e.sourceFile));
}
/**
 * The suite is frozen on first use; later runs must reproduce the same entries exactly. The rules and the
 * Tier B subset are rewritten alongside them, so adding a subset never changes an existing entry.
 */
async function freezeSuite(outputDir: string, suite: SuiteEntry[]): Promise<void> {
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
export type LayaExperiment = 'A-raw' | 'A-raw-nosmell' | 'B-constrained';
export function layaBody(state: DecisionState, experiment: LayaExperiment, order?: Move[]): Record<string, unknown> {
  const raw = experiment !== 'B-constrained';
  const legal = raw ? MOVES4 : (order ?? state.validActions);
  const descriptions = Object.fromEntries(
    legal.map((move) => [
      move.toUpperCase(),
      experiment === 'A-raw'
        ? `${move} movement; local state ${state.perception.directions[move]}, smell ${state.perception.directionSmell[move]}`
        : experiment === 'A-raw-nosmell'
          ? `${move} movement; local state ${state.perception.directions[move]}`
          : `${move} movement; existing expected sensor score ${state.memory.actionEffects[move]?.totalExpectedEiLDelta}; visited ${state.memory.visitCounts[key(nextPosition(state.position, move))] ?? 0}`,
    ]),
  );
  const prompt = experiment === 'A-raw' ? rawPrompt(state) : experiment === 'A-raw-nosmell' ? rawNoSmellPrompt(state) : constrainedPrompt(state, legal);
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
export async function callLaya(layaUrl: string, body: Record<string, unknown>, timeoutMs: number): Promise<Decision> {
  const secret = requireLayaKey();
  const result = await postJson(`${layaUrl}/v1/systemone`, { authorization: `Bearer ${secret}` }, body, timeoutMs);
  if (result.failure) return result;
  const choice = parseMove(result.json?.answers?.move?.choice);
  return choice
    ? { choice, latencyMs: result.latencyMs }
    : { choice: null, latencyMs: result.latencyMs, failure: 'parse', error: 'No movement in answers.move.choice.' };
}
export function ollamaRequestBody(model: string, prompt: string, think: boolean): Record<string, unknown> {
  return { model, messages: [{ role: 'user', content: prompt }], stream: false, format: 'json', think, options: { temperature: OLLAMA_TEMPERATURE } };
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
export function createPolicies(ids: PolicyId[], config: Pick<HarnessConfig, 'timeoutMs' | 'ollamaUrl' | 'ollamaModel' | 'layaUrl'>): Policy[] {
  const laya = `${config.layaUrl}/v1/systemone`;
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
  const layaConfig = (payloadBuilder: string, optionOrdering: string, sees: string): PolicyConfig => ({
    payloadBuilder,
    endpoint: laya,
    model: null,
    think: null,
    temperature: null,
    format: 'systemone choice question',
    optionOrdering,
    sees,
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
  const askLaya = async (body: Record<string, unknown>, presented: Move[], checkCriteria: boolean): Promise<Decision> => ({
    ...(await callLaya(config.layaUrl, body, config.timeoutMs)),
    presented,
    ...(checkCriteria ? { criteria: (body as { questions: { move: { criteria: Record<string, string> } } }).questions.move.criteria } : {}),
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
    'laya-constrained': {
      kind: 'laya',
      deterministic: false,
      config: layaConfig('benchmark.ts layaBody(B-constrained)', LEGAL, SCORES),
      decide: async (state) => askLaya(layaBody(state, 'B-constrained'), state.validActions, true),
    },
    'laya-constrained-shuffled': {
      kind: 'laya',
      deterministic: false,
      config: layaConfig(
        'benchmark.ts layaBody(B-constrained) with shuffled order',
        'legal moves, seeded shuffle per request (criteria keys and prompt-body list use the same order)',
        SCORES,
      ),
      decide: async (state, random) => {
        const order = seededShuffle(state.validActions, random);
        return askLaya(layaBody(state, 'B-constrained', order), order, true);
      },
    },
    'laya-raw': {
      kind: 'laya',
      deterministic: false,
      config: layaConfig('benchmark.ts layaBody(A-raw)', ALL4, SMELL),
      decide: async (state) => askLaya(layaBody(state, 'A-raw'), MOVES4, false),
    },
    'laya-raw-nosmell': {
      kind: 'laya',
      deterministic: false,
      config: layaConfig('layaBody(A-raw) with smell removed from body and criteria', ALL4, NO_SMELL),
      decide: async (state) => askLaya(layaBody(state, 'A-raw-nosmell'), MOVES4, false),
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

function percentile(sorted: number[], fraction: number): number | null {
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
  let criteriaChecked = 0;
  let criteriaMismatches = 0;
  // Tracked here independently of AgentMemory so the scores sent to Laya can be checked against the maze.
  const seen = new Set<string>();
  const freshSinceAction = new Set<string>();
  const checkHealth = () => {
    if (healthDepletedAtStep === null && memory.snapshot().health <= 0) healthDepletedAtStep = steps;
  };
  while (steps < stepCap) {
    if (steps - lastNewCellStep >= stuckWindow) {
      status = 'stuck';
      break;
    }
    const perception = maze.perceive(position);
    for (const cell of [perception.position, ...perception.visibleCells.map((visible) => visible.position)]) {
      if (!seen.has(key(cell))) freshSinceAction.add(key(cell));
      seen.add(key(cell));
    }
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
    for (const [label, text] of Object.entries(decision.criteria ?? {})) {
      criteriaChecked++;
      const destination = nextPosition(position, label.toLowerCase() as Move);
      const destinationVisits = visits.get(key(destination)) ?? 0;
      const expectedScore =
        Math.sign(maze.smellAt(destination) - maze.smellAt(position)) * 10 +
        EXPERIENCE_BY_VISITS[Math.min(8, destinationVisits)] +
        (freshSinceAction.has(key(destination)) ? 10 : 0);
      const sent = text.match(/score (-?\d+); visited (\d+)$/);
      if (!sent || !maze.isWalkable(destination) || Number(sent[1]) !== expectedScore || Number(sent[2]) !== destinationVisits) {
        criteriaMismatches++;
        if (errors.length < 10)
          errors.push(`criteria mismatch at step ${steps}: ${label} "${text}"; expected score ${expectedScore}, visited ${destinationVisits}`);
      }
    }
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
      if (kind === 'parse') freshSinceAction.clear();
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
      freshSinceAction.clear();
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
    freshSinceAction.clear();
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
    criteriaChecked,
    criteriaMismatches,
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
    stuck: runs.filter((run) => run.stuck).length,
    stepCapped: runs.filter((run) => run.status === 'step-cap').length,
    criteriaChecked: sum(runs, (run) => run.criteriaChecked),
    criteriaMismatches: sum(runs, (run) => run.criteriaMismatches),
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
  'criteriaChecked',
  'criteriaMismatches',
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

type Validation = { dir: string; metadata: Record<string, any> } | null;
type Validations = { frozen: Validation; determinism: Validation };
async function latestValidation(outputDir: string, suffix: string): Promise<Validation> {
  const root = path.join(outputDir, 'validation');
  const dirs = (await fs.readdir(root).catch(() => [] as string[])).filter((d) => d.endsWith(suffix)).sort();
  if (!dirs.length) return null;
  const dir = path.join(root, dirs[dirs.length - 1]);
  return { dir: path.relative(ROOT, dir), metadata: JSON.parse(await fs.readFile(path.join(dir, 'results.json'), 'utf-8')).metadata };
}
/** Seeds per policy: smoke 1; scorer/fixed-rd 1; random-legal 3; Laya 1 only if the determinism check passed; Ollama (Tier B) 1. */
export function seedCount(policy: Policy, mode: Mode, layaDeterministic: boolean): number {
  if (mode === 'smoke' || policy.deterministic || policy.kind === 'ollama') return 1;
  if (policy.kind === 'laya') return layaDeterministic ? 1 : REPETITIONS;
  return REPETITIONS;
}
/** Smoke-based request estimate for one entry: each smoke run's steps, relative to its own outcome's reference, mapped onto the entry. */
function expectedSteps(smokeRuns: RunRecord[], entry: SuiteEntry): number {
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
function tierEstimate(title: string, tierEntries: SuiteEntry[], tierPolicies: Policy[], runs: RunRecord[], layaDeterministic: boolean): string[] {
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
    const seeds = seedCount(policy, 'tier-a', layaDeterministic);
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
function tierEstimates(suite: SuiteEntry[], runs: RunRecord[], config: HarnessConfig, validations: Validations): string[] {
  const layaDeterministic = validations.determinism?.metadata.identical === true;
  return [
    '## Tier estimates (from this smoke run)',
    '',
    `Point estimate: each smoke run's length relative to its outcome (optimal steps if completed, stuck window if stuck, cap otherwise), averaged per policy and mapped onto every entry; capped at the step cap. Time = requests × (smoke mean latency + ${SLEEP_MS} ms), sequential. Laya seeds: ${layaDeterministic ? '1 (determinism check passed)' : `${REPETITIONS} (no passing determinism check found)`}. The smoke maze is small, so the point estimate is rough.`,
    '',
    ...tierEstimate('Tier A', suite, createPolicies(TIER_A_POLICIES, config), runs, layaDeterministic),
    ...tierEstimate(
      'Tier B',
      tierBEntries(suite),
      createPolicies([...TIER_B_POLICIES, ...(config.withThinking ? (['ollama-constrained-think'] as PolicyId[]) : [])], config),
      runs,
      layaDeterministic,
    ),
  ];
}

function validationSection(runs: RunRecord[], validations: Validations): string[] {
  const live = aggregate(runs);
  const frozen = validations.frozen?.metadata;
  const det = validations.determinism?.metadata;
  return [
    '## Harness validation',
    '',
    '- **Payload identity:** the test `Laya payload parity with benchmark.ts` (`src/benchmark/full-maze-eval.test.ts`) asserts that the B-constrained and A-raw Laya bodies built here are byte-identical to a verbatim copy of the `benchmark.ts` builders, for all 100 states in `benchmark-results/frozen-dataset.json`.',
    frozen
      ? `- **Frozen-state reproduction:** one laya-constrained request per frozen state (${frozen.timestamp}): ${num(frozen.optimalPct)}% optimal vs ${num(frozen.historicalOptimalPct)}% historically; ${num(frozen.sameAsHistoricalPct)}% of choices identical to the historical run; ${num(frozen.legalPct)}% legal; ${frozen.failures} failed requests. Results: \`${validations.frozen!.dir}\`.`
      : '- **Frozen-state reproduction:** not run (`--mode validate-frozen`).',
    `- **Criteria check:** every score-bearing Laya request in this run was checked against the maze (visits counted by the harness, score recomputed from smell, visit and new-sight terms): ${live.criteriaChecked} criteria, ${live.criteriaMismatches} mismatches. An offline replay of the first smoke run (commit a6474c8) checked 996 criteria with 0 mismatches.`,
    det
      ? `- **Laya determinism:** laya-constrained run twice on ${det.entries.length} entries (${det.entries.join(', ')}): ${det.identical ? 'all move sequences identical, so every Laya policy runs with 1 seed' : 'sequences differ, so Laya policies keep 3 seeds'}. Results: \`${validations.determinism!.dir}\`.`
      : '- **Laya determinism:** not checked (`--mode determinism`).',
    '',
  ];
}

function markdown(
  config: HarnessConfig,
  metadata: Record<string, any>,
  suite: SuiteEntry[],
  entries: SuiteEntry[],
  policies: Policy[],
  runs: RunRecord[],
  validations: Validations,
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
    `- Laya: ${config.layaUrl}/v1/systemone · Ollama: ${config.ollamaModel} at ${config.ollamaUrl}`,
    '- A step is one policy decision. Wall choices are never corrected: the attempt is recorded, the mouse stays, the step counts. A failed request (timeout, HTTP, unparseable answer) also counts as a step with the mouse staying put; an unparseable answer is fed to memory as an invalid action like the GUI does.',
    '- Memory sequence follows `ObservableMazeSolver.run()`: perceive → rememberPerception → decide → evaluate(from) → rememberAction → rememberPerception(entered).',
    '- Revisit rate = successful moves landing on an already-visited cell / successful moves. Illegal rate = wall choices / steps. Loop = any cell entered ≥5 times. Scorer agreement = decisions that picked an argmax-score legal move.',
    '',
    '| Policy | Payload | Model | think | temp | Option order | Seeds |',
    '|---|---|---|---|---|---|---:|',
    ...ordered.map(
      (p) =>
        `| ${p.id} | ${p.config.payloadBuilder}${p.config.notes ? ` (${p.config.notes})` : ''} | ${p.config.model ?? (p.config.endpoint ? 'Laya router' : '—')} | ${p.config.think ?? '—'} | ${p.config.temperature ?? '—'} | ${p.config.optionOrdering} | ${new Set(byPolicy.get(p.id)!.map((run) => run.seed)).size} |`,
    ),
    '',
    ...validationSection(runs, validations),
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
    '- See "Read this first": smell-aware results are gradient following. Only the `*-nosmell` policies and the walls-only baselines are free of the BFS gradient.',
    '- Laya is run with one seed when the determinism check passes; Ollama is not seeded (the payload matches `benchmark.ts`, which sends no seed) and Tier B runs it once per entry, so Ollama results carry sampling noise at temperature 0.2.',
    '- Latency is client-observed HTTP time on a shared CPU-only server, not internal inference time. A warm-up request per model is sent before runs and not recorded.',
    '- Health reaching 0 does not end a run here, unlike the GUI; see `healthDepletedAtStep` in runs.csv.',
    '- The 32 source mazes are small and hand-built; orientations reuse them, so runs on one maze are not independent. Wilson intervals treat runs as independent and are therefore optimistic.',
    '',
  );
  if (config.mode === 'smoke') lines.push(...tierEstimates(suite, runs, config, validations));
  return redactSecrets(lines.join('\n') + '\n');
}

// ---------- CLI ----------

function parseArgs(argv: string[]): HarnessConfig {
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const mode = (get('--mode') ?? 'smoke') as Mode;
  const modes: Mode[] = ['smoke', 'tier-a', 'tier-b', 'validate-frozen', 'determinism'];
  if (!modes.includes(mode)) throw new Error(`Unknown --mode ${mode}; use ${modes.join(', ')}.`);
  const withThinking = argv.includes('--with-thinking');
  const think: PolicyId[] = withThinking ? ['ollama-constrained-think'] : [];
  const defaults: Record<Mode, PolicyId[]> = {
    smoke: [...DEFAULT_POLICIES, ...think],
    'tier-a': TIER_A_POLICIES,
    'tier-b': [...TIER_B_POLICIES, ...think],
    'validate-frozen': ['laya-constrained'],
    determinism: ['laya-constrained'],
  };
  const policies = (get('--policies')
    ?.split(',')
    .map((p) => p.trim())
    .filter(Boolean) ?? defaults[mode]) as PolicyId[];
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

/** One laya-constrained request per frozen benchmark state; checks the harness reproduces the single-step benchmark. */
async function validateFrozen(config: HarnessConfig): Promise<void> {
  requireLayaKey();
  type Frozen = DecisionState & { id: string; optimalActions: Move[] };
  const { states } = JSON.parse(await fs.readFile(path.join(ROOT, 'benchmark-results', 'frozen-dataset.json'), 'utf-8')) as { states: Frozen[] };
  const history = JSON.parse(await fs.readFile(path.join(ROOT, 'benchmark-results', 'latest.json'), 'utf-8')) as {
    rows: { experiment: string; model: string; stateId: string; choice: Move | null }[];
  };
  const historical = new Map(history.rows.filter((r) => r.experiment === 'B-constrained' && r.model === 'laya').map((r) => [r.stateId, r.choice]));
  const [policy] = createPolicies(['laya-constrained'], config);
  const rows: {
    stateId: string;
    validActions: Move[];
    optimalActions: Move[];
    choice: Move | null;
    optimal: boolean;
    legal: boolean;
    firstListed: boolean;
    historicalChoice: Move | null;
    sameAsHistorical: boolean;
    failure: FailureKind | null;
    latencyMs: number;
  }[] = [];
  for (const state of states) {
    const decision = await policy.decide(state, rng(1));
    const optimal = decision.choice !== null && state.optimalActions.includes(decision.choice);
    rows.push({
      stateId: state.id,
      validActions: state.validActions,
      optimalActions: state.optimalActions,
      choice: decision.choice,
      optimal,
      legal: decision.choice !== null && state.validActions.includes(decision.choice),
      firstListed: state.validActions.length >= 2 && decision.choice === state.validActions[0],
      historicalChoice: historical.get(state.id) ?? null,
      sameAsHistorical: historical.get(state.id) === decision.choice,
      failure: decision.failure ?? null,
      latencyMs: Math.round(decision.latencyMs ?? 0),
    });
    await sleep(SLEEP_MS);
  }
  const rate = (pick: (r: (typeof rows)[number]) => boolean, of: typeof rows = rows) => of.filter(pick).length / of.length;
  const multi = rows.filter((r) => r.validActions.length >= 2);
  const historicalOptimal =
    states.filter((s) => {
      const c = historical.get(s.id);
      return c !== undefined && c !== null && s.optimalActions.includes(c);
    }).length / states.length;
  const summary = {
    timestamp: now(),
    gitCommit: git('git rev-parse HEAD'),
    layaUrl: `${config.layaUrl}/v1/systemone`,
    states: rows.length,
    optimalPct: rate((r) => r.optimal) * 100,
    historicalOptimalPct: historicalOptimal * 100,
    legalPct: rate((r) => r.legal) * 100,
    sameAsHistoricalPct: rate((r) => r.sameAsHistorical) * 100,
    firstListedPct: rate((r) => r.firstListed, multi) * 100,
    failures: rows.filter((r) => r.failure).length,
    meanLatencyMs: rows.reduce((t, r) => t + r.latencyMs, 0) / rows.length,
  };
  const dir = path.join(config.outputDir, 'validation', `${summary.timestamp.replace(/[:.]/g, '-')}-frozen-laya-constrained`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'results.json'), runsJson(summary, rows as unknown as RunRecord[]));
  console.log(redactSecrets(JSON.stringify(summary, null, 2)));
  console.log(`Written to ${dir}`);
}

function selectEntries(mode: Mode, suite: SuiteEntry[]): SuiteEntry[] {
  if (mode === 'smoke') return suite.filter((e) => e.sourceFile === SMOKE_MAZE && SMOKE_TRANSFORMS.includes(e.transform));
  if (mode === 'tier-b') return tierBEntries(suite);
  if (mode === 'determinism') return DETERMINISM_ENTRIES.map((id) => suite.find((e) => e.id === id)!);
  return suite;
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  if (config.mode === 'validate-frozen') return validateFrozen(config);
  if (config.policies.some((p) => p.startsWith('laya'))) requireLayaKey();
  const suite = await buildSuite();
  await freezeSuite(config.outputDir, suite);
  let entries = selectEntries(config.mode, suite);
  if (config.mazes) entries = entries.filter((e) => config.mazes!.some((m) => e.id.includes(m)));
  if (!entries.length) throw new Error('No suite entries selected.');
  const policies = createPolicies(config.policies, config);
  const validations: Validations = {
    frozen: await latestValidation(config.outputDir, '-frozen-laya-constrained'),
    determinism: await latestValidation(config.outputDir, '-determinism'),
  };
  const layaDeterministic = validations.determinism?.metadata.identical === true;
  if (config.mode === 'tier-a' && policies.some((p) => p.kind === 'laya') && !validations.determinism)
    throw new Error('Run --mode determinism before Tier A; it decides how many seeds the Laya policies get.');
  // Determinism mode runs laya-constrained twice per entry with the same seed and compares the runs.
  const jobs =
    config.mode === 'determinism'
      ? entries.flatMap((entry) => [1, 2].map(() => ({ entry, policy: policies[0], seed: config.seed })))
      : entries.flatMap((entry) =>
          policies.flatMap((policy) =>
            Array.from({ length: seedCount(policy, config.mode, layaDeterministic) }, (_, i) => ({ entry, policy, seed: config.seed + i })),
          ),
        );
  const timestamp = now();
  const stamp = `${timestamp.replace(/[:.]/g, '-')}-${config.mode}`;
  const runDir = config.mode === 'determinism' ? path.join(config.outputDir, 'validation', stamp) : path.join(config.outputDir, stamp);
  await fs.mkdir(runDir, { recursive: true });
  const metadata = {
    timestamp,
    mode: config.mode,
    gitCommit: git('git rev-parse HEAD'),
    gitBranch: git('git rev-parse --abbrev-ref HEAD'),
    gitDirty: git('git status --porcelain') !== '',
    baseSeed: config.seed,
    seedRule: `smoke 1; scorer, fixed-rd 1; random-legal ${REPETITIONS}; Laya ${layaDeterministic ? '1 (determinism check passed)' : REPETITIONS}; Ollama 1`,
    runSeedRule: 'runSeed(seed, mazeId, policy) — FNV-1a mix; drives scorer ties, random-legal and shuffling',
    stepCapRule: 'max(4 * optimalSteps, 200)',
    stuckRule: 'max(50, 2 * optimalSteps)',
    timeoutMs: config.timeoutMs,
    maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
    sleepMs: SLEEP_MS,
    layaUrl: `${config.layaUrl}/v1/systemone`,
    ollamaUrl: config.ollamaUrl,
    ollamaModel: config.ollamaModel,
    entries: entries.map((e) => e.id),
    policies: policies.map((p) => ({ id: p.id, kind: p.kind, seeds: seedCount(p, config.mode, layaDeterministic), ...p.config })),
    validations: { frozen: validations.frozen?.dir ?? null, determinism: validations.determinism?.dir ?? null },
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
  if (config.mode === 'determinism') {
    const pairs = entries.map((entry, i) => {
      const [a, b] = [runs[2 * i], runs[2 * i + 1]];
      return {
        entry: entry.id,
        identical: JSON.stringify(a.moves) === JSON.stringify(b.moves) && a.status === b.status,
        status: [a.status, b.status],
        steps: [a.steps, b.steps],
      };
    });
    const summary = { ...finalMetadata, identical: pairs.every((pair) => pair.identical), pairs };
    await fs.writeFile(path.join(runDir, 'results.json'), runsJson(summary, runs));
    console.log(redactSecrets(JSON.stringify({ identical: summary.identical, pairs }, null, 2)));
    return;
  }
  const outputs: Record<string, string> = {
    'runs.json': runsJson(finalMetadata, runs),
    'runs.csv': runsCsv(runs),
    'report.md': markdown(config, finalMetadata, suite, entries, policies, runs, validations),
  };
  for (const name of ['latest', ...(config.mode === 'smoke' ? [] : [`latest-${config.mode}`])]) {
    const latest = path.join(config.outputDir, name);
    await fs.rm(latest, { recursive: true, force: true });
    await fs.mkdir(latest, { recursive: true });
    for (const [file, body] of Object.entries(outputs)) await fs.writeFile(path.join(latest, file), body);
    await fs.writeFile(path.join(latest, 'SOURCE'), `${path.basename(runDir)}\n`);
  }
  for (const [file, body] of Object.entries(outputs)) await fs.writeFile(path.join(runDir, file), body);
  console.log(`Done in ${duration(performance.now() - started)}. Report: ${path.join(runDir, 'report.md')}`);
}
if (!process.env.VITEST && !process.env.FULL_MAZE_EVAL_AS_LIBRARY)
  main().catch((error) => {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
