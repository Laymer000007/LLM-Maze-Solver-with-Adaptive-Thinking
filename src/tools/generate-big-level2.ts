// Generates the big level-2 maps (30x30, 40x40, 50x50) deterministically. Never import this file. From the repo root:
//   npx vite-node src/tools/generate-big-level2.ts -- --write
import fs from 'fs';
import path from 'path';

import { LEVEL2_SEED, greedyPolicy, plannerPolicy, runLevel2, type Level2Entry } from '@/eval/level2-eval-lib';
import { legalDirections, optimalSteps, step } from '@/game/game';
import { Level2Game, parseLevel2, type Axis, type CatDirection, type Level2File } from '@/game/level2';
import { rng } from '@/game/random';
import { Maze, type Position } from '@/maze/maze';

const write = process.argv.includes('--write');
const key = (p: Position) => `${p.x},${p.y}`;

function carve(size: number, random: () => number): string[][] {
  const n = size - 1; // odd
  const g = Array.from({ length: n }, () => Array.from({ length: n }, () => '#'));
  const stack: Position[] = [{ x: 1, y: 1 }];
  g[1][1] = ' ';
  while (stack.length) {
    const c = stack.at(-1)!;
    const next = [
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
    ]
      .map(([dx, dy]) => ({ x: c.x + dx, y: c.y + dy, wx: c.x + dx / 2, wy: c.y + dy / 2 }))
      .filter((p) => p.x > 0 && p.y > 0 && p.x < n - 1 && p.y < n - 1 && g[p.y][p.x] === '#');
    if (!next.length) {
      stack.pop();
      continue;
    }
    const p = next[Math.floor(random() * next.length)];
    g[p.wy][p.wx] = ' ';
    g[p.y][p.x] = ' ';
    stack.push({ x: p.x, y: p.y });
  }
  // Loops: knock out some walls between two corridors.
  for (let y = 1; y < n - 1; y++)
    for (let x = 1; x < n - 1; x++) {
      if (g[y][x] !== '#' || (x % 2) + (y % 2) !== 1) continue;
      const horizontal = g[y][x - 1] === ' ' && g[y][x + 1] === ' ';
      const vertical = g[y - 1][x] === ' ' && g[y + 1][x] === ' ';
      if ((horizontal || vertical) && random() < 0.14) g[y][x] = ' ';
    }
  // Open areas.
  const rooms = Math.round(n / 10);
  for (let r = 0; r < rooms; r++) {
    const w = 3 + 2 * Math.floor(random() * 3);
    const h = 3 + 2 * Math.floor(random() * 3);
    const x0 = 1 + 2 * Math.floor(random() * ((n - 1 - w) / 2));
    const y0 = 1 + 2 * Math.floor(random() * ((n - 1 - h) / 2));
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) g[y][x] = ' ';
  }
  // Back to an even size: repeat one middle row and one middle column.
  const mid = Math.floor(n / 2) | 1;
  g.splice(mid, 0, [...g[mid]]);
  for (const row of g) row.splice(mid, 0, row[mid]);
  return g;
}

function bfs(maze: Maze, from: Position): Map<string, number> {
  const seen = new Map([[key(from), 0]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    for (const d of legalDirections(maze, c)) {
      const nx = step(c, d);
      if (!seen.has(key(nx))) {
        seen.set(key(nx), seen.get(key(c))! + 1);
        queue.push(nx);
      }
    }
  }
  return seen;
}

function patrolLine(maze: Maze, p: Position, axis: Axis): Position[] {
  const [a, b] = axis === 'horizontal' ? (['left', 'right'] as const) : (['up', 'down'] as const);
  const line = [p];
  for (let c = step(p, a); maze.isWalkable(c); c = step(c, a)) line.unshift(c);
  for (let c = step(p, b); maze.isWalkable(c); c = step(c, b)) line.push(c);
  return line;
}

type Candidate = { file: Level2File; shortestSafe: number; optimal: number; patrol: number; greedy: string };

function candidate(size: number, seed: number): Candidate | null {
  const random = rng(seed);
  const g = carve(size, random);
  const open: Position[] = [];
  g.forEach((row, y) => row.forEach((c, x) => c === ' ' && open.push({ x, y })));
  const pick = (f: (p: Position) => boolean) => {
    const pool = open.filter(f);
    return pool[Math.floor(random() * pool.length)];
  };
  const q = size / 3;
  const s = pick((p) => p.x < q && p.y < q);
  const goal = pick((p) => p.x > size - q && p.y > size - q);
  if (!s || !goal) return null;
  g[s.y][s.x] = 'S';
  g[goal.y][goal.x] = 'G';
  const layout = g.map((row) => row.join(''));
  const maze = new Maze(layout);
  const fromS = bfs(maze, s);
  const fromG = bfs(maze, goal);
  const optimal = fromS.get(key(goal));
  if (optimal === undefined) return null;
  // Cells on some shortest route, away from the start and the cheese.
  const route = open.filter((p) => fromS.get(key(p))! + fromG.get(key(p))! === optimal && fromS.get(key(p))! > 4 && fromG.get(key(p))! > 2);
  for (let attempt = 0; attempt < 40 && route.length; attempt++) {
    const cell = route[Math.floor(random() * route.length)];
    const axis: Axis = random() < 0.5 ? 'horizontal' : 'vertical';
    const line = patrolLine(maze, cell, axis);
    if (line.length < 3 || line.length > 12) continue;
    if (line.some((p) => (fromS.get(key(p)) ?? 0) <= 4 || maze.isGoal(p))) continue;
    // A way round: start and cheese stay connected with the whole patrol line walled off.
    const blocked = layout.map((row, y) => [...row].map((c, x) => (line.some((p) => p.x === x && p.y === y) ? '#' : c)).join(''));
    if (bfs(new Maze(blocked), s).get(key(goal)) === undefined) continue;
    const start = line[Math.floor(random() * line.length)];
    const dirs: CatDirection[] = axis === 'horizontal' ? ['left', 'right'] : ['up', 'down'];
    const file: Level2File = { layout, cat: { start: [start.x, start.y], axis, direction: dirs[Math.floor(random() * 2)] } };
    const level = parseLevel2(file);
    let game: Level2Game;
    try {
      game = new Level2Game(level.maze, level.cat);
    } catch {
      continue;
    }
    return { file, shortestSafe: game.shortestSafe, optimal: optimalSteps(level.maze), patrol: line.length, greedy: '' };
  }
  return null;
}

async function main() {
  const names = ['07_30x30_loops_a', '08_30x30_loops_b', '09_40x40_loops_a', '10_40x40_loops_b', '11_50x50_loops_a', '12_50x50_loops_b'];
  const sizes = [30, 30, 40, 40, 50, 50];
  let seed = 1000;
  for (const [i, size] of sizes.entries()) {
    for (; ; seed++) {
      const c = candidate(size, seed);
      if (!c) continue;
      const level = parseLevel2(c.file);
      const entry: Level2Entry = { id: names[i], file: '', newGame: (r) => new Level2Game(level.maze, level.cat, r) };
      const greedy = await runLevel2(entry, greedyPolicy, LEVEL2_SEED);
      const planner = await runLevel2(entry, plannerPolicy, LEVEL2_SEED);
      // Greedy caught on every chosen map (so at least half), and the planner solves it optimally.
      if (greedy.status !== 'caught' || planner.status !== 'solved' || planner.steps !== c.shortestSafe) continue;
      console.log(
        `${names[i]}: seed ${seed}, shortest safe ${c.shortestSafe} (optimal ignoring the cat ${c.optimal}), patrol ${c.patrol} cells, greedy caught @${greedy.caughtOnStep}`,
      );
      if (write) {
        const json = `{\n  "layout": [\n${c.file.layout.map((r) => `    "${r}"`).join(',\n')}\n  ],\n  "cat": { "start": [${c.file.cat.start.join(', ')}], "axis": "${c.file.cat.axis}", "direction": "${c.file.cat.direction}" }\n}\n`;
        fs.writeFileSync(path.join('mazes/level2', `${names[i]}.json`), json);
      }
      seed++;
      break;
    }
  }
}

main();
