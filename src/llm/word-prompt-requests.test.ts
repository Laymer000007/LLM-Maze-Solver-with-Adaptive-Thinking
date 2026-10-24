import fs from 'fs/promises';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { rng, seededShuffle, type DecisionState } from '@/benchmark/full-maze-eval-lib';
import { MAZE_CHECK_ARMS, armRequest, layaBestRequest, situationOf } from '@/benchmark/word-prompt-builders';
import { MOVES } from '@/execution/execution';
import { sanitizeLLMConfig } from '@/llm/config';
import { LayaClient } from '@/llm/laya';
import { OllamaClient } from '@/llm/ollama';
import { buildWordsRequest, wordsAnswerToMove } from '@/llm/word-prompt-requests';

const loadStates = async () =>
  (JSON.parse(await fs.readFile(path.resolve(__dirname, '../../benchmark-results/frozen-dataset.json'), 'utf-8')) as { states: (DecisionState & { id: string })[] }).states;
const laya = sanitizeLLMConfig({ provider: 'laya', layaUrl: 'http://laya.test', layaModel: 'english', promptStyle: 'words' });
const ollama = sanitizeLLMConfig({ provider: 'ollama', baseUrl: 'http://ollama.test', model: 'qwen3:1.7b', temperature: 0.7, promptStyle: 'words' });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GUI words requests', () => {
  it('Laya: byte-identical to laya-best-compass in canonical order, and sent unchanged', async () => {
    vi.stubEnv('LAYA_API_KEY', 'fake-laya-key-123456789');
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ answers: { move: { choice: "NORTH" } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    for (const state of await loadStates()) {
      const request = buildWordsRequest(laya, state, rng(1));
      const canonical = MOVES.filter((m) => state.validActions.includes(m));
      expect(request.order).toEqual(canonical);
      const expected = JSON.stringify(layaBestRequest(situationOf(state, canonical), 'compass'));
      expect(JSON.stringify(request.body)).toBe(expected);
      expect(request.body).not.toHaveProperty('model');
      await new LayaClient(laya).sendRequest(request.body);
      expect(fetchMock.mock.calls.at(-1)![1]!.body).toBe(expected);
      expect(String(fetchMock.mock.calls.at(-1)![0])).toBe('http://laya.test/v1/systemone');
    }
  });

  it('Ollama: byte-identical to ollama-best for the same shuffled order, think off and temperature 0.2, sent unchanged', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ message: { content: "{\"move\":\"up\"}" } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    for (const state of await loadStates()) {
      const request = buildWordsRequest(ollama, state, rng(7));
      expect(request.order).toEqual(seededShuffle(state.validActions, rng(7)));
      const expected = JSON.stringify(armRequest(MAZE_CHECK_ARMS['ollama-best'], state, request.order, 'qwen3:1.7b'));
      expect(JSON.stringify(request.body)).toBe(expected);
      expect(request.body).toMatchObject({ think: false, options: { temperature: 0.2 } });
      await new OllamaClient(ollama).sendRequest(request.body);
      expect(fetchMock.mock.calls.at(-1)![1]!.body).toBe(expected);
    }
  });

  it('map answers back to moves without correcting them', async () => {
    const [state] = await loadStates();
    const layaRequest = buildWordsRequest(laya, { ...state, validActions: ['up', 'right'] }, rng(1));
    expect(layaRequest.labels).toEqual(['NORTH', 'EAST']);
    expect(wordsAnswerToMove(layaRequest, 'EAST')).toBe('right');
    expect(wordsAnswerToMove(layaRequest, 'SOUTH')).toBeNull();
    expect(wordsAnswerToMove(layaRequest, 'UP')).toBeNull();
    const ollamaRequest = buildWordsRequest(ollama, { ...state, validActions: ['up', 'right'] }, rng(1));
    expect(wordsAnswerToMove(ollamaRequest, '{"move":"left"}')).toBe('left');
    expect(wordsAnswerToMove(ollamaRequest, 'not json')).toBeNull();
    expect(wordsAnswerToMove(ollamaRequest, '{"move":"cheese"}')).toBeNull();
  });
});
