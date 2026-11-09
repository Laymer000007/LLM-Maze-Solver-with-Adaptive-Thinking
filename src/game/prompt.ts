import { DIRECTIONS, closenessSentence, moodWord, type Direction, type Level, type Option } from '@/game/game';
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

export const label = (direction: Direction) => direction.toUpperCase();

/** The legal options in a seeded random order, so position in the list carries no hint. */
export const shuffleOptions = (options: Option[], random: () => number) => seededShuffle(options, random);

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
