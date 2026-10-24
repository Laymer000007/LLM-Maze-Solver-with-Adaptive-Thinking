import { parseMove, rng, runSeed, seededShuffle, type DecisionState } from '@/benchmark/full-maze-eval-lib';
import { MAZE_CHECK_ARMS, armRequest, labelToMove, layaBestRequest, optionLabels, situationOf } from '@/benchmark/word-prompt-builders';
import { MOVES, type Move } from '@/execution/execution';
import type { AIProvider, LLMConfig } from '@/llm/config';

// The "Words: warmer/colder" prompt style for the GUI. Requests come from the benchmark builders unchanged, so the
// GUI sends exactly what was measured: laya-best-compass for Laya and ollama-best for Ollama.

export type WordsRequest = { provider: AIProvider; order: Move[]; labels: string[]; body: Record<string, unknown>; endpoint: string };

/** Fixed seed for Ollama's option shuffle, per maze, so a GUI run is repeatable. */
export const WORDS_SHUFFLE_SEED = 20261023;
export const createWordsRandom = (mazeFile: string) => rng(runSeed(WORDS_SHUFFLE_SEED, mazeFile));

export function wordsStyleLabel(provider: AIProvider): string {
  return provider === 'laya' ? 'Words: warmer/colder (compass labels)' : 'Words: warmer/colder';
}

/**
 * Laya: warmer/colder options labelled NORTH/SOUTH/EAST/WEST, positive-only rule in state.body and instructions,
 * legal options only, canonical (up, down, left, right) order, no model field (Laya's default router, as measured).
 * Ollama: warmer/colder options, full rule, think:false, temperature 0.2, legal options in a seeded shuffled order.
 */
export function buildWordsRequest(config: LLMConfig, state: DecisionState, random: () => number): WordsRequest {
  if (config.provider === 'laya') {
    const order = MOVES.filter((move) => state.validActions.includes(move));
    return {
      provider: 'laya',
      order,
      labels: optionLabels('compass', order),
      body: layaBestRequest(situationOf(state, order), 'compass'),
      endpoint: `${config.layaUrl}/v1/systemone`,
    };
  }
  const order = seededShuffle(state.validActions, random);
  return {
    provider: 'ollama',
    order,
    labels: optionLabels('moves', order),
    body: armRequest(MAZE_CHECK_ARMS['ollama-best'], state, order, config.model),
    endpoint: `${config.baseUrl}/api/chat`,
  };
}

/**
 * Maps the model's answer back to a move, as the benchmark does. Laya must answer one of the offered compass labels.
 * Ollama answers {"move": ...}; any direction counts, so an unoffered one becomes a wall collision, never a correction.
 */
export function wordsAnswerToMove(request: WordsRequest, text: string): Move | null {
  if (request.provider === 'laya') return labelToMove('compass', request.order, text);
  try {
    return parseMove((JSON.parse(text) as { move?: unknown })?.move);
  } catch {
    return null;
  }
}
