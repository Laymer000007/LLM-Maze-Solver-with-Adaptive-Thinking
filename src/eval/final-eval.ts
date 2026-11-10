import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  MAZES,
  ORIENTATIONS,
  VARIANTS,
  askOllama,
  buildEntry,
  enumerateSituations,
  greedyPolicy,
  ollamaPolicy,
  randomLegalPolicy,
  runEpisode,
  sampleSituations,
  summariseSingleStep,
  type Entry,
  type Policy,
  type RunRecord,
  type SingleStepRow,
} from '@/eval/final-eval-lib';
import { Game } from '@/game/game';
import { buildRequest, type Variant } from '@/game/prompt';
import { DEFAULT_LLM_CONFIG } from '@/llm/config';
import { OllamaClient } from '@/llm/ollama';
import { Maze } from '@/maze/maze';

// Entry point for `npm run eval:final`. Never import this file; the shared code is in final-eval-lib.ts.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const SEED = Number(option('--seed', '20261109'));
const SITUATIONS = Number(option('--situations', '200'));
const BUDGET_MS = Number(option('--time-budget-min', '15')) * 60_000;
const BASE_URL = process.env.OLLAMA_URL ?? DEFAULT_LLM_CONFIG.baseUrl;
const MODEL = process.env.OLLAMA_MODEL ?? DEFAULT_LLM_CONFIG.model;

const started = performance.now();
const elapsed = () => performance.now() - started;
const overBudget = () => elapsed() > BUDGET_MS;
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '—');
const ms = (value: number | null) => (value === null ? '—' : `${Math.round(value)} ms`);
const git = (command: string) => {
  try {
    return execSync(command, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
};

async function main(): Promise<void> {
  const client = new OllamaClient({ baseUrl: BASE_URL, model: MODEL, temperature: 0.2 });
  const entries: Entry[] = [];
  for (const file of MAZES) {
    const maze = await Maze.fromFile(path.join(ROOT, file));
    for (const orientation of ORIENTATIONS) entries.push(buildEntry(maze.layout, file, orientation));
  }
  const optimalSum = entries.reduce((t, e) => t + new Game(e.maze).optimal, 0);
  const capSum = entries.reduce((t, e) => t + new Game(e.maze).stepCap, 0);
  const all = enumerateSituations();
  console.log(
    `Plan: ${SITUATIONS} of ${all.length} situations × ${VARIANTS.length} variants = ${SITUATIONS * VARIANTS.length} requests, then ${entries.length} maze entries × ${VARIANTS.length} variants: ${optimalSum * VARIANTS.length} requests if every run is optimal, ${capSum * VARIANTS.length} if every run hits the cap. At ~0.6 s each: ${(((SITUATIONS + optimalSum) * VARIANTS.length * 0.6) / 60).toFixed(1)} min to ${(((SITUATIONS + capSum) * VARIANTS.length * 0.6) / 60).toFixed(1)} min. Budget ${BUDGET_MS / 60_000} min.`,
  );
  const timestamp = new Date().toISOString();
  const runDir = path.join(ROOT, 'benchmark-results', 'final', timestamp.replace(/[:.]/g, '-'));
  await fs.mkdir(runDir, { recursive: true });
  const skipped: string[] = [];

  // Warm-up: loads the model so the first measured request is not a cold start.
  await client.chat({ model: MODEL, messages: [{ role: 'user', content: 'Return only JSON: {"move":"up"}.' }], stream: false, think: false, format: 'json' });

  const situations = sampleSituations(SITUATIONS, SEED);
  const single: SingleStepRow[] = [];
  for (const [i, situation] of situations.entries()) {
    // Alternate which variant goes first, so neither gains from the other's cached prefix.
    for (const variant of i % 2 ? [...VARIANTS].reverse() : VARIANTS) {
      if (overBudget()) {
        skipped.push(`single-step ${situation.id}/${variant}`);
        continue;
      }
      const answer = await askOllama(client, MODEL, situation, variant);
      single.push({ id: situation.id, variant, offered: situation.options, mood: situation.mood, distance: situation.distance, ...answer });
    }
    if ((i + 1) % 25 === 0) console.log(`single step: ${i + 1}/${situations.length} · ${(elapsed() / 1000).toFixed(0)} s`);
  }
  await fs.writeFile(path.join(runDir, 'single-step.json'), JSON.stringify(single, null, 2));

  const policies: Policy[] = [greedyPolicy, randomLegalPolicy, ...VARIANTS.map((variant) => ollamaPolicy(client, MODEL, variant))];
  const runs: RunRecord[] = [];
  for (const entry of entries)
    for (const policy of policies) {
      if (overBudget()) {
        skipped.push(`${entry.id}/${policy.id}`);
        continue;
      }
      const guarded: Policy = {
        ...policy,
        decide: async (game, offered, random) => {
          if (overBudget()) throw new Error('budget');
          return policy.decide(game, offered, random);
        },
      };
      try {
        const run = await runEpisode(entry, guarded, SEED);
        runs.push(run);
        console.log(
          `${entry.id}/${policy.id} → ${run.status} in ${run.steps} (optimal ${run.optimal}), invalid ${run.invalid}, mood ${run.finalMood} · ${(elapsed() / 1000).toFixed(0)} s`,
        );
      } catch (error) {
        if (!(error instanceof Error && error.message === 'budget')) throw error;
        skipped.push(`${entry.id}/${policy.id} (stopped mid-run)`);
      }
    }
  await fs.writeFile(path.join(runDir, 'runs.json'), JSON.stringify(runs, null, 2));

  const meta = {
    timestamp,
    commit: git('git rev-parse --short HEAD'),
    dirty: git('git status --porcelain') !== '',
    model: MODEL,
    baseUrl: BASE_URL,
    seed: SEED,
    elapsedMs: elapsed(),
    skipped,
  };
  await fs.writeFile(path.join(runDir, 'report.md'), report(meta, all.length, single, runs, entries, situations[0]));
  console.log(`Done in ${(elapsed() / 60_000).toFixed(1)} min. Report: ${path.relative(ROOT, path.join(runDir, 'report.md'))}`);
}

function report(
  meta: Record<string, any>,
  total: number,
  single: SingleStepRow[],
  runs: RunRecord[],
  entries: Entry[],
  example: ReturnType<typeof sampleSituations>[number],
): string {
  const lines = [
    '# Final evaluation: words, 8 directions, mood',
    '',
    `- ${meta.timestamp} · commit ${meta.commit}${meta.dirty ? ' (uncommitted changes)' : ''} · seed ${meta.seed} · Ollama ${meta.model} · think off, temperature 0.2, JSON-schema answer`,
    `- Time used: ${(meta.elapsedMs / 60_000).toFixed(1)} min of 15. ${meta.skipped.length ? `Not run (budget): ${meta.skipped.length} items: ${meta.skipped.slice(0, 10).join(', ')}${meta.skipped.length > 10 ? ', …' : ''}.` : 'Everything planned ran.'}`,
    '- **full** is the final prompt; **smell-only** is the same without the mood rule, the mood line and the mood phrases. Options are legal directions only, shuffled with a seeded RNG; both variants see the same order.',
    '',
    '## Single step',
    '',
    `${single.length / VARIANTS.length} situations sampled with a fixed seed from ${total} distinct ones (open directions × level per direction × closeness × mood word).`,
    '',
    '| Variant | Warmest offered level | Warmer or better | Legal | First listed chosen | Mean latency | p95 latency | Prompt tokens (mean) | Of which cached (mean) | Failures |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  const summaries = VARIANTS.map((variant) => [variant, summariseSingleStep(single.filter((row) => row.variant === variant))] as const);
  for (const [variant, s] of summaries) {
    const n = s.situations - s.failures;
    lines.push(
      `| ${variant} | ${s.warmest}/${n} (${pct(s.warmest, n)}) | ${s.warmerOrBetter}/${n} (${pct(s.warmerOrBetter, n)}) | ${pct(s.legal, n)} | ${s.firstListed}/${n} (${pct(s.firstListed, n)}) | ${ms(s.meanLatencyMs)} | ${ms(s.p95LatencyMs)} | ${s.meanPromptTokens?.toFixed(0) ?? '—'} | ${s.meanCachedTokens?.toFixed(0) ?? '—'} | ${s.failures} |`,
    );
  }
  lines.push('', 'Most common wrong answers (chosen level and direction over the warmest offered level):', '');
  for (const [variant, s] of summaries)
    lines.push(
      `- **${variant}:** ${
        s.wrong.length
          ? s.wrong
              .slice(0, 6)
              .map(([k, v]) => `${k} ×${v}`)
              .join('; ')
          : 'none'
      }`,
    );

  lines.push(
    '',
    '## Mazes',
    '',
    `Entries: ${entries.map((e) => e.id).join(', ')}. One seed per entry. Step cap max(3 × optimal, 100) with optimal by BFS under the 8-direction rules; stuck when no new cell for max(50, 2 × optimal) steps.`,
    '',
  );
  lines.push('| Policy | Completed | Steps / optimal (completed runs) | Invalid answers | Final mood (mean) | Mean latency |', '|---|---:|---|---:|---:|---:|');
  for (const policy of ['greedy', 'random-legal', ...VARIANTS]) {
    const group = runs.filter((run) => run.policy === policy);
    if (!group.length) continue;
    const done = group.filter((run) => run.status === 'solved');
    const latencies = group.flatMap((run) => run.moves.map((m) => m.latencyMs).filter((n): n is number => n !== null));
    lines.push(
      `| ${policy} | ${done.length}/${group.length} | ${done.map((run) => `${run.steps}/${run.optimal}`).join(', ') || '—'} | ${group.reduce((t, run) => t + run.invalid, 0)} | ${Math.round(group.reduce((t, run) => t + run.finalMood, 0) / group.length)} | ${latencies.length ? ms(latencies.reduce((t, v) => t + v, 0) / latencies.length) : '—'} |`,
    );
  }
  lines.push('', '### Per entry', '', '| Entry | Optimal | greedy | random-legal | full | smell-only |', '|---|---:|---|---|---|---|');
  for (const entry of entries) {
    const cell = (policy: string) => {
      const run = runs.find((r) => r.entry === entry.id && r.policy === policy);
      return run ? `${run.status} ${run.steps} · invalid ${run.invalid} · mood ${run.finalMood} (${run.finalMoodWord})` : 'not run';
    };
    const optimal = runs.find((r) => r.entry === entry.id)?.optimal ?? '—';
    lines.push(`| ${entry.id} | ${optimal} | ${cell('greedy')} | ${cell('random-legal')} | ${cell('full')} | ${cell('smell-only')} |`);
  }

  lines.push('', '## Example prompts', '', `Situation ${example.id}, exactly as sent (the full request body, then the prompt text).`, '');
  for (const variant of VARIANTS as Variant[]) {
    const body = buildRequest(meta.model, example, variant);
    lines.push(
      `### ${variant}`,
      '',
      '```json',
      JSON.stringify(body, null, 2),
      '```',
      '',
      '```text',
      (body.messages as { content: string }[])[0].content,
      '```',
      '',
    );
  }
  return lines.join('\n') + '\n';
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
