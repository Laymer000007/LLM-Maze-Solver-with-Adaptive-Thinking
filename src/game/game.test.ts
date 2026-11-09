import fs from 'fs/promises';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  Game,
  INVALID_MOOD_CHANGE,
  isDiagonal,
  legalDirections,
  levelOf,
  closenessSentence,
  moodWord,
  optimalSteps,
  optionsAt,
  step,
  stepCapFor,
  stuckWindowFor,
} from '@/game/game';
import { Maze, rotate180 } from '@/maze/maze';

const allMazes = async () => {
  const dir = path.resolve(__dirname, '../../mazes');
  const files = (await fs.readdir(dir)).filter((file) => file.endsWith('.txt'));
  return Promise.all(files.map(async (file) => Maze.fromFile(path.join(dir, file))));
};

describe('movement', () => {
  it('allows a diagonal only when the target and both straight cells beside it are open', () => {
    const open = new Maze(['#####', '#   #', '# S #', '#  G#', '#####']);
    expect(legalDirections(open, open.startPosition)).toEqual(['up', 'down', 'left', 'right', 'up-left', 'up-right', 'down-left', 'down-right']);
    // A wall above blocks up, up-left and up-right; a wall left of the target corner blocks down-left.
    const walls = new Maze(['#####', '# # #', '# S #', '##  #', '##G##']);
    expect(legalDirections(walls, walls.startPosition)).toEqual(['down', 'left', 'right', 'down-right']);
  });

  it('changes the distance by ±1 straight and by −2, 0 or +2 diagonally, for every legal move in every maze', async () => {
    for (const base of await allMazes())
      for (const maze of [base, new Maze(rotate180(base.layout))])
        for (const cell of maze.openCells()) {
          const here = maze.distanceToGoal(cell);
          if (here === undefined) continue;
          for (const direction of legalDirections(maze, cell)) {
            const change = maze.distanceToGoal(step(cell, direction))! - here;
            expect(isDiagonal(direction) ? [-2, 0, 2] : [-1, 1]).toContain(change);
          }
        }
  });

  it('gives every open cell except the cheese a warmer or much warmer neighbour', async () => {
    for (const maze of await allMazes())
      for (const cell of maze.openCells()) {
        if (maze.isGoal(cell) || maze.distanceToGoal(cell) === undefined) continue;
        expect(optionsAt(maze, cell).some((option) => option.level === 'warmer' || option.level === 'much warmer')).toBe(true);
      }
  });

  it('computes the optimal step count under the 8-direction rules', () => {
    expect(optimalSteps(new Maze(['#####', '#S  #', '#   #', '#  G#', '#####']))).toBe(2);
    // No corner cutting: the down-right shortcut past the wall at (2,3) is closed.
    expect(optimalSteps(new Maze(['#####', '#S# #', '#   #', '# #G#', '#####']))).toBe(4);
    expect(stepCapFor(10)).toBe(60);
    expect(stepCapFor(30)).toBe(90);
    expect(stuckWindowFor(10)).toBe(50);
    expect(stuckWindowFor(40)).toBe(80);
  });
});

describe('smell', () => {
  it('names five levels from the distance change', () => {
    expect([-2, -1, 0, 1, 2].map(levelOf)).toEqual(['much warmer', 'warmer', 'no change', 'colder', 'much colder']);
    expect(() => levelOf(3)).toThrow();
  });

  it('describes closeness with the distance thresholds', () => {
    expect([1, 2].map(closenessSentence)).toEqual(Array(2).fill('The cheese smell is overwhelming, it must be right here.'));
    expect([3, 5].map(closenessSentence)).toEqual(Array(2).fill('The cheese smell is strong.'));
    expect([6, 10].map(closenessSentence)).toEqual(Array(2).fill('The cheese smell is noticeable.'));
    expect(closenessSentence(11)).toBe('The cheese smell is faint.');
  });
});

describe('mood', () => {
  it('names every band at its boundaries', () => {
    const cases: [number, string][] = [
      [1000, 'extremely happy'],
      [800, 'extremely happy'],
      [799, 'happy'],
      [600, 'happy'],
      [599, 'normal'],
      [400, 'normal'],
      [399, 'anxious'],
      [200, 'anxious'],
      [199, 'extremely depressed'],
      [0, 'extremely depressed'],
    ];
    for (const [score, word] of cases) expect(moodWord(score)).toBe(word);
  });

  it('starts at 500, follows the level of each move, costs 30 for an invalid answer and stays within 0…1000', () => {
    const game = new Game(new Maze(['#######', '#S    #', '#     #', '#    G#', '#######']));
    expect(game.mood).toBe(500);
    expect(game.apply('down-right')).toMatchObject({ valid: true, level: 'much warmer', moodChange: 20, mood: 520 });
    expect(game.apply('up-left')).toMatchObject({ valid: true, level: 'much colder', moodChange: -20, mood: 500 });
    expect(game.apply('right')).toMatchObject({ valid: true, level: 'warmer', moodChange: 10, mood: 510 });
    expect(game.apply('left')).toMatchObject({ valid: true, level: 'colder', moodChange: -10, mood: 500 });
    expect(game.apply('up')).toMatchObject({ valid: false, moodChange: INVALID_MOOD_CHANGE, mood: 470, from: { x: 1, y: 1 }, to: { x: 1, y: 1 } });
    expect(game.apply(null)).toMatchObject({ valid: false, mood: 440 });
    expect(game.invalid).toBe(2);
    expect(game.steps).toBe(6);
    for (let i = 0; i < 20; i++) game.apply(null);
    expect(game.mood).toBe(0);
  });

  it('treats a direction that was not offered as invalid even if the cell is open', () => {
    const game = new Game(new Maze(['#####', '#S  #', '#   #', '#  G#', '#####']));
    const offered = game.options().filter((option) => option.direction !== 'right');
    expect(game.apply('right', offered)).toMatchObject({ valid: false, to: { x: 1, y: 1 } });
  });
});

describe('end of a run', () => {
  it('ends at the cheese', () => {
    const game = new Game(new Maze(['#####', '#S  #', '#   #', '#  G#', '#####']));
    game.apply('down-right');
    expect(game.apply('down-right').status).toBe('solved');
    expect(() => game.apply('up')).toThrow();
  });

  it('ends at the step cap, and when stuck without reaching a new cell', () => {
    const capped = new Game(new Maze(['#####', '#S  #', '#   #', '#  G#', '#####']));
    // Step 1 reaches a new cell; the next 50 steps do not.
    for (let i = 0; i < 50; i++) capped.apply(i % 2 ? 'up' : 'down');
    expect(capped.status).toBe('running');
    capped.apply(null);
    expect(capped.status).toBe('stuck');
    expect(capped.steps).toBe(1 + stuckWindowFor(capped.optimal));
    // Cheese right below the start (cap 60, stuck window 50): eleven new cells, then back and forth.
    const corridor = new Game(new Maze(['##############', '#S           #', '#G############']));
    expect(corridor.stepCap).toBe(60);
    for (let i = 0; i < 11; i++) corridor.apply('right');
    for (let i = 0; i < 49; i++) corridor.apply(i % 2 ? 'right' : 'left');
    expect(corridor.status).toBe('step-cap');
    expect(corridor.steps).toBe(60);
  });
});
