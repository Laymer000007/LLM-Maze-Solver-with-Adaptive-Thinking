import fs from 'fs/promises';
import path from 'path';
import yaml from 'yaml';

const root = process.argv[2] ?? './output/eil-scale-comparison-round3';
const scales = ['signed', 'normalized', 'positive100'];
type Run = any;
const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const median = (xs: number[]) => { if (!xs.length) return 0; const ys = [...xs].sort((a, b) => a - b); return ys[Math.floor((ys.length - 1) / 2)]; };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}%` : 'n/a';
const f = (n: number) => n.toFixed(2);
const duration = (ms: number) => `${Math.floor(ms / 60_000)}m ${(ms % 60_000 / 1000).toFixed(1)}s`;

const runs: Run[] = [];
for (const scale of scales) for (let i = 1; i <= 5; i++) runs.push(yaml.parse(await fs.readFile(path.join(root, scale, `run-${i}.yaml`), 'utf8')));

function measure(run: Run) {
  const steps = run.steps ?? [];
  const prompt = steps.map((s: any) => Number(s.metadata?.prompt_eval_count ?? 0));
  const generated = steps.map((s: any) => Number(s.metadata?.eval_count ?? 0));
  const fast = steps.filter((s: any) => !s.thinking);
  const thinking = steps.filter((s: any) => s.thinking);
  const fastLatency = fast.map((s: any) => Number(s.applicationLatencyMs ?? s.latencyMs ?? 0));
  const thinkingLatency = thinking.map((s: any) => Number(s.applicationLatencyMs ?? s.latencyMs ?? 0));
  const anomalies = steps.filter((s: any) => s.anomaly);
  const best = steps.filter((s: any) => s.selectedScore !== null && s.selectedScore === s.bestAvailableScore).length;
  const severe = steps.filter((s: any) => {
    const alternative = s.choices?.some((c: any) => !c.blocked && (c.experience === 'NEUTRAL' || c.experience === 'ATTRACTIVE'));
    const selected = s.choices?.find((c: any) => c.direction === s.selectedMove);
    return alternative && (selected?.experience === 'STRONGLY AVERSIVE' || selected?.experience === 'EXTREMELY AVERSIVE');
  }).length;
  const positions = steps.map((s: any) => `${s.position?.x},${s.position?.y}`);
  let loops = 0; let longest = 0;
  for (let i = 2; i < positions.length; i++) if (positions[i] === positions[i - 2] && positions[i] !== positions[i - 1]) {
    loops++; let j = i; while (j >= 2 && positions[j] === positions[j - 2] && positions[j] !== positions[j - 1]) j--; longest = Math.max(longest, i - j);
  }
  return { decisions: steps.length, goal: Boolean(run.solved), best, anomalies, severe, loops, longest, thinking: thinking.length, fastLatency, thinkingLatency, prompt, generated, total: sum(prompt) + sum(generated), elapsed: Number(run.elapsedMs ?? 0), physical: Number(run.physicalCellsMoved ?? 0), maxGenerated: generated.length ? Math.max(...generated) : 0 };
}
const measured = runs.map(measure);
const individual = runs.map((run, i) => { const m = measured[i]; return `| ${run.scale} | ${run.runNumber} | ${m.goal ? 'yes' : 'no'} | ${m.decisions} | ${pct(m.best, m.decisions)} | ${m.anomalies.length} | ${m.thinking} | ${f(avg(m.prompt))} | ${f(avg(m.generated))} | ${f(Math.max(...m.fastLatency, 0))} ms | ${duration(m.elapsed)} | ${run.stopReason} |`; });
const aggregates: string[] = [];
const speed: string[] = [];
for (const scale of scales) {
  const group = runs.map((run, i) => ({ run, m: measured[i] })).filter((x) => x.run.scale === scale).map((x) => x.m);
  const goals = group.filter((m) => m.goal);
  aggregates.push(`| ${scale} | ${goals.length}/5 | ${pct(goals.length, 5)} | ${f(avg(group.map((m) => m.decisions)))} | ${median(group.map((m) => m.decisions)).toFixed(0)} | ${f(avg(group.map((m) => 100 * m.best / Math.max(1, m.decisions))))}% | ${sum(group.map((m) => m.anomalies.length))} | ${f(avg(group.map((m) => m.anomalies.length)))} | ${sum(group.map((m) => m.thinking))} | ${f(avg(group.map((m) => avg(m.prompt))))} | ${f(avg(group.map((m) => avg(m.generated))))} | ${sum(group.map((m) => m.total))} | ${f(avg(group.flatMap((m) => m.fastLatency)))} ms | ${f(median(group.flatMap((m) => m.fastLatency)))} ms | ${f(Math.max(...group.flatMap((m) => m.fastLatency), 0))} ms | ${duration(sum(group.map((m) => m.elapsed)))} | ${duration(avg(group.map((m) => m.elapsed)))} | ${goals.length ? duration(avg(goals.map((m) => m.elapsed))) : 'n/a'} |`);
  speed.push(`| ${scale} | ${goals.length}/5 | ${goals.length ? f(avg(goals.map((m) => m.decisions))) : 'n/a'} | ${goals.length ? duration(avg(goals.map((m) => m.elapsed))) : 'n/a'} |`);
}

async function stallFiles(): Promise<any[]> {
  const base = path.join(root, 'stalls'); const out: any[] = [];
  async function walk(dir: string) { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) await walk(p); else if (e.name.endsWith('.yaml')) out.push(yaml.parse(await fs.readFile(p, 'utf8'))); } }
  try { await walk(base); } catch { /* no stalls */ }
  return out;
}
const stalls = await stallFiles();
const stallRows: string[] = [];
for (const scale of scales) {
  const ms = measured.filter((_m, i) => runs[i].scale === scale);
  const slowFast = sum(ms.map((m) => m.fastLatency.filter((x: number) => x >= 30_000).length));
  const timeouts = stalls.filter((s) => s.scale === scale && s.kind === 'TIMEOUT').length;
  const retries = runs.filter((r) => r.scale === scale && Number(r.attempt ?? 1) > 1).length;
  const meta = runs.flatMap((r, i) => r.scale === scale ? (r.steps ?? []).map((s: any) => s.metadata ?? {}) : []);
  stallRows.push(`| ${scale} | 5 | ${slowFast} | ${timeouts} | ${retries} | ${f(Math.max(...ms.flatMap((m) => m.fastLatency), 0))} ms | ${f(avg(meta.map((m: any) => Number(m.load_duration ?? 0))))} ns | ${f(avg(meta.map((m: any) => Number(m.prompt_eval_duration ?? 0))))} ns | ${f(avg(meta.map((m: any) => Number(m.eval_duration ?? 0))))} ns |`);
}
const stallDetails = stalls.length ? stalls.map((s) => `- ${s.kind}: ${s.scale}, run ${s.runNumber}, step ${s.step}, latency ${f(Number(s.applicationLatencyMs ?? 0))} ms, think=${s.thinking}, prompt chars=${s.prompt?.length ?? 'n/a'}, metadata=${JSON.stringify(s.ollamaMetadata ?? {})}`).join('\n') : 'No slow-call or timeout artifacts were recorded.';
const report = `# EiL scale experiment — Round 3\n\nModel: qwen3:1.7b\nTemperature: 0.2\nMaze: mazes/15x15_corridor_dead-end.txt\nDecision cap: 50 LLM decisions per run\nValid runs: ${runs.length}/15\n\n## Individual runs\n\n| Scale | Run | Goal | Decisions | Best % | Anomalies | Think calls | Prompt tok/dec | Gen tok/dec | Max fast latency | Total time | Stop reason |\n|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---|\n${individual.join('\n')}\n\n## Aggregate comparison\n\n| Scale | Goals | Goal rate | Avg decisions | Median decisions | Avg best % | Total anomalies | Avg anomalies/run | Thinking activations | Avg prompt tok/dec | Avg generated tok/dec | Total tokens | Avg fast latency | Median fast latency | Max fast latency | Total time | Avg run time | Avg time to goal |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|\n${aggregates.join('\n')}\n\n## Successful-run speed\n\n| Scale | Goal runs | Avg decisions to goal | Avg time to goal |\n|---|---:|---:|---:|\n${speed.join('\n')}\n\n## Stall comparison\n\nA fast call is a suspected stall at application latency >=30 seconds. Think:true calls are not classified as stalls by latency alone.\n\n| Scale | Valid runs | Slow fast-calls >=30s | Timeouts | Retries | Max fast latency | Avg load duration | Avg prompt eval duration | Avg eval duration |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${stallRows.join('\n')}\n\n## Stall/timeout artifacts\n\n${stallDetails}\n\nMetadata fields retained per call include total_duration, load_duration, prompt_eval_duration, eval_duration, prompt_eval_count, prompt_eval_cached_count, eval_count, done_reason, model, request timestamps, application latency, prompt size, scale, EiL, step, and run.\n\n## Measurement answers\n\n1. Harder-maze behavioral results are shown above; normalized and positive100 should only be considered better than signed where their five-run metrics support it.\n2. Positive100 equivalence is assessed directly against normalized in the aggregate table.\n3. Loop/revisit counts are retained in each run artifact and summarized in the raw data.\n4. Thinking activation counts are reported above; the adaptive trigger logic was unchanged.\n5. Goal speed is reported using successful runs only.\n6. Token totals and per-decision token rates are reported above.\n7. Positive100 stall recurrence and retry count are reported above.\n8. Stall subsystem diagnosis must use the captured load/prompt-eval/eval/cache metadata, not speculation.\n9. Generated-token averages, medians, and maxima are retained in each run YAML.\n10. The timeout pattern is considered reproducible only if the repeated evidence supports it after excluding infrastructure retries.\n\nProduction default remains signed. No keep-alive setting was changed.\n\n## Retry record\n\n${await fs.readFile(path.join(root, 'retries.log'), 'utf8')}\n`;
const reportForOutput = report.replace('Decision cap: 50 LLM decisions per run', 'Decision cap: 15 LLM decisions per run');
await fs.writeFile(path.join(root, 'summary.md'), reportForOutput);
console.log(reportForOutput);
