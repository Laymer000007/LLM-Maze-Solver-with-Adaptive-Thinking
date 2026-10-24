import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';

// Must stay the first project imports: they stop the imported experiment modules from running their own main().
import '@/benchmark/as-library';
import '@/benchmark/word-prompts-as-library';
import {
  SLEEP_MS,
  TIMEOUT_MS,
  aggregate,
  buildSuiteEntry,
  callLaya,
  callOllama,
  ollamaRequestBody,
  redactSecrets,
  resolveLayaKey,
  rng,
  runEpisode,
  runSeed,
  runsJson,
  seededShuffle,
  stuckWindowFor,
  type Decision,
  type DecisionState,
  type Policy,
  type PolicyId,
  type RunRecord,
  type SuiteEntry,
} from '@/benchmark/full-maze-eval';
import {
  INTRO,
  LAYA_INSTRUCTIONS,
  MAZES,
  OLLAMA_RETURN,
  ORIENTATIONS,
  capitalise,
  closenessWords,
  lookaheadLine,
  stepCapFor,
  towardStrongerSmell,
  wordRequest,
  type CapturedRequest,
  type Model,
} from '@/benchmark/word-prompts';
import type { Move } from '@/execution/execution';
import { Maze } from '@/maze/maze';

// Prompt-tuning round: single-step "toward stronger smell" on the 100 frozen states, then the best variant per model
// through the 4 maze entries of the word-prompt experiment. Words only; production prompts are untouched.

export type TuningVariant = 'lookahead' | 'lookahead-rule' | 'warmer-only' | 'smell-only';
/** Variants of the main tuning round; smell-only is used only by --mode ablation. */
export const TUNING_VARIANTS: TuningVariant[] = ['lookahead', 'lookahead-rule', 'warmer-only'];
export const ABLATION_VARIANTS: TuningVariant[] = ['warmer-only', 'smell-only'];
export const RULE =
  'The cheese is where the smell is strongest. Always move in a direction where the smell grows stronger. Never choose a direction where it grows weaker.';
export type Arm = { model: Model; variant: TuningVariant; think: boolean };
type Config = { budgetMs: number; seed: number; outputDir: string; layaUrl: string; ollamaUrl: string; ollamaModel: string };
type Row = { arm: string; stateId: string; choice: Move | null; legal: boolean; toward: boolean; latencyMs: number; failure: string | null; order: Move[] };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const THINK_CAP = 50;
const THINK_PROBE = 10;
const MAZE_RESERVE_MS = 4 * 60_000;
export const armId = (arm: Arm) => `${arm.model}-${arm.variant}${arm.think ? '-think' : ''}`;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
class BudgetReached extends Error {}

export function warmerLine(state: DecisionState, move: Move): string {
  return state.perception.directionSmell[move] > state.perception.smell ? 'warmer, the smell grows stronger' : 'colder, the smell grows weaker';
}
/** warmerLine() without the "warmer, " / "colder, " prefix. */
export function smellOnlyLine(state: DecisionState, move: Move): string {
  return state.perception.directionSmell[move] > state.perception.smell ? 'the smell grows stronger' : 'the smell grows weaker';
}
/** Legal directions whose neighbour cell smells stronger than the current one. */
export function strongerMoves(state: DecisionState): Move[] {
  return state.validActions.filter((move) => state.perception.directionSmell[move] > state.perception.smell);
}

/** The request body for an arm, before the Ollama envelope; for Ollama it is { prompt }. */
export function tunedRequest(model: Model, variant: TuningVariant, state: DecisionState, order: Move[]): Record<string, unknown> {
  if (variant === 'lookahead') return wordRequest(model, 'words-lookahead', state, order, '');
  const line = variant === 'lookahead-rule' ? lookaheadLine : variant === 'smell-only' ? smellOnlyLine : warmerLine;
  const closeness = `${capitalise(closenessWords(state.perception.smell))}.`;
  if (model === 'laya')
    return {
      state: { body: [INTRO, closeness, RULE, 'Choose the direction most likely to lead to the cheese.'].join('\n') },
      questions: {
        move: {
          type: 'choice',
          instructions: `${RULE} ${LAYA_INSTRUCTIONS}`,
          criteria: Object.fromEntries(order.map((move) => [move.toUpperCase(), line(state, move)])),
        },
      },
    };
  return {
    prompt: [
      INTRO,
      closeness,
      RULE,
      'You can go:',
      ...order.map((move) => `${move.toUpperCase()}: ${line(state, move)}.`),
      'Choose one direction.',
      OLLAMA_RETURN,
    ].join('\n'),
  };
}
/** What is actually sent: the Laya body, or the full Ollama /api/chat body. */
export function armRequest(arm: Arm, state: DecisionState, order: Move[], ollamaModel: string): CapturedRequest['body'] {
  const body = tunedRequest(arm.model, arm.variant, state, order);
  return arm.model === 'laya' ? body : ollamaRequestBody(ollamaModel, body.prompt as string, arm.think);
}
async function ask(arm: Arm, state: DecisionState, order: Move[], config: Config): Promise<Decision> {
  const body = tunedRequest(arm.model, arm.variant, state, order);
  return arm.model === 'laya'
    ? callLaya(config.layaUrl, body, TIMEOUT_MS)
    : callOllama(config.ollamaUrl, config.ollamaModel, body.prompt as string, arm.think, TIMEOUT_MS);
}

export function summarise(rows: Row[]) {
  const answered = rows.length;
  const latencies = rows.map((r) => r.latencyMs);
  return {
    states: answered,
    towardRate: answered ? rows.filter((r) => r.toward).length / answered : 0,
    legalRate: answered ? rows.filter((r) => r.legal).length / answered : 0,
    failures: rows.filter((r) => r.failure).length,
    meanLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
  };
}
/** Best = highest toward-stronger rate, then legal rate, then lower latency. */
export function bestArm<T extends { towardRate: number; legalRate: number; meanLatencyMs: number }>(candidates: [string, T][]): string {
  return [...candidates].sort(([, a], [, b]) => b.towardRate - a.towardRate || b.legalRate - a.legalRate || a.meanLatencyMs - b.meanLatencyMs)[0][0];
}

function git(command: string): string {
  try {
    return execSync(command, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

/** Reads the previous main tuning round's rows, to check warmer-only reproduces. */
async function previousTuningRows(outputDir: string): Promise<{ dir: string; rows: Row[] } | null> {
  const dirs = (await fs.readdir(outputDir).catch(() => [] as string[])).filter((d) => !d.endsWith('-ablation')).sort();
  for (const dir of dirs.reverse()) {
    const file = path.join(outputDir, dir, 'results.json');
    const body = await fs.readFile(file, 'utf-8').catch(() => null);
    if (body) return { dir: path.relative(ROOT, path.join(outputDir, dir)), rows: JSON.parse(body).rows as Row[] };
  }
  return null;
}

async function writeAblationReport(
  runDir: string,
  config: Config,
  timestamp: string,
  states: (DecisionState & { id: string })[],
  rows: Row[],
  examples: Map<string, CapturedRequest>,
  notes: string[],
  elapsedMs: number,
): Promise<void> {
  const previous = await previousTuningRows(config.outputDir);
  const byId = new Map(states.map((s) => [s.id, s]));
  const lines = [
    '# Ablation: warmer-only vs smell-only',
    '',
    `- Timestamp: ${timestamp} · commit ${git('git rev-parse HEAD')}${git('git status --porcelain') ? ' (dirty)' : ''} · seed ${config.seed}`,
    `- Single step on the ${states.length} frozen states, 1 request per state per arm. Ollama ${config.ollamaModel}, think:false, temperature 0.2.`,
    '- The two arms\' requests differ only in the option text: smell-only drops the "warmer, " / "colder, " prefix. Intro, closeness sentence, rule, instructions and option order are byte-identical; the order uses warmer-only\'s shuffle seed from the last round, so warmer-only\'s requests are also byte-identical to that round\'s.',
    `- Time budget ${config.budgetMs / 60_000} min; used ${seconds(elapsedMs)}.`,
    ...notes.map((n) => `- ${n}`),
    '',
  ];
  for (const model of ['laya', 'ollama'] as Model[]) {
    const ids = ABLATION_VARIANTS.map((variant) => armId({ model, variant, think: false }));
    lines.push(
      `## ${model === 'laya' ? 'Laya' : `Ollama ${config.ollamaModel}`}`,
      '',
      '| Arm | States | Toward stronger | Legal | Failed | Mean latency |',
      '|---|---:|---:|---:|---:|---:|',
    );
    for (const id of ids) {
      const s = summarise(rows.filter((r) => r.arm === id));
      lines.push(
        `| ${id.replace(`${model}-`, '')} | ${s.states} | ${pct(s.towardRate)} | ${pct(s.legalRate)} | ${s.failures} | ${Math.round(s.meanLatencyMs)} ms |`,
      );
    }
    const [warmer, smell] = ids.map((id) => new Map(rows.filter((r) => r.arm === id).map((r) => [r.stateId, r])));
    const differ = [...warmer.values()].filter((w) => smell.has(w.stateId) && smell.get(w.stateId)!.choice !== w.choice);
    const prev = previous?.rows.filter((r) => r.arm === ids[0]) ?? [];
    if (prev.length) {
      const same = prev.filter((p) => warmer.get(p.stateId)?.choice === p.choice).length;
      lines.push('', `warmer-only reproduction against \`${previous!.dir}\`: ${same}/${prev.length} identical choices.`);
    }
    lines.push('', `### States where the two arms chose differently: ${differ.length}`, '');
    if (differ.length) {
      lines.push('| State | Options (order shown) | Stronger | warmer-only | smell-only |', '|---|---|---|---|---|');
      for (const w of differ) {
        const mark = (choice: Move | null) =>
          choice === null
            ? `failed (${w.failure ?? smell.get(w.stateId)!.failure})`
            : `${choice}${strongerMoves(byId.get(w.stateId)!).includes(choice) ? ' ✓' : ' ✗'}`;
        lines.push(
          `| ${w.stateId} | ${w.order.join(', ')} | ${strongerMoves(byId.get(w.stateId)!).join(', ')} | ${mark(w.choice)} | ${mark(smell.get(w.stateId)!.choice)} |`,
        );
      }
      lines.push('', '✓ = a direction where the smell grows stronger.');
    }
    lines.push('');
  }
  lines.push(
    '## Example requests',
    '',
    "Each arm's first request (frozen state `state-001`), exactly as sent. The Laya key travels only in the Authorization header.",
    '',
  );
  for (const [id, example] of examples) {
    lines.push(`### ${id}`, '', `POST ${example.endpoint}`, '', '```json', JSON.stringify(example.body, null, 2), '```', '');
    const prompt = (example.body.messages as { content: string }[] | undefined)?.[0]?.content;
    if (prompt) lines.push('Prompt text as the model reads it:', '', '```text', prompt, '```', '');
  }
  await fs.writeFile(
    path.join(runDir, 'results.json'),
    redactSecrets(JSON.stringify({ timestamp, seed: config.seed, mode: 'ablation', notes, rows }, null, 2)),
  );
  await fs.writeFile(path.join(runDir, 'examples.json'), redactSecrets(JSON.stringify(Object.fromEntries(examples), null, 2)));
  await fs.writeFile(path.join(runDir, 'report.md'), redactSecrets(lines.join('\n') + '\n'));
  console.log(`Done in ${seconds(elapsedMs)}. Report: ${path.join(runDir, 'report.md')}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const config: Config = {
    budgetMs: Number(get('--time-budget-min') ?? '15') * 60_000,
    seed: Number(get('--seed') ?? '20261023'),
    outputDir: path.resolve(get('--output-dir') ?? path.join(ROOT, 'benchmark-results', 'word-prompts-tuning')),
    layaUrl: process.env.LAYA_URL ?? 'http://192.168.88.100:8000',
    ollamaUrl: process.env.OLLAMA_URL ?? 'http://192.168.88.100:11434',
    ollamaModel: process.env.OLLAMA_MODEL ?? 'qwen3:1.7b',
  };
  if (!(config.budgetMs > 0)) throw new Error('--time-budget-min must be a positive number.');
  const mode = get('--mode') ?? 'tuning';
  if (!['tuning', 'ablation'].includes(mode)) throw new Error(`Unknown --mode ${mode}; use tuning or ablation.`);
  const ablation = mode === 'ablation';
  if (!resolveLayaKey()) throw new Error('No Laya key: set LAYA_API_KEY or LAYA_API_KEY_FILE (default ~/.config/laya/api_key).');
  const started = performance.now();
  const remaining = () => config.budgetMs - (performance.now() - started);
  const guard = () => {
    if (remaining() <= 0) throw new BudgetReached();
  };
  const { states } = JSON.parse(await fs.readFile(path.join(ROOT, 'benchmark-results', 'frozen-dataset.json'), 'utf-8')) as {
    states: (DecisionState & { id: string })[];
  };
  const arms: Arm[] = (['laya', 'ollama'] as Model[]).flatMap((model) =>
    (ablation ? ABLATION_VARIANTS : TUNING_VARIANTS).map((variant) => ({ model, variant, think: false })),
  );
  if (ablation)
    console.log(
      `Plan, budget ${config.budgetMs / 60_000} min: ${arms.length} arms × ${states.length} frozen states = ${arms.length * states.length} requests (~${seconds(states.length * 2 * (333 + 523 + 2 * SLEEP_MS))} at the last run's warmer-only latencies). No maze runs.`,
    );
  else
    console.log(
      `Plan, budget ${config.budgetMs / 60_000} min:\n` +
        `  1. ${arms.length} arms × ${states.length} frozen states = ${arms.length * states.length} requests (~${seconds(states.length * 3 * (270 + 460 + 2 * SLEEP_MS))} at the last run's latencies)\n` +
        `  2. best Ollama arm with think:true: ${THINK_CAP}–${states.length} requests (capped at ${THINK_CAP} if ${THINK_PROBE} probe requests project past the budget minus ${MAZE_RESERVE_MS / 60_000} min)\n` +
        `  3. best arm per model on 4 maze entries: at most ${2 * 4 * 60} requests; stops cleanly when the budget runs out`,
    );
  const timestamp = new Date().toISOString();
  const runDir = path.join(config.outputDir, `${timestamp.replace(/[:.]/g, '-')}${ablation ? '-ablation' : ''}`);
  await fs.mkdir(runDir, { recursive: true });
  const rows: Row[] = [];
  const examples = new Map<string, CapturedRequest>();
  const notes: string[] = [];
  // orderArm: whose shuffle seed to use; the ablation shares warmer-only's so both arms see the same order.
  const runArm = async (arm: Arm, subset: typeof states, orderArm: Arm = arm) => {
    const id = armId(arm);
    for (const state of subset) {
      guard();
      const order = seededShuffle(state.validActions, rng(runSeed(config.seed, state.id, armId(orderArm))));
      if (!examples.has(id))
        examples.set(id, {
          endpoint: arm.model === 'laya' ? `${config.layaUrl}/v1/systemone` : `${config.ollamaUrl}/api/chat`,
          body: armRequest(arm, state, order, config.ollamaModel),
        });
      const decision = await ask(arm, state, order, config);
      rows.push({
        arm: id,
        stateId: state.id,
        choice: decision.choice,
        legal: decision.choice !== null && state.validActions.includes(decision.choice),
        toward: decision.choice !== null && strongerMoves(state).includes(decision.choice),
        latencyMs: Math.round(decision.latencyMs ?? 0),
        failure: decision.failure ?? null,
        order,
      });
      await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
    }
    const s = summarise(rows.filter((r) => r.arm === id));
    console.log(
      `${id}: toward ${pct(s.towardRate)}, legal ${pct(s.legalRate)}, ${s.failures} failed, ${Math.round(s.meanLatencyMs)} ms · elapsed ${seconds(performance.now() - started)}`,
    );
  };
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
  if (ablation) {
    try {
      for (const arm of arms) await runArm(arm, states, { ...arm, variant: 'warmer-only' });
    } catch (error) {
      if (!(error instanceof BudgetReached)) throw error;
      notes.push(`Time budget reached after ${seconds(performance.now() - started)}; the report covers what finished.`);
    }
    await writeAblationReport(runDir, config, timestamp, states, rows, examples, notes, performance.now() - started);
    return;
  }
  const entries: SuiteEntry[] = [];
  for (const file of MAZES) {
    const maze = await Maze.fromFile(path.join(ROOT, file));
    for (const transform of ORIENTATIONS) entries.push(buildSuiteEntry(maze.layout, file, transform));
  }
  const mazeRuns: RunRecord[] = [];
  let bestByModel: Record<Model, string> | null = null;
  try {
    for (const arm of arms) await runArm(arm, states);
    const summaries = (ids: string[]) => ids.map((id) => [id, summarise(rows.filter((r) => r.arm === id))] as [string, ReturnType<typeof summarise>]);
    const bestOllama = arms.find((arm) => armId(arm) === bestArm(summaries(arms.filter((a) => a.model === 'ollama').map(armId))))!;
    const thinkArm: Arm = { ...bestOllama, think: true };
    await runArm(thinkArm, states.slice(0, THINK_PROBE));
    const probe = summarise(rows.filter((r) => r.arm === armId(thinkArm)));
    const projected = probe.meanLatencyMs * (states.length - THINK_PROBE);
    const thinkStates = projected > remaining() - MAZE_RESERVE_MS ? THINK_CAP : states.length;
    notes.push(
      `Think arm: ${THINK_PROBE} probe requests averaged ${Math.round(probe.meanLatencyMs)} ms, projecting ${seconds(projected)} for all ${states.length} states; ${thinkStates === THINK_CAP ? `capped at ${THINK_CAP} states` : 'ran all states'}.`,
    );
    await runArm(thinkArm, states.slice(THINK_PROBE, thinkStates));
    const allArms = [...arms, thinkArm];
    // The think arm saw only its subset; compare it with the others on the same states.
    const thinkIds = new Set(rows.filter((r) => r.arm === armId(thinkArm)).map((r) => r.stateId));
    const onThinkStates = (id: string) => summarise(rows.filter((r) => r.arm === id && thinkIds.has(r.stateId)));
    bestByModel = {
      laya: bestArm(summaries(arms.filter((a) => a.model === 'laya').map(armId))),
      ollama: bestArm([armId(bestOllama), armId(thinkArm)].map((id) => [id, onThinkStates(id)] as [string, ReturnType<typeof summarise>])),
    };
    notes.push(
      `Best per model: Laya ${bestByModel.laya}; Ollama ${bestByModel.ollama} (think compared with ${armId(bestOllama)} on the same ${thinkIds.size} states).`,
    );
    console.log(notes.join('\n'));
    for (const entry of entries)
      for (const id of [bestByModel.laya, bestByModel.ollama]) {
        const arm = allArms.find((a) => armId(a) === id)!;
        const policy: Policy = {
          id: id as PolicyId, // experiment-only id
          kind: arm.model,
          deterministic: true,
          config: {
            payloadBuilder: id,
            endpoint: null,
            model: null,
            think: arm.think,
            temperature: null,
            format: null,
            optionOrdering: 'seeded shuffle',
            sees: 'smell trend in words',
          },
          decide: async (state, random) => {
            guard();
            const order = seededShuffle(state.validActions, random);
            return { ...(await ask(arm, state, order, config)), presented: order };
          },
        };
        const run = await runEpisode(entry, policy, config.seed, {
          stepCap: stepCapFor(entry.optimalSteps),
          stuckWindow: stuckWindowFor(entry.optimalSteps),
          rngSeed: runSeed(config.seed, entry.id, id),
        });
        mazeRuns.push(run);
        console.log(
          `${entry.id}/${id} → ${run.status} in ${run.steps}/${run.stepCap}, walls ${run.illegalMoves}, ${seconds(run.wallClockMs)} · elapsed ${seconds(performance.now() - started)}`,
        );
      }
  } catch (error) {
    if (!(error instanceof BudgetReached)) throw error;
    notes.push(`Time budget reached after ${seconds(performance.now() - started)}; the report covers what finished.`);
    console.log(notes.at(-1));
  }

  // ---------- Report ----------
  const ids = [...new Set(rows.map((r) => r.arm))];
  const lines = [
    '# Word-prompt tuning: toward stronger smell',
    '',
    `- Timestamp: ${timestamp} · commit ${git('git rev-parse HEAD')}${git('git status --porcelain') ? ' (dirty)' : ''} · seed ${config.seed}`,
    `- Single step on the ${states.length} states of \`benchmark-results/frozen-dataset.json\`, 1 request per state. Toward stronger = the chosen direction's neighbour smells stronger than the current cell (any such direction counts). Option order shuffled per request with a seeded RNG. No digits in any request; Ollama ${config.ollamaModel}, temperature 0.2.`,
    `- Smell = 101 − BFS distance to the goal, so "stronger that way" is a shortest-path direction. Every frozen state has at least one: ${states.every((s) => strongerMoves(s).length > 0) ? 'yes' : 'no'}.`,
    `- Time budget ${config.budgetMs / 60_000} min; used ${seconds(performance.now() - started)}.`,
    ...notes.map((n) => `- ${n}`),
    '',
  ];
  for (const model of ['laya', 'ollama'] as Model[]) {
    lines.push(
      `## ${model === 'laya' ? 'Laya' : `Ollama ${config.ollamaModel}`}`,
      '',
      '| Variant | think | States | Toward stronger | Legal | Failed | Mean latency |',
      '|---|---|---:|---:|---:|---:|---:|',
    );
    for (const id of ids.filter((i) => i.startsWith(model))) {
      const s = summarise(rows.filter((r) => r.arm === id));
      lines.push(
        `| ${id.replace(`${model}-`, '').replace('-think', '')} | ${id.endsWith('-think')} | ${s.states} | ${pct(s.towardRate)} | ${pct(s.legalRate)} | ${s.failures} | ${Math.round(s.meanLatencyMs)} ms |`,
      );
    }
    lines.push('');
  }
  if (bestByModel) {
    const thinkId = ids.find((i) => i.endsWith('-think'));
    if (thinkId) {
      const subset = new Set(rows.filter((r) => r.arm === thinkId).map((r) => r.stateId));
      const plain = thinkId.replace('-think', '');
      const a = summarise(rows.filter((r) => r.arm === plain && subset.has(r.stateId)));
      const b = summarise(rows.filter((r) => r.arm === thinkId));
      lines.push(
        `Same ${subset.size} states, think off vs on (${plain}): toward ${pct(a.towardRate)} vs ${pct(b.towardRate)}, legal ${pct(a.legalRate)} vs ${pct(b.legalRate)}, latency ${Math.round(a.meanLatencyMs)} vs ${Math.round(b.meanLatencyMs)} ms.`,
        '',
      );
    }
  }
  if (mazeRuns.length) {
    const entryIds = [...new Set(mazeRuns.map((r) => r.mazeId))];
    lines.push(
      '## Best variant per model on the 4 maze entries',
      '',
      'Step cap max(3 × optimal, 60); stuck when no new cell for max(50, 2 × optimal) steps; same entries and seed as the word-prompt experiment.',
      '',
      '| Policy | Completed | Steps (completed; optimal 8) | Stuck | Wall choices | Toward stronger smell | Mean latency | ' + entryIds.join(' | ') + ' |',
      `|---|---:|---|---:|---:|---:|---:|${entryIds.map(() => '---').join('|')}|`,
    );
    for (const id of [...new Set(mazeRuns.map((r) => r.policy))]) {
      const group = mazeRuns.filter((r) => r.policy === id);
      const a = aggregate(group);
      const smell = group
        .map((run) => towardStrongerSmell(entries.find((e) => e.id === run.mazeId)!, run.moves))
        .reduce((t, x) => ({ toward: t.toward + x.toward, chosen: t.chosen + x.chosen }), { toward: 0, chosen: 0 });
      const walls = group.reduce((t, r) => t + r.illegalMoves, 0);
      const steps = group.reduce((t, r) => t + r.steps, 0);
      lines.push(
        `| ${id} | ${a.completed}/${a.runs} | ${
          group
            .filter((r) => r.completed)
            .map((r) => r.steps)
            .join(', ') || '—'
        } | ${a.stuck} | ${walls}/${steps} (${pct(steps ? walls / steps : 0)}) | ${smell.chosen ? pct(smell.toward / smell.chosen) : 'n/a'} | ${a.meanLatencyMs === null ? '—' : `${Math.round(a.meanLatencyMs)} ms`} | ${entryIds
          .map((e) => {
            const run = group.find((r) => r.mazeId === e);
            return run ? `${run.status} ${run.steps}` : 'not run';
          })
          .join(' | ')} |`,
      );
    }
    lines.push(
      '',
      'For comparison, the clean word-prompt run (`benchmark-results/word-prompts/2026-10-23T16-32-34-858Z`): laya-words-lookahead 2/4, ollama-words-lookahead 3/4, scorer 4/4, random-legal 1/4.',
      '',
    );
  } else lines.push('## Maze entries', '', 'Not run: the time budget was used up before this phase.', '');
  lines.push(
    '## Example requests',
    '',
    "Each arm's first request (frozen state `state-001`), exactly as sent. The Laya key travels only in the Authorization header.",
    '',
  );
  for (const [id, example] of examples) {
    lines.push(`### ${id}`, '', `POST ${example.endpoint}`, '', '```json', JSON.stringify(example.body, null, 2), '```', '');
    const prompt = (example.body.messages as { content: string }[] | undefined)?.[0]?.content;
    if (prompt) lines.push('Prompt text as the model reads it:', '', '```text', prompt, '```', '');
  }
  await fs.writeFile(path.join(runDir, 'results.json'), redactSecrets(JSON.stringify({ timestamp, seed: config.seed, notes, bestByModel, rows }, null, 2)));
  await fs.writeFile(path.join(runDir, 'maze-runs.json'), runsJson({ timestamp, bestByModel }, mazeRuns));
  await fs.writeFile(path.join(runDir, 'examples.json'), redactSecrets(JSON.stringify(Object.fromEntries(examples), null, 2)));
  await fs.writeFile(path.join(runDir, 'report.md'), redactSecrets(lines.join('\n') + '\n'));
  console.log(`Done in ${seconds(performance.now() - started)}. Report: ${path.join(runDir, 'report.md')}`);
}
if (!process.env.VITEST)
  main().catch((error) => {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
