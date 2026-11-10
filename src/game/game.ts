import { Maze, type Position } from '@/maze/maze';

// The rules of the final game: 8 directions without corner cutting, smell levels from the 4-direction BFS distance,
// and a mood score that only describes how the walk is going.

export const DIRECTIONS = ['up', 'down', 'left', 'right', 'up-left', 'up-right', 'down-left', 'down-right'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const OFFSETS: Record<Direction, { dx: number; dy: number }> = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
  'up-left': { dx: -1, dy: -1 },
  'up-right': { dx: 1, dy: -1 },
  'down-left': { dx: -1, dy: 1 },
  'down-right': { dx: 1, dy: 1 },
};

export const isDiagonal = (direction: Direction) => direction.includes('-');
export const step = (position: Position, direction: Direction): Position => ({ x: position.x + OFFSETS[direction].dx, y: position.y + OFFSETS[direction].dy });

/** Legal directions in DIRECTIONS order. A diagonal needs its target and both straight cells beside it open. */
export function legalDirections(maze: Maze, position: Position): Direction[] {
  return DIRECTIONS.filter((direction) => {
    if (!maze.isWalkable(step(position, direction))) return false;
    if (!isDiagonal(direction)) return true;
    const { dx, dy } = OFFSETS[direction];
    return maze.isWalkable({ x: position.x + dx, y: position.y }) && maze.isWalkable({ x: position.x, y: position.y + dy });
  });
}

/** Smell levels, best first. */
export const LEVELS = ['much warmer', 'warmer', 'no change', 'colder', 'much colder'] as const;
export type Level = (typeof LEVELS)[number];

/** The level for a change in BFS distance: −2 much warmer … +2 much colder. */
export function levelOf(distanceChange: number): Level {
  const level = { [-2]: 'much warmer', [-1]: 'warmer', 0: 'no change', 1: 'colder', 2: 'much colder' }[distanceChange] as Level | undefined;
  if (!level) throw new Error(`A single move cannot change the distance by ${distanceChange}.`);
  return level;
}

/** How close the cheese smells from a cell, by BFS distance. */
export function closenessSentence(distance: number): string {
  if (distance <= 2) return 'The cheese smell is overwhelming, it must be right here.';
  if (distance <= 5) return 'The cheese smell is strong.';
  if (distance <= 10) return 'The cheese smell is noticeable.';
  return 'The cheese smell is faint.';
}

export const MOOD_START = 500;
const MOOD_MAX = 1000;
export const MOOD_CHANGE: Record<Level, number> = { 'much warmer': 20, warmer: 10, 'no change': 0, colder: -10, 'much colder': -20 };
/** An answer that is not an offered direction: the mouse stays put. */
export const INVALID_MOOD_CHANGE = -30;

export const clampMood = (score: number) => Math.max(0, Math.min(MOOD_MAX, score));

export function moodWord(score: number): string {
  if (score >= 800) return 'extremely happy';
  if (score >= 600) return 'happy';
  if (score >= 400) return 'normal';
  if (score >= 200) return 'anxious';
  return 'extremely depressed';
}

export type Option = { direction: Direction; level: Level };

/** Each legal direction with its smell level, in DIRECTIONS order. */
export function optionsAt(maze: Maze, position: Position): Option[] {
  const here = maze.distanceToGoal(position)!;
  return legalDirections(maze, position).map((direction) => ({ direction, level: levelOf(maze.distanceToGoal(step(position, direction))! - here) }));
}

/** Fewest moves from start to cheese under the 8-direction rules. */
export function optimalSteps(maze: Maze): number {
  const key = (p: Position) => `${p.x},${p.y}`;
  const seen = new Map([[key(maze.startPosition), 0]]);
  const queue = [maze.startPosition];
  while (queue.length) {
    const current = queue.shift()!;
    if (maze.isGoal(current)) return seen.get(key(current))!;
    for (const direction of legalDirections(maze, current)) {
      const next = step(current, direction);
      if (!seen.has(key(next))) {
        seen.set(key(next), seen.get(key(current))! + 1);
        queue.push(next);
      }
    }
  }
  throw new Error('The cheese cannot be reached from the start.');
}

export const stepCapFor = (optimal: number) => Math.max(3 * optimal, 100);
/** Stuck: no new cell reached for this many steps. */
export const stuckWindowFor = (optimal: number) => Math.max(50, 2 * optimal);

export type GameStatus = 'running' | 'solved' | 'step-cap' | 'stuck';

type StepResult = {
  step: number;
  from: Position;
  to: Position;
  /** The options as offered for this step. */
  offered: Option[];
  answer: Direction | null;
  /** The answer was one of the offered directions. */
  valid: boolean;
  level: Level | null;
  moodChange: number;
  mood: number;
  status: GameStatus;
};

/** One walk through a maze. The mouse sees only its options; the caller decides how to present them. */
export class Game {
  public readonly optimal: number;
  public readonly stepCap: number;
  public readonly stuckWindow: number;
  public position: Position;
  public mood = MOOD_START;
  public steps = 0;
  public invalid = 0;
  public status: GameStatus = 'running';
  /** Every cell reached, in order, starting with the start cell. */
  public readonly path: Position[];
  private readonly visitedKeys = new Set<string>();
  private lastNewCellStep = 0;

  constructor(public readonly maze: Maze) {
    this.position = { ...maze.startPosition };
    this.path = [{ ...maze.startPosition }];
    this.visitedKeys.add(`${this.position.x},${this.position.y}`);
    this.optimal = optimalSteps(maze);
    this.stepCap = stepCapFor(this.optimal);
    this.stuckWindow = stuckWindowFor(this.optimal);
  }

  get visitedCount(): number {
    return this.visitedKeys.size;
  }

  get distance(): number {
    return this.maze.distanceToGoal(this.position)!;
  }

  options(): Option[] {
    return optionsAt(this.maze, this.position);
  }

  /** Applies one answer. Anything that is not an offered direction costs a step and mood, and the mouse does not move. */
  apply(answer: Direction | null, offered: Option[] = this.options()): StepResult {
    if (this.status !== 'running') throw new Error(`The game is over (${this.status}).`);
    const from = { ...this.position };
    const chosen = offered.find((option) => option.direction === answer) ?? null;
    this.steps++;
    const moodChange = chosen ? MOOD_CHANGE[chosen.level] : INVALID_MOOD_CHANGE;
    this.mood = clampMood(this.mood + moodChange);
    if (chosen) {
      this.position = step(from, chosen.direction);
      this.path.push({ ...this.position });
      const key = `${this.position.x},${this.position.y}`;
      if (!this.visitedKeys.has(key)) {
        this.visitedKeys.add(key);
        this.lastNewCellStep = this.steps;
      }
    } else this.invalid++;
    if (this.maze.isGoal(this.position)) this.status = 'solved';
    else if (this.steps >= this.stepCap) this.status = 'step-cap';
    else if (this.steps - this.lastNewCellStep >= this.stuckWindow) this.status = 'stuck';
    return {
      step: this.steps,
      from,
      to: { ...this.position },
      offered,
      answer,
      valid: Boolean(chosen),
      level: chosen?.level ?? null,
      moodChange,
      mood: this.mood,
      status: this.status,
    };
  }
}
