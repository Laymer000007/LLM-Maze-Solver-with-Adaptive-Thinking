import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';

// Must stay the first project import: stops full-maze-eval from running its own main() when imported.
import '@/benchmark/as-library';
import {
  SLEEP_MS,
  TIMEOUT_MS,
  aggregate,
  buildSuiteEntry,
  callLaya,
  callOllama,
  constrainedPrompt,
  layaBody,
  ollamaRequestBody,
  redactSecrets,
  resolveLayaKey,
  runEpisode,
  runSeed,
  runsCsv,
  runsJson,
  seededShuffle,
  scorerOptimal,
  stuckWindowFor,
  type Decision,
  type DecisionState,
  type Policy,
  type PolicyId,
  type RunRecord,
  type SuiteEntry,
  type Transform,
} from '@/benchmark/full-maze-eval';
import { MOVES, type Move } from '@/execution/execution';
import { Maze, type Position } from '@/maze/maze';

// Experiment: "hotter/colder" word prompts vs the numeric constrained payload, for Laya and Ollama. Reuses the
// full-maze-eval run loop, stuck rule and criteria check; production prompts are untouched.

export type Variant = 'numbers-baseline' | 'words-lookahead' | 'words-feedback';
export type Model = 'laya' | 'ollama';
export const VARIANTS: Variant[] = ['numbers-baseline', 'words-lookahead', 'words-feedback'];
export const MODELS: Model[] = ['laya', 'ollama'];
/** A request as sent, minus the auth header. For Ollama the prompt itself is messages[0].content. */
export type CapturedRequest = { endpoint: string; body: Record<string, unknown> };
type Config = { budgetMs: number; seed: number; outputDir: string; layaUrl: string; ollamaUrl: string; ollamaModel: string };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MOVES4 = [...MOVES] as Move[];
const MAZES = ['mazes/7x7_corridor_branch.txt', 'mazes/7x7_open_detour.txt'];
const ORIENTATIONS: Transform[] = ['original', 'rotate-180'];
const INTRO = 'You are a mouse in a dark maze, searching for cheese by smell.';
const LAYA_INSTRUCTIONS = 'Choose exactly one movement direction. Return the direction label.';
const OLLAMA_RETURN = 'Return only JSON: {"move":"up|down|left|right"}.';
export const stepCapFor = (optimalSteps: number) => Math.max(3 * optimalSteps, 60);
const key = (p: Position) => `${p.x},${p.y}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
function nextPosition(p: Position, move: Move): Position {
  return { x: p.x + (move === 'left' ? -1 : move === 'right' ? 1 : 0), y: p.y + (move === 'up' ? -1 : move === 'down' ? 1 : 0) };
}

// ---------- Words ----------

/** distance = 101 − smell (smell is 101 − BFS distance to the goal). */
export function closenessWords(smell: number): string {
  const distance = 101 - smell;
  if (distance <= 2) return 'the cheese smell is overwhelming, it must be right here';
  if (distance <= 5) return 'the smell is strong';
  if (distance <= 10) return 'the smell is noticeable';
  return 'the smell is faint';
}
export function visitWords(visits: number): string {
  return visits === 0 ? "you haven't been there" : visits >= 3 ? "you've been there many times" : "you've been there before";
}
export function smellTrendWords(state: DecisionState, move: Move): string {
  return state.perception.directionSmell[move] > state.perception.smell ? 'the smell grows stronger that way' : 'the smell grows weaker that way';
}
const visitsTo = (state: DecisionState, move: Move) => state.memory.visitCounts[key(nextPosition(state.position, move))] ?? 0;
export function lookaheadLine(state: DecisionState, move: Move): string {
  return `an open passage; ${smellTrendWords(state, move)}; ${visitWords(visitsTo(state, move))}`;
}
export function feedbackLine(state: DecisionState, move: Move): string {
  return `an open passage; ${visitWords(visitsTo(state, move))}`;
}
export type LastStep = { position: Position; smell: number; choice: Move | null; blocked: boolean } | null;
/** How the previous decision went, judged only from the position and smell before and after it. */
export function feedbackWords(state: DecisionState, last: LastStep): string {
  if (!last) return 'You have just started.';
  if (key(last.position) === key(state.position)) return last.choice && last.blocked ? 'You bumped into a wall.' : 'You did not move on your last turn.';
  return state.perception.smell > last.smell ? 'That step took you closer: the smell got stronger.' : 'That step took you further: the smell got weaker.';
}

// ---------- Requests ----------

export function wordRequest(
  model: Model,
  variant: Exclude<Variant, 'numbers-baseline'>,
  state: DecisionState,
  order: Move[],
  feedback: string,
): CapturedRequest['body'] {
  const closeness = `${capitalise(closenessWords(state.perception.smell))}.`;
  const line = variant === 'words-lookahead' ? lookaheadLine : feedbackLine;
  const context = variant === 'words-lookahead' ? [INTRO, closeness] : [INTRO, feedback, closeness];
  if (model === 'laya')
    return {
      state: { body: [...context, 'Choose the direction most likely to lead to the cheese.'].join('\n') },
      questions: {
        move: { type: 'choice', instructions: LAYA_INSTRUCTIONS, criteria: Object.fromEntries(order.map((move) => [move.toUpperCase(), line(state, move)])) },
      },
    };
  const directions = order.map((move) => `${move.toUpperCase()}: ${line(state, move)}.`);
  return { prompt: [...context, 'You can go:', ...directions, 'Choose one direction.', OLLAMA_RETURN].join('\n') };
}

export function createWordPolicy(
  model: Model,
  variant: Variant,
  config: Pick<Config, 'layaUrl' | 'ollamaUrl' | 'ollamaModel'>,
  capture?: (request: CapturedRequest) => void,
): Policy {
  let last: LastStep = null;
  const id = `${model}-${variant}` as PolicyId; // experiment-only ids, outside the harness's PolicyId union
  const decide = async (state: DecisionState, random: () => number): Promise<Decision> => {
    const order = seededShuffle(state.validActions, random);
    const feedback = feedbackWords(state, last);
    let decision: Decision;
    if (model === 'laya') {
      const body = variant === 'numbers-baseline' ? layaBody(state, 'B-constrained', order) : wordRequest('laya', variant, state, order, feedback);
      capture?.({ endpoint: `${config.layaUrl}/v1/systemone`, body });
      decision = { ...(await callLaya(config.layaUrl, body, TIMEOUT_MS)), presented: order };
      if (variant === 'numbers-baseline') decision.criteria = (body as { questions: { move: { criteria: Record<string, string> } } }).questions.move.criteria;
    } else {
      const prompt =
        variant === 'numbers-baseline' ? constrainedPrompt(state, order) : (wordRequest('ollama', variant, state, order, feedback).prompt as string);
      capture?.({ endpoint: `${config.ollamaUrl}/api/chat`, body: ollamaRequestBody(config.ollamaModel, prompt, false) });
      decision = { ...(await callOllama(config.ollamaUrl, config.ollamaModel, prompt, false, TIMEOUT_MS)), presented: order };
    }
    last = {
      position: state.position,
      smell: state.perception.smell,
      choice: decision.choice,
      blocked: decision.choice !== null && state.perception.directions[decision.choice] === 'wall',
    };
    return decision;
  };
  const payload =
    variant === 'numbers-baseline' ? (model === 'laya' ? 'layaBody(B-constrained), shuffled' : 'constrainedPrompt(), shuffled') : `${variant} words`;
  return {
    id,
    kind: model,
    deterministic: true,
    config: {
      payloadBuilder: payload,
      endpoint: model === 'laya' ? `${config.layaUrl}/v1/systemone` : `${config.ollamaUrl}/api/chat`,
      model: model === 'laya' ? null : config.ollamaModel,
      think: model === 'laya' ? null : false,
      temperature: model === 'laya' ? null : 0.2,
      format: model === 'laya' ? 'systemone choice question' : 'json',
      optionOrdering: 'legal moves, seeded shuffle per request',
      sees:
        variant === 'numbers-baseline'
          ? 'scores, visits, smell (numbers)'
          : variant === 'words-lookahead'
            ? 'per-direction smell trend (words), visits (words)'
            : 'last-step smell feedback (words), visits (words)',
    },
    decide,
  };
}
function baselinePolicy(id: 'scorer' | 'random-legal'): Policy {
  const choose = <T>(random: () => number, values: T[]) => values[Math.floor(random() * values.length) % values.length];
  return {
    id,
    kind: 'baseline',
    deterministic: true,
    config: {
      payloadBuilder: 'none',
      endpoint: null,
      model: null,
      think: null,
      temperature: null,
      format: null,
      optionOrdering: 'n/a',
      sees: id === 'scorer' ? 'scores' : 'walls only',
    },
    decide: async (state, random) => ({
      choice: choose(random, id === 'scorer' ? scorerOptimal(state) : state.validActions.length ? state.validActions : MOVES4),
      latencyMs: null,
    }),
  };
}

// ---------- Metrics ----------

/** Replays a run's moves and returns the share of chosen moves (walls included) whose target cell smells stronger. */
export function towardStrongerSmell(entry: SuiteEntry, moves: string[]): { toward: number; chosen: number } {
  const maze = new Maze(entry.layout);
  let position = { ...maze.startPosition };
  let toward = 0;
  let chosen = 0;
  for (const step of moves) {
    if (step.startsWith('!')) continue;
    const move = step.replace('#wall', '') as Move;
    const target = nextPosition(position, move);
    chosen++;
    if (maze.isWalkable(target) && maze.smellAt(target) > maze.smellAt(position)) toward++;
    if (!step.endsWith('#wall')) position = target;
  }
  return { toward, chosen };
}

// ---------- Report ----------

const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
function report(
  meta: Record<string, any>,
  entries: SuiteEntry[],
  policies: Policy[],
  runs: RunRecord[],
  skipped: string[],
  examples: Map<string, CapturedRequest>,
): string {
  const byId = (id: string) => runs.filter((run) => run.policy === id);
  const lines = [
    '# Word prompts vs numbers: Laya and Ollama',
    '',
    `- Timestamp: ${meta.timestamp} · commit ${meta.gitCommit}${meta.gitDirty ? ' (dirty)' : ''} · seed ${meta.seed}`,
    `- Entries: ${entries.map((e) => `${e.id} (optimal ${e.optimalSteps})`).join(', ')}`,
    `- Step cap max(3 × optimal, 60); stuck when no new cell for max(50, 2 × optimal) steps; ${TIMEOUT_MS / 1000} s timeout; abort after 3 failed requests in a row; ${SLEEP_MS} ms between requests`,
    `- Option order shuffled per request with a seeded RNG for every model variant. Ollama ${meta.ollamaModel}, think=false, temperature 0.2. Laya ${meta.layaUrl}.`,
    `- Time budget ${meta.budgetMin} min; used ${seconds(meta.elapsedMs)}. ${skipped.length ? `Not run (budget reached): ${skipped.join(', ')}.` : 'Every planned run finished.'}`,
    '- Smell = 101 − BFS distance to the goal, so "stronger that way" is the shortest-path direction. "Toward stronger smell" = chosen moves whose target cell smells stronger than the current one, walls counted as not toward.',
    '',
    '## Results',
    '',
    '| Policy | Completed | Steps / optimal (completed) | Stuck | Step-cap | Aborted | Wall choices | Toward stronger smell | Mean latency |',
    '|---|---:|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const policy of policies) {
    const group = byId(policy.id);
    if (!group.length) continue;
    const a = aggregate(group);
    const smell = group
      .map((run) => towardStrongerSmell(entries.find((e) => e.id === run.mazeId)!, run.moves))
      .reduce((t, x) => ({ toward: t.toward + x.toward, chosen: t.chosen + x.chosen }), { toward: 0, chosen: 0 });
    const done = group.filter((run) => run.completed);
    const stepsCell = done.length ? done.map((run) => `${run.steps}/${run.optimalSteps}`).join(', ') : '—';
    const walls = group.reduce((t, run) => t + run.illegalMoves, 0);
    const steps = group.reduce((t, run) => t + run.steps, 0);
    lines.push(
      `| ${policy.id} | ${a.completed}/${a.runs} | ${stepsCell} | ${a.stuck} | ${a.stepCapped} | ${a.aborted} | ${walls}/${steps} (${pct(steps ? walls / steps : 0)}) | ${smell.chosen ? pct(smell.toward / smell.chosen) : 'n/a'} | ${a.meanLatencyMs === null ? '—' : `${Math.round(a.meanLatencyMs)} ms`} |`,
    );
  }
  lines.push('', '## Per entry', '', `| Policy | ${entries.map((e) => e.id).join(' | ')} |`, `|---|${entries.map(() => '---').join('|')}|`);
  for (const policy of policies) {
    if (!byId(policy.id).length) continue;
    lines.push(
      `| ${policy.id} | ${entries
        .map((e) => {
          const run = byId(policy.id).find((r) => r.mazeId === e.id);
          return run ? `${run.status} ${run.steps}` : 'not run';
        })
        .join(' | ')} |`,
    );
  }
  const mismatches = runs.reduce((t, run) => t + run.criteriaMismatches, 0);
  const checked = runs.reduce((t, run) => t + run.criteriaChecked, 0);
  lines.push(
    '',
    `Criteria check on the numeric Laya baseline: ${checked} criteria, ${mismatches} mismatches.`,
    '',
    '## Example requests',
    '',
    "The second request of each policy's first run (so the feedback variant shows a step result), exactly as sent. The Laya API key travels only in the Authorization header, which is not shown.",
    '',
  );
  for (const policy of policies) {
    const example = examples.get(policy.id);
    if (!example) continue;
    lines.push(`### ${policy.id}`, '', `POST ${example.endpoint}`, '', '```json', JSON.stringify(example.body, null, 2), '```', '');
    const prompt = (example.body.messages as { content: string }[] | undefined)?.[0]?.content;
    if (prompt) lines.push('Prompt text as the model reads it:', '', '```text', prompt, '```', '');
  }
  return redactSecrets(lines.join('\n') + '\n');
}

// ---------- CLI ----------

class BudgetReached extends Error {}
function git(command: string): string {
  try {
    return execSync(command, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}
function parseArgs(argv: string[]): Config {
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const budgetMin = Number(get('--time-budget-min') ?? '15');
  if (!(budgetMin > 0)) throw new Error('--time-budget-min must be a positive number.');
  return {
    budgetMs: budgetMin * 60_000,
    seed: Number(get('--seed') ?? '20261023'),
    outputDir: path.resolve(get('--output-dir') ?? path.join(ROOT, 'benchmark-results', 'word-prompts')),
    layaUrl: process.env.LAYA_URL ?? 'http://192.168.88.100:8000',
    ollamaUrl: process.env.OLLAMA_URL ?? 'http://192.168.88.100:11434',
    ollamaModel: process.env.OLLAMA_MODEL ?? 'qwen3:1.7b',
  };
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  if (!resolveLayaKey()) throw new Error('No Laya key: set LAYA_API_KEY or LAYA_API_KEY_FILE (default ~/.config/laya/api_key).');
  const started = performance.now();
  const overBudget = () => performance.now() - started > config.budgetMs;
  const entries: SuiteEntry[] = [];
  for (const file of MAZES) {
    const maze = await Maze.fromFile(path.join(ROOT, file));
    for (const transform of ORIENTATIONS) entries.push(buildSuiteEntry(maze.layout, file, transform));
  }
  const modelPolicies = MODELS.flatMap((model) => VARIANTS.map((variant) => ({ model, variant })));
  const policyIds = ['scorer', 'random-legal', ...modelPolicies.map((p) => `${p.model}-${p.variant}`)];
  const minRequests = modelPolicies.length * entries.reduce((t, e) => t + e.optimalSteps, 0);
  const maxRequests = modelPolicies.length * entries.reduce((t, e) => t + stepCapFor(e.optimalSteps), 0);
  // Smoke latencies: Laya ~0.35–0.45 s, Ollama ~0.5–0.65 s per request.
  const maxMinutes = (entries.reduce((t, e) => t + stepCapFor(e.optimalSteps), 0) * VARIANTS.length * (0.45 + 0.65 + (2 * SLEEP_MS) / 1000)) / 60;
  console.log(
    `Plan: ${entries.length} entries × ${policyIds.length} policies = ${entries.length * policyIds.length} runs. Model requests: ${minRequests} minimum (all optimal) to ${maxRequests} maximum (all hit the cap), about ${maxMinutes.toFixed(1)} min at the cap. Budget ${config.budgetMs / 60_000} min.`,
  );
  const timestamp = new Date().toISOString();
  const runDir = path.join(config.outputDir, timestamp.replace(/[:.]/g, '-'));
  await fs.mkdir(runDir, { recursive: true });
  for (const [label, call] of [
    [
      'laya',
      () =>
        callLaya(
          config.layaUrl,
          {
            state: { body: INTRO },
            questions: { move: { type: 'choice', instructions: LAYA_INSTRUCTIONS, criteria: { UP: 'an open passage', DOWN: 'an open passage' } } },
          },
          TIMEOUT_MS,
        ),
    ],
    ['ollama', () => callOllama(config.ollamaUrl, config.ollamaModel, `${INTRO}\n${OLLAMA_RETURN}`, false, TIMEOUT_MS)],
  ] as const) {
    const r = await call();
    console.log(`warm-up ${label}: ${r.failure ?? r.choice} ${Math.round(r.latencyMs ?? 0)} ms`);
    if (r.failure === 'http') throw new Error(`${label} warm-up failed: ${r.error}`);
  }
  const runs: RunRecord[] = [];
  const skipped: string[] = [];
  const examples = new Map<string, CapturedRequest>();
  const policiesForReport: Policy[] = [
    baselinePolicy('scorer'),
    baselinePolicy('random-legal'),
    ...modelPolicies.map((p) => createWordPolicy(p.model, p.variant, config)),
  ];
  for (const entry of entries) {
    for (const id of policyIds) {
      const label = `${entry.id}/${id}`;
      if (overBudget()) {
        skipped.push(label);
        continue;
      }
      const spec = modelPolicies.find((p) => `${p.model}-${p.variant}` === id);
      let count = 0;
      const policy = spec
        ? createWordPolicy(spec.model, spec.variant, config, (request) => {
            if (++count === 2 && !examples.has(id)) examples.set(id, request);
          })
        : baselinePolicy(id as 'scorer' | 'random-legal');
      const guarded: Policy = {
        ...policy,
        decide: async (state, random) => {
          if (overBudget()) throw new BudgetReached();
          return policy.decide(state, random);
        },
      };
      try {
        const run = await runEpisode(entry, guarded, config.seed, {
          stepCap: stepCapFor(entry.optimalSteps),
          stuckWindow: stuckWindowFor(entry.optimalSteps),
          rngSeed: runSeed(config.seed, entry.id, id),
        });
        runs.push(run);
        await fs.appendFile(path.join(runDir, 'runs.jsonl'), redactSecrets(JSON.stringify(run)) + '\n');
        console.log(
          `${label} → ${run.status} in ${run.steps}/${run.stepCap} (optimal ${run.optimalSteps}), walls ${run.illegalMoves}, ${seconds(run.wallClockMs)} · elapsed ${seconds(performance.now() - started)}`,
        );
      } catch (error) {
        if (!(error instanceof BudgetReached)) throw error;
        skipped.push(`${label} (stopped mid-run)`);
        console.log(`${label} → stopped: time budget reached`);
      }
      if (spec) await sleep(SLEEP_MS);
    }
  }
  const meta = {
    timestamp,
    gitCommit: git('git rev-parse HEAD'),
    gitDirty: git('git status --porcelain') !== '',
    seed: config.seed,
    budgetMin: config.budgetMs / 60_000,
    elapsedMs: Math.round(performance.now() - started),
    layaUrl: `${config.layaUrl}/v1/systemone`,
    ollamaModel: config.ollamaModel,
    ollamaUrl: config.ollamaUrl,
    entries: entries.map((e) => e.id),
    policies: policiesForReport.map((p) => ({ id: p.id, ...p.config })),
    stepCapRule: 'max(3 * optimalSteps, 60)',
    stuckRule: 'max(50, 2 * optimalSteps)',
    plannedRequests: { min: minRequests, max: maxRequests },
    skipped,
  };
  await fs.writeFile(path.join(runDir, 'runs.json'), runsJson(meta, runs));
  await fs.writeFile(path.join(runDir, 'runs.csv'), runsCsv(runs));
  await fs.writeFile(path.join(runDir, 'examples.json'), redactSecrets(JSON.stringify(Object.fromEntries(examples), null, 2)));
  await fs.writeFile(path.join(runDir, 'report.md'), report(meta, entries, policiesForReport, runs, skipped, examples));
  console.log(`Done in ${seconds(performance.now() - started)}. Report: ${path.join(runDir, 'report.md')}`);
}
if (!process.env.VITEST)
  main().catch((error) => {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
