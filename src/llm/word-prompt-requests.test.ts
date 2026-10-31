import fs from 'fs/promises';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { rng, seededShuffle, type DecisionState } from '@/benchmark/full-maze-eval-lib';
import { MAZE_CHECK_ARMS, armRequest } from '@/benchmark/word-prompt-builders';
import { sanitizeLLMConfig } from '@/llm/config';
import { OllamaClient } from '@/llm/ollama';
import { buildWordsRequest, wordsAnswerToMove } from '@/llm/word-prompt-requests';

const loadStates = async () =>
  (JSON.parse(await fs.readFile(path.resolve(__dirname, '../../benchmark-results/frozen-dataset.json'), 'utf-8')) as { states: (DecisionState & { id: string })[] }).states;
const ollama = sanitizeLLMConfig({ baseUrl: 'http://ollama.test', model: 'qwen3:1.7b', temperature: 0.7, promptStyle: 'words' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GUI words requests', () => {
  it('are byte-identical to ollama-best for the same shuffled order, with think off and temperature 0.2, and sent unchanged', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ message: { content: '{"move":"up"}' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    for (const state of await loadStates()) {
      const request = buildWordsRequest(ollama, state, rng(7));
      expect(request.order).toEqual(seededShuffle(state.validActions, rng(7)));
      const expected = JSON.stringify(armRequest(MAZE_CHECK_ARMS['ollama-best'], state, request.order, 'qwen3:1.7b'));
      expect(JSON.stringify(request.body)).toBe(expected);
      expect(request.body).toMatchObject({ think: false, options: { temperature: 0.2 } });
      expect(request.endpoint).toBe('http://ollama.test/api/chat');
      await new OllamaClient(ollama).sendRequest(request.body);
      expect(fetchMock.mock.calls.at(-1)![1]!.body).toBe(expected);
    }
  });

  it('map answers back to moves without correcting them', () => {
    expect(wordsAnswerToMove('{"move":"left"}')).toBe('left');
    expect(wordsAnswerToMove('{"move":"DOWN"}')).toBe('down');
    expect(wordsAnswerToMove('not json')).toBeNull();
    expect(wordsAnswerToMove('{"move":"cheese"}')).toBeNull();
  });
});
