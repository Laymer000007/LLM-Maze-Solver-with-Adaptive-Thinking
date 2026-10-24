import {
  type Decision,
  type DecisionState,
  type Policy,
  type PolicyId,
  type SuiteEntry,
  TIMEOUT_MS,
  type Transform,
  callLaya,
  callOllama,
  constrainedPrompt,
  layaBody,
  ollamaRequestBody,
  scorerOptimal,
  seededShuffle,
} from '@/benchmark/full-maze-eval-lib';
import { MOVES, type Move } from '@/execution/execution';
import { Maze, type Position } from '@/maze/maze';

// Word-prompt builders, policies and metrics shared by the word-prompt experiments. Side-effect free (no main()).

/** Where the models live; enough to build and send requests. */
export type ModelEndpoints = { layaUrl: string; ollamaUrl: string; ollamaModel: string };

export type Variant = 'numbers-baseline' | 'words-lookahead' | 'words-feedback';
export type Model = 'laya' | 'ollama';
export const VARIANTS: Variant[] = ['numbers-baseline', 'words-lookahead', 'words-feedback'];
export const MODELS: Model[] = ['laya', 'ollama'];
/** A request as sent, minus the auth header. For Ollama the prompt itself is messages[0].content. */
export type CapturedRequest = { endpoint: string; body: Record<string, unknown> };
export const MOVES4 = [...MOVES] as Move[];
export const MAZES = ['mazes/7x7_corridor_branch.txt', 'mazes/7x7_open_detour.txt'];
export const ORIENTATIONS: Transform[] = ['original', 'rotate-180'];
export const INTRO = 'You are a mouse in a dark maze, searching for cheese by smell.';
export const LAYA_INSTRUCTIONS = 'Choose exactly one movement direction. Return the direction label.';
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

export function wordRequest(
  model: Model,
  variant: Exclude<Variant, 'numbers-baseline'>,
  state: DecisionState,
  order: Move[],
  feedback: string,
): CapturedRequest['body'] {
  const closeness = `${capitalise(closenessWords(state.perception.smell))}.`;
  const line = variant === 'words-lookahead' ? lookaheadLine : feedbackLine;
  const context = variant === 'words-lookahead' ? [INTRO, closeness] : [INTRO, feedback, closeness];
  if (model === 'laya')
    return {
      state: { body: [...context, 'Choose the direction most likely to lead to the cheese.'].join('\n') },
      questions: {
        move: { type: 'choice', instructions: LAYA_INSTRUCTIONS, criteria: Object.fromEntries(order.map((move) => [move.toUpperCase(), line(state, move)])) },
      },
    };
  const directions = order.map((move) => `${move.toUpperCase()}: ${line(state, move)}.`);
  return { prompt: [...context, 'You can go:', ...directions, 'Choose one direction.', OLLAMA_RETURN].join('\n') };
}

export function createWordPolicy(model: Model, variant: Variant, config: ModelEndpoints, capture?: (request: CapturedRequest) => void): Policy {
  let last: LastStep = null;
  const id = `${model}-${variant}` as PolicyId; // experiment-only ids, outside the harness's PolicyId union
  const decide = async (state: DecisionState, random: () => number): Promise<Decision> => {
    const order = seededShuffle(state.validActions, random);
    const feedback = feedbackWords(state, last);
    let decision: Decision;
    if (model === 'laya') {
      const body = variant === 'numbers-baseline' ? layaBody(state, 'B-constrained', order) : wordRequest('laya', variant, state, order, feedback);
      capture?.({ endpoint: `${config.layaUrl}/v1/systemone`, body });
      decision = { ...(await callLaya(config.layaUrl, body, TIMEOUT_MS)), presented: order };
      if (variant === 'numbers-baseline') decision.criteria = (body as { questions: { move: { criteria: Record<string, string> } } }).questions.move.criteria;
    } else {
      const prompt =
        variant === 'numbers-baseline' ? constrainedPrompt(state, order) : (wordRequest('ollama', variant, state, order, feedback).prompt as string);
      capture?.({ endpoint: `${config.ollamaUrl}/api/chat`, body: ollamaRequestBody(config.ollamaModel, prompt, false) });
      decision = { ...(await callOllama(config.ollamaUrl, config.ollamaModel, prompt, false, TIMEOUT_MS)), presented: order };
    }
    last = {
      position: state.position,
      smell: state.perception.smell,
      choice: decision.choice,
      blocked: decision.choice !== null && state.perception.directions[decision.choice] === 'wall',
    };
    return decision;
  };
  const payload =
    variant === 'numbers-baseline' ? (model === 'laya' ? 'layaBody(B-constrained), shuffled' : 'constrainedPrompt(), shuffled') : `${variant} words`;
  return {
    id,
    kind: model,
    deterministic: true,
    config: {
      payloadBuilder: payload,
      endpoint: model === 'laya' ? `${config.layaUrl}/v1/systemone` : `${config.ollamaUrl}/api/chat`,
      model: model === 'laya' ? null : config.ollamaModel,
      think: model === 'laya' ? null : false,
      temperature: model === 'laya' ? null : 0.2,
      format: model === 'laya' ? 'systemone choice question' : 'json',
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

export type TuningVariant =
  | 'lookahead'
  | 'lookahead-rule'
  | 'warmer-only'
  | 'smell-only'
  | 'warmer-only-positive'
  | 'smell-only-positive'
  | 'rule-instructions-only'
  | 'rule-state-only';
/** Variants of the main tuning round; smell-only is used only by --mode ablation. */
export const TUNING_VARIANTS: TuningVariant[] = ['lookahead', 'lookahead-rule', 'warmer-only'];
export const ABLATION_VARIANTS: TuningVariant[] = ['warmer-only', 'smell-only'];
/** --mode ablation-positive: the same two arms with the positive-only rule. */
export const POSITIVE_VARIANTS: TuningVariant[] = ['warmer-only-positive', 'smell-only-positive'];
/** --mode ablation-placement, Laya only: warmer/colder + positive rule, with the rule in both places, instructions only, or state.body only. */
export const PLACEMENT_VARIANTS: TuningVariant[] = ['warmer-only-positive', 'rule-instructions-only', 'rule-state-only'];
export const RULE_PLACEMENT_ONLY: TuningVariant[] = ['rule-instructions-only', 'rule-state-only'];
export const RULE =
  'The cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker.';
export const POSITIVE_RULE = 'The cheese is where the smell is strongest. Always move in the direction where the smell grows stronger.';
export type Arm = { model: Model; variant: TuningVariant; think: boolean };
export type Row = {
  arm: string;
  stateId: string;
  choice: Move | null;
  legal: boolean;
  toward: boolean;
  latencyMs: number;
  failure: string | null;
  order: Move[];
  /** Laya's usage.input_tokens, when returned. */
  inputTokens?: number | null;
};

export const armId = (arm: Arm) => `${arm.model}-${arm.variant}${arm.think ? '-think' : ''}`;

export function warmerLine(state: DecisionState, move: Move): string {
  return state.perception.directionSmell[move] > state.perception.smell ? 'warmer, the smell grows stronger' : 'colder, the smell grows weaker';
}
/** warmerLine() without the "warmer, " / "colder, " prefix. */
export function smellOnlyLine(state: DecisionState, move: Move): string {
  return state.perception.directionSmell[move] > state.perception.smell ? 'the smell grows stronger' : 'the smell grows weaker';
}
/** Legal directions whose neighbour cell smells stronger than the current one. */
export function strongerMoves(state: DecisionState): Move[] {
  return state.validActions.filter((move) => state.perception.directionSmell[move] > state.perception.smell);
}

/** The request body for an arm, before the Ollama envelope; for Ollama it is { prompt }. */
export function tunedRequest(model: Model, variant: TuningVariant, state: DecisionState, order: Move[]): Record<string, unknown> {
  if (variant === 'lookahead') return wordRequest(model, 'words-lookahead', state, order, '');
  const line = variant === 'lookahead-rule' ? lookaheadLine : variant.startsWith('smell-only') ? smellOnlyLine : warmerLine;
  const placementOnly = RULE_PLACEMENT_ONLY.includes(variant);
  if (placementOnly && model !== 'laya') throw new Error(`${variant} is a Laya-only variant.`);
  const rule = variant.endsWith('-positive') || placementOnly ? POSITIVE_RULE : RULE;
  const closeness = `${capitalise(closenessWords(state.perception.smell))}.`;
  if (model === 'laya')
    return {
      state: {
        body: [INTRO, closeness, ...(variant === 'rule-instructions-only' ? [] : [rule]), 'Choose the direction most likely to lead to the cheese.'].join('\n'),
      },
      questions: {
        move: {
          type: 'choice',
          instructions: variant === 'rule-state-only' ? LAYA_INSTRUCTIONS : `${rule} ${LAYA_INSTRUCTIONS}`,
          criteria: Object.fromEntries(order.map((move) => [move.toUpperCase(), line(state, move)])),
        },
      },
    };
  return {
    prompt: [
      INTRO,
      closeness,
      rule,
      'You can go:',
      ...order.map((move) => `${move.toUpperCase()}: ${line(state, move)}.`),
      'Choose one direction.',
      OLLAMA_RETURN,
    ].join('\n'),
  };
}
/** What is actually sent: the Laya body, or the full Ollama /api/chat body. */
export function armRequest(arm: Arm, state: DecisionState, order: Move[], ollamaModel: string): CapturedRequest['body'] {
  const body = tunedRequest(arm.model, arm.variant, state, order);
  return arm.model === 'laya' ? body : ollamaRequestBody(ollamaModel, body.prompt as string, arm.think);
}
export async function ask(arm: Arm, state: DecisionState, order: Move[], config: ModelEndpoints): Promise<Decision> {
  const body = tunedRequest(arm.model, arm.variant, state, order);
  return arm.model === 'laya'
    ? callLaya(config.layaUrl, body, TIMEOUT_MS)
    : callOllama(config.ollamaUrl, config.ollamaModel, body.prompt as string, arm.think, TIMEOUT_MS);
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

export const MAZE_CHECK_ARMS: Record<'laya-best' | 'ollama-best', Arm> = {
  'laya-best': { model: 'laya', variant: 'warmer-only-positive', think: false },
  'ollama-best': { model: 'ollama', variant: 'warmer-only', think: false },
};
export type ColderStep = { policy: string; entry: string; step: number; position: string; options: Move[]; choice: Move | null; legal: boolean };
/** Every legal direction smells weaker than the current cell: every option is "colder". */
export function allColder(state: DecisionState): boolean {
  return state.validActions.length > 0 && strongerMoves(state).length === 0;
}
export function armPolicy(id: string, arm: Arm, config: ModelEndpoints, capture?: (request: CapturedRequest) => void): Policy {
  return {
    id: id as PolicyId, // experiment-only id
    kind: arm.model,
    deterministic: true,
    config: {
      payloadBuilder: `${armId(arm)} words`,
      endpoint: arm.model === 'laya' ? `${config.layaUrl}/v1/systemone` : `${config.ollamaUrl}/api/chat`,
      model: arm.model === 'laya' ? null : config.ollamaModel,
      think: arm.model === 'laya' ? null : arm.think,
      temperature: arm.model === 'laya' ? null : 0.2,
      format: arm.model === 'laya' ? 'systemone choice question' : 'json',
      optionOrdering: 'legal moves, seeded shuffle per request',
      sees: 'warmer/colder per direction (words)',
    },
    decide: async (state, random) => {
      const order = seededShuffle(state.validActions, random);
      capture?.({
        endpoint: arm.model === 'laya' ? `${config.layaUrl}/v1/systemone` : `${config.ollamaUrl}/api/chat`,
        body: armRequest(arm, state, order, config.ollamaModel),
      });
      return { ...(await ask(arm, state, order, config)), presented: order };
    },
  };
}
