import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { optionsAt } from '@/game/game';
import { Level2Game, filterNearCat, level2Situation, type CatState, type Level2Situation } from '@/game/level2';
import {
  buildLevel2Prompt,
  buildLevel2Request,
  buildRequest,
  catHistorySentence,
  catLine,
  filtersNearCat,
  parseLevel2Answer,
  senseRangeFor,
  shuffleOptions,
  type Level2Variant,
} from '@/game/prompt';
import { rng } from '@/game/random';
import { Maze } from '@/maze/maze';

const VARIANTS: Level2Variant[] = ['cat-history', 'cat-facts', 'cat-position', 'cat-rule', 'cat-danger', 'cat-danger-range5', 'cat-filter', 'cat-filter-range5'];
const OPEN = new Maze(['#########', '#S      #', '#       #', '#       #', '#      G#', '#########']);

/** Plays random legal moves and collects every situation, sensed or not; filtered: with the near-cat filter applied. */
function situations(senseRange?: number, filtered = false): Level2Situation[] {
  const out: Level2Situation[] = [];
  const random = rng(3);
  for (const cat of [{ position: { x: 3, y: 2 }, direction: 'left' }, { position: { x: 2, y: 3 }, direction: 'up' }, { position: { x: 5, y: 1 }, direction: 'down' }] as CatState[])
    for (let run = 0; run < 20; run++) {
      const game = new Level2Game(OPEN, cat, senseRange);
      while (game.status === 'running' && game.steps < 30) {
        const shuffled = shuffleOptions(game.options(), random);
        const offered = filtered ? filterNearCat(game, shuffled).options : shuffled;
        out.push(level2Situation(game, offered));
        game.apply(offered[Math.floor(random() * offered.length)].direction, offered);
      }
    }
  return out;
}

describe('level-1 prompts', () => {
  it('are byte-identical to the final level-1 version for every maze cell', () => {
    // Hash computed with the builder from commit ceaf562 over the same inputs.
    const hash = createHash('sha256');
    const random = rng(42);
    const dir = path.resolve(__dirname, '../../mazes');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort()) {
      const maze = new Maze(fs.readFileSync(path.join(dir, file), 'utf-8').split('\n').filter(Boolean));
      for (const [i, cell] of maze.openCells().entries()) {
        const distance = maze.distanceToGoal(cell);
        if (distance === undefined || maze.isGoal(cell)) continue;
        const situation = { distance, mood: (i * 137) % 1001, options: shuffleOptions(optionsAt(maze, cell), random) };
        for (const variant of ['full', 'smell-only'] as const) hash.update(JSON.stringify(buildRequest('qwen3:1.7b', situation, variant)));
      }
    }
    expect(hash.digest('hex')).toBe('4c8e3f1fa9c70c0daeb6cd7401e6523d4219b3251161d9a018bfda605a948301');
  });
});

describe('level-2 prompts', () => {
  it('render exactly, with the cat sensed and not sensed', () => {
    const base: Level2Situation = {
      distance: 4,
      mood: 380,
      sensed: { distance: 2, direction: 'up-right', history: ['left', 'left', 'right'] },
      options: [
        { direction: 'down', level: 'warmer', catDistance: 3 },
        { direction: 'stay', level: 'no change', catDistance: 2 },
        { direction: 'up-right', level: 'much colder', catDistance: 1 },
        { direction: 'right', level: 'warmer', catDistance: 0 },
        { direction: 'left', level: 'colder', catDistance: 4 },
      ],
    };
    const head = `You are a mouse in a maze, looking for the cheese. A cat patrols the maze: it walks in a straight line, one block per move, and turns around when it hits a wall. If the cat catches you, you fail.
Stay away from the cat first: never move next to it. Then follow the smell: always move where the smell grows stronger, and prefer much warmer over warmer.
Being near the cat ruins your mood.

Right now:
The cheese smell is strong.
Your mood is anxious.`;
    expect(buildLevel2Prompt(base, 'cat-facts')).toBe(`${head}
You sense the cat two blocks up-right of you. Its last three moves were left, left, right.

You can go:
DOWN: warmer, the smell grows stronger, three blocks from where the cat is now.
STAY: no change, the smell stays the same, two blocks from where the cat is now.
UP-RIGHT: much colder, the smell grows much weaker, one block from where the cat is now.
RIGHT: warmer, the smell grows stronger, where the cat is now.
LEFT: colder, the smell grows weaker, far from where the cat is now.
Choose one direction.
Return only JSON: {"move":"down|stay|up-right|right|left"}.`);
    expect(buildLevel2Prompt(base, 'cat-history')).toBe(`${head}
You sense the cat two blocks up-right of you. Its last three moves were left, left, right.

You can go:
DOWN: warmer, the smell grows stronger.
STAY: no change, the smell stays the same.
UP-RIGHT: much colder, the smell grows much weaker.
RIGHT: warmer, the smell grows stronger.
LEFT: colder, the smell grows weaker.
Choose one direction.
Return only JSON: {"move":"down|stay|up-right|right|left"}.`);
    const unsensed = { ...base, sensed: null };
    for (const variant of VARIANTS) {
      expect(buildLevel2Prompt(unsensed, variant)).toContain("Your mood is anxious.\nYou can't sense the cat.\n\nYou can go:\nDOWN: warmer, the smell grows stronger.\n");
      expect(buildLevel2Prompt(unsensed, variant)).not.toMatch(/from where the cat is/);
    }
  });

  it('describe the cat history for none, one, two, three and more moves, oldest first', () => {
    expect(catHistorySentence([])).toBe("It hasn't moved yet.");
    expect(catHistorySentence(['left'])).toBe('Its last move was left.');
    expect(catHistorySentence(['up', 'stayed'])).toBe('Its last two moves were up, stayed.');
    expect(catHistorySentence(['left', 'left', 'right'])).toBe('Its last three moves were left, left, right.');
    expect(catHistorySentence(['up', 'up', 'left', 'left', 'right'])).toBe('Its last three moves were left, left, right.');
    expect(catLine({ distance: 1, direction: 'down', history: [] })).toBe("You sense the cat one block down of you. It hasn't moved yet.");
    expect(catLine(null)).toBe("You can't sense the cat.");
  });

  it('contain no digits, never reveal the next move or axis, and limit the answer to the offered options', () => {
    const all = situations();
    expect(all.filter((s) => s.sensed).length).toBeGreaterThan(50);
    expect(all.filter((s) => !s.sensed).length).toBeGreaterThan(50);
    for (const situation of all)
      for (const variant of VARIANTS) {
        const body = buildLevel2Request('qwen3:1.7b', situation, variant) as any;
        const prompt: string = body.messages[0].content;
        expect(prompt).not.toMatch(/\d/);
        expect(prompt).not.toMatch(/horizontal|vertical|next move|will move/i);
        const offered = situation.options.map((o) => o.direction);
        expect(offered).toContain('stay');
        expect(prompt.split('\n').filter((l) => /^[A-Z-]+: /.test(l)).map((l) => l.split(':')[0])).toEqual(offered.map((o) => o.toUpperCase()));
        expect(body.format.properties.move.enum).toEqual(offered);
        expect(body).toMatchObject({ think: false, stream: false, options: { temperature: 0.2 } });
      }
  });

  it('differ between the variants only in the per-option cat parts', () => {
    for (const situation of situations()) {
      const facts = buildLevel2Prompt(situation, 'cat-facts');
      expect(facts.replace(/, (where the cat is now|(one block|two blocks|three blocks|far) from where the cat is now)\./g, '.')).toBe(buildLevel2Prompt(situation, 'cat-history'));
    }
  });

  it('cat-position differs from cat-history only by the history sentence', () => {
    let sensed = 0;
    for (const situation of situations()) {
      const history = buildLevel2Prompt(situation, 'cat-history');
      const position = buildLevel2Prompt(situation, 'cat-position');
      if (!situation.sensed) {
        expect(position).toBe(history);
        continue;
      }
      sensed++;
      expect(position).not.toMatch(/Its last|hasn't moved/);
      expect(history.replace(` ${catHistorySentence(situation.sensed.history)}`, '')).toBe(position);
    }
    expect(sensed).toBeGreaterThan(50);
  });

  const SAFETY_RULE = 'If you sense the cat, safety comes first. If an option says danger, never choose it, even if it is warmer. Follow the smell only among the other options.';
  const OLD_RULE = 'Stay away from the cat first: never move next to it. Then follow the smell: always move where the smell grows stronger, and prefer much warmer over warmer.';
  const DANGER = /^([A-Z-]+: )(danger, next to the cat; |closer to the cat; |further from the cat; )/gm;

  it('cat-rule differs from cat-history only by the rule line', () => {
    for (const situation of situations()) {
      const rule = buildLevel2Prompt(situation, 'cat-rule');
      expect(rule.split('\n')[1]).toBe(SAFETY_RULE);
      expect(rule.replace(SAFETY_RULE, OLD_RULE)).toBe(buildLevel2Prompt(situation, 'cat-history'));
    }
  });

  it('cat-danger differs from cat-rule only by a danger part first in each option, while the cat is sensed', () => {
    let marked = 0;
    for (const situation of [...situations(), ...situations(5)]) {
      const danger = buildLevel2Prompt(situation, 'cat-danger');
      expect(danger.replace(DANGER, '$1')).toBe(buildLevel2Prompt(situation, 'cat-rule'));
      const lines = danger.split('\n').filter((l) => /^[A-Z-]+: /.test(l));
      situation.options.forEach((option, i) => {
        const part = lines[i].match(/^[A-Z-]+: (danger, next to the cat|closer to the cat|further from the cat); /)?.[1] ?? null;
        if (!situation.sensed) return expect(part).toBeNull();
        const expected =
          option.catDistance <= 1 ? 'danger, next to the cat' : option.catDistance < situation.sensed.distance ? 'closer to the cat' : option.catDistance > situation.sensed.distance ? 'further from the cat' : null;
        expect(part).toBe(expected);
        if (part) marked++;
      });
    }
    expect(marked).toBeGreaterThan(100);
  });

  it('renders a cat-danger option exactly', () => {
    const situation: Level2Situation = {
      distance: 8,
      mood: 500,
      sensed: { distance: 2, direction: 'up', history: ['up'] },
      options: [
        { direction: 'up', level: 'warmer', catDistance: 1 },
        { direction: 'down', level: 'colder', catDistance: 3 },
        { direction: 'left', level: 'colder', catDistance: 2 },
        { direction: 'stay', level: 'no change', catDistance: 2 },
      ],
    };
    const lines = buildLevel2Prompt(situation, 'cat-danger').split('\n');
    expect(lines.slice(lines.indexOf('You can go:') + 1, -2)).toEqual([
      'UP: danger, next to the cat; warmer, the smell grows stronger.',
      'DOWN: further from the cat; colder, the smell grows weaker.',
      'LEFT: colder, the smell grows weaker.',
      'STAY: no change, the smell stays the same.',
    ]);
  });

  it('cat-danger-range5 is cat-danger with the cat sensed within five blocks; the prompt text is otherwise the same', () => {
    expect([senseRangeFor('cat-danger'), senseRangeFor('cat-danger-range5'), senseRangeFor('cat-history')]).toEqual([3, 5, 3]);
    let wide = 0;
    for (const situation of situations(5)) {
      expect(buildLevel2Prompt(situation, 'cat-danger-range5')).toBe(buildLevel2Prompt(situation, 'cat-danger'));
      if (situation.sensed && situation.sensed.distance > 3) wide++;
    }
    expect(wide).toBeGreaterThan(10);
    expect(catLine({ distance: 5, direction: 'left', history: [] })).toBe("You sense the cat five blocks left of you. It hasn't moved yet.");
    const game = new Level2Game(OPEN, { position: { x: 5, y: 1 }, direction: 'down' }, 5);
    expect(game.sense()?.distance).toBe(4);
    expect(new Level2Game(OPEN, { position: { x: 5, y: 1 }, direction: 'down' }).sense()).toBeNull();
  });

  const STAY_AWAY_RULE = 'If you sense the cat, stay away from it. Follow the smell, but prefer moves that take you further from the cat.';

  it('cat-filter-range5 differs from cat-danger-range5 only by the rule line and the options it leaves out', () => {
    expect([senseRangeFor('cat-filter-range5'), filtersNearCat('cat-filter-range5'), filtersNearCat('cat-danger-range5')]).toEqual([5, true, false]);
    let filteredSteps = 0;
    const random = rng(7);
    for (const cat of [{ position: { x: 3, y: 2 }, direction: 'left' }, { position: { x: 2, y: 3 }, direction: 'up' }, { position: { x: 5, y: 1 }, direction: 'down' }] as CatState[])
      for (let run = 0; run < 20; run++) {
        const game = new Level2Game(OPEN, cat, 5);
        while (game.status === 'running' && game.steps < 30) {
          const shuffled = shuffleOptions(game.options(), random);
          const { options, removed, trapped: allNear } = filterNearCat(game, shuffled);
          const full = level2Situation(game, shuffled);
          const near = full.options.filter((o) => o.catDistance <= 1);
          // Exactly the options within one block of the cat's current cell go, in the shown order, unless all of them would.
          if (near.length === full.options.length) {
            expect([options, removed, allNear]).toEqual([shuffled, 0, true]);
          } else {
            expect(options).toEqual(shuffled.filter((_, i) => full.options[i].catDistance > 1));
            expect(removed).toBe(near.length);
          }
          if (removed) filteredSteps++;
          const situation = level2Situation(game, options);
          const filter = buildLevel2Prompt(situation, 'cat-filter-range5');
          expect(filter.split('\n')[1]).toBe(STAY_AWAY_RULE);
          expect(filter.replace(STAY_AWAY_RULE, SAFETY_RULE)).toBe(buildLevel2Prompt(situation, 'cat-danger-range5'));
          const request = buildLevel2Request('m', situation, 'cat-filter-range5') as any;
          expect(request.format.properties.move.enum).toEqual(options.map((o) => o.direction));
          expect({ ...request, messages: [] }).toEqual({ ...(buildLevel2Request('m', situation, 'cat-danger-range5') as any), messages: [] });
          if (!allNear) expect(filter).not.toMatch(/danger, next to the cat/);
          game.apply(options[Math.floor(random() * options.length)].direction, options);
        }
      }
    expect(filteredSteps).toBeGreaterThan(20);
    // Cornered: every option is within one block of the cat, so all of them stay, danger labels included.
    const cornered = new Level2Game(OPEN, { position: { x: 2, y: 2 }, direction: 'left' }, 5);
    const all = cornered.options();
    expect(filterNearCat(cornered, all)).toEqual({ options: all, removed: 0, trapped: true });
    const lines = buildLevel2Prompt(level2Situation(cornered, all), 'cat-filter-range5').split('\n');
    expect(lines.filter((l) => /^[A-Z-]+: danger, next to the cat; /.test(l))).toHaveLength(all.length);
  });

  it('cat-filter is cat-filter-range5 with the cat sensed within three blocks; the prompt text is otherwise the same', () => {
    expect([senseRangeFor('cat-filter'), filtersNearCat('cat-filter')]).toEqual([3, true]);
    for (const situation of [...situations(3, true), ...situations(5, true)])
      expect(buildLevel2Prompt(situation, 'cat-filter')).toBe(buildLevel2Prompt(situation, 'cat-filter-range5'));
  });

  it('contain no digits for any variant, including with the wider sensing range', () => {
    for (const situation of [...situations(5), ...situations(5, true)]) for (const variant of VARIANTS) expect(buildLevel2Prompt(situation, variant)).not.toMatch(/\d/);
  });

  it('can switch thinking on for a single request', () => {
    const [situation] = situations();
    expect((buildLevel2Request('m', situation, 'cat-facts', 0.2, true) as any).think).toBe(true);
  });

  it('read stay and directions from answers', () => {
    expect(parseLevel2Answer('{"move":"stay"}')).toBe('stay');
    expect(parseLevel2Answer('{"move":"UP-LEFT"}')).toBe('up-left');
    expect(parseLevel2Answer('{"move":"wait"}')).toBeNull();
    expect(parseLevel2Answer('nope')).toBeNull();
  });
});
