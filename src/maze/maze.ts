import fs from 'fs/promises';

export interface Position {
  x: number;
  y: number;
}

/** A maze read from text: '#' wall, 'S' start, 'G' cheese, anything else open. */
export class Maze {
  public readonly layout: string[];
  public readonly startPosition: Position;
  public readonly goalPosition: Position;
  public readonly height: number;
  public readonly width: number;
  private distances?: Map<string, number>;

  static async fromFile(filePath: string): Promise<Maze> {
    const content = await fs.readFile(filePath, 'utf-8');
    return new Maze(content.split('\n').filter((line) => line.length > 0));
  }

  constructor(layout: string[]) {
    if (layout.length === 0) throw new Error('Maze layout cannot be empty.');
    this.layout = layout;
    this.height = layout.length;
    this.width = layout[0].length;
    let start: Position | null = null;
    let goal: Position | null = null;
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++) {
        const char = layout[y][x];
        if (char === 'S') {
          if (start) throw new Error('Multiple start positions found.');
          start = { x, y };
        }
        if (char === 'G') {
          if (goal) throw new Error('Multiple goal positions found.');
          goal = { x, y };
        }
      }
    if (!start) throw new Error('No start position found.');
    if (!goal) throw new Error('No goal position found.');
    this.startPosition = start;
    this.goalPosition = goal;
  }

  public isWalkable(position: Position): boolean {
    const char = this.layout[position.y]?.[position.x];
    return char !== undefined && char !== '#';
  }

  public isGoal(position: Position): boolean {
    return position.x === this.goalPosition.x && position.y === this.goalPosition.y;
  }

  /** Open cells, in row order. */
  public openCells(): Position[] {
    const cells: Position[] = [];
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) if (this.isWalkable({ x, y })) cells.push({ x, y });
    return cells;
  }

  /** BFS distance to the cheese in 4-direction steps, or undefined if unreachable. */
  public distanceToGoal(position: Position): number | undefined {
    if (!this.distances) this.distances = this.calculateDistancesToGoal();
    return this.distances.get(`${position.x},${position.y}`);
  }

  /** Cheese smell: 101 − BFS distance (0 if unreachable). */
  public smellAt(position: Position): number {
    const distance = this.distanceToGoal(position);
    return distance === undefined ? 0 : Math.max(0, 101 - distance);
  }

  private calculateDistancesToGoal(): Map<string, number> {
    const distances = new Map<string, number>([[`${this.goalPosition.x},${this.goalPosition.y}`, 0]]);
    const queue: Position[] = [this.goalPosition];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const distance = distances.get(`${current.x},${current.y}`)!;
      for (const next of [
        { x: current.x, y: current.y - 1 },
        { x: current.x, y: current.y + 1 },
        { x: current.x - 1, y: current.y },
        { x: current.x + 1, y: current.y },
      ]) {
        const key = `${next.x},${next.y}`;
        if (this.isWalkable(next) && !distances.has(key)) {
          distances.set(key, distance + 1);
          queue.push(next);
        }
      }
    }
    return distances;
  }
}

/** The same layout turned upside down and mirrored (rotated by 180°). */
export function rotate180(layout: string[]): string[] {
  return [...layout].reverse().map((row) => [...row].reverse().join(''));
}
