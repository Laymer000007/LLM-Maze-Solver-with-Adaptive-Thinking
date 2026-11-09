import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  LEVEL2_SEED,
  greedyPolicy,
  level2Entry,
  level2Files,
  plannerPolicy,
  randomLegalPolicy,
  runLevel2,
  summariseLevel2,
  unsafeKind,
  type Level2Run,
  type Level2StepRecord,
} from '@/eval/level2-eval-lib';
import { optimalSteps } from '@/game/game';
import { shortestSafePath } from '@/game/level2';

const ROOT = path.resolve(__dirname, '../..');
const entries = async () => Promise.all((await level2Files(ROOT)).map((file) => level2Entry(ROOT, file)));

describe('level-2 mazes', () => {
  it('are six winnable levels from about 7x7 up to 15x15', async () => {
    const all = await entries();
    expect(all).toHaveLength(6);
    const sizes = all.map((e) => e.newGame().maze.width);
    expect(Math.min(...sizes)).toBe(7);
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(15);
    for (const entry of all) {
      const game = entry.newGame();
      expect(shortestSafePath(game.maze, game.position, game.cat)).toHaveLength(game.shortestSafe);
      expect(game.shortestSafe).toBeGreaterThanOrEqual(optimalSteps(game.maze));
    }
  });

  it('put the cat in the way: the cat-ignoring greedy policy is caught on at least half of them', async () => {
    const runs = await Promise.all((await entries()).map((entry) => runLevel2(entry, greedyPolicy, LEVEL2_SEED)));
    expect(runs.filter((run) => run.status === 'caught').length).toBeGreaterThanOrEqual(3);
  });

  it('are won by the planner in exactly the shortest safe number of steps', async () => {
    for (const entry of await entries()) {
      const run = await runLevel2(entry, plannerPolicy, LEVEL2_SEED);
      expect(run).toMatchObject({ status: 'solved', invalid: 0 });
      expect(run.steps).toBe(run.shortestSafe);
    }
  });

  it('play random-legal deterministically and never invalidly', async () => {
    for (const entry of await entries()) {
      const run = await runLevel2(entry, randomLegalPolicy, LEVEL2_SEED);
      expect(run.invalid).toBe(0);
      expect(await runLevel2(entry, randomLegalPolicy, LEVEL2_SEED)).toEqual(run);
    }
  });
});

describe('level-2 scoring', () => {
  const step = (over: Partial<Level2StepRecord>): Level2StepRecord => ({
    step: 1,
    sensed: true,
    sense: { distance: 2, direction: 'up', history: [] },
    offered: [],
    answer: 'up',
    valid: true,
    catPenalty: 0,
    distanceAfter: 3,
    catchCase: null,
    latencyMs: 100,
    thinking: false,
    failure: null,
    ...over,
  });

  it('counts safe sensed choices, penalties and unsafe kinds', () => {
    expect(unsafeKind(step({ distanceAfter: 1, catPenalty: -200 }))).toBe('ended one block from the cat');
    expect(unsafeKind(step({ catchCase: 'swapped cells', distanceAfter: 0 }))).toBe('swapped cells');
    const run = (records: Level2StepRecord[], status: Level2Run['status']): Level2Run => ({
      entry: 'e',
      policy: 'p',
      status,
      steps: records.length,
      shortestSafe: 2,
      stepCap: 60,
      invalid: 0,
      finalMood: 500,
      catchCase: null,
      caughtOnStep: null,
      records,
    });
    const s = summariseLevel2([
      run([step({}), step({ distanceAfter: 2, catPenalty: -100 }), step({ sensed: false, latencyMs: 300 })], 'solved'),
      run([step({ distanceAfter: 1, catPenalty: -200 }), step({ catchCase: 'the cat landed on the mouse', distanceAfter: 0 })], 'caught'),
    ]);
    expect(s).toMatchObject({ runs: 2, completed: 1, caught: 1, penalties100: 1, penalties200: 1, sensedSteps: 4, safeSensed: 2 });
    expect(s.unsafe).toEqual([
      ['ended one block from the cat', 1],
      ['the cat landed on the mouse', 1],
    ]);
    expect(s.latencyNotSensed.mean).toBe(300);
  });
});
