import { DIRECTIONS, Game, LEVELS, isDiagonal, moodWord, type Direction, type GameStatus, type Level, type Option } from '@/game/game';
import { buildRequest, parseAnswer, shuffleOptions, type Situation, type Variant } from '@/game/prompt';
import { rng, runSeed, seededShuffle } from '@/game/random';
import { OllamaClient } from '@/llm/ollama';
import { Maze, rotate180 } from '@/maze/maze';

// The final evaluation (§3): single-step situations and full mazes, for the two prompt variants and two baselines.
// No side effects on import; the entry point is final-eval.ts.

export const VARIANTS: Variant[] = ['full', 'smell-only'];
export const MAZES = ['mazes/7x7_corridor_branch.txt', 'mazes/7x7_open_detour.txt', 'mazes/11x11_corridor_dead-end.txt', 'mazes/15x15_corridor_spiral.txt'];
export const ORIENTATIONS = ['original', 'rotate-180'] as const;
const TIMEOUT_MS = 45_000;

/** One representative distance per closeness sentence, and one score per mood word. */
const CLOSENESS_DISTANCES = [2, 4, 8, 20];
const MOOD_SCORES = [900, 700, 500, 300, 100];

const STRAIGHT = ['up', 'down', 'left', 'right'] as const;
const sidesOf = (diagonal: Direction) => diagonal.split('-') as [Direction, Direction];
const warmerOrBetter = (level: Level) => level === 'much warmer' || level === 'warmer';
const rank = (level: Level) => LEVELS.indexOf(level);
export const warmestLevel = (options: Option[]) => LEVELS[Math.min(...options.map((option) => rank(option.level)))];

/**
 * Every distinct situation the rules allow: open directions × a level per direction × closeness × mood word.
 * Straight moves are warmer or colder. A diagonal is open only with both straight sides open, and its level must fit
 * them: both warmer → much warmer or no change, both colder → no change or much colder, mixed → no change. At least one
 * option is warmer or better, as in every real maze cell.
 */
export function enumerateSituations(): Situation[] {
  const local: Option[][] = [];
  for (let mask = 1; mask < 16; mask++) {
    const straight = STRAIGHT.filter((_, i) => mask & (1 << i));
    for (let levelMask = 0; levelMask < 1 << straight.length; levelMask++) {
      const level = new Map<Direction, Level>(straight.map((d, i) => [d, levelMask & (1 << i) ? 'colder' : 'warmer']));
      const diagonals = DIRECTIONS.filter((d) => isDiagonal(d) && sidesOf(d).every((side) => level.has(side)));
      // Each diagonal: closed, or open with a level that fits its sides.
      let partial: Option[][] = [straight.map((direction) => ({ direction, level: level.get(direction)! }))];
      for (const diagonal of diagonals) {
        const sides = sidesOf(diagonal).map((side) => level.get(side)!);
        const fits: Level[] = sides.every((l) => l === 'warmer')
          ? ['much warmer', 'no change']
          : sides.every((l) => l === 'colder')
            ? ['no change', 'much colder']
            : ['no change'];
        partial = partial.flatMap((options) => [options, ...fits.map((l) => [...options, { direction: diagonal, level: l }])]);
      }
      local.push(...partial.filter((options) => options.some((option) => warmerOrBetter(option.level))));
    }
  }
  return local.flatMap((options) => CLOSENESS_DISTANCES.flatMap((distance) => MOOD_SCORES.map((mood) => ({ distance, mood, options }))));
}

/** A fixed-seed sample; each situation's options get their own seeded shuffle, shared by both variants. */
export function sampleSituations(count: number, seed: number): (Situation & { id: string })[] {
  return seededShuffle(enumerateSituations(), rng(seed))
    .slice(0, count)
    .map((situation, i) => ({
      ...situation,
      id: `s${String(i + 1).padStart(3, '0')}`,
      options: shuffleOptions(situation.options, rng(runSeed(seed, String(i)))),
    }));
}

type Answer = {
  answer: Direction | null;
  text: string;
  latencyMs: number | null;
  promptTokens: number | null;
  cachedTokens: number | null;
  failure: string | null;
};

/** One Ollama request for one situation. A transport failure is reported, never retried or corrected. */
export async function askOllama(client: OllamaClient, model: string, situation: Situation, variant: Variant): Promise<Answer> {
  const started = performance.now();
  try {
    const { text, raw } = await client.chat(buildRequest(model, situation, variant), AbortSignal.timeout(TIMEOUT_MS));
    const count = (key: string) => (typeof raw[key] === 'number' ? (raw[key] as number) : null);
    return {
      answer: parseAnswer(text),
      text,
      latencyMs: performance.now() - started,
      promptTokens: count('prompt_eval_count'),
      cachedTokens: count('prompt_eval_cached_count'),
      failure: null,
    };
  } catch (error) {
    return { answer: null, text: '', latencyMs: null, promptTokens: null, cachedTokens: null, failure: error instanceof Error ? error.message : String(error) };
  }
}

// ---------- Single step ----------

export type SingleStepRow = { id: string; variant: Variant; offered: Option[]; mood: number; distance: number } & Answer;

export function summariseSingleStep(rows: SingleStepRow[]) {
  const answered = rows.filter((row) => !row.failure);
  const chosen = (row: SingleStepRow) => row.offered.find((option) => option.direction === row.answer);
  const latencies = answered.map((row) => row.latencyMs!).sort((a, b) => a - b);
  const mean = (values: number[]) => (values.length ? values.reduce((t, v) => t + v, 0) / values.length : null);
  const wrong = new Map<string, number>();
  for (const row of answered) {
    const option = chosen(row);
    const best = warmestLevel(row.offered);
    if (!option) wrong.set(`illegal answer ${JSON.stringify(row.text)}`, (wrong.get(`illegal answer ${JSON.stringify(row.text)}`) ?? 0) + 1);
    else if (option.level !== best) {
      const key = `${option.level} (${option.direction}) over ${best}`;
      wrong.set(key, (wrong.get(key) ?? 0) + 1);
    }
  }
  return {
    situations: rows.length,
    failures: rows.length - answered.length,
    warmest: answered.filter((row) => chosen(row)?.level === warmestLevel(row.offered)).length,
    warmerOrBetter: answered.filter((row) => warmerOrBetter(chosen(row)?.level ?? 'much colder')).length,
    legal: answered.filter((row) => chosen(row)).length,
    firstListed: answered.filter((row) => row.answer === row.offered[0].direction).length,
    meanLatencyMs: mean(latencies),
    p95LatencyMs: latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(0.95 * latencies.length) - 1)] : null,
    meanPromptTokens: mean(answered.map((row) => row.promptTokens).filter((n): n is number => n !== null)),
    meanCachedTokens: mean(answered.map((row) => row.cachedTokens).filter((n): n is number => n !== null)),
    wrong: [...wrong.entries()].sort((a, b) => b[1] - a[1]),
  };
}

// ---------- Mazes ----------

export type Entry = { id: string; file: string; orientation: (typeof ORIENTATIONS)[number]; maze: Maze };

export function buildEntry(layout: string[], file: string, orientation: Entry['orientation']): Entry {
  const name = file.replace(/^.*\//, '').replace(/\.txt$/, '');
  return { id: `${name}@${orientation}`, file, orientation, maze: new Maze(orientation === 'rotate-180' ? rotate180(layout) : layout) };
}

export type Policy = { id: string; decide: (game: Game, offered: Option[], random: () => number) => Promise<Answer> };

const instant = (answer: Direction): Answer => ({ answer, text: '', latencyMs: null, promptTokens: null, cachedTokens: null, failure: null });

/** Always the warmest offered level; ties broken by the seeded RNG. */
export const greedyPolicy: Policy = {
  id: 'greedy',
  decide: async (_game, offered, random) => {
    const best = warmestLevel(offered);
    const ties = offered.filter((option) => option.level === best);
    return instant(ties[Math.floor(random() * ties.length)].direction);
  },
};

export const randomLegalPolicy: Policy = {
  id: 'random-legal',
  decide: async (_game, offered, random) => instant(offered[Math.floor(random() * offered.length)].direction),
};

export function ollamaPolicy(client: OllamaClient, model: string, variant: Variant): Policy {
  return { id: variant, decide: (game, offered) => askOllama(client, model, { distance: game.distance, mood: game.mood, options: offered }, variant) };
}

export type RunRecord = {
  entry: string;
  policy: string;
  status: GameStatus | 'aborted';
  steps: number;
  optimal: number;
  stepCap: number;
  invalid: number;
  failures: number;
  finalMood: number;
  finalMoodWord: string;
  meanLatencyMs: number | null;
  moves: { offered: Option[]; answer: Direction | null; valid: boolean; level: Level | null; latencyMs: number | null; failure: string | null }[];
};

/** Plays one maze to the end. Options are shuffled every step; three failed requests in a row abort the run. */
export async function runEpisode(entry: Entry, policy: Policy, seed: number): Promise<RunRecord> {
  const game = new Game(entry.maze);
  const random = rng(runSeed(seed, entry.id, policy.id));
  const moves: RunRecord['moves'] = [];
  let failuresInARow = 0;
  let aborted = false;
  while (game.status === 'running') {
    const offered = shuffleOptions(game.options(), random);
    const answer = await policy.decide(game, offered, random);
    const result = game.apply(answer.answer, offered);
    moves.push({ offered, answer: answer.answer, valid: result.valid, level: result.level, latencyMs: answer.latencyMs, failure: answer.failure });
    failuresInARow = answer.failure ? failuresInARow + 1 : 0;
    if (failuresInARow >= 3) {
      aborted = true;
      break;
    }
  }
  const latencies = moves.map((move) => move.latencyMs).filter((n): n is number => n !== null);
  return {
    entry: entry.id,
    policy: policy.id,
    status: aborted ? 'aborted' : game.status,
    steps: game.steps,
    optimal: game.optimal,
    stepCap: game.stepCap,
    invalid: game.invalid,
    failures: moves.filter((move) => move.failure).length,
    finalMood: game.mood,
    finalMoodWord: moodWord(game.mood),
    meanLatencyMs: latencies.length ? latencies.reduce((t, v) => t + v, 0) / latencies.length : null,
    moves,
  };
}
