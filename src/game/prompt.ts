import { DIRECTIONS, closenessSentence, moodWord, type Direction, type Level, type Option } from '@/game/game';
import { SENSE_RANGE, WIDE_SENSE_RANGE, type CatMove, type CatSense, type Level2Situation, type Move } from '@/game/level2';
import { seededShuffle } from '@/game/random';

// The one prompt builder, shared by the GUI and the evaluation. No side effects on import.

/** full: smell and mood. smell-only: the same without any mood text. */
export type Variant = 'full' | 'smell-only';

/** What the mouse is told at one step: options already in the order they are shown. */
export type Situation = { distance: number; mood: number; options: Option[] };

const RULES = [
  'You are a mouse in a maze, looking for the cheese.',
  'The cheese is where the smell is strongest. Always move where the smell grows stronger, and prefer much warmer over warmer. Never choose a direction where the smell grows weaker.',
];
const MOOD_RULE = 'Warmer moves lift your mood, colder moves lower it.';

const PHRASES: Record<Level, { smell: string; mood: string }> = {
  'much warmer': { smell: 'grows much stronger', mood: 'rises a lot' },
  warmer: { smell: 'grows stronger', mood: 'rises' },
  'no change': { smell: 'stays the same', mood: 'stays the same' },
  colder: { smell: 'grows weaker', mood: 'drops' },
  'much colder': { smell: 'grows much weaker', mood: 'drops a lot' },
};

export const label = (direction: Move) => direction.toUpperCase();

/** The legal options in a seeded random order, so position in the list carries no hint. */
export const shuffleOptions = <T>(options: T[], random: () => number) => seededShuffle(options, random);

export function buildPrompt(situation: Situation, variant: Variant): string {
  const full = variant === 'full';
  const offered = situation.options.map((option) => option.direction);
  return [
    ...RULES,
    ...(full ? [MOOD_RULE] : []),
    '',
    'Right now:',
    closenessSentence(situation.distance),
    ...(full ? [`Your mood is ${moodWord(situation.mood)}.`] : []),
    '',
    'You can go:',
    ...situation.options.map(
      ({ direction, level }) => `${label(direction)}: ${level}, the smell ${PHRASES[level].smell}${full ? `, your mood ${PHRASES[level].mood}` : ''}.`,
    ),
    'Choose one direction.',
    `Return only JSON: {"move":"${offered.join('|')}"}.`,
  ].join('\n');
}

/** The Ollama /api/chat body (think off, temperature 0.2 unless the GUI setting says otherwise). The JSON schema limits the answer to the offered directions. */
export function buildRequest(model: string, situation: Situation, variant: Variant, temperature = 0.2): Record<string, unknown> {
  return {
    model,
    messages: [{ role: 'user', content: buildPrompt(situation, variant) }],
    stream: false,
    think: false,
    format: {
      type: 'object',
      properties: { move: { type: 'string', enum: situation.options.map((option) => option.direction) } },
      required: ['move'],
    },
    options: { temperature },
  };
}

/** The direction named in a {"move": ...} answer (case-insensitive), or null. Whether it was offered is the game's call. */
export function parseAnswer(text: string): Direction | null {
  try {
    const move = String((JSON.parse(text) as { move?: unknown })?.move ?? '')
      .trim()
      .toLowerCase();
    return (DIRECTIONS as readonly string[]).includes(move) ? (move as Direction) : null;
  } catch {
    return null;
  }
}

// ---------- Level 2: the patrolling cat ----------

/**
 * cat-history: the cat line only. cat-facts: also each option's walking distance to the cat's current cell.
 * cat-position: like cat-history, without the sentence about the cat's recent moves.
 * cat-rule: like cat-history, with a safety-first rule about options marked "danger".
 * cat-danger: cat-rule, plus a danger part first in each option while the cat is sensed.
 * cat-danger-range5: cat-danger with the cat sensed within five blocks instead of three.
 */
export type Level2Variant = 'cat-history' | 'cat-facts' | 'cat-position' | 'cat-rule' | 'cat-danger' | 'cat-danger-range5';

/** How far the mouse senses the cat with this variant. */
export const senseRangeFor = (variant: Level2Variant) => (variant === 'cat-danger-range5' ? WIDE_SENSE_RANGE : SENSE_RANGE);
const hasSafetyRule = (variant: Level2Variant) => variant === 'cat-rule' || variant === 'cat-danger' || variant === 'cat-danger-range5';
const hasDangerParts = (variant: Level2Variant) => variant === 'cat-danger' || variant === 'cat-danger-range5';

const LEVEL2_INTRO =
  'You are a mouse in a maze, looking for the cheese. A cat patrols the maze: it walks in a straight line, one block per move, and turns around when it hits a wall. If the cat catches you, you fail.';
const CAT_RULE =
  'Stay away from the cat first: never move next to it. Then follow the smell: always move where the smell grows stronger, and prefer much warmer over warmer.';
const SAFETY_RULE =
  'If you sense the cat, safety comes first. If an option says danger, never choose it, even if it is warmer. Follow the smell only among the other options.';
const MOOD_NOTE = 'Being near the cat ruins your mood.';
const BLOCKS = ['', 'one block', 'two blocks', 'three blocks', 'four blocks', 'five blocks'];

/** The cat's recent moves, oldest first, in words; "stayed" when it did not move. */
export function catHistorySentence(history: CatMove[]): string {
  const last = history.slice(-3);
  if (!last.length) return "It hasn't moved yet.";
  if (last.length === 1) return `Its last move was ${last[0]}.`;
  return `Its last ${last.length === 2 ? 'two' : 'three'} moves were ${last.join(', ')}.`;
}

export function catLine(sensed: CatSense | null, withHistory = true): string {
  if (!sensed) return "You can't sense the cat.";
  const position = `You sense the cat ${BLOCKS[sensed.distance]} ${sensed.direction} of you.`;
  return withHistory ? `${position} ${catHistorySentence(sensed.history)}` : position;
}

/** cat-danger: what moving there does relative to the cat's current cell; empty when nothing changes. */
function dangerPart(catDistance: number, sensed: CatSense | null, variant: Level2Variant): string {
  if (!hasDangerParts(variant) || !sensed) return '';
  if (catDistance <= 1) return 'danger, next to the cat; ';
  if (catDistance < sensed.distance) return 'closer to the cat; ';
  if (catDistance > sensed.distance) return 'further from the cat; ';
  return '';
}

function catPart(catDistance: number, sensed: boolean, variant: Level2Variant): string {
  if (variant !== 'cat-facts' || !sensed) return '';
  if (catDistance === 0) return ', where the cat is now';
  return `, ${catDistance <= 3 ? BLOCKS[catDistance] : 'far'} from where the cat is now`;
}

export function buildLevel2Prompt(situation: Level2Situation, variant: Level2Variant): string {
  const offered = situation.options.map((option) => option.direction);
  return [
    LEVEL2_INTRO,
    hasSafetyRule(variant) ? SAFETY_RULE : CAT_RULE,
    MOOD_NOTE,
    '',
    'Right now:',
    closenessSentence(situation.distance),
    `Your mood is ${moodWord(situation.mood)}.`,
    catLine(situation.sensed, variant !== 'cat-position'),
    '',
    'You can go:',
    ...situation.options.map(
      ({ direction, level, catDistance }) =>
        `${label(direction)}: ${dangerPart(catDistance, situation.sensed, variant)}${level}, the smell ${PHRASES[level].smell}${catPart(catDistance, Boolean(situation.sensed), variant)}.`,
    ),
    'Choose one direction.',
    `Return only JSON: {"move":"${offered.join('|')}"}.`,
  ].join('\n');
}

/** The level-2 /api/chat body: like level 1, with "stay" in the enum; think is on only when asked for. */
export function buildLevel2Request(
  model: string,
  situation: Level2Situation,
  variant: Level2Variant,
  temperature = 0.2,
  think = false,
): Record<string, unknown> {
  return {
    model,
    messages: [{ role: 'user', content: buildLevel2Prompt(situation, variant) }],
    stream: false,
    think,
    format: {
      type: 'object',
      properties: { move: { type: 'string', enum: situation.options.map((option) => option.direction) } },
      required: ['move'],
    },
    options: { temperature },
  };
}

/** A level-2 answer: a direction or "stay" (case-insensitive), or null. */
export function parseLevel2Answer(text: string): Move | null {
  try {
    const move = String((JSON.parse(text) as { move?: unknown })?.move ?? '')
      .trim()
      .toLowerCase();
    return move === 'stay' ? 'stay' : parseAnswer(text);
  } catch {
    return null;
  }
}
