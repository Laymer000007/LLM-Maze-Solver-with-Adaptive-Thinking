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
    const { state } = await solve(sanitizeLLMConfig({ baseUrl: 'http://ollama.test', model: 'qwen3:1.7b', temperature: 0.9, promptStyle: 'words' }));
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

  it('leaves the Numbers style unchanged: the existing prompt with adaptive thinking off at the start', async () => {
    const bodies: any[] = [];
    let solverRef: ObservableMazeSolver | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      solverRef?.stop();
      return new Response(JSON.stringify({ message: { content: '{"move":"down"}' } }), { status: 200 });
    }));
    const solver = new ObservableMazeSolver(maze(), 'test.txt', sanitizeLLMConfig({ baseUrl: 'http://ollama.test' }), () => 0, () => {});
    solverRef = solver;
    solver.start();
    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    expect(solver.state.promptStyle).toBe('numbers');
    expect(bodies[0]).toMatchObject({ model: 'qwen3:1.7b', think: false, options: { temperature: 0.2 } });
    expect(bodies[0].messages[0].content).toContain('You are a mouse inside a maze and need to reach the cheese to win.');
  });

});
