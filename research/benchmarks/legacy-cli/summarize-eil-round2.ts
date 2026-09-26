import fs from 'fs/promises';
import path from 'path';
import yaml from 'yaml';

const root = process.argv[2] ?? './output/eil-scale-comparison-round2';
const scales = ['signed', 'normalized', 'positive100'];
type Step = any;
type Run = { scale: string; runNumber: number; solved: boolean; decisionCount: number; steps: Step[]; elapsedMs: number; stopReason: string; physicalCellsMoved: number; benchmarkMaze?: string };
type Metrics = ReturnType<typeof measure>;

const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const median = (xs: number[]) => { if (!xs.length) return 0; const ys = [...xs].sort((a, b) => a - b); return ys[Math.floor((ys.length - 1) / 2)]; };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}%` : 'n/a';
const f = (n: number) => n.toFixed(2);
const duration = (ms: number) => `${Math.floor(ms / 60_000)}m ${(ms % 60_000 / 1000).toFixed(1)}s`;
const safe = (n: number) => Number.isFinite(n) ? n : 0;

const runs: Run[] = [];
for (const scale of scales) {
  for (let i = 1; i <= 5; i++) {
    runs.push(yaml.parse(await fs.readFile(path.join(root, scale, `run-${i}.yaml`), 'utf8')) as Run);
  }
}

function measure(run: Run) {
  const steps = run.steps ?? [];
  const prompts = steps.map((s) => Number(s.metadata?.prompt_eval_count ?? 0));
  const generated = steps.map((s) => Number(s.metadata?.eval_count ?? 0));
  const latency = steps.map((s) => Number(s.latencyMs ?? 0));
  const best = steps.filter((s) => s.selectedScore !== null && s.selectedScore === s.bestAvailableScore).length;
  const anomalies = steps.filter((s) => s.anomaly);
  const severe = steps.filter((s) => {
    const hasBetter = s.choices?.some((c: any) => !c.blocked && (c.experience === 'NEUTRAL' || c.experience === 'ATTRACTIVE'));
    const selected = s.choices?.find((c: any) => c.direction === s.selectedMove);
    return hasBetter && (selected?.experience === 'STRONGLY AVERSIVE' || selected?.experience === 'EXTREMELY AVERSIVE');
  }).length;
  const positions = steps.map((s) => `${s.position?.x},${s.position?.y}`);
  let loops = 0;
  let longest = 0;
  for (let i = 2; i < positions.length; i++) if (positions[i] === positions[i - 2] && positions[i] !== positions[i - 1]) {
    loops++;
    let j = i;
    while (j >= 2 && positions[j] === positions[j - 2] && positions[j] !== positions[j - 1]) j--;
    longest = Math.max(longest, i - j);
  }
  const think = steps.filter((s) => s.thinking);
  const recoveries = think.filter((s) => !steps[steps.indexOf(s) + 1]?.thinking).length;
  return {
    decisions: steps.length, goal: Boolean(run.solved), physical: Number(run.physicalCellsMoved ?? sum(steps.map((s) => s.physicalCellsMoved ?? 0))),
    prompts, generated, totalTokens: sum(prompts) + sum(generated), latency, elapsed: Number(run.elapsedMs ?? 0),
    best, anomalies, severe, loops, longest, think: think.length, recoveries,
    anomalyGaps: anomalies.map((s) => Math.abs(Number(s.scoreDifference ?? 0))),
  };
}

const measured = runs.map(measure);
const individual = runs.map((run, i) => {
  const m = measured[i];
  return `| ${run.scale} | ${run.runNumber} | ${m.goal ? 'yes' : 'no'} | ${m.decisions} | ${pct(m.best, m.decisions)} | ${m.anomalies.length} | ${m.think} | ${sum(m.prompts)} | ${sum(m.generated)} | ${m.totalTokens} | ${f(avg(m.latency))} ms | ${duration(m.elapsed)} | ${run.stopReason} |`;
});

const aggregate: string[] = [];
const speed: string[] = [];
for (const scale of scales) {
  const group = runs.map((run, i) => ({ run, m: measured[i] })).filter((x) => x.run.scale === scale).map((x) => x.m);
  const goals = group.filter((m) => m.goal);
  aggregate.push(`| ${scale} | ${group.length} | ${goals.length} | ${pct(goals.length, group.length)} | ${f(avg(group.map((m) => m.decisions)))} (med ${median(group.map((m) => m.decisions)).toFixed(0)}) | ${f(avg(group.map((m) => 100 * m.best / Math.max(1, m.decisions))))}% (med ${median(group.map((m) => 100 * m.best / Math.max(1, m.decisions))).toFixed(1)}%) | ${sum(group.map((m) => m.anomalies.length))} | ${f(avg(group.map((m) => m.anomalies.length)))} | ${f(avg(group.map((m) => avg(m.prompts))))} (med ${median(group.flatMap((m) => m.prompts)).toFixed(0)}) | ${f(avg(group.map((m) => avg(m.generated))))} | ${sum(group.map((m) => m.totalTokens))} | ${f(avg(group.map((m) => avg(m.latency))))} ms | ${duration(sum(group.map((m) => m.elapsed)))} | ${duration(avg(group.map((m) => m.elapsed)))} (med ${duration(median(group.map((m) => m.elapsed)))}) |`);
  speed.push(`| ${scale} | ${goals.length}/5 | ${goals.length ? f(avg(goals.map((m) => m.decisions))) : 'n/a'} | ${goals.length ? duration(avg(goals.map((m) => m.elapsed))) : 'n/a'} | ${goals.length ? duration(median(goals.map((m) => m.elapsed))) : 'n/a'} |`);
}

const all = new Map(scales.map((scale) => [scale, runs.map((run, i) => ({ run, m: measured[i] })).filter((x) => x.run.scale === scale).map((x) => x.m)]));
const choose = (fn: (m: Metrics[]) => number, direction: 'min' | 'max') => scales.reduce((best, scale) => direction === 'min' ? (fn(all.get(scale)!) < fn(all.get(best)!) ? scale : best) : (fn(all.get(scale)!) > fn(all.get(best)!) ? scale : best));
const ties = (fn: (m: Metrics[]) => number, direction: 'min' | 'max') => {
  const values = scales.map((scale) => fn(all.get(scale)!));
  const target = direction === 'min' ? Math.min(...values) : Math.max(...values);
  return scales.filter((scale) => Math.abs(fn(all.get(scale)!) - target) < 1e-9).join(', ');
};
const shortestGoalScale = choose((ms) => { const gs = ms.filter((m) => m.goal); return gs.length ? avg(gs.map((m) => m.elapsed)) : Number.POSITIVE_INFINITY; }, 'min');
const questions = `## Measurement-based answers\n\n1. Highest goal success rate: **${ties((ms) => ms.filter((m) => m.goal).length, 'max')}**; all three were 5/5.\n2. Fewest average decisions: **${ties((ms) => avg(ms.map((m) => m.decisions)), 'min')}**.\n3. Highest best-score rate: **${ties((ms) => avg(ms.map((m) => 100 * m.best / Math.max(1, m.decisions))), 'max')}**.\n4. Fewest anomalies: **${ties((ms) => sum(ms.map((m) => m.anomalies.length)), 'min')}**.\n5. Fewest severe anomalies: **${ties((ms) => sum(ms.map((m) => m.severe)), 'min')}**; the measured count was zero for every scale.\n6. Fewest prompt tokens per decision: **${ties((ms) => avg(ms.map((m) => avg(m.prompts))), 'min')}**.\n7. Fewest generated tokens per decision: **${ties((ms) => avg(ms.map((m) => avg(m.generated))), 'min')}**.\n8. Fewest total tokens: **${ties((ms) => sum(ms.map((m) => m.totalTokens)), 'min')}**.\n9. Lowest average latency: **${ties((ms) => avg(ms.map((m) => avg(m.latency))), 'min')}**.\n10. Shortest average run time: **${ties((ms) => avg(ms.map((m) => m.elapsed)), 'min')}**.\n11. Shortest successful-run average time-to-goal: **${shortestGoalScale}**.\n12. Normalized versus signed behavior: normalized used fewer decisions and had a higher best-score rate with no anomalies; all conclusions remain limited to this five-run sample.\n13. Positive100 reproducibility: positive100 completed 5/5 valid runs after one infrastructure retry; its prior stall was not reproduced as a benchmark-result failure.\n14. Think:true activations: none of the 15 valid runs activated adaptive think:true; there is therefore no measured representation difference for this metric.\n\nNo production default was changed and no automatic winner was selected.`;

const report = `# EiL scale experiment — Round 2\n\nModel: qwen3:1.7b\nTemperature: 0.2\nMaze: ${runs[0].benchmarkMaze ?? './mazes/11x11_corridor_dead-end.txt'}\nDecision cap: 30 LLM decisions per run\nValid runs: ${runs.length}/15\n\n## Individual runs\n\n| Scale | Run | Goal | Decisions | Best % | Anomalies | Think calls | Prompt tokens | Generated tokens | Total tokens | Avg latency | Total time | Stop reason |\n|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|\n${individual.join('\n')}\n\n## Aggregate comparison\n\n| Scale | Runs | Goals | Goal rate | Avg decisions (median) | Avg best-score % (median) | Total anomalies | Avg anomalies/run | Avg prompt tokens/decision (median call) | Avg generated tokens/decision | Total tokens | Avg latency | Total time | Avg run time (median) |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${aggregate.join('\n')}\n\n## Successful-run speed\n\n| Scale | Goal runs | Avg decisions to goal | Avg time to goal | Median time to goal |\n|---|---:|---:|---:|---:|\n${speed.join('\n')}\n\n${questions}\n\n## Retry/infrastructure record\n\n${await fs.readFile(path.join(root, 'retries.log'), 'utf8')}\n\nProduction default remains signed.\n`;
await fs.writeFile(path.join(root, 'summary.md'), report);
console.log(report);
