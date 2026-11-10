import { afterEach, describe, expect, it, vi } from 'vitest';

import { senseRangeFor } from '@/game/prompt';
import { LEVEL2_VARIANT, ObservableMazeSolver, type SolverState } from '@/gui/solver';
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

describe('GUI solver, level 2', () => {
  const WAIT = ['#####', '#S G#', '## ##', '## ##', '#####'];
  const cat = { position: { x: 2, y: 2 }, direction: 'up' } as const;

  function play(answers: string[]): Promise<{ state: SolverState; bodies: any[] }> {
    const bodies: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ message: { content: JSON.stringify({ move: answers[bodies.length - 1] }) } }), { status: 200 });
      }),
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('solver did not finish')), 5000);
      const solver = new ObservableMazeSolver(new Maze(WAIT), 'level2.json', config, () => 0, (state) => {
        if (state.status === 'SOLVED' || state.status === 'FAILED') {
          clearTimeout(timer);
          resolve({ state, bodies });
        }
      }, cat);
      solver.start();
    });
  }

  it('waits with STAY, moves the cat after the mouse, and wins', async () => {
    const { state, bodies } = await play(['stay', 'stay', 'right', 'right']);
    expect(state).toMatchObject({ level: 2, status: 'SOLVED', step: 4, current: { x: 3, y: 1 } });
    expect(bodies[0].messages[0].content).toContain('A cat patrols the maze');
    expect(bodies[0].messages[0].content).toContain("You sense the cat two blocks down-right of you. It hasn't moved yet.");
    // The GUI sends C5 (cat-danger-range5): the safety rule and danger parts, sensing within five blocks.
    expect(bodies[0].messages[0].content).toContain('If you sense the cat, safety comes first.');
    expect(bodies[0].messages[0].content).toContain('RIGHT: danger, next to the cat; warmer, the smell grows stronger.');
    expect([LEVEL2_VARIANT, senseRangeFor(LEVEL2_VARIANT)]).toEqual(['cat-danger-range5', 5]);
    expect(bodies[0].format.properties.move.enum).toContain('stay');
    const log = [...state.moveLog].reverse();
    expect(log[0]).toMatch(/cat \(2,2\) → \(2,1\) \(up\)/);
    expect(log[0]).toMatch(/answer: STAY \(stays put\)/);
    expect(log[0]).toMatch(/cat: sensed, 2 blocks down-right · told: "You sense the cat two blocks down-right of you\. It hasn't moved yet\."/);
    expect(log[0]).toMatch(/smell 0, cat -200/);
  });

  it('fails with a clear message when the cat catches the mouse', async () => {
    const { state } = await play(['right']);
    expect(state.status).toBe('FAILED');
    expect(state.error).toBe('The cat caught the mouse.');
    expect(state.moveLog[0]).toMatch(/CAUGHT: the cat landed on the mouse/);
    expect(state.cat).toEqual({ x: 2, y: 1 });
  });
});
