import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  LEVEL2_SEED,
  THINK_TIMEOUT_MS,
  greedyPolicy,
  level2Entry,
  level2Files,
  ollamaPolicy,
  plannerPolicy,
  randomLegalPolicy,
  runLevel2,
  summariseLevel2,
  unsafeKind,
  type Level2Entry,
  type Level2Policy,
  type Level2Run,
} from '@/eval/level2-eval-lib';
import { catLine, filtersNearCat, label, type Level2Variant } from '@/game/prompt';
import { DEFAULT_LLM_CONFIG } from '@/llm/config';
import { OllamaClient } from '@/llm/ollama';

// Entry point for `npm run eval:level2`. Never import this file; the shared code is in level2-eval-lib.ts.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const SEED = Number(option('--seed', String(LEVEL2_SEED)));
const BUDGET_MS = Number(option('--time-budget-min', '15')) * 60_000;
const BASE_URL = process.env.OLLAMA_URL ?? DEFAULT_LLM_CONFIG.baseUrl;
const MODEL = process.env.OLLAMA_MODEL ?? DEFAULT_LLM_CONFIG.model;

const started = performance.now();
const elapsed = () => performance.now() - started;
const remaining = () => BUDGET_MS - elapsed();
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

class BudgetReached extends Error {}
type Examples = Map<string, Record<string, unknown>>;

async function main(): Promise<void> {
  if (args.includes('--compare-history')) return compareVariants(['cat-history', 'cat-position']);
  if (args.includes('--compare')) return compareVariants(option('--compare', '').split(',') as Level2Variant[]);
  const client = new OllamaClient({ baseUrl: BASE_URL, model: MODEL, temperature: 0.2 });
  const entries: Level2Entry[] = await Promise.all((await level2Files(ROOT)).map((file) => level2Entry(ROOT, file)));
  const safeSum = entries.reduce((t, e) => t + e.newGame().shortestSafe, 0);
  const capSum = entries.reduce((t, e) => t + e.newGame().stepCap, 0);
  console.log(
    `Plan: ${entries.length} levels. Free policies first, then cat-facts, cat-history, and cat-facts with thinking when the cat is sensed. Per Ollama variant: ${safeSum} requests if every run is optimal, at most ${capSum}. At ~0.9 s: ${((2 * safeSum * 0.9) / 60).toFixed(1)}–${((2 * capSum * 0.9) / 60).toFixed(1)} min for the two plain variants; the thinking variant gets what is left of ${BUDGET_MS / 60_000} min.`,
  );
  const timestamp = new Date().toISOString();
  const runDir = path.join(ROOT, 'benchmark-results', 'level2', timestamp.replace(/[:.]/g, '-'));
  await fs.mkdir(runDir, { recursive: true });
  await client.chat({ model: MODEL, messages: [{ role: 'user', content: 'Return only JSON: {"move":"up"}.' }], stream: false, think: false, format: 'json' });

  const examples: Examples = new Map();
  const capture = (variant: string) => (body: Record<string, unknown>, sensed: boolean) => {
    const key = `${variant}/${sensed ? 'sensed' : 'not sensed'}`;
    if (!examples.has(key)) examples.set(key, body);
  };
  const order: Level2Policy[] = [
    greedyPolicy,
    plannerPolicy,
    randomLegalPolicy,
    ollamaPolicy(client, MODEL, 'cat-facts', false, capture('cat-facts')),
    ollamaPolicy(client, MODEL, 'cat-history', false, capture('cat-history')),
    ollamaPolicy(client, MODEL, 'cat-facts', true),
  ];
  const runs: Level2Run[] = [];
  const skipped: string[] = [];
  let thinkingDropped = false;
  for (const policy of order)
    for (const entry of entries) {
      const thinkingVariant = policy.id.endsWith('+think');
      if (thinkingDropped && thinkingVariant) {
        skipped.push(`${entry.id}/${policy.id}`);
        continue;
      }
      if (!policy.free && remaining() <= 0) {
        skipped.push(`${entry.id}/${policy.id}`);
        continue;
      }
      // A thinking request may take up to its timeout; stop the variant as soon as one might not fit.
      const guarded: Level2Policy = {
        ...policy,
        decide: async (game, offered, random) => {
          const needed = thinkingVariant && game.sense() ? THINK_TIMEOUT_MS : 0;
          if (!policy.free && remaining() <= needed) throw new BudgetReached();
          return policy.decide(game, offered, random);
        },
      };
      try {
        const run = await runLevel2(entry, guarded, SEED);
        runs.push(run);
        console.log(
          `${entry.id}/${policy.id} → ${run.status}${run.catchCase ? ` (${run.catchCase}, step ${run.caughtOnStep})` : ''} in ${run.steps} (shortest safe ${run.shortestSafe}), mood ${run.finalMood} · ${(elapsed() / 1000).toFixed(0)} s`,
        );
      } catch (error) {
        if (!(error instanceof BudgetReached)) throw error;
        skipped.push(`${entry.id}/${policy.id} (stopped mid-run)`);
        if (thinkingVariant) thinkingDropped = true;
        console.log(`${entry.id}/${policy.id} → stopped: time budget`);
      }
    }
  await fs.writeFile(path.join(runDir, 'runs.json'), JSON.stringify(runs, null, 2));
  const meta = {
    timestamp,
    commit: git('git rev-parse --short HEAD'),
    dirty: git('git status --porcelain') !== '',
    model: MODEL,
    seed: SEED,
    elapsedMs: elapsed(),
    skipped,
  };
  await fs.writeFile(path.join(runDir, 'report.md'), report(meta, entries, order, runs, examples));
  console.log(`Done in ${(elapsed() / 60_000).toFixed(1)} min. Report: ${path.relative(ROOT, path.join(runDir, 'report.md'))}`);
}

function report(meta: Record<string, any>, entries: Level2Entry[], order: Level2Policy[], runs: Level2Run[], examples: Examples): string {
  const lines = [
    '# Level 2 evaluation: the patrolling cat',
    '',
    `- ${meta.timestamp} · commit ${meta.commit}${meta.dirty ? ' (uncommitted changes)' : ''} · seed ${meta.seed} · Ollama ${meta.model} · temperature 0.2, JSON-schema answer`,
    `- Time used: ${(meta.elapsedMs / 60_000).toFixed(1)} min of 15. ${meta.skipped.length ? `Not run (budget): ${meta.skipped.join(', ')}.` : 'Everything planned ran.'}`,
    `- Levels: ${entries.map((e) => `${e.id} (shortest safe ${e.newGame().shortestSafe})`).join(', ')}. Step cap max(3 × shortest safe, 100); stuck when no new cell for max(50, 2 × shortest safe) steps.`,
    "- **cat-history** (A): the cat line only. **cat-facts** (B): also each option's walking distance to the cat's current cell. **cat-facts+think**: B with think on (60 s timeout) only on steps where the cat is sensed. **planner** follows the safe-path search; **greedy** ignores the cat.",
    '- A sensed choice is *safe* when the mouse is not caught and does not end one block from the cat after its move.',
    '',
    '## Per policy',
    '',
    '| Policy | Completed | Caught | Steps / shortest safe (completed) | Final mood (mean) | −100 / −200 penalties | Safe when sensed | Invalid | Latency mean / p95 |',
    '|---|---:|---:|---|---:|---:|---:|---:|---:|',
  ];
  const ids = order.map((p) => p.id).filter((id) => runs.some((r) => r.policy === id));
  for (const id of ids) {
    const group = runs.filter((r) => r.policy === id);
    const s = summariseLevel2(group);
    const done = group.filter((r) => r.status === 'solved');
    lines.push(
      `| ${id} | ${s.completed}/${group.length} | ${s.caught} | ${done.map((r) => `${r.steps}/${r.shortestSafe}`).join(', ') || '—'} | ${Math.round(group.reduce((t, r) => t + r.finalMood, 0) / group.length)} | ${s.penalties100} / ${s.penalties200} | ${s.safeSensed}/${s.sensedSteps} (${pct(s.safeSensed, s.sensedSteps)}) | ${s.invalid} | ${s.latency.mean === null ? '—' : `${ms(s.latency.mean)} / ${ms(s.latency.p95)}`} |`,
    );
  }
  const think = runs.filter((r) => r.policy.endsWith('+think'));
  if (think.length) {
    const s = summariseLevel2(think);
    lines.push(
      '',
      `Thinking variant latency: sensed steps (think on) ${ms(s.latencySensed.mean)} mean / ${ms(s.latencySensed.p95)} p95; not sensed (think off) ${ms(s.latencyNotSensed.mean)} / ${ms(s.latencyNotSensed.p95)}. Failed requests: ${s.failures}.`,
    );
  }

  lines.push('', '## Per level', '', `| Level | ${ids.join(' | ')} |`, `|---|${ids.map(() => '---').join('|')}|`);
  for (const entry of entries)
    lines.push(
      `| ${entry.id} | ${ids
        .map((id) => {
          const r = runs.find((x) => x.entry === entry.id && x.policy === id);
          return r ? `${r.status}${r.caughtOnStep ? ` @${r.caughtOnStep}` : ''} ${r.steps}/${r.shortestSafe} · mood ${r.finalMood}` : 'not run';
        })
        .join(' | ')} |`,
    );

  lines.push('', '## Catches', '');
  const caught = runs.filter((r) => r.status === 'caught');
  if (!caught.length) lines.push('None.');
  for (const r of caught) lines.push(`- ${r.policy} on ${r.entry}: turn ${r.caughtOnStep}, ${r.catchCase}`);

  lines.push('', '## Unsafe choices with the cat sensed: one example of each kind per policy', '');
  for (const id of ids.filter((x) => !['greedy', 'planner', 'random-legal'].includes(x))) {
    const seen = new Set<string>();
    for (const r of runs.filter((x) => x.policy === id))
      for (const step of r.records) {
        const kind = step.sense ? unsafeKind(step) : null;
        if (!kind || seen.has(kind)) continue;
        seen.add(kind);
        lines.push(
          `- **${id}, ${kind}:** ${r.entry} turn ${step.step}. Cat sensed ${step.sense!.distance} block(s) ${step.sense!.direction}, history [${step.sense!.history.join(', ')}]. Offered ${step.offered.map((o) => `${label(o.direction)} ${o.level}`).join(' · ')}; chose ${step.answer ? label(step.answer) : 'nothing valid'}.`,
        );
      }
    if (!seen.size) lines.push(`- **${id}:** no unsafe choices.`);
  }

  lines.push('', '## Example prompts', '');
  for (const key of ['cat-history/sensed', 'cat-facts/sensed', 'cat-facts/not sensed']) {
    const body = examples.get(key);
    if (!body) continue;
    lines.push(
      `### ${key}`,
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

/**
 * Level-2 prompt variants side by side, on every level (or those named by --levels, as file-name prefixes) with
 * --seeds seeds (default two, the same for every variant). --baselines adds greedy and the planner.
 */
async function compareVariants(variants: Level2Variant[]): Promise<void> {
  const client = new OllamaClient({ baseUrl: BASE_URL, model: MODEL, temperature: 0.2 });
  const prefixes = option('--levels', '').split(',').filter(Boolean);
  const files = (await level2Files(ROOT)).filter((file) => !prefixes.length || prefixes.some((prefix) => path.basename(file).startsWith(prefix)));
  const entries: Level2Entry[] = await Promise.all(files.map((file) => level2Entry(ROOT, file)));
  const seeds = Array.from({ length: Number(option('--seeds', '2')) }, (_, i) => SEED + i);
  const baselines = args.includes('--baselines') ? [greedyPolicy, plannerPolicy] : [];
  const policyIds = [...baselines.map((policy) => policy.id), ...variants];
  const runsPlanned = variants.length * seeds.length; // Ollama runs per level
  const safeSum = entries.reduce((t, e) => t + e.newGame().shortestSafe, 0);
  const capSum = entries.reduce((t, e) => t + e.newGame().stepCap, 0);
  console.log(
    `Plan: ${variants.length} variants × ${entries.length} levels × ${seeds.length} seeds = ${runsPlanned * entries.length} runs, ${runsPlanned * safeSum}–${runsPlanned * capSum} requests; at ~0.9 s: ${((runsPlanned * safeSum * 0.9) / 60).toFixed(1)}–${((runsPlanned * capSum * 0.9) / 60).toFixed(1)} min. Budget ${BUDGET_MS / 60_000} min.`,
  );
  const timestamp = new Date().toISOString();
  const runDir = path.join(ROOT, 'benchmark-results', 'level2', `${timestamp.replace(/[:.]/g, '-')}-compare`);
  await fs.mkdir(runDir, { recursive: true });
  await client.chat({ model: MODEL, messages: [{ role: 'user', content: 'Return only JSON: {"move":"up"}.' }], stream: false, think: false, format: 'json' });
  const allRuns: (Level2Run & { seed: number })[] = [];
  const skipped: string[] = [];
  // Seed by seed, every variant per level, so a budget stop leaves the comparison balanced.
  for (const seed of seeds)
    for (const entry of entries)
      for (const id of policyIds) {
        const name = `${entry.id}/${id}/seed ${seed}`;
        const policy = baselines.find((baseline) => baseline.id === id) ?? ollamaPolicy(client, MODEL, id as Level2Variant);
        if (!policy.free && remaining() <= 0) {
          skipped.push(name);
          continue;
        }
        const guarded: Level2Policy = {
          ...policy,
          decide: async (game, offered, random) => {
            if (!policy.free && remaining() <= 0) throw new BudgetReached();
            return policy.decide(game, offered, random);
          },
        };
        try {
          const run = { ...(await runLevel2(entry, guarded, seed)), seed };
          allRuns.push(run);
          console.log(
            `${name} → ${run.status}${run.catchCase ? ` (${run.catchCase}, step ${run.caughtOnStep})` : ''} in ${run.steps} (shortest safe ${run.shortestSafe}) · ${(elapsed() / 1000).toFixed(0)} s`,
          );
        } catch (error) {
          if (!(error instanceof BudgetReached)) throw error;
          skipped.push(`${name} (stopped mid-run)`);
        }
      }
  // Only levels and seeds that every variant finished count, so all variants are compared on the same runs.
  const complete = (r: Level2Run & { seed: number }) => policyIds.every((v) => allRuns.some((x) => x.entry === r.entry && x.seed === r.seed && x.policy === v));
  const runs = allRuns.filter(complete);
  const unbalanced = allRuns.filter((r) => !complete(r)).map((r) => `${r.entry}/${r.policy}/seed ${r.seed}`);
  await fs.writeFile(path.join(runDir, 'runs.json'), JSON.stringify(allRuns, null, 2));
  const lines = [
    `# Level 2: ${policyIds.join(' vs ')}${prefixes.length ? ` on ${entries.map((e) => e.id).join(', ')}` : ''}`,
    '',
    `- ${timestamp} · commit ${git('git rev-parse --short HEAD')}${git('git status --porcelain') ? ' (uncommitted changes)' : ''} · seeds ${seeds.join(', ')} (the same for every variant) · Ollama ${MODEL} · think off, temperature 0.2`,
    `- Time used: ${(elapsed() / 60_000).toFixed(1)} min of ${BUDGET_MS / 60_000}. ${skipped.length ? `Not run (budget): ${skipped.join(', ')}.` : 'Everything planned ran.'}`,
    ...(unbalanced.length ? [`- Finished, but left out because not every variant ran that level and seed: ${unbalanced.join(', ')} (kept in runs.json).`] : []),
    '- A sensed choice is safe when the mouse is not caught and does not end one block from the cat. "Sensed" uses each variant\'s own sensing range.',
    '',
    '| Variant | Completed | Caught | Steps / shortest safe (completed) | Safe when sensed | Invalid | Steps filtered (options removed) | Trapped | Not sensed: colder | Not sensed: not the warmest when warmer offered | Latency mean / p95 |',
    '|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const variant of policyIds) {
    const group = runs.filter((r) => r.policy === variant);
    const s = summariseLevel2(group);
    lines.push(
      `| ${variant} | ${s.completed}/${group.length} | ${s.caught} | ${
        group
          .filter((r) => r.status === 'solved')
          .map((r) => `${r.steps}/${r.shortestSafe}`)
          .join(', ') || '—'
      } | ${s.safeSensed}/${s.sensedSteps} (${pct(s.safeSensed, s.sensedSteps)}) | ${s.invalid} | ${filtersNearCat(variant as Level2Variant) ? `${s.filteredSteps}/${group.reduce((t, r) => t + r.steps, 0)} steps (${s.removedOptions})` : '—'} | ${filtersNearCat(variant as Level2Variant) ? `${s.trappedSteps} steps` : '—'} | ${s.notSensedColder}/${s.notSensedAnswered} (${pct(s.notSensedColder, s.notSensedAnswered)}) | ${s.notSensedNotWarmest}/${s.notSensedWarmerOffered} (${pct(s.notSensedNotWarmest, s.notSensedWarmerOffered)}) | ${ms(s.latency.mean)} / ${ms(s.latency.p95)} |`,
    );
  }
  lines.push(
    '',
    '## Per level',
    '',
    `| Level | ${seeds.flatMap((seed) => policyIds.map((v) => `${v} · seed ${seed}`)).join(' | ')} |`,
    `|---|${seeds.flatMap(() => policyIds.map(() => '---')).join('|')}|`,
  );
  for (const entry of entries)
    lines.push(
      `| ${entry.id} | ${seeds
        .flatMap((seed) =>
          policyIds.map((v) => {
            const r = runs.find((x) => x.entry === entry.id && x.policy === v && x.seed === seed);
            return r ? `${r.status}${r.caughtOnStep ? ` @${r.caughtOnStep}` : ''} ${r.steps}/${r.shortestSafe}` : 'not run';
          }),
        )
        .join(' | ')} |`,
    );
  lines.push('', '## Catches', '', 'For each catch: whether the cat was sensed, its last moves, the options exactly as shown, and the move chosen.', '');
  const caught = runs.filter((r) => r.status === 'caught');
  if (!caught.length) lines.push('None.');
  for (const r of caught) {
    const last = r.records.at(-1)!;
    const optionLines = (last.prompt ?? '').split('\n').filter((line) => /^[A-Z-]+: /.test(line));
    lines.push(
      `- **${r.policy}**, ${r.entry}, seed ${r.seed}, turn ${r.caughtOnStep} (${r.catchCase}). ${last.sense ? `Sensed: ${last.sense.distance} block(s) ${last.sense.direction}` : 'Not sensed'}; the cat's last moves: ${last.catHistory.length ? last.catHistory.join(', ') : 'none'}; told: "${catLine(last.sense, r.policy !== 'cat-position')}"${filtersNearCat(r.policy as Level2Variant) ? (last.trapped ? ' Trapped: every option was next to the cat.' : ` Options removed by the filter: ${last.removed}.`) : ''} Chose **${last.answer ? label(last.answer) : 'nothing valid'}** from:`,
      '',
      ...optionLines.map((line) => `    ${line}`),
      '',
    );
  }
  await fs.writeFile(path.join(runDir, 'report.md'), lines.join('\n') + '\n');
  console.log(`Done in ${(elapsed() / 60_000).toFixed(1)} min. Report: ${path.relative(ROOT, path.join(runDir, 'report.md'))}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
