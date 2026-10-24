import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';

import {
  ROOT,
  SLEEP_MS,
  TIMEOUT_MS,
  aggregate,
  buildSuite,
  buildSuiteEntry,
  callLayaRaw,
  redactSecrets,
  resolveLayaKey,
  runEpisode,
  runSeed,
  runsJson,
  seededShuffle,
  stuckWindowFor,
  type Decision,
  type Policy,
  type PolicyId,
  type RunRecord,
  type SuiteEntry,
} from '@/benchmark/full-maze-eval-lib';
import {
  CLOSENESS_PHRASES,
  INTRO,
  LABEL_SCHEMES,
  LAYA_INSTRUCTIONS,
  MOVES4,
  closenessWords,
  enumerateSituations,
  labelToMove,
  layaBestRequest,
  situationFor,
  situationOf,
  stepCapFor,
  towardStrongerSmell,
  type EnumeratedRequest,
  type LabelScheme,
} from '@/benchmark/word-prompt-builders';
import type { Move } from '@/execution/execution';
import { Maze } from '@/maze/maze';

// Laya only: every distinct laya-best request, sent once (Laya is deterministic), with three label schemes; then the
// best non-direction label scheme on the maze-check entries. Builders are in word-prompt-builders.ts.

type Config = { budgetMs: number; seed: number; outputDir: string; layaUrl: string };
type Row = EnumeratedRequest & {
  scheme: LabelScheme;
  answer: string | null;
  move: Move | null;
  legal: boolean;
  correct: boolean;
  latencyMs: number;
  inputTokens: number | null;
  failure: string | null;
};

const MAZE_ENTRIES = ['7x7_corridor_branch', '7x7_open_detour', '11x11_corridor_dead-end', '15x15_corridor_spiral'];
const PRIOR_LATENCY_MS = 290;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
const ratio = (rows: Row[]) =>
  rows.length ? `${rows.filter((r) => r.correct).length}/${rows.length} (${pct(rows.filter((r) => r.correct).length / rows.length)})` : '—';
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
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

/** How often each situation key occurs over all walkable non-goal cells of the 128-entry suite (canonical option order). */
async function suiteOccurrence(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const entry of await buildSuite()) {
    const maze = new Maze(entry.layout);
    for (let y = 0; y < maze.height; y++)
      for (let x = 0; x < maze.width; x++) {
        const p = { x, y };
        if (!maze.isWalkable(p) || (x === entry.goal.x && y === entry.goal.y)) continue;
        const next = (m: Move) => ({ x: x + (m === 'left' ? -1 : m === 'right' ? 1 : 0), y: y + (m === 'up' ? -1 : m === 'down' ? 1 : 0) });
        const open = MOVES4.filter((m) => maze.isWalkable(next(m)));
        const warmer = open.filter((m) => maze.smellAt(next(m)) > maze.smellAt(p));
        const key = `${open.join('+')}|warm:${warmer.join('+')}|${closenessWords(maze.smellAt(p))}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
  }
  return counts;
}

function schemePolicy(scheme: LabelScheme, config: Config, guard: () => void): Policy {
  return {
    id: (scheme === 'moves' ? 'laya-best' : `laya-best-${scheme}`) as PolicyId, // experiment-only id
    kind: 'laya',
    deterministic: true,
    config: {
      payloadBuilder: `layaBestRequest(${scheme})`,
      endpoint: `${config.layaUrl}/v1/systemone`,
      model: null,
      think: null,
      temperature: null,
      format: 'systemone choice question',
      optionOrdering: 'legal moves, seeded shuffle per request',
      sees: 'warmer/colder per direction (words)',
    },
    decide: async (state, random): Promise<Decision> => {
      guard();
      const order = seededShuffle(state.validActions, random);
      const r = await callLayaRaw(config.layaUrl, layaBestRequest(situationOf(state, order), scheme), TIMEOUT_MS);
      const move = labelToMove(scheme, order, r.answer);
      return {
        choice: move,
        latencyMs: r.latencyMs,
        presented: order,
        ...(r.failure ? { failure: r.failure, error: r.error } : move ? {} : { failure: 'parse', error: `Unrecognised label: ${r.answer}` }),
      };
    },
  };
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
    outputDir: path.resolve(get('--output-dir') ?? path.join(ROOT, 'benchmark-results', 'laya-exhaustive')),
    layaUrl: process.env.LAYA_URL ?? 'http://192.168.88.100:8000',
  };
  if (!(config.budgetMs > 0)) throw new Error('--time-budget-min must be a positive number.');
  if (!resolveLayaKey()) throw new Error('No Laya key: set LAYA_API_KEY or LAYA_API_KEY_FILE (default ~/.config/laya/api_key).');
  const started = performance.now();
  const remaining = () => config.budgetMs - (performance.now() - started);
  const guard = () => {
    if (remaining() <= 0) throw new BudgetReached();
  };
  const requests = enumerateSituations(config.seed);
  const entries: SuiteEntry[] = [];
  for (const name of MAZE_ENTRIES) {
    const maze = await Maze.fromFile(path.join(ROOT, 'mazes', `${name}.txt`));
    for (const transform of ['original', 'rotate-180'] as const) entries.push(buildSuiteEntry(maze.layout, `mazes/${name}.txt`, transform));
  }
  const mazeMax = entries.reduce((t, e) => t + stepCapFor(e.optimalSteps), 0);
  console.log(
    `Plan, budget ${config.budgetMs / 60_000} min:\n` +
      `  1. ${requests.length} distinct situations (${requests.filter((r) => r.orderKind === 'canonical').length} canonical + ${requests.filter((r) => r.orderKind === 'shuffled').length} shuffled order) × ${LABEL_SCHEMES.length} label schemes = ${requests.length * LABEL_SCHEMES.length} requests (~${seconds(requests.length * LABEL_SCHEMES.length * (PRIOR_LATENCY_MS + SLEEP_MS))})\n` +
      `  2. if time allows: the best non-direction label scheme, then laya-best, on ${entries.length} maze entries: ≤${mazeMax} requests each (~${seconds(mazeMax * (PRIOR_LATENCY_MS + SLEEP_MS))} each at the cap); a run is skipped if its cap would not fit`,
  );
  const warm = await callLayaRaw(
    config.layaUrl,
    {
      state: { body: INTRO },
      questions: { move: { type: 'choice', instructions: LAYA_INSTRUCTIONS, criteria: { UP: 'an open passage', DOWN: 'an open passage' } } },
    },
    TIMEOUT_MS,
  );
  console.log(`warm-up laya: ${warm.failure ?? warm.answer} ${Math.round(warm.latencyMs)} ms`);
  if (warm.failure === 'http') throw new Error(`Laya warm-up failed: ${warm.error}`);
  const timestamp = new Date().toISOString();
  const runDir = path.join(config.outputDir, timestamp.replace(/[:.]/g, '-'));
  await fs.mkdir(runDir, { recursive: true });
  const rows: Row[] = [];
  const notes: string[] = [];
  const mazeRuns: RunRecord[] = [];
  let bestScheme: LabelScheme | null = null;
  try {
    for (const scheme of LABEL_SCHEMES) {
      for (const request of requests) {
        guard();
        const r = await callLayaRaw(config.layaUrl, layaBestRequest(situationFor(request), scheme), TIMEOUT_MS);
        const move = labelToMove(scheme, request.order, r.answer);
        rows.push({
          ...request,
          scheme,
          answer: r.answer,
          move,
          legal: move !== null && request.open.includes(move),
          correct: move !== null && request.warmer.includes(move),
          latencyMs: Math.round(r.latencyMs),
          inputTokens: typeof r.usage?.input_tokens === 'number' ? r.usage.input_tokens : null,
          failure: r.failure ?? null,
        });
        await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
      }
      const group = rows.filter((r) => r.scheme === scheme);
      console.log(
        `${scheme}: correct ${ratio(group)}, legal ${pct(group.filter((r) => r.legal).length / group.length)}, ${Math.round(mean(group.map((r) => r.latencyMs)) ?? 0)} ms · elapsed ${seconds(performance.now() - started)}`,
      );
    }
    const score = (scheme: LabelScheme) => rows.filter((r) => r.scheme === scheme && r.correct).length;
    bestScheme = (['compass', 'neutral'] as LabelScheme[]).sort((a, b) => score(b) - score(a))[0];
    notes.push(`Best non-direction label scheme: ${bestScheme} (${score('compass')} vs ${score('neutral')} correct of ${requests.length}).`);
    const meanLatency = (scheme: LabelScheme) => mean(rows.filter((r) => r.scheme === scheme).map((r) => r.latencyMs)) ?? PRIOR_LATENCY_MS;
    for (const scheme of [bestScheme, 'moves'] as LabelScheme[])
      for (const entry of entries) {
        const projected = stepCapFor(entry.optimalSteps) * (meanLatency(scheme) + SLEEP_MS);
        const policy = schemePolicy(scheme, config, guard);
        if (projected > remaining()) {
          notes.push(`Skipped ${entry.id}/${policy.id}: up to ${seconds(projected)} needed, ${seconds(Math.max(0, remaining()))} left.`);
          console.log(notes.at(-1));
          continue;
        }
        const run = await runEpisode(entry, policy, config.seed, {
          stepCap: stepCapFor(entry.optimalSteps),
          stuckWindow: stuckWindowFor(entry.optimalSteps),
          rngSeed: runSeed(config.seed, entry.id, 'laya-best'),
        });
        mazeRuns.push(run);
        console.log(
          `${entry.id}/${policy.id} → ${run.status} in ${run.steps}/${run.stepCap} (optimal ${run.optimalSteps}), ${seconds(run.wallClockMs)} · elapsed ${seconds(performance.now() - started)}`,
        );
      }
  } catch (error) {
    if (!(error instanceof BudgetReached)) throw error;
    notes.push(`Time budget reached after ${seconds(performance.now() - started)}; the report covers what finished.`);
    console.log(notes.at(-1));
  }

  // ---------- Report ----------
  const occurrence = await suiteOccurrence();
  const totalCells = [...occurrence.values()].reduce((a, b) => a + b, 0);
  const coveredKeys = new Set(requests.map((r) => r.key));
  const uncovered = [...occurrence.keys()].filter((k) => !coveredKeys.has(k));
  const weighted = (group: Row[]) => {
    const byKey = new Map<string, Row[]>();
    for (const r of group) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
    let hit = 0;
    let total = 0;
    for (const [key, count] of occurrence) {
      const answers = byKey.get(key);
      if (!answers) continue;
      hit += count * (answers.filter((r) => r.correct).length / answers.length);
      total += count;
    }
    return total ? hit / total : 0;
  };
  const schemes = LABEL_SCHEMES.filter((s) => rows.some((r) => r.scheme === s));
  const lines = [
    '# Laya: exhaustive single-step test of laya-best, and label variants',
    '',
    `- Timestamp: ${timestamp} · commit ${git('git rev-parse HEAD')}${git('git status --porcelain') ? ' (dirty)' : ''} · seed ${config.seed} · ${config.layaUrl}/v1/systemone`,
    `- laya-best: warmer/colder options, positive-only rule in state.body and instructions. Its request depends only on the open directions, which of them are warmer, the closeness phrase and the option order, so ${requests.filter((r) => r.orderKind === 'canonical').length} situations (15 open sets × every non-empty warmer subset × ${CLOSENESS_PHRASES.length} closeness phrases) cover every request it can send; each is sent in canonical (up, down, left, right) order and, with ≥2 options, one seeded shuffled order. Laya is deterministic, so each is sent once.`,
    '- Label schemes: moves (UP/DOWN/LEFT/RIGHT, as laya-best), compass (NORTH/SOUTH/EAST/WEST), neutral (PATH_A, PATH_B, … by position in the shown order, so the label says nothing about direction). Option text, rule and instructions are identical across schemes; answers are mapped back to moves in code.',
    `- Correct = the chosen direction is one of the warmer ones. Weighted = accuracy weighted by how often each situation occurs over the ${totalCells} walkable non-goal cells of the 128-entry suite (canonical and shuffled answers averaged). ${uncovered.length ? `Uncovered suite situations: ${uncovered.length}.` : 'Every suite situation is in the enumeration.'}`,
    `- Time budget ${config.budgetMs / 60_000} min; used ${seconds(performance.now() - started)}.`,
    ...notes.map((n) => `- ${n}`),
    '',
    '## Overall',
    '',
    '| Labels | Requests | Correct | Legal | Failed | Canonical order | Shuffled order | Weighted by suite occurrence | Mean latency | Mean input tokens |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const scheme of schemes) {
    const g = rows.filter((r) => r.scheme === scheme);
    const tokens = g.map((r) => r.inputTokens).filter((t): t is number => t !== null);
    lines.push(
      `| ${scheme} | ${g.length} | ${ratio(g)} | ${pct(g.filter((r) => r.legal).length / g.length)} | ${g.filter((r) => r.failure).length} | ${ratio(g.filter((r) => r.orderKind === 'canonical'))} | ${ratio(g.filter((r) => r.orderKind === 'shuffled'))} | ${pct(weighted(g))} | ${Math.round(mean(g.map((r) => r.latencyMs)) ?? 0)} ms | ${tokens.length ? Math.round(mean(tokens)!) : 'n/a'} |`,
    );
  }
  const breakdown = (title: string, keyOf: (r: Row) => string, order: string[], extra?: (k: string) => string) => {
    lines.push(
      '',
      `## By ${title}`,
      '',
      `| ${title} | ${extra ? 'Suite cells | ' : ''}${schemes.join(' | ')} |`,
      `|---|${extra ? '---:|' : ''}${schemes.map(() => '---:').join('|')}|`,
    );
    for (const k of order)
      lines.push(`| ${k} | ${extra ? `${extra(k)} | ` : ''}${schemes.map((s) => ratio(rows.filter((r) => r.scheme === s && keyOf(r) === k))).join(' | ')} |`);
  };
  const openSets = [...new Set(requests.map((r) => r.open.join(', ')))];
  const cellsWithOpen = (k: string) => String([...occurrence].filter(([key]) => key.split('|')[0] === k.replace(/, /g, '+')).reduce((t, [, c]) => t + c, 0));
  breakdown('directions offered', (r) => r.open.join(', '), openSets, cellsWithOpen);
  breakdown(
    'number of warmer options',
    (r) => `${r.warmer.length} of ${r.open.length}`,
    [...new Set(requests.map((r) => `${r.warmer.length} of ${r.open.length}`))].sort(),
  );
  breakdown('closeness', (r) => r.closeness, CLOSENESS_PHRASES);
  const wrong = rows.filter((r) => r.scheme === 'moves' && !r.correct);
  lines.push(
    '',
    `## Wrong laya-best (moves) answers: ${wrong.length}`,
    '',
    '| Options (order shown, ✓ = warmer) | Closeness | Answer | Suite cells |',
    '|---|---|---|---:|',
  );
  for (const r of wrong)
    lines.push(
      `| ${r.order.map((m) => `${m}${r.warmer.includes(m) ? ' ✓' : ''}`).join(', ')} | ${r.closeness} | ${r.answer ?? r.failure} | ${occurrence.get(r.key) ?? 0} |`,
    );
  if (mazeRuns.length) {
    const previousDir = (await fs.readdir(path.join(ROOT, 'benchmark-results', 'word-prompts-tuning')).catch(() => [] as string[]))
      .filter((d) => d.endsWith('-maze-check'))
      .sort()
      .at(-1);
    const previous: RunRecord[] = previousDir
      ? JSON.parse(await fs.readFile(path.join(ROOT, 'benchmark-results', 'word-prompts-tuning', previousDir, 'runs.json'), 'utf-8')).runs
      : [];
    lines.push(
      '',
      '## Maze check',
      '',
      `Same 8 entries, step cap max(3 × optimal, 60), stuck rule max(50, 2 × optimal), shuffle seeds as laya-best in \`benchmark-results/word-prompts-tuning/${previousDir}\`.`,
      '',
      '| Policy | Completed | Steps / optimal (completed) | Stuck | Wall choices | Toward stronger smell | Mean latency | ' +
        entries.map((e) => e.id).join(' | ') +
        ' |',
      `|---|---:|---|---:|---:|---:|---:|${entries.map(() => '---').join('|')}|`,
    );
    for (const id of [...new Set(mazeRuns.map((r) => r.policy))]) {
      const g = mazeRuns.filter((r) => r.policy === id);
      const a = aggregate(g);
      const smell = g
        .map((run) => towardStrongerSmell(entries.find((e) => e.id === run.mazeId)!, run.moves))
        .reduce((t, x) => ({ toward: t.toward + x.toward, chosen: t.chosen + x.chosen }), { toward: 0, chosen: 0 });
      const walls = g.reduce((t, r) => t + r.illegalMoves, 0);
      const steps = g.reduce((t, r) => t + r.steps, 0);
      lines.push(
        `| ${id} | ${a.completed}/${a.runs} | ${
          g
            .filter((r) => r.completed)
            .map((r) => `${r.steps}/${r.optimalSteps}`)
            .join(', ') || '—'
        } | ${a.stuck} | ${walls}/${steps} | ${smell.chosen ? pct(smell.toward / smell.chosen) : 'n/a'} | ${a.meanLatencyMs === null ? '—' : `${Math.round(a.meanLatencyMs)} ms`} | ${entries
          .map((e) => {
            const run = g.find((r) => r.mazeId === e.id);
            return run ? `${run.status} ${run.steps}` : 'not run';
          })
          .join(' | ')} |`,
      );
    }
    const isLayaBest = (r: RunRecord) => (r.policy as string) === 'laya-best';
    const replay = mazeRuns.filter(isLayaBest);
    if (replay.length && previous.length)
      lines.push(
        '',
        `laya-best reproduction: ${replay.filter((r) => JSON.stringify(previous.find((p) => isLayaBest(p) && p.mazeId === r.mazeId)?.moves) === JSON.stringify(r.moves)).length}/${replay.length} runs move-for-move identical to the earlier maze check.`,
      );
  } else lines.push('', '## Maze check', '', 'Not run: the time budget was used up first.');
  const example = requests.find(
    (r) => r.open.join() === 'up,down,right' && r.warmer.join() === 'down' && r.closeness === 'the smell is faint' && r.orderKind === 'shuffled',
  )!;
  lines.push(
    '',
    '## Example requests',
    '',
    `One situation (options ${example.order.join(', ')}; warmer: ${example.warmer.join(', ')}; ${example.closeness}) in each label scheme, exactly as sent. The key travels only in the Authorization header.`,
    '',
  );
  for (const scheme of LABEL_SCHEMES)
    lines.push(`### ${scheme}`, '', '```json', JSON.stringify(layaBestRequest(situationFor(example), scheme), null, 2), '```', '');
  await fs.writeFile(path.join(runDir, 'results.json'), redactSecrets(JSON.stringify({ timestamp, seed: config.seed, notes, bestScheme, rows }, null, 2)));
  await fs.writeFile(path.join(runDir, 'maze-runs.json'), runsJson({ timestamp, bestScheme }, mazeRuns));
  await fs.writeFile(path.join(runDir, 'report.md'), redactSecrets(lines.join('\n') + '\n'));
  console.log(`Done in ${seconds(performance.now() - started)}. Report: ${path.join(runDir, 'report.md')}`);
}

// Entry point: run with vite-node. Never import this file; shared code lives in full-maze-eval-lib.ts and word-prompt-builders.ts.
main().catch((error) => {
  console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
