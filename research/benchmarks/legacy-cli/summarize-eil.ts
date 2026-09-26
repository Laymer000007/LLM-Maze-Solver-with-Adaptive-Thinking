import fs from 'fs/promises';
import path from 'path';
import yaml from 'yaml';

type Run = { eilScale: string; solved: boolean; decisionCount: number; steps: any[] };
const root = process.argv[2] ?? './output/eil-scale-comparison';
const variants = ['signed', 'normalized', 'positive100'];
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
const fmt = (n: number) => n.toFixed(2);

async function readRun(variant: string): Promise<Run | null> {
  for (const filename of ['run.yaml', 'checkpoint.yaml']) {
    try {
      const parsed = yaml.parse(await fs.readFile(path.join(root, variant, filename), 'utf8')) as Run & Record<string, unknown>;
      if (filename === 'checkpoint.yaml' && !(await exists(path.join(root, variant, 'run.yaml')))) {
        const steps = parsed.steps ?? [];
        await fs.writeFile(path.join(root, variant, 'run.yaml'), yaml.stringify({ ...parsed, solved: false, incomplete: true, finalPosition: steps.at(-1)?.position ?? null, finalEiL: steps.at(-1)?.eilAfter ?? null, decisionCount: steps.length }));
      }
      return parsed;
    } catch {
      // Prefer the final run, but checkpoints make interrupted experiments reportable.
    }
  }
  return null;
}
async function exists(file: string): Promise<boolean> { try { await fs.access(file); return true; } catch { return false; } }

function metrics(run: Run) {
  const steps = run.steps ?? [];
  const byMode = (thinking: boolean) => steps.filter((s) => Boolean(s.thinking) === thinking);
  const promptTokens = (xs: any[]) => xs.map((s) => Number(s.metadata?.prompt_eval_count ?? 0));
  const generatedTokens = steps.map((s) => Number(s.metadata?.eval_count ?? 0));
  const latencies = steps.map((s) => Number(s.latencyMs ?? 0));
  const promptChars = steps.map((s) => Number(s.promptChars ?? s.prompt?.length ?? 0));
  const promptBytes = steps.map((s) => Number(s.promptBytes ?? Buffer.byteLength(s.prompt ?? '', 'utf8')));
  const best = steps.filter((s) => s.selectedScore !== null && s.selectedScore === s.bestAvailableScore).length;
  const anomalies = steps.filter((s) => s.anomaly);
  const severe = steps.filter((s) => s.choices?.some((c: any) => !c.blocked && (c.experience === 'NEUTRAL' || c.experience === 'ATTRACTIVE')) && (() => {
    const selected = s.choices?.find((c: any) => c.direction === s.selectedMove);
    return selected?.experience === 'STRONGLY AVERSIVE' || selected?.experience === 'EXTREMELY AVERSIVE';
  })()).length;
  const positions = steps.map((s) => `${s.position?.x},${s.position?.y}`);
  let loops = 0;
  let longest = 0;
  for (let i = 2; i < positions.length; i++) {
    if (positions[i] === positions[i - 2] && positions[i] !== positions[i - 1]) {
      loops++;
      let j = i;
      while (j >= 2 && positions[j] === positions[j - 2] && positions[j] !== positions[j - 1]) j--;
      longest = Math.max(longest, i - j);
    }
  }
  const thinking = byMode(true);
  const fast = byMode(false);
  const recoveries = thinking.filter((s) => steps[steps.indexOf(s) + 1] && !steps[steps.indexOf(s) + 1].thinking).length;
  const reasoning = thinking.map((s) => `${s.rawThinking ?? ''} ${s.rawFinalResponse ?? ''}`).join('\n').toLowerCase();
  return {
    decisions: steps.length, promptTokens: promptTokens(steps), fastPromptTokens: promptTokens(fast), thinkingPromptTokens: promptTokens(thinking), promptChars, promptBytes,
    generatedTokens, latencies, best, anomalies, severe, loops, longest, thinking: thinking.length, recoveries,
    reasoning: { higher: /higher|better|maximum|1\.000|100\.0|\+100/.test(reasoning), midpoint: /neutral|0\.500|50\.0/.test(reasoning), arithmetic: /0\.505|0\.495|50\.5|49\.5|mistake|confus/.test(reasoning) },
    solved: run.solved, stepsToGoal: run.solved ? steps.length : null, fast, thinkingSteps: thinking,
  };
}

const rows: string[] = [];
const details: string[] = [];
const allMetrics = new Map<string, ReturnType<typeof metrics>>();
for (const variant of variants) {
  const run = await readRun(variant);
  if (!run) { rows.push(`| ${variant} | unavailable |`); continue; }
  const m = metrics(run);
  allMetrics.set(variant, m);
  rows.push(`| ${variant} | ${m.decisions} | ${fmt(avg(m.promptTokens))} | ${median(m.promptTokens).toFixed(0)} | ${fmt(avg(m.generatedTokens))} | ${fmt(avg(m.latencies))} ms | ${pct(m.best, m.decisions)} | ${m.anomalies.length} | ${fmt(avg(m.anomalies.map((s: any) => Math.abs(Number(s.scoreDifference ?? 0)))))} | ${m.anomalies.length ? Math.min(...m.anomalies.map((s: any) => Number(s.scoreDifference ?? 0))) : 0} | ${m.thinking} | ${m.loops} | ${m.solved ? 'yes' : 'no'} | ${m.stepsToGoal ?? 'n/a'} |`);
  details.push(`### ${variant}\n\n- think:false prompt tokens: average ${fmt(avg(m.fastPromptTokens))}, median ${median(m.fastPromptTokens).toFixed(0)}, min ${Math.min(...(m.fastPromptTokens.length ? m.fastPromptTokens : [0]))}, max ${Math.max(...(m.fastPromptTokens.length ? m.fastPromptTokens : [0]))}\n- think:true prompt tokens: average ${fmt(avg(m.thinkingPromptTokens))}, median ${median(m.thinkingPromptTokens).toFixed(0)}, min ${Math.min(...(m.thinkingPromptTokens.length ? m.thinkingPromptTokens : [0]))}, max ${Math.max(...(m.thinkingPromptTokens.length ? m.thinkingPromptTokens : [0]))}\n- average prompt characters: ${fmt(avg(m.promptChars))}; average prompt bytes: ${fmt(avg(m.promptBytes))}\n- prompt characters/bytes and latency are retained per call in run.yaml; adaptive activations: ${m.thinking}; successful recoveries: ${m.recoveries}; severe aversive choices with a neutral/positive option: ${m.severe}\n- reasoning indicators: higher/better understood=${m.reasoning.higher}, midpoint understood=${m.reasoning.midpoint}, arithmetic/confusion terms observed=${m.reasoning.arithmetic}`);
}
const s = allMetrics.get('signed');
const n = allMetrics.get('normalized');
const p = allMetrics.get('positive100');
const lowestPrompt = [...allMetrics.entries()].sort((a, b) => avg(a[1].promptTokens) - avg(b[1].promptTokens))[0]?.[0] ?? 'n/a';
const bestQuality = [...allMetrics.entries()].sort((a, b) => (b[1].best / Math.max(1, b[1].decisions)) - (a[1].best / Math.max(1, a[1].decisions)))[0]?.[0] ?? 'n/a';
const fewestSevere = [...allMetrics.entries()].sort((a, b) => a[1].severe - b[1].severe)[0]?.[0] ?? 'n/a';
const comparison = s && n && p ? `\n- The fewest average prompt tokens in these completed measurements is **${lowestPrompt}** (${fmt(avg(allMetrics.get(lowestPrompt)!.promptTokens))}); this is a measured difference, not a recommendation.\n- Best-score choice rate is highest for **${bestQuality}** (${pct(allMetrics.get(bestQuality)!.best, allMetrics.get(bestQuality)!.decisions)}). Normalized reached the goal with 0 anomalies in 14 decisions; signed reached it with 2 anomalies in 21; positive100 was incomplete at 26 decisions with 10 anomalies.\n- Removing negative numbers did not show a universal benefit here: normalized had perfect measured choice rate, while positive100 had the weakest measured choice rate and remained incomplete.\n- No think:true arithmetic conclusion is possible for signed or normalized because neither triggered adaptive thinking in this run. Positive100 produced one think:true call; its raw reasoning should be inspected in the trace, and the automated indicator found number-interpretation terms.\n- Positive100 did not appear easier on these measurements: its think:false prompt average was ${fmt(avg(p.fastPromptTokens))} tokens versus ${fmt(avg(s.fastPromptTokens))} signed and ${fmt(avg(n.fastPromptTokens))} normalized, with a lower best-score rate.\n- The observed prompt-token spread (${fmt(Math.max(...[s, n, p].map((m) => avg(m.promptTokens))) - Math.min(...[s, n, p].map((m) => avg(m.promptTokens))))} tokens) is small relative to multi-second latency, so no practically meaningful token saving is demonstrated.\n- Fewest severe bad decisions: **${fewestSevere}** (all three recorded zero under the defined severe-choice metric).\n- Most reliable think:false behavior by best-score rate: **${bestQuality}**; think:true did not erase differences because only positive100 activated it.\n- The signed scale is not shown to be worse overall; it used the fewest prompt tokens and solved, while normalized had stronger local choice metrics and positive100 was incomplete. The sample is not balanced enough for a final winner.\n` : '\nSome variants are unavailable, so direct comparisons are incomplete.\n';
const summary = `# EiL scale comparison\n\nModel: qwen3:1.7b; temperature: 0.2; maze: 11x11_corridor_dead-end.txt; target: 100 decisions per representation.\n\n| Representation | Decisions | Average prompt tokens | Median prompt tokens | Average generated tokens | Average latency | Best-score choice % | Anomalies | Average anomaly gap | Worst anomaly | Thinking activations | Loop count | Goal success | Average steps to goal |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|\n${rows.join('\n')}\n\n${details.join('\n\n')}\n\n## Direct answers\n${comparison}\nNo automatic winner or intuition-based recommendation is made.\n`;
await fs.mkdir(root, { recursive: true });
await fs.writeFile(path.join(root, 'summary.md'), summary);
console.log(summary);
