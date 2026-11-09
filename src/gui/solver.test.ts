import { afterEach, describe, expect, it, vi } from 'vitest';

import { ObservableMazeSolver, type SolverState } from '@/gui/solver';
import { sanitizeLLMConfig } from '@/llm/config';
import { Maze } from '@/maze/maze';

const LAYOUT = ['#######', '#S#   #', '# # # #', '#   #G#', '#######'];
const config = sanitizeLLMConfig({ baseUrl: 'http://ollama.test', model: 'qwen3:1.7b' });

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answers with the warmest offered option, read from the prompt; the first answer names a direction that is not offered. */
function stubOllama(bodies: any[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      const lines = (body.messages[0].content as string).split('\n');
      const pick = lines.find((l) => /: much warmer,/.test(l)) ?? lines.find((l) => /: warmer,/.test(l))!;
      const move = bodies.length === 1 ? 'up' : pick.split(':')[0].toLowerCase();
      return new Response(JSON.stringify({ message: { content: JSON.stringify({ move }) } }), { status: 200 });
    }),
  );
}

function solve(): Promise<SolverState> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('solver did not finish')), 5000);
    const solver = new ObservableMazeSolver(new Maze(LAYOUT), 'test.txt', config, () => 0, (state) => {
      if (state.status === 'SOLVED' || state.status === 'FAILED') {
        clearTimeout(timer);
        resolve(state);
      }
    });
    solver.start();
  });
}

describe('GUI solver', () => {
  it('sends the shared full prompt, counts an unoffered answer as invalid without moving, and logs each step', async () => {
    const bodies: any[] = [];
    stubOllama(bodies);
    const state = await solve();
    expect(state.status).toBe('SOLVED');
    expect(state.invalidMoves).toBe(1);
    expect(state.step).toBe(bodies.length);
    expect(state.path[0]).toEqual({ x: 1, y: 1 });
    expect(state.path.at(-1)).toEqual({ x: 5, y: 3 });
    for (const body of bodies) {
      expect(body).toMatchObject({ model: 'qwen3:1.7b', think: false, stream: false, options: { temperature: 0.2 }, format: { type: 'object' } });
      expect(body.messages[0].content).toContain('Warmer moves lift your mood, colder moves lower it.');
      expect(body.messages[0].content).not.toMatch(/\d/);
    }
    expect(state.moveLog.at(-1)).toMatch(/offered: DOWN warmer/);
    expect(state.moveLog.at(-1)).toMatch(/INVALID, the mouse stays put · mood 470 normal \(-30\)/);
    expect(state.prompt).toMatch(/^POST http:\/\/ollama\.test\/api\/chat\n\{/);
    expect(state.mood).toBe(470 + 10 * (bodies.length - 1));
  });

  it('stops the run with a clear message when Ollama fails, without any fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('model not found', { status: 404 })));
    const state = await solve();
    expect(state.status).toBe('FAILED');
    expect(state.error).toMatch(/Ollama request failed \(HTTP 404\)/);
    expect(state.step).toBe(0);
  });

  it('drops an answer that arrives after Stop', async () => {
    let release: (r: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => (release = resolve))));
    const solver = new ObservableMazeSolver(new Maze(LAYOUT), 'test.txt', config, () => 0, () => {});
    solver.start();
    await vi.waitFor(() => expect(solver.state.status).toBe('ASKING'));
    solver.stop();
    release(new Response(JSON.stringify({ message: { content: '{"move":"down"}' } }), { status: 200 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(solver.state.step).toBe(0);
    expect(solver.state.current).toEqual({ x: 1, y: 1 });
  });
});
