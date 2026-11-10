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
  smellNotSensed,
  summariseLevel2,
  unsafeKind,
  type Level2Policy,
  type Level2Run,
  type Level2StepRecord,
} from '@/eval/level2-eval-lib';
import { optimalSteps, step } from '@/game/game';
import { shortestSafePath, target, walkingDistance, type Level2Game, type Move, type Option2 } from '@/game/level2';
import { Maze, type Position } from '@/maze/maze';

const ROOT = path.resolve(__dirname, '../..');
const entries = async () => Promise.all((await level2Files(ROOT)).map((file) => level2Entry(ROOT, file)));

describe('level-2 mazes', () => {
  it('are twelve winnable levels: six from 7x7 to 15x15, then two each of 30x30, 40x40 and 50x50', async () => {
    const all = await entries();
    expect(all.map((e) => e.newGame().maze.width)).toEqual([7, 7, 11, 11, 11, 15, 30, 30, 40, 40, 50, 50]);
    for (const entry of all) {
      const game = entry.newGame();
      expect(game.maze.height).toBe(game.maze.width);
      expect(shortestSafePath(game.maze, game.position, game.cat)).toHaveLength(game.shortestSafe);
      expect(game.shortestSafe).toBeGreaterThanOrEqual(optimalSteps(game.maze));
    }
  });

  it('give every cat a patrol line of at least three cells that crosses a shortest route', async () => {
    for (const entry of await entries()) {
      const { maze, cat } = entry.newGame();
      const axis = cat.direction === 'left' || cat.direction === 'right' ? (['left', 'right'] as const) : (['up', 'down'] as const);
      const line = [cat.position];
      for (const direction of axis) for (let c = step(cat.position, direction); maze.isWalkable(c); c = step(c, direction)) line.push(c);
      expect(line.length, entry.id).toBeGreaterThanOrEqual(3);
      const optimal = optimalSteps(maze);
      const onRoute = (p: Position) => walkingDistance(maze, maze.startPosition, p) + walkingDistance(maze, p, maze.goalPosition) === optimal;
      expect(line.some(onRoute), entry.id).toBe(true);
    }
  });

  it('leave a way round the cat on the big maps: start and cheese stay connected with the patrol line walled off', async () => {
    for (const entry of (await entries()).slice(6)) {
      const { maze, cat } = entry.newGame();
      const axis = cat.direction === 'left' || cat.direction === 'right' ? (['left', 'right'] as const) : (['up', 'down'] as const);
      const line = new Set([`${cat.position.x},${cat.position.y}`]);
      for (const direction of axis) for (let c = step(cat.position, direction); maze.isWalkable(c); c = step(c, direction)) line.add(`${c.x},${c.y}`);
      const blocked = new Maze(maze.layout.map((row, y) => [...row].map((c, x) => (line.has(`${x},${y}`) ? '#' : c)).join('')));
      expect(() => optimalSteps(blocked), entry.id).not.toThrow();
    }
  });

  it('put the cat in the way: the cat-ignoring greedy policy is caught on at least half of them, and of the big maps', async () => {
    const runs = await Promise.all((await entries()).map((entry) => runLevel2(entry, greedyPolicy, LEVEL2_SEED)));
    expect(runs.filter((run) => run.status === 'caught').length).toBeGreaterThanOrEqual(6);
    expect(runs.slice(6).filter((run) => run.status === 'caught').length).toBeGreaterThanOrEqual(3);
  });

  it('are won by the planner in exactly the shortest safe number of steps', async () => {
    for (const entry of await entries()) {
      const run = await runLevel2(entry, plannerPolicy, LEVEL2_SEED);
      expect(run).toMatchObject({ status: 'solved', invalid: 0 });
      expect(run.steps).toBe(run.shortestSafe);
    }
  }, 30_000); // the planner searches the whole state space on every step of the big maps

  it('play random-legal deterministically and never invalidly', async () => {
    for (const entry of await entries()) {
      const run = await runLevel2(entry, randomLegalPolicy, LEVEL2_SEED);
      expect(run.invalid).toBe(0);
      expect(await runLevel2(entry, randomLegalPolicy, LEVEL2_SEED)).toEqual(run);
    }
  });
});

describe('the near-cat filter in a run', () => {
  it('never offers an option next to the cat unless every option is, and is off for other policies', async () => {
    const near = (game: Level2Game, move: Move) => walkingDistance(game.maze, target(game.position, move), game.cat.position) <= 1;
    let checked = 0;
    const filtering: Level2Policy = {
      ...randomLegalPolicy,
      id: 'random-filtered',
      filterNearCat: true,
      decide: async (game, offered, random) => {
        const all = game.options();
        if (all.every((o) => near(game, o.direction))) expect(offered).toHaveLength(all.length);
        else expect(offered.filter((o) => near(game, o.direction))).toEqual([]);
        checked++;
        return randomLegalPolicy.decide(game, offered, random);
      },
    };
    let removed = 0;
    for (const entry of await entries()) {
      for (const record of (await runLevel2(entry, filtering, LEVEL2_SEED)).records) removed += record.removed;
      expect((await runLevel2(entry, randomLegalPolicy, LEVEL2_SEED)).records.every((r) => r.removed === 0 && !r.trapped)).toBe(true);
    }
    expect(checked).toBeGreaterThan(0);
    expect(removed).toBeGreaterThan(0);
  });
});

describe('level-2 scoring', () => {
  const step = (over: Partial<Level2StepRecord>): Level2StepRecord => ({
    step: 1,
    sensed: true,
    sense: { distance: 2, direction: 'up', history: [] },
    catHistory: [],
    offered: [],
    removed: 0,
    trapped: false,
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
      stepCap: 100,
      invalid: 0,
      finalMood: 500,
      catchCase: null,
      caughtOnStep: null,
      records,
    });
    const s = summariseLevel2([
      run([step({ removed: 2 }), step({ distanceAfter: 2, catPenalty: -100, removed: 1 }), step({ sensed: false, latencyMs: 300, trapped: true })], 'solved'),
      run([step({ distanceAfter: 1, catPenalty: -200 }), step({ catchCase: 'the cat landed on the mouse', distanceAfter: 0 })], 'caught'),
    ]);
    expect(s).toMatchObject({ runs: 2, completed: 1, caught: 1, penalties100: 1, penalties200: 1, sensedSteps: 4, safeSensed: 2 });
    expect(s.unsafe).toEqual([
      ['ended one block from the cat', 1],
      ['the cat landed on the mouse', 1],
    ]);
    expect(s.latencyNotSensed.mean).toBe(300);
    expect(s).toMatchObject({ filteredSteps: 2, removedOptions: 3, trappedSteps: 1 });
    const offered = (...levels: Option2['level'][]): Option2[] => levels.map((level, i) => ({ direction: (['up', 'down', 'left'] as const)[i], level }));
    expect(
      smellNotSensed([
        step({ sensed: false, offered: offered('much warmer', 'warmer', 'colder'), answer: 'down' }), // not the warmest
        step({ sensed: false, offered: offered('much warmer', 'warmer', 'colder'), answer: 'left' }), // colder, not the warmest
        step({ sensed: false, offered: offered('warmer', 'no change', 'colder'), answer: 'up' }), // the warmest
        step({ sensed: false, offered: offered('no change', 'colder', 'much colder'), answer: 'down' }), // colder, no warmer offered
        step({ sensed: false, offered: offered('warmer', 'colder', 'colder'), answer: null }), // invalid: not counted
      ]),
    ).toEqual({ notSensedAnswered: 4, notSensedColder: 2, notSensedWarmerOffered: 3, notSensedNotWarmest: 2 });
  });
});
