import { describe, expect, it } from 'vitest';

import { Maze, rotate180 } from '@/maze/maze';

const LAYOUT = ['#####', '#S  #', '# # #', '#  G#', '#####'];

describe('Maze', () => {
  it('finds start and cheese and measures smell as 101 − 4-direction BFS distance', () => {
    const maze = new Maze(LAYOUT);
    expect(maze.startPosition).toEqual({ x: 1, y: 1 });
    expect(maze.goalPosition).toEqual({ x: 3, y: 3 });
    expect(maze.distanceToGoal({ x: 1, y: 1 })).toBe(4);
    expect(maze.smellAt({ x: 1, y: 1 })).toBe(97);
    expect(maze.smellAt({ x: 2, y: 2 })).toBe(0);
    expect(maze.isWalkable({ x: 2, y: 2 })).toBe(false);
    expect(maze.isWalkable({ x: -1, y: 0 })).toBe(false);
  });

  it('rotates a layout by 180°', () => {
    const rotated = new Maze(rotate180(LAYOUT));
    expect(rotated.startPosition).toEqual({ x: 3, y: 3 });
    expect(rotated.goalPosition).toEqual({ x: 1, y: 1 });
    expect(rotate180(rotate180(LAYOUT))).toEqual(LAYOUT);
  });
});
