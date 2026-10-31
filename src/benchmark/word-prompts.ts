import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';

import {
  type Policy,
  type RunRecord,
  SLEEP_MS,
  type SuiteEntry,
  TIMEOUT_MS,
  aggregate,
  buildSuiteEntry,
  callOllama,
  runEpisode,
  runSeed,
  runsCsv,
  runsJson,
  stuckWindowFor,
} from '@/benchmark/full-maze-eval-lib';
import {
  type CapturedRequest,
  INTRO,
  MAZES,
  OLLAMA_RETURN,
  ORIENTATIONS,
  VARIANTS,
  baselinePolicy,
  createWordPolicy,
  stepCapFor,
  towardStrongerSmell,
} from '@/benchmark/word-prompt-builders';
import { Maze } from '@/maze/maze';

// Experiment: "hotter/colder" word prompts vs the numeric constrained prompt, for Ollama. Builders are in
// word-prompt-builders.ts; production prompts are untouched.

type Config = { budgetMs: number; seed: number; outputDir: string; ollamaUrl: string; ollamaModel: string };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    '# Word prompts vs numbers: Ollama',
    '',
    `- Timestamp: ${meta.timestamp} · commit ${meta.gitCommit}${meta.gitDirty ? ' (dirty)' : ''} · seed ${meta.seed}`,
    `- Entries: ${entries.map((e) => `${e.id} (optimal ${e.optimalSteps})`).join(', ')}`,
    `- Step cap max(3 × optimal, 60); stuck when no new cell for max(50, 2 × optimal) steps; ${TIMEOUT_MS / 1000} s timeout; abort after 3 failed requests in a row; ${SLEEP_MS} ms between requests`,
    `- Option order shuffled per request with a seeded RNG for every model variant. Ollama ${meta.ollamaModel}, think=false, temperature 0.2.`,
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
  lines.push(
    '',
    '## Example requests',
    '',
    "The second request of each policy's first run (so the feedback variant shows a step result), exactly as sent.",
    '',
  );
  for (const policy of policies) {
    const example = examples.get(policy.id);
    if (!example) continue;
    lines.push(`### ${policy.id}`, '', `POST ${example.endpoint}`, '', '```json', JSON.stringify(example.body, null, 2), '```', '');
    const prompt = (example.body.messages as { content: string }[] | undefined)?.[0]?.content;
    if (prompt) lines.push('Prompt text as the model reads it:', '', '```text', prompt, '```', '');
  }
  return lines.join('\n') + '\n';
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
    ollamaUrl: process.env.OLLAMA_URL ?? 'http://192.168.88.100:11434',
    ollamaModel: process.env.OLLAMA_MODEL ?? 'qwen3:1.7b',
  };
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const started = performance.now();
  const overBudget = () => performance.now() - started > config.budgetMs;
  const entries: SuiteEntry[] = [];
  for (const file of MAZES) {
    const maze = await Maze.fromFile(path.join(ROOT, file));
    for (const transform of ORIENTATIONS) entries.push(buildSuiteEntry(maze.layout, file, transform));
  }
  const policyIds = ['scorer', 'random-legal', ...VARIANTS.map((variant) => `ollama-${variant}`)];
  const minRequests = VARIANTS.length * entries.reduce((t, e) => t + e.optimalSteps, 0);
  const maxRequests = VARIANTS.length * entries.reduce((t, e) => t + stepCapFor(e.optimalSteps), 0);
  // Smoke latency: Ollama ~0.5–0.65 s per request.
  const maxMinutes = (maxRequests * (0.65 + SLEEP_MS / 1000)) / 60;
  console.log(
    `Plan: ${entries.length} entries × ${policyIds.length} policies = ${entries.length * policyIds.length} runs. Model requests: ${minRequests} minimum (all optimal) to ${maxRequests} maximum (all hit the cap), about ${maxMinutes.toFixed(1)} min at the cap. Budget ${config.budgetMs / 60_000} min.`,
  );
  const timestamp = new Date().toISOString();
  const runDir = path.join(config.outputDir, timestamp.replace(/[:.]/g, '-'));
  await fs.mkdir(runDir, { recursive: true });
  const warm = await callOllama(config.ollamaUrl, config.ollamaModel, `${INTRO}\n${OLLAMA_RETURN}`, false, TIMEOUT_MS);
  console.log(`warm-up ollama: ${warm.failure ?? warm.choice} ${Math.round(warm.latencyMs ?? 0)} ms`);
  if (warm.failure === 'http') throw new Error(`Ollama warm-up failed: ${warm.error}`);
  const runs: RunRecord[] = [];
  const skipped: string[] = [];
  const examples = new Map<string, CapturedRequest>();
  const policiesForReport: Policy[] = [
    baselinePolicy('scorer'),
    baselinePolicy('random-legal'),
    ...VARIANTS.map((variant) => createWordPolicy(variant, config)),
  ];
  for (const entry of entries) {
    for (const id of policyIds) {
      const label = `${entry.id}/${id}`;
      if (overBudget()) {
        skipped.push(label);
        continue;
      }
      const spec = VARIANTS.find((variant) => `ollama-${variant}` === id);
      let count = 0;
      const policy = spec
        ? createWordPolicy(spec, config, (request) => {
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
        await fs.appendFile(path.join(runDir, 'runs.jsonl'), JSON.stringify(run) + '\n');
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
  await fs.writeFile(path.join(runDir, 'examples.json'), JSON.stringify(Object.fromEntries(examples), null, 2));
  await fs.writeFile(path.join(runDir, 'report.md'), report(meta, entries, policiesForReport, runs, skipped, examples));
  console.log(`Done in ${seconds(performance.now() - started)}. Report: ${path.join(runDir, 'report.md')}`);
}
// Entry point: run with vite-node. Never import this file; shared code lives in full-maze-eval-lib.ts and word-prompt-builders.ts.
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
