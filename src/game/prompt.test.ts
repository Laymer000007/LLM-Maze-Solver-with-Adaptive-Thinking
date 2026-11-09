import fs from 'fs/promises';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { DIRECTIONS, legalDirections, optionsAt, type Option } from '@/game/game';
import { buildPrompt, buildRequest, label, parseAnswer, shuffleOptions, type Situation, type Variant } from '@/game/prompt';
import { rng } from '@/game/random';
import { Maze } from '@/maze/maze';

const VARIANTS: Variant[] = ['full', 'smell-only'];
const FIXED_START = [
  'You are a mouse in a maze, looking for the cheese.',
  'The cheese is where the smell is strongest. Always move where the smell grows stronger, and prefer much warmer over warmer. Never choose a direction where the smell grows weaker.',
].join('\n');

/** Every open cell of every maze, at a spread of moods, with options in a seeded shuffled order. */
async function mazeSituations(): Promise<{ maze: Maze; cell: { x: number; y: number }; situation: Situation }[]> {
  const dir = path.resolve(__dirname, '../../mazes');
  const out = [];
  const random = rng(11);
  for (const file of (await fs.readdir(dir)).filter((f) => f.endsWith('.txt'))) {
    const maze = await Maze.fromFile(path.join(dir, file));
    for (const [i, cell] of maze.openCells().entries()) {
      const distance = maze.distanceToGoal(cell);
      if (distance === undefined || maze.isGoal(cell)) continue;
      out.push({ maze, cell, situation: { distance, mood: [0, 150, 250, 450, 650, 900, 1000][i % 7], options: shuffleOptions(optionsAt(maze, cell), random) } });
    }
  }
  return out;
}

const optionLines = (prompt: string) => prompt.split('\n').filter((line) => /^[A-Z-]+: /.test(line));

describe('prompt builder', () => {
  it('renders the full prompt exactly', () => {
    const situation: Situation = {
      distance: 4,
      mood: 650,
      options: [
        { direction: 'up-right', level: 'much warmer' },
        { direction: 'left', level: 'colder' },
        { direction: 'down', level: 'warmer' },
      ],
    };
    expect(buildPrompt(situation, 'full')).toBe(
      `${FIXED_START}
Warmer moves lift your mood, colder moves lower it.

Right now:
The cheese smell is strong.
Your mood is happy.

You can go:
UP-RIGHT: much warmer, the smell grows much stronger, your mood rises a lot.
LEFT: colder, the smell grows weaker, your mood drops.
DOWN: warmer, the smell grows stronger, your mood rises.
Choose one direction.
Return only JSON: {"move":"up-right|left|down"}.`,
    );
    expect(buildPrompt(situation, 'smell-only')).toBe(
      `${FIXED_START}

Right now:
The cheese smell is strong.

You can go:
UP-RIGHT: much warmer, the smell grows much stronger.
LEFT: colder, the smell grows weaker.
DOWN: warmer, the smell grows stronger.
Choose one direction.
Return only JSON: {"move":"up-right|left|down"}.`,
    );
  });

  it('puts the fixed text first, lists only legal directions, contains no digits, and limits the answer to the offered directions', async () => {
    const all = await mazeSituations();
    expect(all.length).toBeGreaterThan(1000);
    for (const { maze, cell, situation } of all)
      for (const variant of VARIANTS) {
        const body = buildRequest('qwen3:1.7b', situation, variant) as any;
        const prompt: string = body.messages[0].content;
        expect(prompt.startsWith(FIXED_START)).toBe(true);
        expect(prompt).not.toMatch(/\d/);
        const offered = situation.options.map((option) => option.direction);
        expect(optionLines(prompt).map((line) => line.split(':')[0])).toEqual(offered.map(label));
        expect([...offered].sort()).toEqual([...legalDirections(maze, cell)].sort());
        expect(body.format.properties.move.enum).toEqual(offered);
        expect(prompt.endsWith(`Return only JSON: {"move":"${offered.join('|')}"}.`)).toBe(true);
        expect(body).toMatchObject({ think: false, stream: false, options: { temperature: 0.2 }, format: { type: 'object', required: ['move'] } });
        if (variant === 'smell-only') expect(prompt).not.toMatch(/mood/i);
      }
  });

  it('differs between the variants only in the mood text', async () => {
    for (const { situation } of (await mazeSituations()).slice(0, 300)) {
      const full = buildPrompt(situation, 'full');
      const smellOnly = buildPrompt(situation, 'smell-only');
      const stripped = full
        .replace('Warmer moves lift your mood, colder moves lower it.\n', '')
        .replace(/Your mood is [a-z ]+\.\n/, '')
        .replace(/, your mood [a-z ]+\./g, '.');
      expect(stripped).toBe(smellOnly);
    }
  });

  it('shuffles deterministically for a given seed', () => {
    const options: Option[] = DIRECTIONS.map((direction) => ({ direction, level: 'warmer' }));
    const a = shuffleOptions(options, rng(5));
    expect(shuffleOptions(options, rng(5))).toEqual(a);
    expect(shuffleOptions(options, rng(6))).not.toEqual(a);
    expect([...a].sort((x, y) => x.direction.localeCompare(y.direction))).toEqual([...options].sort((x, y) => x.direction.localeCompare(y.direction)));
  });

  it('reads answers without correcting them', () => {
    expect(parseAnswer('{"move":"up-right"}')).toBe('up-right');
    expect(parseAnswer('{"move":"DOWN-LEFT"}')).toBe('down-left');
    expect(parseAnswer('{"move":"north"}')).toBeNull();
    expect(parseAnswer('not json')).toBeNull();
    expect(parseAnswer('{}')).toBeNull();
  });
});
