import { afterEach, describe, expect, it, vi } from 'vitest';

import { bfsShortestPath } from '@/benchmark/full-maze-eval-lib';
import { ObservableMazeSolver, type SolverState } from '@/gui/solver';
import { sanitizeLLMConfig, type LLMConfig } from '@/llm/config';
import { Maze } from '@/maze/maze';

const LAYOUT = ['#######', '#S#   #', '# # # #', '#   #G#', '#######'];
const maze = () => new Maze(LAYOUT);
const optimal = bfsShortestPath(LAYOUT, { x: 1, y: 1 }, { x: 5, y: 3 })!;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Runs the real GUI loop with zero delay until it finishes. */
function solve(config: LLMConfig): Promise<{ state: SolverState; solver: ObservableMazeSolver }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('solver did not finish')), 5000);
    const solver: ObservableMazeSolver = new ObservableMazeSolver(maze(), 'test.txt', config, () => 0, (state) => {
      if (state.status === 'SOLVED' || state.status === 'FAILED') {
        clearTimeout(timer);
        setTimeout(() => resolve({ state, solver }), 0);
      }
    });
    solver.start();
  });
}

describe('GUI solver, Words prompt style', () => {
  it('Laya: sends laya-best-compass requests, one decision per step, and follows the warmer label to the goal', async () => {
    vi.stubEnv('LAYA_API_KEY', 'fake-laya-key-123456789');
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      const warmer = Object.entries(body.questions.move.criteria as Record<string, string>).find(([, text]) => text.startsWith('warmer'))![0];
      return new Response(JSON.stringify({ answers: { move: { choice: warmer } } }), { status: 200 });
    }));
    const { state } = await solve(sanitizeLLMConfig({ provider: 'laya', layaUrl: 'http://laya.test', promptStyle: 'words' }));
    expect(state.status).toBe('SOLVED');
    expect(state.step).toBe(optimal);
    expect(bodies).toHaveLength(optimal);
    expect(state.llmCalls).toBe(optimal);
    for (const body of bodies) {
      expect(Object.keys(body.questions.move.criteria).every((label) => ['NORTH', 'SOUTH', 'EAST', 'WEST'].includes(label))).toBe(true);
      expect(body).not.toHaveProperty('model');
      expect(JSON.stringify(body)).not.toMatch(/cheese"|CHEESE|\d/);
    }
    expect(state.thinking).toBe(false);
    expect(state.promptStyle).toBe('words');
    expect(state.prompt).toMatch(/^POST http:\/\/laya\.test\/v1\/systemone\n\{/);
    expect(state.llmLog.join('\n')).toContain('style=words');
    expect(state.moveLog.join('\n')).toContain('PROMPT STYLE: Words: warmer/colder (compass labels)');
    expect(state.moveLog.join('\n')).not.toContain('CHEESE DIRECT TRAVEL');
  });

  it('Ollama: sends ollama-best requests with think off and temperature 0.2, even after a wall collision', async () => {
    const bodies: any[] = [];
    let first = true;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      const line = (body.messages[0].content as string).split('\n').find((l) => / warmer, /.test(l))!;
      // The first answer is an unoffered direction: a wall collision (EiL drop > 100) that must not switch thinking on.
      const move = first ? 'up' : line.split(':')[0].toLowerCase();
      first = false;
      return new Response(JSON.stringify({ message: { content: JSON.stringify({ move }) } }), { status: 200 });
    }));
    const { state } = await solve(sanitizeLLMConfig({ provider: 'ollama', baseUrl: 'http://ollama.test', model: 'qwen3:1.7b', temperature: 0.9, promptStyle: 'words' }));
    expect(state.status).toBe('SOLVED');
    expect(state.invalidMoves).toBe(1);
    expect(bodies).toHaveLength(optimal + 1);
    for (const body of bodies) {
      expect(body).toMatchObject({ model: 'qwen3:1.7b', think: false, stream: false, format: 'json', options: { temperature: 0.2 } });
      expect(body.messages[0].content).toContain('Never choose a direction where it grows weaker.');
    }
    expect(state.thinking).toBe(false);
    expect(state.llmLog.join('\n')).toContain('style=words think=false');
  });

  it('stops with a clear error, without guessing, when Laya answers an unoffered label', async () => {
    vi.stubEnv('LAYA_API_KEY', 'fake-laya-key-123456789');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ answers: { move: { choice: 'UP' } } }), { status: 200 })));
    const { state } = await solve(sanitizeLLMConfig({ provider: 'laya', layaUrl: 'http://laya.test', promptStyle: 'words' }));
    expect(state.status).toBe('FAILED');
    expect(state.error).toMatch(/Laya answered "UP", which is not one of the offered options \(SOUTH\)/);
    expect(state.step).toBe(0);
  });

  it('leaves the Numbers style unchanged', async () => {
    vi.stubEnv('LAYA_API_KEY', 'fake-laya-key-123456789');
    const bodies: any[] = [];
    let solverRef: ObservableMazeSolver | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      solverRef?.stop();
      return new Response(JSON.stringify({ answers: { move: { choice: 'DOWN' } } }), { status: 200 });
    }));
    const solver = new ObservableMazeSolver(maze(), 'test.txt', sanitizeLLMConfig({ provider: 'laya', layaUrl: 'http://laya.test', layaMode: 'constrained' }), () => 0, () => {});
    solverRef = solver;
    solver.start();
    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    expect(solver.state.promptStyle).toBe('numbers');
    expect(bodies[0]).toMatchObject({ model: 'english', questions: { move: { criteria: { DOWN: 'down movement' } } } });
  });
});
