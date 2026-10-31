import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';

import { AgentMemory } from '@/agent/memory';
import {
  ALL_POLICIES,
  DEFAULT_POLICIES,
  type DecisionState,
  type HarnessConfig,
  MAX_CONSECUTIVE_FAILURES,
  MOVES4,
  type Mode,
  type Policy,
  type PolicyId,
  REPETITIONS,
  ROOT,
  type RunRecord,
  SLEEP_MS,
  SMOKE_MAZE,
  SMOKE_TRANSFORMS,
  type SuiteEntry,
  TIER_A_POLICIES,
  TIER_B_POLICIES,
  TIMEOUT_MS,
  buildSuite,
  buildSuiteEntry,
  callOllama,
  constrainedPrompt,
  createPolicies,
  duration,
  freezeSuite,
  markdown,
  now,
  runEpisode,
  runSeed,
  runsCsv,
  runsJson,
  seedCount,
  tierBEntries,
} from '@/benchmark/full-maze-eval-lib';
import { Maze } from '@/maze/maze';

// CLI for the full-maze evaluation. The harness itself is in full-maze-eval-lib.ts.

// ---------- CLI ----------

function parseArgs(argv: string[]): HarnessConfig {
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const mode = (get('--mode') ?? 'smoke') as Mode;
  const modes: Mode[] = ['smoke', 'tier-a', 'tier-b'];
  if (!modes.includes(mode)) throw new Error(`Unknown --mode ${mode}; use ${modes.join(', ')}.`);
  const withThinking = argv.includes('--with-thinking');
  const think: PolicyId[] = withThinking ? ['ollama-constrained-think'] : [];
  const defaults: Record<Mode, PolicyId[]> = {
    smoke: [...DEFAULT_POLICIES, ...think],
    'tier-a': TIER_A_POLICIES,
    'tier-b': [...TIER_B_POLICIES, ...think],
  };
  const policies = (get('--policies')
    ?.split(',')
    .map((p) => p.trim())
    .filter(Boolean) ?? defaults[mode]) as PolicyId[];
  const unknown = policies.filter((p) => !ALL_POLICIES.includes(p));
  if (unknown.length) throw new Error(`Unknown policies: ${unknown.join(', ')}. Known: ${ALL_POLICIES.join(', ')}.`);
  if (policies.includes('ollama-constrained-think') && !withThinking) throw new Error('ollama-constrained-think requires --with-thinking.');
  const seed = Number(get('--seed') ?? '20261023');
  if (!Number.isInteger(seed)) throw new Error('--seed must be an integer.');
  return {
    mode,
    policies,
    seed,
    withThinking,
    outputDir: path.resolve(get('--output-dir') ?? path.join(ROOT, 'benchmark-results', 'full-maze-eval')),
    mazes:
      get('--mazes')
        ?.split(',')
        .map((m) => m.trim())
        .filter(Boolean) ?? null,
    timeoutMs: TIMEOUT_MS,
    ollamaUrl: process.env.OLLAMA_URL ?? 'http://192.168.88.100:11434',
    ollamaModel: process.env.OLLAMA_MODEL ?? 'qwen3:1.7b',
  };
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

async function preflight(config: HarnessConfig, policies: Policy[]): Promise<void> {
  const ollamaModes = [...new Set(policies.filter((p) => p.id.startsWith('ollama')).map((p) => p.config.think as boolean))];
  if (ollamaModes.length) {
    const tags = await fetch(`${config.ollamaUrl}/api/tags`).then((r) => r.json() as Promise<{ models?: { name: string }[] }>);
    if (!tags.models?.some((m) => m.name === config.ollamaModel)) throw new Error(`Ollama at ${config.ollamaUrl} does not list ${config.ollamaModel}.`);
  }
  const dummy = buildSuiteEntry(['#####', '#S G#', '#####'], 'preflight', 'original');
  const maze = new Maze(dummy.layout);
  const memory = new AgentMemory();
  const perception = maze.perceive(maze.startPosition);
  memory.rememberPerception(perception, true);
  const state: DecisionState = {
    position: maze.startPosition,
    goal: maze.goalPosition,
    perception,
    memory: memory.snapshot(),
    validActions: MOVES4.filter((m) => perception.directions[m] !== 'wall'),
  };
  for (const think of ollamaModes) {
    const r = await callOllama(config.ollamaUrl, config.ollamaModel, constrainedPrompt(state), think, config.timeoutMs);
    console.log(`warm-up ollama think=${think}: ${r.failure ?? r.choice} ${Math.round(r.latencyMs ?? 0)} ms`);
    if (r.failure === 'http') throw new Error(`Ollama warm-up failed: ${r.error}`);
  }
}

function selectEntries(mode: Mode, suite: SuiteEntry[]): SuiteEntry[] {
  if (mode === 'smoke') return suite.filter((e) => e.sourceFile === SMOKE_MAZE && SMOKE_TRANSFORMS.includes(e.transform));
  if (mode === 'tier-b') return tierBEntries(suite);
  return suite;
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const suite = await buildSuite();
  await freezeSuite(config.outputDir, suite);
  let entries = selectEntries(config.mode, suite);
  if (config.mazes) entries = entries.filter((e) => config.mazes!.some((m) => e.id.includes(m)));
  if (!entries.length) throw new Error('No suite entries selected.');
  const policies = createPolicies(config.policies, config);
  const jobs = entries.flatMap((entry) =>
    policies.flatMap((policy) => Array.from({ length: seedCount(policy, config.mode) }, (_, i) => ({ entry, policy, seed: config.seed + i }))),
  );
  const timestamp = now();
  const stamp = `${timestamp.replace(/[:.]/g, '-')}-${config.mode}`;
  const runDir = path.join(config.outputDir, stamp);
  await fs.mkdir(runDir, { recursive: true });
  const metadata = {
    timestamp,
    mode: config.mode,
    gitCommit: git('git rev-parse HEAD'),
    gitBranch: git('git rev-parse --abbrev-ref HEAD'),
    gitDirty: git('git status --porcelain') !== '',
    baseSeed: config.seed,
    seedRule: `smoke 1; scorer, fixed-rd 1; random-legal ${REPETITIONS}; Ollama 1`,
    runSeedRule: 'runSeed(seed, mazeId, policy) — FNV-1a mix; drives scorer ties, random-legal and shuffling',
    stepCapRule: 'max(4 * optimalSteps, 200)',
    stuckRule: 'max(50, 2 * optimalSteps)',
    timeoutMs: config.timeoutMs,
    maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
    sleepMs: SLEEP_MS,
    ollamaUrl: config.ollamaUrl,
    ollamaModel: config.ollamaModel,
    entries: entries.map((e) => e.id),
    policies: policies.map((p) => ({ id: p.id, kind: p.kind, seeds: seedCount(p, config.mode), ...p.config })),
    complete: false,
  };
  console.log(`${config.mode}: ${entries.length} entries × ${policies.length} policies → ${jobs.length} runs. Output: ${runDir}`);
  await preflight(config, policies);
  const runs: RunRecord[] = [];
  const started = performance.now();
  for (const [index, job] of jobs.entries()) {
    const run = await runEpisode(job.entry, job.policy, job.seed, { rngSeed: runSeed(job.seed, job.entry.id, job.policy.id) });
    runs.push(run);
    await fs.appendFile(path.join(runDir, 'runs.jsonl'), JSON.stringify(run) + '\n');
    console.log(
      `[${index + 1}/${jobs.length}] ${run.runId} → ${run.status} in ${run.steps}/${run.stepCap} steps (optimal ${run.optimalSteps}), illegal ${run.illegalMoves}, failed ${run.timeouts + run.httpFailures + run.parseFailures}, ${duration(run.wallClockMs)} · elapsed ${duration(performance.now() - started)}`,
    );
  }
  const finalMetadata = { ...metadata, complete: true, totalWallClockMs: Math.round(performance.now() - started) };
  const outputs: Record<string, string> = {
    'runs.json': runsJson(finalMetadata, runs),
    'runs.csv': runsCsv(runs),
    'report.md': markdown(config, finalMetadata, suite, entries, policies, runs),
  };
  for (const name of ['latest', ...(config.mode === 'smoke' ? [] : [`latest-${config.mode}`])]) {
    const latest = path.join(config.outputDir, name);
    await fs.rm(latest, { recursive: true, force: true });
    await fs.mkdir(latest, { recursive: true });
    for (const [file, body] of Object.entries(outputs)) await fs.writeFile(path.join(latest, file), body);
    await fs.writeFile(path.join(latest, 'SOURCE'), `${path.basename(runDir)}\n`);
  }
  for (const [file, body] of Object.entries(outputs)) await fs.writeFile(path.join(runDir, file), body);
  console.log(`Done in ${duration(performance.now() - started)}. Report: ${path.join(runDir, 'report.md')}`);
}
// Entry point: run with vite-node. Never import this file; shared code lives in full-maze-eval-lib.ts and word-prompt-builders.ts.
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
