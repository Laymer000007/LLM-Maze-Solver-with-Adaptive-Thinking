import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  MAZES,
  ORIENTATIONS,
  buildEntry,
  enumerateSituations,
  greedyPolicy,
  randomLegalPolicy,
  runEpisode,
  sampleSituations,
  summariseSingleStep,
  warmestLevel,
  type SingleStepRow,
} from '@/eval/final-eval-lib';
import { isDiagonal, optionsAt } from '@/game/game';
import { Maze } from '@/maze/maze';

const key = (options: { direction: string; level: string }[]) =>
  options
    .map((o) => `${o.direction}=${o.level}`)
    .sort()
    .join(',');

describe('situations', () => {
  it('are distinct, follow the movement rules, and always offer something warmer', () => {
    const all = enumerateSituations();
    const keys = new Set(all.map((s) => `${key(s.options)}|${s.distance}|${s.mood}`));
    expect(keys.size).toBe(all.length);
    for (const { options } of all) {
      const level = new Map(options.map((o) => [o.direction, o.level]));
      expect(options.some((o) => o.level === 'warmer' || o.level === 'much warmer')).toBe(true);
      for (const o of options) {
        if (!isDiagonal(o.direction)) expect(['warmer', 'colder']).toContain(o.level);
        else {
          const sides = o.direction.split('-').map((side) => level.get(side as never));
          expect(sides.every(Boolean)).toBe(true);
          if (o.level === 'much warmer') expect(sides).toEqual(['warmer', 'warmer']);
          if (o.level === 'much colder') expect(sides).toEqual(['colder', 'colder']);
          expect(['much warmer', 'no change', 'much colder']).toContain(o.level);
        }
      }
    }
  }, 20_000);

  it('cover every local situation that occurs in the evaluation mazes', async () => {
    const local = new Set(enumerateSituations().map((s) => key(s.options)));
    for (const file of MAZES) {
      const maze = await Maze.fromFile(path.resolve(__dirname, '../..', file));
      for (const cell of maze.openCells()) if (!maze.isGoal(cell)) expect(local.has(key(optionsAt(maze, cell)))).toBe(true);
    }
  });

  it('are sampled and shuffled deterministically', () => {
    const a = sampleSituations(200, 1);
    expect(a).toHaveLength(200);
    expect(sampleSituations(200, 1)).toEqual(a);
    expect(sampleSituations(200, 2)).not.toEqual(a);
  });
});

describe('scoring', () => {
  it('counts warmest, warmer-or-better, legal and first-listed answers', () => {
    const offered = [
      { direction: 'up', level: 'warmer' },
      { direction: 'up-right', level: 'much warmer' },
      { direction: 'right', level: 'warmer' },
      { direction: 'left', level: 'colder' },
    ] as const;
    expect(warmestLevel([...offered])).toBe('much warmer');
    const row = (answer: string | null, failure: string | null = null): SingleStepRow => ({
      id: 's',
      variant: 'full',
      offered: [...offered],
      mood: 500,
      distance: 8,
      answer: answer as never,
      text: answer ? JSON.stringify({ move: answer }) : 'x',
      latencyMs: failure ? null : 100,
      promptTokens: 150,
      cachedTokens: 100,
      failure,
    });
    const s = summariseSingleStep([row('up-right'), row('up'), row('left'), row('down'), row(null, 'timeout')]);
    expect(s).toMatchObject({ situations: 5, failures: 1, warmest: 1, warmerOrBetter: 2, legal: 3, firstListed: 1, meanLatencyMs: 100, p95LatencyMs: 100, meanPromptTokens: 150 });
    expect(s.wrong.map(([k]) => k)).toEqual(['warmer (up) over much warmer', 'colder (left) over much warmer', 'illegal answer "{\\"move\\":\\"down\\"}"']);
  });
});

describe('maze runs', () => {
  it('greedy solves every evaluation entry; random-legal never makes an invalid move', async () => {
    for (const file of MAZES) {
      const maze = await Maze.fromFile(path.resolve(__dirname, '../..', file));
      for (const orientation of ORIENTATIONS) {
        const entry = buildEntry(maze.layout, file, orientation);
        const greedy = await runEpisode(entry, greedyPolicy, 1);
        expect(greedy).toMatchObject({ status: 'solved', invalid: 0 });
        expect(greedy.steps).toBeLessThanOrEqual(greedy.stepCap);
        const random = await runEpisode(entry, randomLegalPolicy, 1);
        expect(random.invalid).toBe(0);
        expect(await runEpisode(entry, randomLegalPolicy, 1)).toEqual(random);
      }
    }
  });
});
