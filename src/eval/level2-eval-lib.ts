import fs from 'fs/promises';
import path from 'path';

import { timedChat } from '@/eval/final-eval-lib';
import { LEVELS } from '@/game/game';
import {
  Level2Game,
  level2Situation,
  loadLevel2,
  shortestSafePath,
  type CatMove,
  type CatSense,
  type CatchCase,
  type Level2Status,
  type Move,
  type Option2,
} from '@/game/level2';
import { buildLevel2Request, parseLevel2Answer, senseRangeFor, shuffleOptions, type Level2Variant } from '@/game/prompt';
import { rng, runSeed } from '@/game/random';
import { OllamaClient } from '@/llm/ollama';

// The level-2 evaluation: the six cat levels, played by free policies and by Ollama. No side effects on import;
// the entry point is level2-eval.ts.

export const LEVEL2_DIR = 'mazes/level2';
export const THINK_TIMEOUT_MS = 60_000;
/** The default evaluation seed; the levels were chosen so greedy is caught with it. */
export const LEVEL2_SEED = 20261109;

export async function level2Files(root: string): Promise<string[]> {
  return (await fs.readdir(path.join(root, LEVEL2_DIR)))
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => path.join(LEVEL2_DIR, file));
}

export type Level2Entry = { id: string; file: string; newGame: (senseRange?: number) => Level2Game };

export async function level2Entry(root: string, file: string): Promise<Level2Entry> {
  const level = await loadLevel2(path.join(root, file));
  return { id: path.basename(file, '.json'), file, newGame: (senseRange?: number) => new Level2Game(level.maze, level.cat, senseRange) };
}

export type Decision = {
  answer: Move | null;
  text: string;
  latencyMs: number | null;
  failure: string | null;
  /** The request had think on. */
  thinking: boolean;
  /** The prompt text sent, for Ollama policies. */
  prompt?: string;
};

export type Level2Policy = {
  id: string;
  free: boolean;
  /** The mouse's sensing range for this policy (default SENSE_RANGE). */
  senseRange?: number;
  decide: (game: Level2Game, offered: Option2[], random: () => number) => Promise<Decision>;
};

const instant = (answer: Move): Decision => ({ answer, text: '', latencyMs: null, failure: null, thinking: false });

/** Ignores the cat: always the warmest legal move, ties broken by the seeded RNG. */
export const greedyPolicy: Level2Policy = {
  id: 'greedy',
  free: true,
  decide: async (_game, offered, random) => {
    const moves = offered.filter((option) => option.direction !== 'stay');
    const best = LEVELS[Math.min(...moves.map((option) => LEVELS.indexOf(option.level)))];
    const ties = moves.filter((option) => option.level === best);
    return instant(ties[Math.floor(random() * ties.length)].direction);
  },
};

/** Follows the solvability search from the current state. */
export const plannerPolicy: Level2Policy = {
  id: 'planner',
  free: true,
  decide: async (game) => instant(shortestSafePath(game.maze, game.position, game.cat)?.[0] ?? 'stay'),
};

export const randomLegalPolicy: Level2Policy = {
  id: 'random-legal',
  free: true,
  decide: async (_game, offered, random) => instant(offered[Math.floor(random() * offered.length)].direction),
};

/** An Ollama policy. thinkWhenSensed: think on (60 s timeout) only on steps where the cat is sensed. */
export function ollamaPolicy(
  client: OllamaClient,
  model: string,
  variant: Level2Variant,
  thinkWhenSensed = false,
  capture?: (body: Record<string, unknown>, sensed: boolean) => void,
): Level2Policy {
  return {
    id: thinkWhenSensed ? `${variant}+think` : variant,
    free: false,
    senseRange: senseRangeFor(variant),
    decide: async (game, offered) => {
      const situation = level2Situation(game, offered);
      const thinking = thinkWhenSensed && situation.sensed !== null;
      const body = buildLevel2Request(model, situation, variant, 0.2, thinking);
      capture?.(body, situation.sensed !== null);
      const reply = await timedChat(client, body, thinking ? THINK_TIMEOUT_MS : undefined);
      return {
        answer: reply.failure ? null : parseLevel2Answer(reply.text),
        text: reply.text,
        latencyMs: reply.latencyMs,
        failure: reply.failure,
        thinking,
        prompt: (body.messages as { content: string }[])[0].content,
      };
    },
  };
}

export type Level2StepRecord = {
  step: number;
  sensed: boolean;
  sense: CatSense | null;
  /** The cat's last three moves before this step, whether or not the mouse was told. */
  catHistory: CatMove[];
  offered: Option2[];
  answer: Move | null;
  valid: boolean;
  catPenalty: number;
  distanceAfter: number;
  catchCase: CatchCase | null;
  latencyMs: number | null;
  thinking: boolean;
  failure: string | null;
  prompt?: string;
};

export type Level2Run = {
  entry: string;
  policy: string;
  status: Level2Status | 'aborted';
  steps: number;
  shortestSafe: number;
  stepCap: number;
  invalid: number;
  finalMood: number;
  catchCase: CatchCase | null;
  caughtOnStep: number | null;
  records: Level2StepRecord[];
};

/** Plays one level to the end. Options are shuffled every step; three failed requests in a row abort the run. */
export async function runLevel2(entry: Level2Entry, policy: Level2Policy, seed: number): Promise<Level2Run> {
  const game = entry.newGame(policy.senseRange);
  const random = rng(runSeed(seed, entry.id, policy.id));
  const records: Level2StepRecord[] = [];
  let failuresInARow = 0;
  let aborted = false;
  while (game.status === 'running') {
    const offered = shuffleOptions(game.options(), random);
    const historyBefore = game.catHistory.slice(-3);
    const decision = await policy.decide(game, offered, random);
    const result = game.apply(decision.answer, offered);
    records.push({
      step: result.step,
      sensed: result.sensed !== null,
      sense: result.sensed,
      catHistory: historyBefore,
      offered,
      answer: decision.answer,
      valid: result.valid,
      catPenalty: result.catPenalty,
      distanceAfter: result.distanceAfter,
      catchCase: result.catchCase,
      latencyMs: decision.latencyMs,
      thinking: decision.thinking,
      failure: decision.failure,
      prompt: decision.prompt,
    });
    failuresInARow = decision.failure ? failuresInARow + 1 : 0;
    if (failuresInARow >= 3) {
      aborted = true;
      break;
    }
  }
  return {
    entry: entry.id,
    policy: policy.id,
    status: aborted ? 'aborted' : game.status,
    steps: game.steps,
    shortestSafe: game.shortestSafe,
    stepCap: game.stepCap,
    invalid: game.invalid,
    finalMood: game.mood,
    catchCase: game.catchCase,
    caughtOnStep: game.status === 'caught' ? game.steps : null,
    records,
  };
}

/** A choice made with the cat sensed was safe if the mouse was not caught and did not end one block from the cat. */
export const unsafeKind = (step: Level2StepRecord): string | null => step.catchCase ?? (step.distanceAfter === 1 ? 'ended one block from the cat' : null);

export function summariseLevel2(runs: Level2Run[]) {
  const steps = runs.flatMap((run) => run.records);
  const sensed = steps.filter((step) => step.sensed);
  const latencies = (filter: (s: Level2StepRecord) => boolean) => steps.filter((s) => s.latencyMs !== null && filter(s)).map((s) => s.latencyMs!);
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      mean: sorted.length ? sorted.reduce((t, v) => t + v, 0) / sorted.length : null,
      p95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] : null,
    };
  };
  const unsafe = new Map<string, number>();
  for (const step of sensed) {
    const kind = unsafeKind(step);
    if (kind) unsafe.set(kind, (unsafe.get(kind) ?? 0) + 1);
  }
  return {
    runs: runs.length,
    completed: runs.filter((run) => run.status === 'solved').length,
    caught: runs.filter((run) => run.status === 'caught').length,
    invalid: runs.reduce((t, run) => t + run.invalid, 0),
    penalties100: steps.filter((s) => s.catPenalty === -100).length,
    penalties200: steps.filter((s) => s.catPenalty === -200).length,
    sensedSteps: sensed.length,
    safeSensed: sensed.filter((s) => !unsafeKind(s)).length,
    unsafe: [...unsafe.entries()].sort((a, b) => b[1] - a[1]),
    latency: stats(latencies(() => true)),
    latencySensed: stats(latencies((s) => s.sensed)),
    latencyNotSensed: stats(latencies((s) => !s.sensed)),
    failures: steps.filter((s) => s.failure).length,
  };
}
