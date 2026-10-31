import { ollamaRequestBody, parseMove, rng, runSeed, seededShuffle, type DecisionState } from '@/benchmark/full-maze-eval-lib';
import { ollamaBestPrompt, optionLabels, situationOf } from '@/benchmark/word-prompt-builders';
import type { Move } from '@/execution/execution';
import type { LLMConfig } from '@/llm/config';

// The "Words: warmer/colder" prompt style for the GUI. The request comes from the benchmark builders unchanged, so the
// GUI sends exactly what was measured as ollama-best.

export type WordsRequest = { order: Move[]; labels: string[]; body: Record<string, unknown>; endpoint: string };

/** Fixed seed for the option shuffle, per maze, so a GUI run is repeatable. */
export const WORDS_SHUFFLE_SEED = 20261023;
export const createWordsRandom = (mazeFile: string) => rng(runSeed(WORDS_SHUFFLE_SEED, mazeFile));
export const WORDS_STYLE_LABEL = 'Words: warmer/colder';

/** ollama-best: warmer/colder options, full rule, think:false, temperature 0.2, legal options in a seeded shuffled order. */
export function buildWordsRequest(config: LLMConfig, state: DecisionState, random: () => number): WordsRequest {
  const order = seededShuffle(state.validActions, random);
  return {
    order,
    labels: optionLabels('moves', order),
    body: ollamaRequestBody(config.model, ollamaBestPrompt(situationOf(state, order), 'moves'), false),
    endpoint: `${config.baseUrl}/api/chat`,
  };
}

/** Maps Ollama's {"move": ...} answer back to a move, as the benchmark does; an unoffered direction is a wall collision, never a correction. */
export function wordsAnswerToMove(text: string): Move | null {
  try {
    return parseMove((JSON.parse(text) as { move?: unknown })?.move);
  } catch {
    return null;
  }
}
