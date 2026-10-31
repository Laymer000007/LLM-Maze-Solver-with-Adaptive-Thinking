import {
  type Decision,
  type DecisionState,
  type Policy,
  type PolicyId,
  type SuiteEntry,
  TIMEOUT_MS,
  type Transform,
  callOllama,
  constrainedPrompt,
  ollamaRequestBody,
  parseMove,
  scorerOptimal,
  rng,
  runSeed,
  seededShuffle,
} from '@/benchmark/full-maze-eval-lib';
import { MOVES, type Move } from '@/execution/execution';
import { Maze, type Position } from '@/maze/maze';

// Word-prompt builders, policies and metrics shared by the Ollama word-prompt experiments. Side-effect free (no main()).

/** Where the model lives; enough to build and send requests. */
export type ModelEndpoints = { ollamaUrl: string; ollamaModel: string };

export type Variant = 'numbers-baseline' | 'words-lookahead' | 'words-feedback';
export const VARIANTS: Variant[] = ['numbers-baseline', 'words-lookahead', 'words-feedback'];
/** A request as sent. The prompt itself is messages[0].content. */
export type CapturedRequest = { endpoint: string; body: Record<string, unknown> };
export const MOVES4 = [...MOVES] as Move[];
export const MAZES = ['mazes/7x7_corridor_branch.txt', 'mazes/7x7_open_detour.txt'];
export const ORIENTATIONS: Transform[] = ['original', 'rotate-180'];
export const INTRO = 'You are a mouse in a dark maze, searching for cheese by smell.';
export const OLLAMA_RETURN = 'Return only JSON: {"move":"up|down|left|right"}.';
export const stepCapFor = (optimalSteps: number) => Math.max(3 * optimalSteps, 60);
export const key = (p: Position) => `${p.x},${p.y}`;
export const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
export function nextPosition(p: Position, move: Move): Position {
  return { x: p.x + (move === 'left' ? -1 : move === 'right' ? 1 : 0), y: p.y + (move === 'up' ? -1 : move === 'down' ? 1 : 0) };
}

// ---------- Words ----------

/** distance = 101 − smell (smell is 101 − BFS distance to the goal). */
export function closenessWords(smell: number): string {
  const distance = 101 - smell;
  if (distance <= 2) return 'the cheese smell is overwhelming, it must be right here';
  if (distance <= 5) return 'the smell is strong';
  if (distance <= 10) return 'the smell is noticeable';
  return 'the smell is faint';
}
export function visitWords(visits: number): string {
  return visits === 0 ? "you haven't been there" : visits >= 3 ? "you've been there many times" : "you've been there before";
}
export function smellTrendWords(state: DecisionState, move: Move): string {
  return state.perception.directionSmell[move] > state.perception.smell ? 'the smell grows stronger that way' : 'the smell grows weaker that way';
}
export const visitsTo = (state: DecisionState, move: Move) => state.memory.visitCounts[key(nextPosition(state.position, move))] ?? 0;
export function lookaheadLine(state: DecisionState, move: Move): string {
  return `an open passage; ${smellTrendWords(state, move)}; ${visitWords(visitsTo(state, move))}`;
}
export function feedbackLine(state: DecisionState, move: Move): string {
  return `an open passage; ${visitWords(visitsTo(state, move))}`;
}
export type LastStep = { position: Position; smell: number; choice: Move | null; blocked: boolean } | null;
/** How the previous decision went, judged only from the position and smell before and after it. */
export function feedbackWords(state: DecisionState, last: LastStep): string {
  if (!last) return 'You have just started.';
  if (key(last.position) === key(state.position)) return last.choice && last.blocked ? 'You bumped into a wall.' : 'You did not move on your last turn.';
  return state.perception.smell > last.smell ? 'That step took you closer: the smell got stronger.' : 'That step took you further: the smell got weaker.';
}

// ---------- Requests ----------

export function wordPrompt(variant: Exclude<Variant, 'numbers-baseline'>, state: DecisionState, order: Move[], feedback: string): string {
  const closeness = `${capitalise(closenessWords(state.perception.smell))}.`;
  const line = variant === 'words-lookahead' ? lookaheadLine : feedbackLine;
  const context = variant === 'words-lookahead' ? [INTRO, closeness] : [INTRO, feedback, closeness];
  const directions = order.map((move) => `${move.toUpperCase()}: ${line(state, move)}.`);
  return [...context, 'You can go:', ...directions, 'Choose one direction.', OLLAMA_RETURN].join('\n');
}

export function createWordPolicy(variant: Variant, config: ModelEndpoints, capture?: (request: CapturedRequest) => void): Policy {
  let last: LastStep = null;
  const id = `ollama-${variant}` as PolicyId; // experiment-only ids, outside the harness's PolicyId union
  const decide = async (state: DecisionState, random: () => number): Promise<Decision> => {
    const order = seededShuffle(state.validActions, random);
    const prompt = variant === 'numbers-baseline' ? constrainedPrompt(state, order) : wordPrompt(variant, state, order, feedbackWords(state, last));
    capture?.({ endpoint: `${config.ollamaUrl}/api/chat`, body: ollamaRequestBody(config.ollamaModel, prompt, false) });
    const decision = { ...(await callOllama(config.ollamaUrl, config.ollamaModel, prompt, false, TIMEOUT_MS)), presented: order };
    last = {
      position: state.position,
      smell: state.perception.smell,
      choice: decision.choice,
      blocked: decision.choice !== null && state.perception.directions[decision.choice] === 'wall',
    };
    return decision;
  };
  return {
    id,
    kind: 'ollama',
    deterministic: true,
    config: {
      payloadBuilder: variant === 'numbers-baseline' ? 'constrainedPrompt(), shuffled' : `${variant} words`,
      endpoint: `${config.ollamaUrl}/api/chat`,
      model: config.ollamaModel,
      think: false,
      temperature: 0.2,
      format: 'json',
      optionOrdering: 'legal moves, seeded shuffle per request',
      sees:
        variant === 'numbers-baseline'
          ? 'scores, visits, smell (numbers)'
          : variant === 'words-lookahead'
            ? 'per-direction smell trend (words), visits (words)'
            : 'last-step smell feedback (words), visits (words)',
    },
    decide,
  };
}
export function baselinePolicy(id: 'scorer' | 'random-legal'): Policy {
  const choose = <T>(random: () => number, values: T[]) => values[Math.floor(random() * values.length) % values.length];
  return {
    id,
    kind: 'baseline',
    deterministic: true,
    config: {
      payloadBuilder: 'none',
      endpoint: null,
      model: null,
      think: null,
      temperature: null,
      format: null,
      optionOrdering: 'n/a',
      sees: id === 'scorer' ? 'scores' : 'walls only',
    },
    decide: async (state, random) => ({
      choice: choose(random, id === 'scorer' ? scorerOptimal(state) : state.validActions.length ? state.validActions : MOVES4),
      latencyMs: null,
    }),
  };
}

// ---------- Metrics ----------

/** Replays a run's moves and returns the share of chosen moves (walls included) whose target cell smells stronger. */
export function towardStrongerSmell(entry: SuiteEntry, moves: string[]): { toward: number; chosen: number } {
  const maze = new Maze(entry.layout);
  let position = { ...maze.startPosition };
  let toward = 0;
  let chosen = 0;
  for (const step of moves) {
    if (step.startsWith('!')) continue;
    const move = step.replace('#wall', '') as Move;
    const target = nextPosition(position, move);
    chosen++;
    if (maze.isWalkable(target) && maze.smellAt(target) > maze.smellAt(position)) toward++;
    if (!step.endsWith('#wall')) position = target;
  }
  return { toward, chosen };
}

// ---------- Tuning variants ----------

export type TuningVariant = 'lookahead' | 'lookahead-rule' | 'warmer-only' | 'smell-only' | 'warmer-only-positive' | 'smell-only-positive';
/** Variants of the main tuning round; smell-only is used only by --mode ablation. */
export const TUNING_VARIANTS: TuningVariant[] = ['lookahead', 'lookahead-rule', 'warmer-only'];
export const ABLATION_VARIANTS: TuningVariant[] = ['warmer-only', 'smell-only'];
/** --mode ablation-positive: the same two arms with the positive-only rule. */
export const POSITIVE_VARIANTS: TuningVariant[] = ['warmer-only-positive', 'smell-only-positive'];
export const RULE =
  'The cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker.';
export const POSITIVE_RULE = 'The cheese is where the smell is strongest. Always move in the direction where the smell grows stronger.';
export type Arm = { variant: TuningVariant; think: boolean };
export type Row = {
  arm: string;
  stateId: string;
  choice: Move | null;
  legal: boolean;
  toward: boolean;
  latencyMs: number;
  failure: string | null;
  order: Move[];
};

export const armId = (arm: Arm) => `ollama-${arm.variant}${arm.think ? '-think' : ''}`;

export const WARMER_TEXT = 'warmer, the smell grows stronger';
export const COLDER_TEXT = 'colder, the smell grows weaker';
export function warmerLine(state: DecisionState, move: Move): string {
  return state.perception.directionSmell[move] > state.perception.smell ? WARMER_TEXT : COLDER_TEXT;
}
/** warmerLine() without the "warmer, " / "colder, " prefix. */
export function smellOnlyLine(state: DecisionState, move: Move): string {
  return state.perception.directionSmell[move] > state.perception.smell ? 'the smell grows stronger' : 'the smell grows weaker';
}
/** Legal directions whose neighbour cell smells stronger than the current one. */
export function strongerMoves(state: DecisionState): Move[] {
  return state.validActions.filter((move) => state.perception.directionSmell[move] > state.perception.smell);
}

/** The prompt for a tuning variant. */
export function tunedPrompt(variant: TuningVariant, state: DecisionState, order: Move[]): string {
  if (variant === 'lookahead') return wordPrompt('words-lookahead', state, order, '');
  const line = variant === 'lookahead-rule' ? lookaheadLine : variant.startsWith('smell-only') ? smellOnlyLine : warmerLine;
  const rule = variant.endsWith('-positive') ? POSITIVE_RULE : RULE;
  const closeness = `${capitalise(closenessWords(state.perception.smell))}.`;
  return [
    INTRO,
    closeness,
    rule,
    'You can go:',
    ...order.map((move) => `${move.toUpperCase()}: ${line(state, move)}.`),
    'Choose one direction.',
    OLLAMA_RETURN,
  ].join('\n');
}
/** The full Ollama /api/chat body for an arm. */
export function armRequest(arm: Arm, state: DecisionState, order: Move[], ollamaModel: string): CapturedRequest['body'] {
  return ollamaRequestBody(ollamaModel, tunedPrompt(arm.variant, state, order), arm.think);
}
export async function ask(arm: Arm, state: DecisionState, order: Move[], config: ModelEndpoints): Promise<Decision> {
  return callOllama(config.ollamaUrl, config.ollamaModel, tunedPrompt(arm.variant, state, order), arm.think, TIMEOUT_MS);
}

export function summarise(rows: Row[]) {
  const answered = rows.length;
  const latencies = rows.map((r) => r.latencyMs);
  return {
    states: answered,
    towardRate: answered ? rows.filter((r) => r.toward).length / answered : 0,
    legalRate: answered ? rows.filter((r) => r.legal).length / answered : 0,
    failures: rows.filter((r) => r.failure).length,
    meanLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
  };
}
/** Best = highest toward-stronger rate, then legal rate, then lower latency. */
export function bestArm<T extends { towardRate: number; legalRate: number; meanLatencyMs: number }>(candidates: [string, T][]): string {
  return [...candidates].sort(([, a], [, b]) => b.towardRate - a.towardRate || b.legalRate - a.legalRate || a.meanLatencyMs - b.meanLatencyMs)[0][0];
}

export const MAZE_CHECK_ARMS: Record<'ollama-best', Arm> = {
  'ollama-best': { variant: 'warmer-only', think: false },
};
export type ColderStep = { policy: string; entry: string; step: number; position: string; options: Move[]; choice: Move | null; legal: boolean };
/** Every legal direction smells weaker than the current cell: every option is "colder". */
export function allColder(state: DecisionState): boolean {
  return state.validActions.length > 0 && strongerMoves(state).length === 0;
}
export function armPolicy(id: string, arm: Arm, config: ModelEndpoints, capture?: (request: CapturedRequest) => void): Policy {
  return {
    id: id as PolicyId, // experiment-only id
    kind: 'ollama',
    deterministic: true,
    config: {
      payloadBuilder: `${armId(arm)} words`,
      endpoint: `${config.ollamaUrl}/api/chat`,
      model: config.ollamaModel,
      think: arm.think,
      temperature: 0.2,
      format: 'json',
      optionOrdering: 'legal moves, seeded shuffle per request',
      sees: 'warmer/colder per direction (words)',
    },
    decide: async (state, random) => {
      const order = seededShuffle(state.validActions, random);
      capture?.({ endpoint: `${config.ollamaUrl}/api/chat`, body: armRequest(arm, state, order, config.ollamaModel) });
      return { ...(await ask(arm, state, order, config)), presented: order };
    },
  };
}

// ---------- Situations: every distinct word request ----------

/**
 * Everything a warmer/colder word request depends on: the closeness phrase and the options in the order shown, each
 * warmer or colder. The request has no coordinates, so two cells with the same situation get byte-identical requests.
 */
export type Situation = { closeness: string; options: { move: Move; warmer: boolean }[] };
export type OllamaLabels = 'moves' | 'compass';
const COMPASS: Record<Move, string> = { up: 'NORTH', down: 'SOUTH', right: 'EAST', left: 'WEST' };
/** The four closeness phrases, nearest first (distances 1, 4, 8 and 20 produce them). */
export const CLOSENESS_PHRASES = [1, 4, 8, 20].map((distance) => closenessWords(101 - distance));

export function situationOf(state: DecisionState, order: Move[]): Situation {
  return {
    closeness: closenessWords(state.perception.smell),
    options: order.map((move) => ({ move, warmer: state.perception.directionSmell[move] > state.perception.smell })),
  };
}
/** Labels for the options in shown order: direction words or compass points. */
export function optionLabels(labels: OllamaLabels, order: Move[]): string[] {
  return order.map((move) => (labels === 'moves' ? move.toUpperCase() : COMPASS[move]));
}

export type EnumeratedRequest = { key: string; open: Move[]; warmer: Move[]; closeness: string; orderKind: 'canonical' | 'shuffled'; order: Move[] };
const subsets = (values: Move[]) => Array.from({ length: (1 << values.length) - 1 }, (_, mask) => values.filter((_, i) => ((mask + 1) >> i) & 1));
/**
 * Every situation: each non-empty set of open directions (canonical up, down, left, right order), each non-empty warmer
 * subset (every cell has a warmer neighbour under BFS smell), each closeness phrase; in canonical order and one seeded
 * shuffled order that differs from it (none for a single option).
 */
export function enumerateSituations(seed: number): EnumeratedRequest[] {
  const out: EnumeratedRequest[] = [];
  for (const open of subsets(MOVES4))
    for (const warmer of subsets(open))
      for (const closeness of CLOSENESS_PHRASES) {
        const key = `${open.join('+')}|warm:${warmer.join('+')}|${closeness}`;
        out.push({ key, open, warmer, closeness, orderKind: 'canonical', order: open });
        if (open.length < 2) continue;
        let shuffled = seededShuffle(open, rng(runSeed(seed, key)));
        if (shuffled.join() === open.join()) shuffled = [...open].reverse();
        out.push({ key, open, warmer, closeness, orderKind: 'shuffled', order: shuffled });
      }
  return out;
}
export const situationFor = (request: EnumeratedRequest): Situation => ({
  closeness: request.closeness,
  options: request.order.map((move) => ({ move, warmer: request.warmer.includes(move) })),
});

// ---------- ollama-best with direction or compass labels ----------

export const OLLAMA_COMPASS_RETURN = 'Return only JSON: {"move":"north|south|east|west"}.';
/**
 * ollama-best (warmer/colder options, full rule) from a situation. 'moves' is byte-identical to the ollama-best prompt;
 * 'compass' labels the options NORTH/SOUTH/EAST/WEST and asks for {"move":"north|south|east|west"}.
 */
export function ollamaBestPrompt(situation: Situation, labels: OllamaLabels): string {
  const names = optionLabels(
    labels,
    situation.options.map((o) => o.move),
  );
  return [
    INTRO,
    `${capitalise(situation.closeness)}.`,
    RULE,
    'You can go:',
    ...situation.options.map((o, i) => `${names[i]}: ${o.warmer ? WARMER_TEXT : COLDER_TEXT}.`),
    'Choose one direction.',
    labels === 'compass' ? OLLAMA_COMPASS_RETURN : OLLAMA_RETURN,
  ].join('\n');
}
const FROM_COMPASS: Record<string, Move> = { north: 'up', south: 'down', east: 'right', west: 'left' };
/**
 * Maps Ollama's message.content back to a move. Any direction in the scheme counts, offered or not, so an unoffered one
 * is an illegal choice (a wall collision in a maze) rather than a failure, for both label schemes alike.
 */
export function ollamaAnswerToMove(labels: OllamaLabels, content: string | null): Move | null {
  if (content === null) return null;
  let value: unknown;
  try {
    value = (JSON.parse(content) as { move?: unknown })?.move;
  } catch {
    return null;
  }
  // Same rule for both: a direction word anywhere in the value (parseMove, as ollama-best always used).
  if (labels === 'moves') return parseMove(value);
  const match = (typeof value === 'string' ? value : (JSON.stringify(value) ?? '')).match(/\b(north|south|east|west)\b/i);
  return match ? FROM_COMPASS[match[1].toLowerCase()] : null;
}
