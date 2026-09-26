import { describe, it, expect } from 'vitest';
import { Maze, type Direction } from '@/maze/maze';

const DOWN: Direction = { dx: 0, dy: 1 };
const RIGHT: Direction = { dx: 1, dy: 0 };

describe('Maze.getDirectionsToGoal', () => {
  it('returns directions that approach the goal', () => {
    const layout = [
      '#####',
      '#S  #',
      '# # #',
      '#  G#',
      '#####',
    ];
    const maze = new Maze(layout);

    // Distance from goal(3,3):
    // (1,1)=4, (2,1)=3, (3,1)=2
    // (1,2)=3,        , (3,2)=1
    // (1,3)=2, (2,3)=1, (3,3)=0

    expect(maze.getDirectionsToGoal({ x: 1, y: 1 })).toEqual(expect.arrayContaining([DOWN, RIGHT]));
    expect(maze.getDirectionsToGoal({ x: 2, y: 1 })).toEqual([RIGHT]);
    expect(maze.getDirectionsToGoal({ x: 3, y: 1 })).toEqual([DOWN]);
    expect(maze.getDirectionsToGoal({ x: 1, y: 2 })).toEqual([DOWN]);
    expect(maze.getDirectionsToGoal({ x: 3, y: 2 })).toEqual([DOWN]);
    expect(maze.getDirectionsToGoal({ x: 1, y: 3 })).toEqual([RIGHT]);
    expect(maze.getDirectionsToGoal({ x: 2, y: 3 })).toEqual([RIGHT]);
    expect(maze.getDirectionsToGoal({ x: 3, y: 3 })).toEqual([]);
  });

  it('returns multiple directions when equidistant paths exist', () => {
    const layout = [
      '#####',
      '#S  #',
      '#   #',
      '#  G#',
      '#####',
    ];
    const maze = new Maze(layout);

    // Distance from goal(3,3):
    // (1,1)=4, (2,1)=3, (3,1)=2
    // (1,2)=3, (2,2)=2, (3,2)=1
    // (1,3)=2, (2,3)=1, (3,3)=0

    expect(maze.getDirectionsToGoal({ x: 2, y: 2 })).toEqual(expect.arrayContaining([DOWN, RIGHT]));
    expect(maze.getDirectionsToGoal({ x: 1, y: 2 })).toEqual(expect.arrayContaining([DOWN, RIGHT]));
  });
});

describe('Maze visual perception', () => {
  it('sees every unobstructed open cell in an open room, including diagonal cheese', () => {
    const maze = new Maze(['#####', '#S  #', '#   #', '#  G#', '#####']);
    const perception = maze.perceive({ x: 1, y: 1 });
    expect(perception.visibleCells.map((cell) => cell.position)).toEqual(expect.arrayContaining([
      { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 },
      { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 },
      { x: 1, y: 3 }, { x: 2, y: 3 }, { x: 3, y: 3 },
    ]));
    expect(maze.isVisible({ x: 1, y: 1 }, { x: 3, y: 3 })).toBe(true);
  });

  it('occludes cells behind walls and sealed diagonal corners', () => {
    const maze = new Maze(['########', '#S # G #', '#  #   #', '########']);
    expect(maze.isVisible({ x: 1, y: 1 }, { x: 5, y: 1 })).toBe(false);
    const corner = new Maze(['###', '#S#', '##G']);
    expect(corner.isVisible({ x: 1, y: 1 }, { x: 2, y: 2 })).toBe(false);
  });

  it('executes a direct diagonal path without pathfinding', () => {
    const maze = new Maze(['#####', '#S  #', '#   #', '#  G#', '#####']);
    expect(maze.directPath({ x: 1, y: 1 }, { x: 3, y: 3 })).toEqual([{ x: 2, y: 2 }, { x: 3, y: 3 }]);
    const blocked = new Maze(['####', '#S##', '##G#', '####']);
    expect(blocked.directPath({ x: 1, y: 1 }, { x: 2, y: 2 })).toBeNull();
  });

  it('casts cardinal rays and stops at the first wall', () => {
    const maze = new Maze([
      '#########',
      '#S   #G#',
      '# ###  #',
      '#     ##',
      '########',
    ]);
    const perception = maze.perceive({ x: 2, y: 1 });
    expect(perception.visual.right.visibleCells).toEqual([{ x: 3, y: 1 }, { x: 4, y: 1 }]);
    expect(perception.visual.right.termination).toBe('wall');
    expect(perception.visual.right.goalDistance).toBeUndefined();
    expect(perception.visual.left.visibleCells).toEqual([{ x: 1, y: 1 }]);
  });

  it('recognizes a perpendicular opening as the end of a tunnel', () => {
    const maze = new Maze([
      '########',
      '#S    G#',
      '#####  #',
      '########',
    ]);
    expect(maze.isDecisionPoint({ x: 5, y: 1 }, 'right')).toBe(true);
    expect(maze.isDecisionPoint({ x: 3, y: 1 }, 'right')).toBe(false);
  });
});

describe('Maze.getPathFromStart', () => {
  it('returns path from start to each position', () => {
    const layout = [
      '#####',
      '#S  #',
      '# # #',
      '#  G#',
      '#####',
    ];
    const maze = new Maze(layout);

    // Path to start itself
    expect(maze.getPathFromStart({ x: 1, y: 1 })).toEqual([{ x: 1, y: 1 }]);

    // Path to goal
    const pathToGoal = maze.getPathFromStart({ x: 3, y: 3 });
    expect(pathToGoal[0]).toEqual({ x: 1, y: 1 }); // starts from start
    expect(pathToGoal[pathToGoal.length - 1]).toEqual({ x: 3, y: 3 }); // ends at goal
  });

  it('prioritizes axis with greater distance to goal', () => {
    const layout = [
      '#####',
      '#S  #',
      '#   #',
      '#  G#',
      '#####',
    ];
    const maze = new Maze(layout);

    const pathToGoal = maze.getPathFromStart({ x: 3, y: 3 });
    // Reduces dependency on maze orientation
    // Expected: (1,1) -> (1,2) -> (2,2) -> (2,3) -> (3,3)
    expect(pathToGoal).toEqual([
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 3 },
      { x: 3, y: 3 },
    ]);
  });

  it('passes through goal when no alternative path exists (dead-end beyond G)', () => {
    // (5,1) is only reachable by passing through G
    const layout = [
      '#######',
      '#S  # #',
      '# ### #',
      '#    G#',
      '# ### #',
      '#     #',
      '#######',
    ];
    const maze = new Maze(layout);

    const pathToDeadEnd = maze.getPathFromStart({ x: 5, y: 1 });
    const pathStr1 = pathToDeadEnd.map((p) => `(${p.x},${p.y})`).join(' → ');
    const passesGoalForDeadEnd = pathToDeadEnd.some((p) => p.x === 5 && p.y === 3);
    expect(passesGoalForDeadEnd, `Path to dead-end: ${pathStr1}`).toBe(true);
  });

  it('avoids passing through goal when alternative path exists', () => {
    // (5,4) can be reached via G or by going around - should avoid G
    const layout = [
      '#######',
      '#S  # #',
      '# ### #',
      '#    G#',
      '# ### #',
      '#     #',
      '#######',
    ];
    const maze = new Maze(layout);

    const pathToLower = maze.getPathFromStart({ x: 5, y: 4 });
    const pathStr2 = pathToLower.map((p) => `(${p.x},${p.y})`).join(' → ');
    const passesGoalForLower = pathToLower.some((p) => p.x === 5 && p.y === 3);
    expect(passesGoalForLower, `Path to lower: ${pathStr2}`).toBe(false);
  });
});
