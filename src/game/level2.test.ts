import { describe, expect, it } from 'vitest';

import {
  Level2Game,
  catPenalty,
  catStep,
  directionTo,
  parseLevel2,
  resolveTurn,
  shortestSafePath,
  walkingDistance,
  type CatState,
} from '@/game/level2';
import { Maze } from '@/maze/maze';

const cat = (x: number, y: number, direction: CatState['direction']): CatState => ({ position: { x, y }, direction });
/** Only winnable by waiting: the cat patrols the column the mouse must cross. */
const WAIT = ['#####', '#S G#', '## ##', '## ##', '#####'];

describe('the cat', () => {
  it('moves one block along its axis and bounces off walls in the same turn', () => {
    const maze = new Maze(['#####', '#S G#', '#####']);
    expect(catStep(maze, cat(2, 1, 'right'))).toEqual({ cat: cat(3, 1, 'right'), move: 'right' });
    expect(catStep(maze, cat(3, 1, 'right'))).toEqual({ cat: cat(2, 1, 'left'), move: 'left' });
  });

  it('stays put on a patrol line of length one', () => {
    const maze = new Maze(['#####', '#S#G#', '# # #', '#####']);
    expect(catStep(maze, cat(1, 2, 'left'))).toEqual({ cat: cat(1, 2, 'left'), move: 'stayed' });
  });

  it('records a bounce in its history', () => {
    const game = new Level2Game(new Maze(['#######', '#S    #', '#     #', '#    G#', '#######']), cat(4, 2, 'right'));
    game.apply('stay');
    game.apply('stay');
    expect(game.catHistory).toEqual(['right', 'left']);
  });
});

describe('catches and winning', () => {
  const corridor = new Maze(['#######', '#S   G#', '#######']);
  it('catches the mouse when it moves onto the cat', () => {
    expect(resolveTurn(corridor, { x: 1, y: 1 }, cat(2, 1, 'right'), 'right')).toMatchObject({ outcome: 'caught', catchCase: 'moved onto the cat', catMove: null });
  });

  it('catches the mouse when the cat lands on it', () => {
    expect(resolveTurn(corridor, { x: 1, y: 1 }, cat(3, 1, 'left'), 'right')).toMatchObject({ outcome: 'caught', catchCase: 'the cat landed on the mouse' });
  });

  it('reports a swap of cells as moving onto the cat, which is checked first', () => {
    // The mouse moves into the cat's cell while the cat would move into the mouse's: rule 1 catches it before the cat moves.
    expect(resolveTurn(corridor, { x: 1, y: 1 }, cat(2, 1, 'left'), 'right')).toMatchObject({ outcome: 'caught', catchCase: 'moved onto the cat' });
  });

  it('wins on reaching the cheese before the cat moves', () => {
    expect(resolveTurn(corridor, { x: 4, y: 1 }, cat(3, 1, 'right'), 'right')).toMatchObject({ outcome: 'won', catMove: null, cat: cat(3, 1, 'right') });
  });

  it('lets an invalid answer stay put and still lets the cat move', () => {
    const game = new Level2Game(new Maze(['#######', '#S    #', '#     #', '#    G#', '#######']), cat(5, 1, 'left'));
    expect(game.apply('up')).toMatchObject({ valid: false, to: { x: 1, y: 1 }, catTo: { x: 4, y: 1 }, smellMoodChange: -30 });
    expect(game.invalid).toBe(1);
  });
});

describe('sensing and walking distance', () => {
  it('goes through openings, never through walls', () => {
    // The cat is two cells to the right, behind a wall: six blocks away on foot.
    const maze = new Maze(['#######', '#S# # #', '# # # #', '#     #', '#    G#', '#######']);
    expect(walkingDistance(maze, { x: 1, y: 1 }, { x: 3, y: 1 })).toBe(6);
    const game = new Level2Game(maze, cat(3, 1, 'up'));
    expect(game.catDistance).toBe(6);
    expect(game.sense()).toBeNull();
    expect(walkingDistance(maze, { x: 1, y: 1 }, { x: 1, y: 3 })).toBe(2);
  });

  it('senses within three blocks and names the direction from the offset', () => {
    const game = new Level2Game(new Maze(['#######', '#S    #', '#     #', '#    G#', '#######']), cat(3, 3, 'right'));
    expect(game.sense()).toEqual({ distance: 2, direction: 'down-right', history: [] });
    expect(directionTo({ x: 2, y: 2 }, { x: 2, y: 0 })).toBe('up');
    expect(directionTo({ x: 2, y: 2 }, { x: 0, y: 3 })).toBe('down-left');
  });
});

describe('mood near the cat', () => {
  it('penalises distance one by 200 and distance two by 100, never both', () => {
    expect([1, 2, 3, 9].map(catPenalty)).toEqual([-200, -100, 0, 0]);
    // Open room: the cat ends one block away after its move.
    const game = new Level2Game(new Maze(['#########', '#S      #', '#       #', '#      G#', '#########']), cat(4, 1, 'left'));
    const result = game.apply('right');
    expect(result).toMatchObject({ distanceAfter: 1, catPenalty: -200, smellMoodChange: 10, mood: 310 });
  });
});

describe('solvability search', () => {
  it('finds a level that is only winnable by waiting', () => {
    expect(shortestSafePath(new Maze(WAIT), { x: 1, y: 1 }, cat(2, 2, 'up'))).toEqual(['stay', 'stay', 'right', 'right']);
  });

  it('finds the plain shortest path when the cat is out of the way, and null when the level cannot be won', () => {
    expect(shortestSafePath(new Maze(['#########', '#S     G#', '#       #', '#########']), { x: 1, y: 1 }, cat(1, 2, 'up'))).toHaveLength(6);
    expect(shortestSafePath(new Maze(['#####', '#S G#', '#####']), { x: 1, y: 1 }, cat(2, 1, 'right'))).toBeNull();
    expect(() => new Level2Game(new Maze(['#####', '#S G#', '#####']), cat(2, 1, 'right'))).toThrow(/cannot be won/);
  });

  it('a game that follows the search wins in exactly that many steps', () => {
    const maze = new Maze(WAIT);
    const game = new Level2Game(maze, cat(2, 2, 'up'));
    for (const move of shortestSafePath(maze, game.position, game.cat)!) game.apply(move);
    expect(game.status).toBe('solved');
    expect(game.steps).toBe(game.shortestSafe);
  });
});

describe('level files', () => {
  it('reject a cat whose direction is not on its axis, or that starts in a wall', () => {
    expect(() => parseLevel2({ layout: WAIT, cat: { start: [2, 2], axis: 'horizontal', direction: 'up' } })).toThrow(/axis/);
    expect(() => parseLevel2({ layout: WAIT, cat: { start: [0, 0], axis: 'vertical', direction: 'up' } })).toThrow(/wall/);
  });
});
