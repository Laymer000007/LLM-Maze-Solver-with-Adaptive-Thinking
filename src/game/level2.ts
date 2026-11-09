import fs from 'fs/promises';

import {
  DIRECTIONS,
  MOOD_CHANGE,
  MOOD_START,
  OFFSETS,
  clampMood,
  legalDirections,
  optionsAt,
  step,
  stepCapFor,
  stuckWindowFor,
  INVALID_MOOD_CHANGE,
  type Direction,
  type Level,
} from '@/game/game';
import { Maze, type Position } from '@/maze/maze';

// Level 2: the level-1 rules plus a patrolling cat and a "stay" option. Level 1 (game.ts) is unchanged.

export type Axis = 'horizontal' | 'vertical';
export type CatDirection = 'up' | 'down' | 'left' | 'right';
/** What the cat did in one turn. */
export type CatMove = CatDirection | 'stayed';
export type CatState = { position: Position; direction: CatDirection };

/** A level-2 file: the layout plus the cat's start cell, patrol axis and starting direction. */
export type Level2File = { layout: string[]; cat: { start: [number, number]; axis: Axis; direction: CatDirection } };
export type Level2 = { maze: Maze; cat: CatState };

export function parseLevel2(file: Level2File): Level2 {
  const maze = new Maze(file.layout);
  const [x, y] = file.cat.start;
  const axisDirections: Record<Axis, CatDirection[]> = { horizontal: ['left', 'right'], vertical: ['up', 'down'] };
  if (!axisDirections[file.cat.axis]?.includes(file.cat.direction))
    throw new Error(`The cat's direction ${file.cat.direction} is not on its ${file.cat.axis} axis.`);
  if (!maze.isWalkable({ x, y })) throw new Error(`The cat starts in a wall at (${x},${y}).`);
  return { maze, cat: { position: { x, y }, direction: file.cat.direction } };
}

export async function loadLevel2(path: string): Promise<Level2> {
  return parseLevel2(JSON.parse(await fs.readFile(path, 'utf-8')) as Level2File);
}

const REVERSE: Record<CatDirection, CatDirection> = { up: 'down', down: 'up', left: 'right', right: 'left' };

/** One cat turn: one block along its axis, reversing at a wall or the edge; if both sides are blocked it stays put. */
export function catStep(maze: Maze, cat: CatState): { cat: CatState; move: CatMove } {
  for (const direction of [cat.direction, REVERSE[cat.direction]]) {
    const next = step(cat.position, direction);
    if (maze.isWalkable(next)) return { cat: { position: next, direction }, move: direction };
  }
  return { cat, move: 'stayed' };
}

export type Move = Direction | 'stay';
export const MOVES: readonly Move[] = [...DIRECTIONS, 'stay'];
export type Option2 = { direction: Move; level: Level };

/** Level-1 options plus "stay", which never changes the smell. */
export function optionsAt2(maze: Maze, position: Position): Option2[] {
  return [...optionsAt(maze, position), { direction: 'stay', level: 'no change' }];
}

export const target = (position: Position, move: Move): Position => (move === 'stay' ? { ...position } : step(position, move));
const key = (p: Position) => `${p.x},${p.y}`;
const same = (a: Position, b: Position) => a.x === b.x && a.y === b.y;

const walkCache = new WeakMap<Maze, Map<string, Map<string, number>>>();
/** Walking distance through open cells under the 8-direction, no-corner-cutting rules (Infinity if unreachable). */
export function walkingDistance(maze: Maze, from: Position, to: Position): number {
  let byStart = walkCache.get(maze);
  if (!byStart) walkCache.set(maze, (byStart = new Map()));
  let distances = byStart.get(key(from));
  if (!distances) {
    distances = new Map([[key(from), 0]]);
    const queue = [from];
    while (queue.length) {
      const current = queue.shift()!;
      for (const direction of legalDirections(maze, current)) {
        const next = step(current, direction);
        if (!distances.has(key(next))) {
          distances.set(key(next), distances.get(key(current))! + 1);
          queue.push(next);
        }
      }
    }
    byStart.set(key(from), distances);
  }
  return distances.get(key(to)) ?? Infinity;
}

/** The direction word for where `to` lies from `from`, by the signs of the offset. */
export function directionTo(from: Position, to: Position): Direction {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  return DIRECTIONS.find((d) => OFFSETS[d].dx === dx && OFFSETS[d].dy === dy) ?? 'up';
}

/** The mouse senses the cat within this walking distance. */
export const SENSE_RANGE = 3;
/** The sensing range of the cat-danger-range5 prompt variant. */
export const WIDE_SENSE_RANGE = 5;

/** Mood penalty after the cat's move; the two do not add up. */
export function catPenalty(distance: number): number {
  if (distance <= 1) return -200;
  if (distance === 2) return -100;
  return 0;
}

export type CatchCase = 'moved onto the cat' | 'the cat landed on the mouse' | 'swapped cells';
export type TurnResult = { mouse: Position; cat: CatState; catMove: CatMove | null; outcome: 'won' | 'caught' | 'continue'; catchCase: CatchCase | null };

/** One turn: the mouse moves (null = stays, for an invalid answer), then the cat, with every catch rule. */
export function resolveTurn(maze: Maze, mouse: Position, cat: CatState, move: Move | null): TurnResult {
  const next = move ? target(mouse, move) : { ...mouse };
  if (same(next, cat.position)) return { mouse: next, cat, catMove: null, outcome: 'caught', catchCase: 'moved onto the cat' };
  if (maze.isGoal(next)) return { mouse: next, cat, catMove: null, outcome: 'won', catchCase: null };
  const moved = catStep(maze, cat);
  if (same(moved.cat.position, next)) return { mouse: next, cat: moved.cat, catMove: moved.move, outcome: 'caught', catchCase: 'the cat landed on the mouse' };
  if (same(moved.cat.position, mouse) && same(next, cat.position))
    return { mouse: next, cat: moved.cat, catMove: moved.move, outcome: 'caught', catchCase: 'swapped cells' };
  return { mouse: next, cat: moved.cat, catMove: moved.move, outcome: 'continue', catchCase: null };
}

/**
 * Breadth-first search over (mouse cell, cat cell, cat direction) with the exact turn rules: the shortest list of moves
 * that reaches the cheese without being caught, or null if the level cannot be won from here.
 */
export function shortestSafePath(maze: Maze, mouse: Position, cat: CatState): Move[] | null {
  const stateKey = (m: Position, c: CatState) => `${key(m)}|${key(c.position)}|${c.direction}`;
  const parents = new Map<string, { from: string; move: Move } | null>([[stateKey(mouse, cat), null]]);
  const queue: { mouse: Position; cat: CatState }[] = [{ mouse, cat }];
  const pathTo = (end: string) => {
    const moves: Move[] = [];
    for (let at = parents.get(end); at; at = parents.get(at.from)) moves.unshift(at.move);
    return moves;
  };
  while (queue.length) {
    const state = queue.shift()!;
    const from = stateKey(state.mouse, state.cat);
    for (const move of [...legalDirections(maze, state.mouse), 'stay' as const]) {
      const turn = resolveTurn(maze, state.mouse, state.cat, move);
      if (turn.outcome === 'caught') continue;
      if (turn.outcome === 'won') return [...pathTo(from), move];
      const next = stateKey(turn.mouse, turn.cat);
      if (parents.has(next)) continue;
      parents.set(next, { from, move });
      queue.push({ mouse: turn.mouse, cat: turn.cat });
    }
  }
  return null;
}

export type CatSense = { distance: number; direction: Direction; history: CatMove[] };
export type Level2Status = 'running' | 'solved' | 'caught' | 'step-cap' | 'stuck';

export type Level2StepResult = {
  step: number;
  from: Position;
  to: Position;
  catFrom: Position;
  catTo: Position;
  catMove: CatMove | null;
  /** What the mouse sensed before choosing. */
  sensed: CatSense | null;
  offered: Option2[];
  answer: Move | null;
  valid: boolean;
  level: Level | null;
  smellMoodChange: number;
  catPenalty: number;
  mood: number;
  /** Walking distance to the cat after its move (0 when caught). */
  distanceAfter: number;
  catchCase: CatchCase | null;
  status: Level2Status;
};

/** One level-2 walk. Like Game, the caller decides how to present the options. */
export class Level2Game {
  public readonly shortestSafe: number;
  public readonly stepCap: number;
  public readonly stuckWindow: number;
  public position: Position;
  public cat: CatState;
  public readonly catHistory: CatMove[] = [];
  public mood = MOOD_START;
  public steps = 0;
  public invalid = 0;
  public status: Level2Status = 'running';
  public catchCase: CatchCase | null = null;
  public readonly path: Position[];
  private readonly visitedKeys = new Set<string>();
  private lastNewCellStep = 0;

  constructor(
    public readonly maze: Maze,
    cat: CatState,
    /** How far (walking distance) the mouse senses the cat; mood penalties do not depend on it. */
    public readonly senseRange = SENSE_RANGE,
  ) {
    this.position = { ...maze.startPosition };
    this.cat = { position: { ...cat.position }, direction: cat.direction };
    this.path = [{ ...this.position }];
    this.visitedKeys.add(key(this.position));
    const safe = shortestSafePath(maze, this.position, this.cat);
    if (!safe) throw new Error('This level cannot be won.');
    this.shortestSafe = safe.length;
    this.stepCap = stepCapFor(this.shortestSafe);
    this.stuckWindow = stuckWindowFor(this.shortestSafe);
  }

  get distance(): number {
    return this.maze.distanceToGoal(this.position)!;
  }

  get catDistance(): number {
    return walkingDistance(this.maze, this.position, this.cat.position);
  }

  /** What the mouse is told about the cat, or null when it is too far away to sense. */
  sense(): CatSense | null {
    const distance = this.catDistance;
    if (distance > this.senseRange) return null;
    return { distance, direction: directionTo(this.position, this.cat.position), history: this.catHistory.slice(-3) };
  }

  options(): Option2[] {
    return optionsAt2(this.maze, this.position);
  }

  /** Applies one answer: anything not offered costs mood and the mouse stays, then the cat moves. */
  apply(answer: Move | null, offered: Option2[] = this.options()): Level2StepResult {
    if (this.status !== 'running') throw new Error(`The game is over (${this.status}).`);
    const sensed = this.sense();
    const from = { ...this.position };
    const catFrom = { ...this.cat.position };
    const chosen = offered.find((option) => option.direction === answer) ?? null;
    this.steps++;
    if (!chosen) this.invalid++;
    const turn = resolveTurn(this.maze, from, this.cat, chosen?.direction ?? null);
    this.position = turn.mouse;
    this.cat = turn.cat;
    if (turn.catMove) this.catHistory.push(turn.catMove);
    if (!same(from, this.position)) this.path.push({ ...this.position });
    if (!this.visitedKeys.has(key(this.position))) {
      this.visitedKeys.add(key(this.position));
      this.lastNewCellStep = this.steps;
    }
    const smellMoodChange = chosen ? MOOD_CHANGE[chosen.level] : INVALID_MOOD_CHANGE;
    const distanceAfter = turn.outcome === 'caught' ? 0 : this.catDistance;
    const penalty = turn.outcome === 'continue' ? catPenalty(distanceAfter) : 0;
    this.mood = clampMood(this.mood + smellMoodChange + penalty);
    if (turn.outcome === 'caught') {
      this.status = 'caught';
      this.catchCase = turn.catchCase;
    } else if (turn.outcome === 'won') this.status = 'solved';
    else if (this.steps >= this.stepCap) this.status = 'step-cap';
    else if (this.steps - this.lastNewCellStep >= this.stuckWindow) this.status = 'stuck';
    return {
      step: this.steps,
      from,
      to: { ...this.position },
      catFrom,
      catTo: { ...this.cat.position },
      catMove: turn.catMove,
      sensed,
      offered,
      answer,
      valid: Boolean(chosen),
      level: chosen?.level ?? null,
      smellMoodChange,
      catPenalty: penalty,
      mood: this.mood,
      distanceAfter,
      catchCase: turn.catchCase,
      status: this.status,
    };
  }
}

/** What the mouse is told at one level-2 step, with options in the order shown. */
export type Level2Situation = {
  distance: number;
  mood: number;
  sensed: CatSense | null;
  /** catDistance: walking distance from the option's target cell to the cat's current cell. */
  options: (Option2 & { catDistance: number })[];
};

export function level2Situation(game: Level2Game, offered: Option2[]): Level2Situation {
  return {
    distance: game.distance,
    mood: game.mood,
    sensed: game.sense(),
    options: offered.map((option) => ({ ...option, catDistance: walkingDistance(game.maze, target(game.position, option.direction), game.cat.position) })),
  };
}
