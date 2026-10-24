import fs from 'fs/promises';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { buildSuite, rng, seededShuffle, type DecisionState } from '@/benchmark/full-maze-eval-lib';
import {
  CLOSENESS_PHRASES,
  LABEL_SCHEMES,
  MAZE_CHECK_ARMS,
  MOVES4,
  armRequest,
  closenessWords,
  enumerateSituations,
  labelToMove,
  layaBestRequest,
  optionLabels,
  situationFor,
  situationOf,
} from '@/benchmark/word-prompt-builders';
import type { Move } from '@/execution/execution';
import { Maze } from '@/maze/maze';

const loadStates = async () =>
  (JSON.parse(await fs.readFile(path.resolve(__dirname, '../../benchmark-results/frozen-dataset.json'), 'utf-8')) as { states: (DecisionState & { id: string })[] }).states;
const requests = enumerateSituations(20261023);

describe('enumeration of laya-best situations', () => {
  it('has 65 open/warmer combinations × 4 closeness phrases, canonical plus one differing shuffled order', () => {
    const canonical = requests.filter((r) => r.orderKind === 'canonical');
    const shuffled = requests.filter((r) => r.orderKind === 'shuffled');
    expect(CLOSENESS_PHRASES).toEqual(['the cheese smell is overwhelming, it must be right here', 'the smell is strong', 'the smell is noticeable', 'the smell is faint']);
    expect(canonical).toHaveLength(65 * 4);
    expect(shuffled).toHaveLength(61 * 4);
    expect(new Set(canonical.map((r) => r.key)).size).toBe(260);
    for (const r of canonical) {
      expect(r.order).toEqual(MOVES4.filter((m) => r.open.includes(m)));
      expect(r.warmer.length).toBeGreaterThan(0);
      expect(r.warmer.every((m) => r.open.includes(m))).toBe(true);
    }
    for (const r of shuffled) {
      expect(r.order.join()).not.toBe(r.open.join());
      expect([...r.order].sort()).toEqual([...r.open].sort());
    }
    expect(enumerateSituations(20261023)).toEqual(requests);
  });

  it('covers every request laya-best actually sends: the frozen states and every cell of the suite', async () => {
    const keys = new Set(requests.map((r) => r.key));
    for (const state of await loadStates()) {
      const order = seededShuffle(state.validActions, rng(4));
      const situation = situationOf(state, order);
      // The situation request in direction labels is byte-identical to laya-best's real request.
      expect(JSON.stringify(layaBestRequest(situation, 'moves'))).toBe(JSON.stringify(armRequest(MAZE_CHECK_ARMS['laya-best'], state, order, 'm')));
      const warmer = MOVES4.filter((m) => situation.options.some((o) => o.move === m && o.warmer));
      expect(keys.has(`${MOVES4.filter((m) => order.includes(m)).join('+')}|warm:${warmer.join('+')}|${situation.closeness}`)).toBe(true);
    }
    for (const entry of (await buildSuite()).slice(0, 40)) {
      const maze = new Maze(entry.layout);
      for (let y = 0; y < maze.height; y++)
        for (let x = 0; x < maze.width; x++) {
          if (!maze.isWalkable({ x, y }) || (x === entry.goal.x && y === entry.goal.y)) continue;
          const next = (m: Move) => ({ x: x + (m === 'left' ? -1 : m === 'right' ? 1 : 0), y: y + (m === 'up' ? -1 : m === 'down' ? 1 : 0) });
          const open = MOVES4.filter((m) => maze.isWalkable(next(m)));
          const warmer = open.filter((m) => maze.smellAt(next(m)) > maze.smellAt({ x, y }));
          expect(keys.has(`${open.join('+')}|warm:${warmer.join('+')}|${closenessWords(maze.smellAt({ x, y }))}`)).toBe(true);
        }
    }
  });
});

describe('label schemes', () => {
  it('change only the option labels: body, instructions, option text and order stay identical', () => {
    for (const request of requests) {
      const situation = situationFor(request);
      const base = layaBestRequest(situation, 'moves') as any;
      for (const scheme of LABEL_SCHEMES) {
        const other = layaBestRequest(situation, scheme) as any;
        expect(other.state).toEqual(base.state);
        expect({ ...other.questions.move, criteria: null }).toEqual({ ...base.questions.move, criteria: null });
        expect(Object.values(other.questions.move.criteria)).toEqual(Object.values(base.questions.move.criteria));
        expect(Object.keys(other.questions.move.criteria)).toEqual(optionLabels(scheme, request.order));
        // Relabelling the moves request gives this scheme's request byte for byte.
        let relabelled = JSON.stringify(base);
        for (const [from, to] of Object.keys(base.questions.move.criteria).map((k, i) => [`"${k}":`, `"${optionLabels(scheme, request.order)[i]}":`])) relabelled = relabelled.replace(from, to);
        expect(relabelled).toBe(JSON.stringify(other));
        expect(JSON.stringify(other)).not.toMatch(/\d/);
      }
    }
  });

  it('use compass points and position-only neutral labels', () => {
    expect(optionLabels('moves', ['left', 'up'])).toEqual(['LEFT', 'UP']);
    expect(optionLabels('compass', ['up', 'down', 'left', 'right'])).toEqual(['NORTH', 'SOUTH', 'WEST', 'EAST']);
    expect(optionLabels('neutral', ['right', 'up', 'left'])).toEqual(['PATH_A', 'PATH_B', 'PATH_C']);
    expect(optionLabels('neutral', ['up', 'right', 'left'])).toEqual(['PATH_A', 'PATH_B', 'PATH_C']);
  });

  it('map answers back to moves and reject labels that were not offered', () => {
    expect(labelToMove('compass', ['up', 'right'], 'EAST')).toBe('right');
    expect(labelToMove('compass', ['up', 'right'], ' north ')).toBe('up');
    expect(labelToMove('compass', ['up', 'right'], 'SOUTH')).toBeNull();
    expect(labelToMove('neutral', ['right', 'up', 'left'], 'PATH_B')).toBe('up');
    expect(labelToMove('neutral', ['right', 'up'], 'PATH_C')).toBeNull();
    expect(labelToMove('neutral', ['right', 'up'], 'I choose PATH_A')).toBe('right');
    expect(labelToMove('moves', ['down', 'left'], 'LEFT')).toBe('left');
    expect(labelToMove('moves', ['down', 'left'], null)).toBeNull();
  });
});
