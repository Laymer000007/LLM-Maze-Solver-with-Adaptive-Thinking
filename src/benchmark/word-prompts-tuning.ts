import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';

import {
  type DecisionState,
  type Policy,
  type PolicyId,
  type RunRecord,
  SLEEP_MS,
  type SuiteEntry,
  TIMEOUT_MS,
  aggregate,
  buildSuiteEntry,
  callLaya,
  callOllama,
  redactSecrets,
  resolveLayaKey,
  rng,
  runEpisode,
  runSeed,
  runsJson,
  seededShuffle,
  stuckWindowFor,
} from '@/benchmark/full-maze-eval-lib';
import {
  ABLATION_VARIANTS,
  type Arm,
  type CapturedRequest,
  type ColderStep,
  INTRO,
  LAYA_INSTRUCTIONS,
  MAZES,
  MAZE_CHECK_ARMS,
  type Model,
  OLLAMA_RETURN,
  ORIENTATIONS,
  PLACEMENT_VARIANTS,
  POSITIVE_RULE,
  POSITIVE_VARIANTS,
  RULE,
  RULE_PLACEMENT_ONLY,
  type Row,
  TUNING_VARIANTS,
  type TuningVariant,
  allColder,
  armId,
  armPolicy,
  armRequest,
  ask,
  baselinePolicy,
  bestArm,
  createWordPolicy,
  stepCapFor,
  strongerMoves,
  summarise,
  towardStrongerSmell,
} from '@/benchmark/word-prompt-builders';
import { type Move } from '@/execution/execution';
import { Maze } from '@/maze/maze';

// Prompt-tuning rounds (tuning, ablations, maze check). Builders are in word-prompt-builders.ts; production prompts
// are untouched.

type Config = { budgetMs: number; seed: number; outputDir: string; layaUrl: string; ollamaUrl: string; ollamaModel: string };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const THINK_CAP = 50;
const THINK_PROBE = 10;
const MAZE_RESERVE_MS = 4 * 60_000;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
class BudgetReached extends Error {}
class ArmDropped extends Error {}

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
  const dirs = (await fs.readdir(outputDir).catch(() => [] as string[])).filter((d) => !d.includes('-ablation')).sort();
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

// ---------- Maze check ----------

const FIRST_ENTRIES = ['7x7_corridor_branch', '7x7_open_detour'];
const EXTRA_ENTRIES = ['11x11_corridor_dead-end', '15x15_corridor_spiral'];
/** An arm averaging more than this per request after 10 requests is dropped. */
export const SLOW_ARM_MS = 3000;
/** Assumed latency before an arm has its own measurements (the last single-step runs). */
const PRIOR_LATENCY_MS: Record<string, number> = { 'laya-best': 290, 'ollama-best': 530, 'laya-numbers-baseline': 360, 'ollama-numbers-baseline': 460 };

async function mazeCheck(config: Config): Promise<void> {
  const started = performance.now();
  const remaining = () => config.budgetMs - (performance.now() - started);
  const entryFor = async (name: string, transform: 'original' | 'rotate-180') =>
    buildSuiteEntry((await Maze.fromFile(path.join(ROOT, 'mazes', `${name}.txt`))).layout, `mazes/${name}.txt`, transform);
  const load = async (names: string[]) => Promise.all(names.flatMap((n) => (['original', 'rotate-180'] as const).map((t) => entryFor(n, t))));
  const first = await load(FIRST_ENTRIES);
  const extra = await load(EXTRA_ENTRIES);
  const examples = new Map<string, CapturedRequest>();
  const capture = (id: string) => (request: CapturedRequest) => {
    if (!examples.has(id)) examples.set(id, request);
  };
  const policies: Record<string, Policy> = {
    scorer: baselinePolicy('scorer'),
    'random-legal': baselinePolicy('random-legal'),
    'laya-best': armPolicy('laya-best', MAZE_CHECK_ARMS['laya-best'], config, capture('laya-best')),
    'ollama-best': armPolicy('ollama-best', MAZE_CHECK_ARMS['ollama-best'], config, capture('ollama-best')),
    'laya-numbers-baseline': createWordPolicy('laya', 'numbers-baseline', config, capture('laya-numbers-baseline')),
    'ollama-numbers-baseline': createWordPolicy('ollama', 'numbers-baseline', config, capture('ollama-numbers-baseline')),
  };
  const core = ['scorer', 'random-legal', 'laya-best', 'ollama-best'];
  const numbers = ['laya-numbers-baseline', 'ollama-numbers-baseline'];
  // Priority order: every policy on the first 4 entries before any extra entry.
  const phases: { label: string; entries: SuiteEntry[]; ids: string[] }[] = [
    { label: 'first 4 entries, best prompts and free baselines', entries: first, ids: core },
    { label: 'first 4 entries, numbers baselines', entries: first, ids: numbers },
    { label: 'extra entries, best prompts and free baselines', entries: extra, ids: core },
    { label: 'extra entries, numbers baselines', entries: extra, ids: numbers },
  ];
  const latency: Record<string, { total: number; count: number }> = {};
  const meanLatency = (id: string) => (latency[id]?.count ? latency[id].total / latency[id].count : (PRIOR_LATENCY_MS[id] ?? 0));
  const cap = (e: SuiteEntry) => stepCapFor(e.optimalSteps);
  console.log(`Plan, budget ${config.budgetMs / 60_000} min, in priority order (requests at most = step cap per run):`);
  for (const phase of phases) {
    const models = phase.ids.filter((id) => !['scorer', 'random-legal'].includes(id));
    const maxRequests = models.length * phase.entries.reduce((t, e) => t + cap(e), 0);
    const maxMs = models.reduce((t, id) => t + phase.entries.reduce((u, e) => u + cap(e) * (meanLatency(id) + SLEEP_MS), 0), 0);
    console.log(`  ${phase.label}: ${phase.entries.length * phase.ids.length} runs, ≤${maxRequests} requests, ≤${seconds(maxMs)}`);
  }
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
  const timestamp = new Date().toISOString();
  const runDir = path.join(config.outputDir, `${timestamp.replace(/[:.]/g, '-')}-maze-check`);
  await fs.mkdir(runDir, { recursive: true });
  const runs: RunRecord[] = [];
  const colder: ColderStep[] = [];
  const dropped = new Map<string, string>();
  const notes: string[] = [];
  for (const phase of phases)
    for (const entry of phase.entries)
      for (const id of phase.ids) {
        if (dropped.has(id)) continue;
        const model = !['scorer', 'random-legal'].includes(id);
        const projected = model ? cap(entry) * (meanLatency(id) + SLEEP_MS) : 0;
        if (projected > remaining()) {
          notes.push(`Skipped ${entry.id}/${id}: up to ${seconds(projected)} needed, ${seconds(Math.max(0, remaining()))} left.`);
          console.log(notes.at(-1));
          continue;
        }
        const inner = policies[id];
        let step = 0;
        const policy: Policy = {
          ...inner,
          decide: async (state, random) => {
            step++;
            if (remaining() <= 0) throw new BudgetReached();
            const decision = await inner.decide(state, random);
            if (decision.latencyMs !== null) {
              latency[id] = { total: (latency[id]?.total ?? 0) + decision.latencyMs, count: (latency[id]?.count ?? 0) + 1 };
              if (latency[id].count >= 10 && meanLatency(id) > SLOW_ARM_MS && !dropped.has(id)) {
                dropped.set(id, `mean latency ${Math.round(meanLatency(id))} ms after ${latency[id].count} requests`);
                throw new ArmDropped();
              }
            }
            if (allColder(state))
              colder.push({
                policy: id,
                entry: entry.id,
                step,
                position: `(${state.position.x},${state.position.y})`,
                options: decision.presented ?? state.validActions,
                choice: decision.choice,
                legal: decision.choice !== null && state.validActions.includes(decision.choice),
              });
            return decision;
          },
        };
        try {
          const run = await runEpisode(entry, policy, config.seed, {
            stepCap: cap(entry),
            stuckWindow: stuckWindowFor(entry.optimalSteps),
            rngSeed: runSeed(config.seed, entry.id, id),
          });
          runs.push(run);
          console.log(
            `${entry.id}/${id} → ${run.status} in ${run.steps}/${run.stepCap} (optimal ${run.optimalSteps}), walls ${run.illegalMoves}, ${seconds(run.wallClockMs)} · elapsed ${seconds(performance.now() - started)}`,
          );
        } catch (error) {
          if (error instanceof ArmDropped) {
            notes.push(`${entry.id}/${id} stopped mid-run: arm dropped as too slow (${dropped.get(id)}).`);
            console.log(notes.at(-1));
            continue;
          }
          if (!(error instanceof BudgetReached)) throw error;
          notes.push(`${entry.id}/${id} stopped mid-run: time budget reached after ${seconds(performance.now() - started)}.`);
          console.log(notes.at(-1));
        }
        if (dropped.has(id) && !notes.some((n) => n.startsWith(`Dropped ${id}`))) notes.push(`Dropped ${id}: ${dropped.get(id)}.`);
      }
  const elapsed = performance.now() - started;
  const ids = Object.keys(policies).filter((id) => runs.some((r) => r.policy === id));
  const entries = [...first, ...extra].filter((e) => runs.some((r) => r.mazeId === e.id));
  const lines = [
    '# Maze check: best single-step prompts',
    '',
    `- Timestamp: ${timestamp} · commit ${git('git rev-parse HEAD')}${git('git status --porcelain') ? ' (dirty)' : ''} · seed ${config.seed}`,
    `- laya-best: warmer/colder options + positive-only rule ("${POSITIVE_RULE}"). ollama-best: warmer/colder options + full rule ("${RULE}"), ${config.ollamaModel}, think:false, temperature 0.2. Numbers baselines: the constrained numeric payloads, shuffled.`,
    `- Step cap max(3 × optimal, 60); stuck when no new cell for max(50, 2 × optimal) steps; option order shuffled per request with a seeded RNG. Every policy ran on the first 4 entries before any extra entry. An arm is dropped if it averages over ${SLOW_ARM_MS} ms per request after 10 requests; a run is skipped if its step cap at the arm's mean latency would not fit the remaining budget.`,
    `- Time budget ${config.budgetMs / 60_000} min; used ${seconds(elapsed)}.`,
    ...notes.map((n) => `- ${n}`),
    '',
    '## Per policy',
    '',
    '| Policy | Entries run | Completed | Steps / optimal (completed) | Stuck | Step-cap | Aborted | Wall choices | Toward stronger smell | Mean latency |',
    '|---|---:|---:|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const id of ids) {
    const group = runs.filter((r) => r.policy === id);
    const a = aggregate(group);
    const smell = group
      .map((run) => towardStrongerSmell(entries.find((e) => e.id === run.mazeId)!, run.moves))
      .reduce((t, x) => ({ toward: t.toward + x.toward, chosen: t.chosen + x.chosen }), { toward: 0, chosen: 0 });
    const walls = group.reduce((t, r) => t + r.illegalMoves, 0);
    const steps = group.reduce((t, r) => t + r.steps, 0);
    const done =
      group
        .filter((r) => r.completed)
        .map((r) => `${r.steps}/${r.optimalSteps}`)
        .join(', ') || '—';
    lines.push(
      `| ${id} | ${group.length} | ${a.completed}/${a.runs} | ${done} | ${a.stuck} | ${a.stepCapped} | ${a.aborted} | ${walls}/${steps} (${pct(steps ? walls / steps : 0)}) | ${smell.chosen ? pct(smell.toward / smell.chosen) : 'n/a'} | ${a.meanLatencyMs === null ? '—' : `${Math.round(a.meanLatencyMs)} ms`} |`,
    );
  }
  lines.push(
    '',
    '## Per entry',
    '',
    `| Policy | ${entries.map((e) => `${e.id} (opt ${e.optimalSteps})`).join(' | ')} |`,
    `|---|${entries.map(() => '---').join('|')}|`,
  );
  for (const id of ids)
    lines.push(
      `| ${id} | ${entries
        .map((e) => {
          const run = runs.find((r) => r.policy === id && r.mazeId === e.id);
          return run ? `${run.status} ${run.steps}` : 'not run';
        })
        .join(' | ')} |`,
    );
  const mismatches = runs.reduce((t, r) => t + r.criteriaMismatches, 0);
  const checked = runs.reduce((t, r) => t + r.criteriaChecked, 0);
  lines.push(
    '',
    `Criteria check on the Laya numbers baseline: ${checked} criteria, ${mismatches} mismatches.`,
    '',
    '## Steps where every open direction is "colder"',
    '',
    'For example backing out of a dead end: every legal option says the smell grows weaker, so there is no "warmer" option to follow.',
    '',
    '| Policy | Such steps | Legal choices | Wall/illegal or failed | Choices |',
    '|---|---:|---:|---:|---|',
  );
  for (const id of ids) {
    const steps = colder.filter((c) => c.policy === id);
    const choices = Object.entries(steps.reduce((t, c) => ({ ...t, [c.choice ?? 'failed']: (t[c.choice ?? 'failed'] ?? 0) + 1 }), {} as Record<string, number>))
      .map(([k, v]) => `${k} ×${v}`)
      .join(', ');
    lines.push(`| ${id} | ${steps.length} | ${steps.filter((c) => c.legal).length} | ${steps.filter((c) => !c.legal).length} | ${choices || '—'} |`);
  }
  const modelColder = colder.filter((c) => !['scorer', 'random-legal'].includes(c.policy));
  if (modelColder.length) {
    lines.push(
      '',
      '<details><summary>Every all-colder step of the model policies</summary>',
      '',
      '| Policy | Entry | Step | Position | Options shown | Choice | Legal |',
      '|---|---|---:|---|---|---|---|',
    );
    for (const c of modelColder)
      lines.push(`| ${c.policy} | ${c.entry} | ${c.step} | ${c.position} | ${c.options.join(', ')} | ${c.choice ?? 'failed'} | ${c.legal ? 'yes' : 'no'} |`);
    lines.push('', '</details>');
  }
  lines.push('', '## Example requests', '', "Each model policy's first request, exactly as sent. The Laya key travels only in the Authorization header.", '');
  for (const [id, example] of examples) {
    lines.push(`### ${id}`, '', `POST ${example.endpoint}`, '', '```json', JSON.stringify(example.body, null, 2), '```', '');
    const prompt = (example.body.messages as { content: string }[] | undefined)?.[0]?.content;
    if (prompt) lines.push('Prompt text as the model reads it:', '', '```text', prompt, '```', '');
  }
  await fs.writeFile(path.join(runDir, 'runs.json'), runsJson({ timestamp, seed: config.seed, notes, dropped: Object.fromEntries(dropped) }, runs));
  await fs.writeFile(path.join(runDir, 'colder-steps.json'), redactSecrets(JSON.stringify(colder, null, 2)));
  await fs.writeFile(path.join(runDir, 'examples.json'), redactSecrets(JSON.stringify(Object.fromEntries(examples), null, 2)));
  await fs.writeFile(path.join(runDir, 'report.md'), redactSecrets(lines.join('\n') + '\n'));
  console.log(`Done in ${seconds(elapsed)}. Report: ${path.join(runDir, 'report.md')}`);
}

/** Laya rule-placement arms, with usage.input_tokens and changes against rule-both. */
async function writePlacementReport(
  runDir: string,
  config: Config,
  timestamp: string,
  states: (DecisionState & { id: string })[],
  rows: Row[],
  examples: Map<string, CapturedRequest>,
  notes: string[],
  elapsedMs: number,
): Promise<void> {
  const label: Record<string, string> = {
    'warmer-only-positive': 'rule-both',
    'rule-instructions-only': 'rule-instructions-only',
    'rule-state-only': 'rule-state-only',
  };
  const where: Record<string, string> = {
    'warmer-only-positive': 'state.body + instructions',
    'rule-instructions-only': 'instructions only',
    'rule-state-only': 'state.body only',
  };
  const previousDir = (await fs.readdir(config.outputDir))
    .filter((d) => d.endsWith('-ablation-positive'))
    .sort()
    .at(-1);
  const previous: Row[] = previousDir ? JSON.parse(await fs.readFile(path.join(config.outputDir, previousDir, 'results.json'), 'utf-8')).rows : [];
  const both = new Map(rows.filter((r) => r.arm === 'laya-warmer-only-positive').map((r) => [r.stateId, r]));
  const lines = [
    '# Ablation: where Laya gets the rule',
    '',
    `- Timestamp: ${timestamp} · commit ${git('git rev-parse HEAD')}${git('git status --porcelain') ? ' (dirty)' : ''} · seed ${config.seed}`,
    `- Laya only. Single step on the ${states.length} frozen states, 1 request per state per arm, warmer/colder options, positive-only rule ("${POSITIVE_RULE}"), option order from warmer-only's shuffle seed (identical across arms).`,
    '- rule-both is laya-best. rule-instructions-only drops the rule line from state.body; rule-state-only drops the rule from questions.move.instructions, leaving "Choose exactly one movement direction. Return the direction label."',
    `- Input tokens are Laya's response \`usage.input_tokens\`. Time budget ${config.budgetMs / 60_000} min; used ${seconds(elapsedMs)}.`,
    ...notes.map((n) => `- ${n}`),
    '',
    '| Arm | Rule in | States | Toward stronger | Legal | Failed | Mean latency | Input tokens (mean, min–max) | Choices changed vs rule-both |',
    '|---|---|---:|---:|---:|---:|---:|---|---:|',
  ];
  for (const variant of PLACEMENT_VARIANTS) {
    const id = armId({ model: 'laya', variant, think: false });
    const group = rows.filter((r) => r.arm === id);
    if (!group.length) continue;
    const s = summarise(group);
    const tokens = group.map((r) => r.inputTokens).filter((t): t is number => typeof t === 'number');
    const tokenCell = tokens.length
      ? `${Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length)} (${Math.min(...tokens)}–${Math.max(...tokens)})${tokens.length < group.length ? `, ${tokens.length}/${group.length} reported` : ''}`
      : 'not returned';
    const changed =
      variant === 'warmer-only-positive' ? '—' : String(group.filter((r) => both.has(r.stateId) && both.get(r.stateId)!.choice !== r.choice).length);
    lines.push(
      `| ${label[variant]} | ${where[variant]} | ${s.states} | ${pct(s.towardRate)} | ${pct(s.legalRate)} | ${s.failures} | ${Math.round(s.meanLatencyMs)} ms | ${tokenCell} | ${changed} |`,
    );
  }
  const prev = previous.filter((r) => r.arm === 'laya-warmer-only-positive');
  if (prev.length)
    lines.push(
      '',
      `rule-both reproduction against \`${path.relative(ROOT, path.join(config.outputDir, previousDir!))}\` (laya-warmer-only-positive): ${prev.filter((p) => both.get(p.stateId)?.choice === p.choice).length}/${prev.length} identical choices.`,
    );
  for (const variant of RULE_PLACEMENT_ONLY) {
    const id = armId({ model: 'laya', variant, think: false });
    const differ = rows.filter((r) => r.arm === id && both.has(r.stateId) && both.get(r.stateId)!.choice !== r.choice);
    lines.push('', `### ${label[variant]}: states that chose differently from rule-both (${differ.length})`, '');
    if (!differ.length) continue;
    const byId = new Map(states.map((st) => [st.id, st]));
    const mark = (choice: Move | null, stateId: string) =>
      choice === null ? 'failed' : `${choice}${strongerMoves(byId.get(stateId)!).includes(choice) ? ' ✓' : ' ✗'}`;
    lines.push('| State | Options (order shown) | Stronger | rule-both | this arm |', '|---|---|---|---|---|');
    for (const r of differ)
      lines.push(
        `| ${r.stateId} | ${r.order.join(', ')} | ${strongerMoves(byId.get(r.stateId)!).join(', ')} | ${mark(both.get(r.stateId)!.choice, r.stateId)} | ${mark(r.choice, r.stateId)} |`,
      );
  }
  lines.push(
    '',
    '## Example requests',
    '',
    "Each arm's first request (frozen state `state-001`), exactly as sent. The key travels only in the Authorization header.",
    '',
  );
  for (const [id, example] of examples)
    lines.push(`### ${label[id.replace('laya-', '')] ?? id}`, '', `POST ${example.endpoint}`, '', '```json', JSON.stringify(example.body, null, 2), '```', '');
  await fs.writeFile(
    path.join(runDir, 'results.json'),
    redactSecrets(JSON.stringify({ timestamp, seed: config.seed, mode: 'ablation-placement', previous: previousDir ?? null, notes, rows }, null, 2)),
  );
  await fs.writeFile(path.join(runDir, 'examples.json'), redactSecrets(JSON.stringify(Object.fromEntries(examples), null, 2)));
  await fs.writeFile(path.join(runDir, 'report.md'), redactSecrets(lines.join('\n') + '\n'));
  console.log(`Done in ${seconds(elapsedMs)}. Report: ${path.join(runDir, 'report.md')}`);
}

/** The positive-rule arms next to the four arms of the latest --mode ablation run. */
async function writePositiveReport(
  runDir: string,
  config: Config,
  timestamp: string,
  states: (DecisionState & { id: string })[],
  rows: Row[],
  examples: Map<string, CapturedRequest>,
  notes: string[],
  elapsedMs: number,
): Promise<void> {
  const previousDir = (await fs.readdir(config.outputDir))
    .filter((d) => d.endsWith('-ablation'))
    .sort()
    .at(-1);
  const previous: Row[] = previousDir ? JSON.parse(await fs.readFile(path.join(config.outputDir, previousDir, 'results.json'), 'utf-8')).rows : [];
  const all = [...previous, ...rows];
  const lines = [
    '# Ablation: positive-only rule',
    '',
    `- Timestamp: ${timestamp} · commit ${git('git rev-parse HEAD')}${git('git status --porcelain') ? ' (dirty)' : ''} · seed ${config.seed}`,
    `- Single step on the ${states.length} frozen states, 1 request per state per arm, option order from warmer-only's shuffle seed (identical across all six arms). Ollama ${config.ollamaModel}, think:false, temperature 0.2.`,
    `- Full rule: "${RULE}"`,
    `- Positive rule: "${POSITIVE_RULE}" (replaces the full rule in the body and, for Laya, in the question instructions; nothing else changes).`,
    `- The four earlier arms come from \`${previousDir ? path.relative(ROOT, path.join(config.outputDir, previousDir)) : 'none found'}\`; the two positive arms are new. Time budget ${config.budgetMs / 60_000} min; used ${seconds(elapsedMs)}.`,
    ...notes.map((n) => `- ${n}`),
    '',
  ];
  for (const model of ['laya', 'ollama'] as Model[]) {
    lines.push(
      `## ${model === 'laya' ? 'Laya' : `Ollama ${config.ollamaModel}`}`,
      '',
      '| Option text | Rule | Run | Toward stronger | Legal | Failed | Mean latency |',
      '|---|---|---|---:|---:|---:|---:|',
    );
    for (const variant of ['warmer-only', 'warmer-only-positive', 'smell-only', 'smell-only-positive'] as TuningVariant[]) {
      const id = armId({ model, variant, think: false });
      const group = all.filter((r) => r.arm === id);
      if (!group.length) continue;
      const s = summarise(group);
      lines.push(
        `| ${variant.startsWith('warmer') ? 'warmer/colder' : 'smell only'} | ${variant.endsWith('-positive') ? 'positive only' : 'full (with "Never…")'} | ${variant.endsWith('-positive') ? 'new' : 'previous'} | ${pct(s.towardRate)} | ${pct(s.legalRate)} | ${s.failures} | ${Math.round(s.meanLatencyMs)} ms |`,
      );
    }
    for (const base of ['warmer-only', 'smell-only'] as TuningVariant[]) {
      const [a, b] = [base, `${base}-positive` as TuningVariant].map(
        (v) => new Map(all.filter((r) => r.arm === armId({ model, variant: v, think: false })).map((r) => [r.stateId, r])),
      );
      const differ = [...a.values()].filter((r) => b.has(r.stateId) && b.get(r.stateId)!.choice !== r.choice);
      const better = differ.filter((r) => !r.toward && b.get(r.stateId)!.toward).length;
      const worse = differ.filter((r) => r.toward && !b.get(r.stateId)!.toward).length;
      lines.push(
        '',
        `${base} → ${base}-positive: ${differ.length} states chose differently (${better} became toward stronger, ${worse} stopped being toward stronger): ${differ.map((r) => r.stateId).join(', ') || 'none'}.`,
      );
    }
    lines.push('');
  }
  lines.push(
    '## Example requests (new arms)',
    '',
    "Each new arm's first request (frozen state `state-001`), exactly as sent. The Laya key travels only in the Authorization header.",
    '',
  );
  for (const [id, example] of examples) {
    lines.push(`### ${id}`, '', `POST ${example.endpoint}`, '', '```json', JSON.stringify(example.body, null, 2), '```', '');
    const prompt = (example.body.messages as { content: string }[] | undefined)?.[0]?.content;
    if (prompt) lines.push('Prompt text as the model reads it:', '', '```text', prompt, '```', '');
  }
  await fs.writeFile(
    path.join(runDir, 'results.json'),
    redactSecrets(JSON.stringify({ timestamp, seed: config.seed, mode: 'ablation-positive', previous: previousDir ?? null, notes, rows }, null, 2)),
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
  const modes = ['tuning', 'ablation', 'ablation-positive', 'ablation-placement', 'maze-check'];
  if (!modes.includes(mode)) throw new Error(`Unknown --mode ${mode}; use ${modes.join(', ')}.`);
  if (mode === 'maze-check') {
    if (!resolveLayaKey()) throw new Error('No Laya key: set LAYA_API_KEY or LAYA_API_KEY_FILE (default ~/.config/laya/api_key).');
    return mazeCheck(config);
  }
  const ablation = mode !== 'tuning';
  if (!resolveLayaKey()) throw new Error('No Laya key: set LAYA_API_KEY or LAYA_API_KEY_FILE (default ~/.config/laya/api_key).');
  const started = performance.now();
  const remaining = () => config.budgetMs - (performance.now() - started);
  const guard = () => {
    if (remaining() <= 0) throw new BudgetReached();
  };
  const { states } = JSON.parse(await fs.readFile(path.join(ROOT, 'benchmark-results', 'frozen-dataset.json'), 'utf-8')) as {
    states: (DecisionState & { id: string })[];
  };
  const arms: Arm[] =
    mode === 'ablation-placement'
      ? PLACEMENT_VARIANTS.map((variant) => ({ model: 'laya', variant, think: false }))
      : (['laya', 'ollama'] as Model[]).flatMap((model) =>
          (mode === 'ablation' ? ABLATION_VARIANTS : mode === 'ablation-positive' ? POSITIVE_VARIANTS : TUNING_VARIANTS).map((variant) => ({
            model,
            variant,
            think: false,
          })),
        );
  if (mode === 'ablation-placement')
    console.log(
      `Plan, budget ${config.budgetMs / 60_000} min: ${arms.length} Laya arms × ${states.length} frozen states = ${arms.length * states.length} requests (~${seconds(arms.length * states.length * (290 + SLEEP_MS))} at laya-best's maze-check latency). No maze runs.`,
    );
  else if (ablation)
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
  const runDir = path.join(config.outputDir, `${timestamp.replace(/[:.]/g, '-')}${ablation ? `-${mode}` : ''}`);
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
        inputTokens: typeof decision.usage?.input_tokens === 'number' ? decision.usage.input_tokens : null,
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
    if (mode === 'ablation-placement') await writePlacementReport(runDir, config, timestamp, states, rows, examples, notes, performance.now() - started);
    else if (mode === 'ablation-positive') await writePositiveReport(runDir, config, timestamp, states, rows, examples, notes, performance.now() - started);
    else await writeAblationReport(runDir, config, timestamp, states, rows, examples, notes, performance.now() - started);
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
// Entry point: run with vite-node. Never import this file; shared code lives in full-maze-eval-lib.ts and word-prompt-builders.ts.
main().catch((error) => {
  console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
