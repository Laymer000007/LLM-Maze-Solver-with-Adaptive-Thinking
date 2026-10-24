import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';

import {
  ROOT,
  SLEEP_MS,
  TIMEOUT_MS,
  aggregate,
  buildSuiteEntry,
  callOllamaRaw,
  redactSecrets,
  rng,
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
  INTRO,
  OLLAMA_RETURN,
  enumerateSituations,
  ollamaAnswerToMove,
  ollamaBestPrompt,
  situationFor,
  situationOf,
  stepCapFor,
  towardStrongerSmell,
  type EnumeratedRequest,
  type OllamaLabels,
} from '@/benchmark/word-prompt-builders';
import type { Move } from '@/execution/execution';
import { Maze } from '@/maze/maze';

// Qwen3 only: ollama-best with direction labels vs compass labels. Single step on 200 sampled laya-exhaustive
// situations, then the 8-entry maze check. Builders are in word-prompt-builders.ts.

type Config = { budgetMs: number; seed: number; outputDir: string; ollamaUrl: string; ollamaModel: string };
type Row = EnumeratedRequest & {
  arm: OllamaLabels;
  content: string | null;
  move: Move | null;
  legal: boolean;
  toward: boolean;
  latencyMs: number;
  promptTokens: number | null;
  failure: string | null;
};

const SAMPLE_SIZE = 200;
const MAZE_ENTRIES = ['7x7_corridor_branch', '7x7_open_detour', '11x11_corridor_dead-end', '15x15_corridor_spiral'];
const PRIOR_LATENCY_MS = 450;
const ARM_ID: Record<OllamaLabels, string> = { moves: 'ollama-best', compass: 'ollama-best-compass' };
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
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

function armPolicy(labels: OllamaLabels, config: Config, guard: () => void): Policy {
  return {
    id: ARM_ID[labels] as PolicyId, // experiment-only id
    kind: 'ollama',
    deterministic: true,
    config: {
      payloadBuilder: `ollamaBestPrompt(${labels})`,
      endpoint: `${config.ollamaUrl}/api/chat`,
      model: config.ollamaModel,
      think: false,
      temperature: 0.2,
      format: 'json',
      optionOrdering: 'legal moves, seeded shuffle per request',
      sees: 'warmer/colder per direction (words)',
    },
    decide: async (state, random): Promise<Decision> => {
      guard();
      const order = seededShuffle(state.validActions, random);
      const r = await callOllamaRaw(config.ollamaUrl, config.ollamaModel, ollamaBestPrompt(situationOf(state, order), labels), TIMEOUT_MS);
      const move = ollamaAnswerToMove(labels, r.content);
      return {
        choice: move,
        latencyMs: r.latencyMs,
        presented: order,
        ...(r.failure ? { failure: r.failure, error: r.error } : move ? {} : { failure: 'parse', error: `Unrecognised answer: ${r.content}` }),
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
    outputDir: path.resolve(get('--output-dir') ?? path.join(ROOT, 'benchmark-results', 'ollama-compass')),
    ollamaUrl: process.env.OLLAMA_URL ?? 'http://192.168.88.100:11434',
    ollamaModel: process.env.OLLAMA_MODEL ?? 'qwen3:1.7b',
  };
  if (!(config.budgetMs > 0)) throw new Error('--time-budget-min must be a positive number.');
  const started = performance.now();
  const remaining = () => config.budgetMs - (performance.now() - started);
  const guard = () => {
    if (remaining() <= 0) throw new BudgetReached();
  };
  const sample = seededShuffle(enumerateSituations(config.seed), rng(runSeed(config.seed, 'ollama-compass-sample'))).slice(0, SAMPLE_SIZE);
  const entries: SuiteEntry[] = [];
  for (const name of MAZE_ENTRIES) {
    const maze = await Maze.fromFile(path.join(ROOT, 'mazes', `${name}.txt`));
    for (const transform of ['original', 'rotate-180'] as const) entries.push(buildSuiteEntry(maze.layout, `mazes/${name}.txt`, transform));
  }
  const mazeMax = entries.reduce((t, e) => t + stepCapFor(e.optimalSteps), 0);
  console.log(
    `Plan, budget ${config.budgetMs / 60_000} min, ${config.ollamaModel}, think:false, temperature 0.2:\n` +
      `  1. ${SAMPLE_SIZE} situations (seeded sample of the 504 laya-exhaustive situations) × 2 arms = ${2 * SAMPLE_SIZE} requests (~${seconds(2 * SAMPLE_SIZE * (PRIOR_LATENCY_MS + SLEEP_MS))})\n` +
      `  2. the better arm, then the other, on ${entries.length} maze entries: ≤${mazeMax} requests each (~${seconds(mazeMax * (PRIOR_LATENCY_MS + SLEEP_MS))} each at the cap; ollama-best took ~150 s last time); a run is skipped if its cap would not fit`,
  );
  const warm = await callOllamaRaw(config.ollamaUrl, config.ollamaModel, `${INTRO}\n${OLLAMA_RETURN}`, TIMEOUT_MS);
  console.log(`warm-up ollama: ${warm.failure ?? warm.content} ${Math.round(warm.latencyMs)} ms`);
  if (warm.failure === 'http') throw new Error(`Ollama warm-up failed: ${warm.error}`);
  const timestamp = new Date().toISOString();
  const runDir = path.join(config.outputDir, timestamp.replace(/[:.]/g, '-'));
  await fs.mkdir(runDir, { recursive: true });
  const rows: Row[] = [];
  const notes: string[] = [];
  const mazeRuns: RunRecord[] = [];
  const summary = (arm: OllamaLabels) => {
    const g = rows.filter((r) => r.arm === arm);
    return {
      n: g.length,
      toward: g.filter((r) => r.toward).length,
      legal: g.filter((r) => r.legal).length,
      failed: g.filter((r) => r.failure).length,
      latency: mean(g.map((r) => r.latencyMs)) ?? PRIOR_LATENCY_MS,
      tokens: mean(g.map((r) => r.promptTokens).filter((t): t is number => t !== null)),
    };
  };
  let better: OllamaLabels | null = null;
  try {
    for (const arm of ['moves', 'compass'] as OllamaLabels[]) {
      for (const request of sample) {
        guard();
        const r = await callOllamaRaw(config.ollamaUrl, config.ollamaModel, ollamaBestPrompt(situationFor(request), arm), TIMEOUT_MS);
        const move = ollamaAnswerToMove(arm, r.content);
        rows.push({
          ...request,
          arm,
          content: r.content,
          move,
          legal: move !== null && request.open.includes(move),
          toward: move !== null && request.warmer.includes(move),
          latencyMs: Math.round(r.latencyMs),
          promptTokens: r.promptTokens,
          failure: r.failure ?? (move ? null : 'parse'),
        });
        await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
      }
      const s = summary(arm);
      console.log(
        `${ARM_ID[arm]}: toward ${s.toward}/${s.n}, legal ${s.legal}/${s.n}, ${s.failed} failed, ${Math.round(s.latency)} ms · elapsed ${seconds(performance.now() - started)}`,
      );
    }
    const [a, b] = [summary('moves'), summary('compass')];
    better = b.toward > a.toward || (b.toward === a.toward && (b.legal > a.legal || (b.legal === a.legal && b.latency < a.latency))) ? 'compass' : 'moves';
    notes.push(`Better arm: ${ARM_ID[better]} (toward ${a.toward} vs ${b.toward} of ${SAMPLE_SIZE} for moves vs compass).`);
    for (const arm of [better, better === 'compass' ? 'moves' : 'compass'] as OllamaLabels[])
      for (const entry of entries) {
        const projected = stepCapFor(entry.optimalSteps) * (summary(arm).latency + SLEEP_MS);
        if (projected > remaining()) {
          notes.push(`Skipped ${entry.id}/${ARM_ID[arm]}: up to ${seconds(projected)} needed, ${seconds(Math.max(0, remaining()))} left.`);
          console.log(notes.at(-1));
          continue;
        }
        const run = await runEpisode(entry, armPolicy(arm, config, guard), config.seed, {
          stepCap: stepCapFor(entry.optimalSteps),
          stuckWindow: stuckWindowFor(entry.optimalSteps),
          rngSeed: runSeed(config.seed, entry.id, 'ollama-best'),
        });
        mazeRuns.push(run);
        console.log(
          `${entry.id}/${ARM_ID[arm]} → ${run.status} in ${run.steps}/${run.stepCap} (optimal ${run.optimalSteps}), walls ${run.illegalMoves}, ${seconds(run.wallClockMs)} · elapsed ${seconds(performance.now() - started)}`,
        );
      }
  } catch (error) {
    if (!(error instanceof BudgetReached)) throw error;
    notes.push(`Time budget reached after ${seconds(performance.now() - started)}; the report covers what finished.`);
    console.log(notes.at(-1));
  }

  // ---------- Report ----------
  const arms = (['moves', 'compass'] as OllamaLabels[]).filter((arm) => rows.some((r) => r.arm === arm));
  const lines = [
    '# Qwen3: ollama-best with direction vs compass labels',
    '',
    `- Timestamp: ${timestamp} · commit ${git('git rev-parse HEAD')}${git('git status --porcelain') ? ' (dirty)' : ''} · seed ${config.seed} · ${config.ollamaModel} at ${config.ollamaUrl}, think:false, temperature 0.2`,
    '- ollama-best: warmer/colder options, full rule, options labelled UP/DOWN/LEFT/RIGHT, answer {"move":"up|down|left|right"}. ollama-best-compass: the same prompt with NORTH/SOUTH/EAST/WEST labels and answer {"move":"north|south|east|west"}, mapped back to moves in code. A test checks that only the option labels and the answer-format line differ.',
    `- Single step: the same ${SAMPLE_SIZE} situations for both arms, a seeded sample of the 504 laya-exhaustive situations (each with its canonical or shuffled option order), 1 request each. Toward = the answer is a warmer direction; legal = an offered direction; failed = no direction word in the answer.`,
    `- Time budget ${config.budgetMs / 60_000} min; used ${seconds(performance.now() - started)}.`,
    ...notes.map((n) => `- ${n}`),
    '',
    '## Single step',
    '',
    '| Arm | Situations | Toward stronger | Legal | Failed | Mean latency | Mean prompt tokens |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const arm of arms) {
    const s = summary(arm);
    lines.push(
      `| ${ARM_ID[arm]} | ${s.n} | ${s.toward}/${s.n} (${pct(s.toward / s.n)}) | ${s.legal}/${s.n} (${pct(s.legal / s.n)}) | ${s.failed} | ${Math.round(s.latency)} ms | ${s.tokens === null ? 'n/a' : Math.round(s.tokens)} |`,
    );
  }
  const both = new Map<string, Row[]>();
  for (const r of rows) both.set(`${r.key}|${r.orderKind}`, [...(both.get(`${r.key}|${r.orderKind}`) ?? []), r]);
  const pairs = [...both.values()].filter((p) => p.length === 2);
  lines.push(
    '',
    `Same situation, both arms: both toward ${pairs.filter((p) => p.every((r) => r.toward)).length}, only ollama-best ${pairs.filter((p) => p[0].toward && !p[1].toward).length}, only compass ${pairs.filter((p) => !p[0].toward && p[1].toward).length}, neither ${pairs.filter((p) => p.every((r) => !r.toward)).length} (of ${pairs.length}).`,
  );
  for (const arm of arms) {
    const wrong = rows.filter((r) => r.arm === arm && !r.toward);
    const kind = (r: Row) =>
      r.move === null ? `no direction (${JSON.stringify(r.content)})` : !r.legal ? `${r.move}: not offered` : `${r.move}: offered, colder`;
    const counts = [...wrong.reduce((m, r) => m.set(kind(r), (m.get(kind(r)) ?? 0) + 1), new Map<string, number>())].sort((x, y) => y[1] - x[1]);
    lines.push(
      '',
      `## ${ARM_ID[arm]}: wrong answers (${wrong.length})`,
      '',
      '| Answer (as a move) | Count |',
      '|---|---:|',
      ...counts.slice(0, 10).map(([k, c]) => `| ${k} | ${c} |`),
    );
    const bySet = [...wrong.reduce((m, r) => m.set(r.open.join(', '), (m.get(r.open.join(', ')) ?? 0) + 1), new Map<string, number>())].sort(
      (x, y) => y[1] - x[1],
    );
    lines.push(
      '',
      `Most wrong answers by directions offered: ${bySet
        .slice(0, 6)
        .map(([k, c]) => `${k} (${c}/${rows.filter((r) => r.arm === arm && r.open.join(', ') === k).length})`)
        .join('; ')}.`,
    );
    lines.push(
      '',
      '<details><summary>Every wrong answer</summary>',
      '',
      '| Options (order shown, ✓ = warmer) | Closeness | Answer |',
      '|---|---|---|',
      ...wrong.map(
        (r) =>
          `| ${r.order.map((m) => `${m}${r.warmer.includes(m) ? ' ✓' : ''}`).join(', ')} | ${r.closeness} | ${r.content === null ? r.failure : r.content.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`,
      ),
      '',
      '</details>',
    );
  }
  if (mazeRuns.length) {
    lines.push(
      '',
      '## Maze check',
      '',
      'Same 8 entries as the earlier maze checks; step cap max(3 × optimal, 60), stuck rule max(50, 2 × optimal), option shuffle seeded as ollama-best was. Ollama samples at temperature 0.2, so repeated runs can differ.',
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
    lines.push(
      '',
      'Earlier ollama-best maze check (`benchmark-results/word-prompts-tuning/2026-10-24T15-17-39-284Z-maze-check`): 8/8 completed; 20/8, 10/8, 16/8, 8/8, 36/32, 36/32, 102/96, 98/96.',
    );
  } else lines.push('', '## Maze check', '', 'Not run: the time budget was used up first.');
  const example = sample.find((r) => r.orderKind === 'shuffled' && r.open.length === 3) ?? sample[0];
  lines.push(
    '',
    '## Example prompts',
    '',
    `One sampled situation (options ${example.order.join(', ')}; warmer: ${example.warmer.join(', ')}; ${example.closeness}), as the model reads it. The request body is ollamaRequestBody(model, prompt, think:false) with temperature 0.2.`,
    '',
  );
  for (const arm of ['moves', 'compass'] as OllamaLabels[])
    lines.push(`### ${ARM_ID[arm]}`, '', '```text', ollamaBestPrompt(situationFor(example), arm), '```', '');
  await fs.writeFile(path.join(runDir, 'results.json'), redactSecrets(JSON.stringify({ timestamp, seed: config.seed, notes, better, rows }, null, 2)));
  await fs.writeFile(path.join(runDir, 'maze-runs.json'), runsJson({ timestamp, better }, mazeRuns));
  await fs.writeFile(path.join(runDir, 'report.md'), redactSecrets(lines.join('\n') + '\n'));
  console.log(`Done in ${seconds(performance.now() - started)}. Report: ${path.join(runDir, 'report.md')}`);
}

// Entry point: run with vite-node. Never import this file; shared code lives in full-maze-eval-lib.ts and word-prompt-builders.ts.
main().catch((error) => {
  console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
