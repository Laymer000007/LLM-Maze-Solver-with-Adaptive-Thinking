import fs from 'fs/promises';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { rng, seededShuffle, type DecisionState } from '@/benchmark/full-maze-eval-lib';
import {
  MAZE_CHECK_ARMS,
  OLLAMA_COMPASS_RETURN,
  OLLAMA_RETURN,
  armRequest,
  enumerateSituations,
  ollamaAnswerToMove,
  ollamaBestPrompt,
  optionLabels,
  situationFor,
  situationOf,
} from '@/benchmark/word-prompt-builders';

const loadStates = async () =>
  (JSON.parse(await fs.readFile(path.resolve(__dirname, '../../benchmark-results/frozen-dataset.json'), 'utf-8')) as { states: (DecisionState & { id: string })[] }).states;

describe('ollama-best prompt from a situation', () => {
  it('in direction labels is byte-identical to the ollama-best prompt for every frozen state', async () => {
    for (const state of await loadStates()) {
      const order = seededShuffle(state.validActions, rng(11));
      const real = (armRequest(MAZE_CHECK_ARMS['ollama-best'], state, order, 'qwen3:1.7b') as any).messages[0].content;
      expect(ollamaBestPrompt(situationOf(state, order), 'moves')).toBe(real);
    }
  });

  it('with compass labels differs only in the option labels and the answer format', () => {
    for (const request of enumerateSituations(20261023)) {
      const situation = situationFor(request);
      const moves = ollamaBestPrompt(situation, 'moves').split('\n');
      const compass = ollamaBestPrompt(situation, 'compass').split('\n');
      expect(compass).toHaveLength(moves.length);
      const directionLabels = optionLabels('moves', request.order);
      const compassLabels = optionLabels('compass', request.order);
      for (const [i, line] of moves.entries()) {
        const option = directionLabels.findIndex((label) => line.startsWith(`${label}: `));
        if (option >= 0) expect(compass[i]).toBe(`${compassLabels[option]}${line.slice(directionLabels[option].length)}`);
        else if (line === OLLAMA_RETURN) expect(compass[i]).toBe(OLLAMA_COMPASS_RETURN);
        else expect(compass[i]).toBe(line);
      }
      expect(moves.filter((l, i) => l !== compass[i])).toHaveLength(request.order.length + 1);
      expect(compass.join('\n')).not.toMatch(/\d|\bUP\b|\bDOWN\b|\bLEFT\b|\bRIGHT\b/);
    }
  });
});

describe('Ollama answers', () => {
  it('map compass words and direction words back to moves the same way, offered or not', () => {
    expect(ollamaAnswerToMove('compass', '{"move":"north"}')).toBe('up');
    expect(ollamaAnswerToMove('compass', '{"move":"WEST"}')).toBe('left');
    expect(ollamaAnswerToMove('compass', '{"move":"go east"}')).toBe('right');
    expect(ollamaAnswerToMove('compass', '{"move":"up"}')).toBeNull();
    expect(ollamaAnswerToMove('moves', '{"move":"down"}')).toBe('down');
    expect(ollamaAnswerToMove('moves', '{"move":"south"}')).toBeNull();
    expect(ollamaAnswerToMove('moves', 'not json')).toBeNull();
    expect(ollamaAnswerToMove('compass', null)).toBeNull();
  });
});
