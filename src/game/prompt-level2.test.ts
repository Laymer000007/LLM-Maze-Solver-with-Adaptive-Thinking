import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { optionsAt } from '@/game/game';
import { Level2Game, level2Situation, type CatState, type Level2Situation } from '@/game/level2';
import { buildLevel2Prompt, buildLevel2Request, buildRequest, catHistorySentence, catLine, parseLevel2Answer, shuffleOptions, type Level2Variant } from '@/game/prompt';
import { rng } from '@/game/random';
import { Maze } from '@/maze/maze';

const VARIANTS: Level2Variant[] = ['cat-history', 'cat-facts', 'cat-position'];
const OPEN = new Maze(['#########', '#S      #', '#       #', '#       #', '#      G#', '#########']);

/** Plays random legal moves and collects every situation, sensed or not. */
function situations(): Level2Situation[] {
  const out: Level2Situation[] = [];
  const random = rng(3);
  for (const cat of [{ position: { x: 3, y: 2 }, direction: 'left' }, { position: { x: 2, y: 3 }, direction: 'up' }, { position: { x: 5, y: 1 }, direction: 'down' }] as CatState[])
    for (let run = 0; run < 20; run++) {
      const game = new Level2Game(OPEN, cat);
      while (game.status === 'running' && game.steps < 30) {
        const offered = shuffleOptions(game.options(), random);
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
