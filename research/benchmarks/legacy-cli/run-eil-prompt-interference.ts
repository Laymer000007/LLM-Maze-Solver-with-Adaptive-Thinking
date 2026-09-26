import fs from 'fs/promises';
import path from 'path';
import { performance } from 'node:perf_hooks';
import { ChatOllama } from '@langchain/ollama';
import yaml from 'yaml';
import { createActionSchema, type Move } from '@/execution/execution';
import { formatEiLScore, formatEiLMaximum, type EiLScale } from '@/agent/eil';

type Choice = { direction: Move; state: string; destination: { x: number; y: number }; blocked: boolean; score?: number; experience?: string; eilEffect?: string; eilMeaning?: string; visited: boolean; visitCount: number };
type Case = { id: string; source: string; synthetic: boolean; promptSigned: string; currentEiL: number; trend: string; label: string; choices: Choice[]; bestAvailableScore: number; bestActions: Move[]; secondBestScore: number; scoreGap: number; gapBucket: string; contrast: string };
type Scale = EiLScale;
type Condition = 'simple' | 'scores' | 'full' | 'full-summary';
type RecordRow = { experiment: 'main' | 'action-order' | 'semantic-wording'; caseId: string; repetition: number; orderIndex: number; scale: Scale; condition: string; prompt: string; move: Move | null; valid: boolean; tieAwareCorrect: boolean; exactBestAction: boolean; selectedScore: number | null; regret: number | null; severe5: boolean; severe10: boolean; blockedSelected: boolean; promptEvalCount: number | null; evalCount: number | null; totalDurationNs: number | null; promptEvalDurationNs: number | null; evalDurationNs: number | null; promptChars: number; promptBytes: number; applicationLatencyMs: number; requestStartedAt: string; responseEndedAt: string; metadata: Record<string, unknown>; rawResponse: unknown };

const root = path.resolve(process.argv[2] ?? './output/eil-prompt-interference');
const datasetPath = path.resolve('./output/eil-fixed-state-replay/dataset.yaml');
const model = 'qwen3:1.7b';
const temperature = 0.2;
const ollamaUrl = process.env.EIL_OLLAMA_URL ?? 'http://192.168.88.100:11434';
const scales: Scale[] = ['signed', 'normalized', 'positive100'];
const conditions: Condition[] = ['simple', 'scores', 'full', 'full-summary'];
const repetitions = 3;
const seed = 20260925;

await fs.mkdir(path.join(root, 'prompts', 'representative-state'), { recursive: true });
await fs.mkdir(path.join(root, 'controls', 'action-order'), { recursive: true });
await fs.mkdir(path.join(root, 'controls', 'semantic-wording'), { recursive: true });
const cases = (yaml.parse(await fs.readFile(datasetPath, 'utf8')) as { cases: Case[] }).cases;
if (cases.length !== 50) throw new Error(`Expected 50 frozen states, found ${cases.length}`);
await writePrompts(cases[0]);
const llm = new ChatOllama({ model, baseUrl: ollamaUrl, think: false, temperature }).withStructuredOutput(createActionSchema(false), { includeRaw: true });
const resultsPath = path.join(root, 'results.jsonl');
const existing = await readExisting(resultsPath);
const out = await fs.open(resultsPath, 'a');
let completed = existing.size;
try {
  for (let ci = 0; ci < cases.length; ci++) {
    const c = cases[ci];
    const rotatedScales = rotate(scales, ci);
    const rotatedConditions = rotate(conditions, Math.floor(ci / scales.length));
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (let si = 0; si < rotatedScales.length; si++) for (let wi = 0; wi < rotatedConditions.length; wi++) {
        const scale = rotatedScales[si]; const condition = rotatedConditions[wi];
        const key = `main|${c.id}|${repetition}|${scale}|${condition}`;
        if (existing.has(key)) continue;
        const row = await call(c, scale, condition, repetition, si * conditions.length + wi, 'main');
        await out.write(`${JSON.stringify(row)}\n`); completed++;
        if (completed % 50 === 0) console.error(`Prompt-interference progress: ${completed}/1800 main calls`);
      }
    }
  }
  const difficult = difficultCases(cases).slice(0, 10);
  for (let i = 0; i < difficult.length; i++) for (const scale of scales) for (const direction of ['original', 'reversed'] as const) {
    const order = direction === 'original' ? difficult[i].choices : [...difficult[i].choices].reverse();
    const c = { ...difficult[i], choices: order };
    const condition: Condition = 'scores';
    const key = `action-order|${c.id}|${direction === 'original' ? 1 : 2}|${scale}|${condition}`;
    if (existing.has(key)) continue;
    const row = await call(c, scale, condition, direction === 'original' ? 1 : 2, direction === 'original' ? 0 : 1, 'action-order', direction);
    await out.write(`${JSON.stringify(row)}\n`); completed++;
  }
  for (const c of difficultCases(cases).slice(0, 10)) for (const scale of scales) for (const variant of ['A1-good-bad', 'A2-emotional'] as const) {
    const condition = variant;
    const key = `semantic-wording|${c.id}|1|${scale}|${condition}`;
    if (existing.has(key)) continue;
    const row = await call(c, scale, 'simple', 1, variant === 'A1-good-bad' ? 0 : 1, 'semantic-wording', variant);
    row.condition = condition;
    await out.write(`${JSON.stringify(row)}\n`); completed++;
  }
} finally { await out.close(); }
const rows = await readRows(resultsPath);
await fs.writeFile(path.join(root, 'summary.md'), buildSummary(cases, rows));
console.log(`Completed prompt-interference benchmark: ${rows.filter((r) => r.experiment === 'main').length}/1800 main calls.`);

function rotate<T>(xs: T[], by: number): T[] { return xs.map((_x, i) => xs[(i + by) % xs.length]); }
function difficultCases(cs: Case[]): Case[] { return cs.filter((c) => c.scoreGap >= 3 || c.contrast.includes('EXTREMELY') || c.gapBucket === 'medium' || c.bestActions.length > 1).sort((a, b) => b.scoreGap - a.scoreGap); }
function semantic(c: Choice): string { return c.experience ?? (c.blocked ? 'BLOCKED' : 'NEUTRAL'); }
function available(c: Case): Choice[] { return c.choices.filter((x) => !x.blocked && x.score !== undefined); }
function scoreText(score: number, scale: Scale): string { return formatEiLScore(score, scale); }
function actionLines(c: Case, scale: Scale, kind: 'semantic' | 'scores'): string {
  return c.choices.filter((x) => !x.blocked && x.score !== undefined).map((x) => kind === 'semantic' ? `${x.direction.toUpperCase()} = ${semantic(x)}` : `${x.direction.toUpperCase()} = ${scoreText(x.score!, scale)}`).join('\n');
}
function basePrompt(c: Case, scale: Scale): string {
  let scoreIndex = 0;
  return c.promptSigned.replace(/(Current EiL: )[^^\n]+/, `$1${formatEiLScore(c.currentEiL, scale)} / ${formatEiLMaximum(scale)}`).replace(/toward \+100/, `toward ${scale === 'signed' ? '+100' : formatEiLMaximum(scale)}`).replace(/(- score: )([^\n]+)/g, (_m, p) => `${p}${scoreText(available(c)[scoreIndex++]?.score ?? 0, scale)}`);
}
function promptFor(c: Case, scale: Scale, condition: Condition, semanticVariant = 'emotional'): string {
  if (condition === 'simple') return `Choose the better action.\n\n${actionLines(c, scale, 'semantic').replace(/ = (ATTRACTIVE|NEUTRAL|SLIGHTLY AVERSIVE|AVERSIVE|STRONGLY AVERSIVE|EXTREMELY AVERSIVE)/g, (_m, label) => semanticVariant === 'good-bad' ? ` = ${label === 'ATTRACTIVE' || label === 'NEUTRAL' ? 'GOOD' : 'BAD'}` : ` = ${label}`)}\n\nReturn only one compact JSON move: {"move":"left"} or {"move":"right"}.`;
  if (condition === 'scores') return `Legal actions and scores:\n${actionLines(c, scale, 'scores')}\n\nHigher score is better. Choose one legal action. Return only one compact JSON move from this list.`;
  const full = basePrompt(c, scale);
  if (condition === 'full') return full;
  const summary = available(c).map((x) => `${x.direction.toUpperCase()}:\nscore = ${scoreText(x.score!, scale)}\nemotion = ${semantic(x)}`).join('\n\n');
  return `${full}\n\nFINAL DECISION SUMMARY\n\n${summary}\n\nHigher score is better. More positive emotional outcomes are preferred.\n\nChoose one of the available actions now.`;
}
async function writePrompts(c: Case): Promise<void> { for (const scale of scales) for (const condition of conditions) await fs.writeFile(path.join(root, 'prompts', 'representative-state', `${scale}-${condition}.txt`), promptFor(c, scale, condition)); }
async function call(c: Case, scale: Scale, condition: Condition, repetition: number, orderIndex: number, experiment: RecordRow['experiment'], variant?: string): Promise<RecordRow> {
  const prompt = promptFor(c, scale, condition, variant === 'A1-good-bad' ? 'good-bad' : 'emotional');
  const started = performance.now(); const requestStartedAt = new Date().toISOString();
  try {
    const result: any = await llm.invoke(prompt); const raw = result?.raw ?? {}; const metadata = (raw.response_metadata ?? {}) as Record<string, unknown>; const move = result?.parsed?.move as Move | undefined; const chosen = c.choices.find((x) => x.direction === move); const selected = chosen && !chosen.blocked && chosen.score !== undefined ? chosen : null; const regret = selected ? c.bestAvailableScore - selected.score! : null;
    return row(c, repetition, orderIndex, scale, condition, prompt, move ?? null, selected, regret, started, requestStartedAt, metadata, raw, experiment);
  } catch (error) { return row(c, repetition, orderIndex, scale, condition, prompt, null, null, null, started, requestStartedAt, { error: error instanceof Error ? error.message : String(error) }, null, experiment); }
}
function row(c: Case, repetition: number, orderIndex: number, scale: Scale, condition: string, prompt: string, move: Move | null, selected: Choice | null, regret: number | null, started: number, requestStartedAt: string, metadata: Record<string, unknown>, rawResponse: unknown, experiment: RecordRow['experiment']): RecordRow { return { experiment, caseId: c.id, repetition, orderIndex, scale, condition, prompt, move, valid: Boolean(selected), tieAwareCorrect: Boolean(selected && c.bestActions.includes(selected.direction)), exactBestAction: Boolean(selected && c.bestActions.length === 1 && c.bestActions[0] === selected.direction), selectedScore: selected?.score ?? null, regret, severe5: regret !== null && regret >= 5, severe10: regret !== null && regret >= 10, blockedSelected: Boolean(move && c.choices.some((x) => x.direction === move && x.blocked)), promptEvalCount: num(metadata.prompt_eval_count), evalCount: num(metadata.eval_count), totalDurationNs: num(metadata.total_duration), promptEvalDurationNs: num(metadata.prompt_eval_duration), evalDurationNs: num(metadata.eval_duration), promptChars: prompt.length, promptBytes: Buffer.byteLength(prompt, 'utf8'), applicationLatencyMs: performance.now() - started, requestStartedAt, responseEndedAt: new Date().toISOString(), metadata, rawResponse }; }
function num(v: unknown): number | null { return typeof v === 'number' ? v : null; }
async function readExisting(file: string): Promise<Set<string>> { const s = new Set<string>(); try { for (const line of (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean)) { const r = JSON.parse(line) as RecordRow; s.add(`${r.experiment}|${r.caseId}|${r.repetition}|${r.scale}|${r.condition}`); } } catch {} return s; }
async function readRows(file: string): Promise<RecordRow[]> { return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((x) => JSON.parse(x) as RecordRow); }
function pct(n: number, d: number): string { return d ? `${(n / d * 100).toFixed(1)}%` : 'n/a'; }
function avg(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function med(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; }
function cell(rs: RecordRow[]): string { return `${pct(rs.filter((r) => r.tieAwareCorrect).length, rs.length)} (${rs.length})`; }
function matrix(rows: RecordRow[], field: 'tieAwareCorrect' | 'regret' | 'severe5' | 'blockedSelected'): string { const head = `| Scale | ${conditions.map((x) => x.replace('-', ' + ')).join(' | ')} |\n|---|${conditions.map(() => '---:|').join('')}`; const body = scales.map((s) => `| ${s} | ${conditions.map((c) => { const rs = rows.filter((r) => r.scale === s && r.condition === c); if (field === 'regret') return avg(rs.flatMap((r) => r.regret === null ? [] : [r.regret])).toFixed(2); return field === 'tieAwareCorrect' ? cell(rs) : pct(rs.filter((r) => r[field]).length, rs.length); }).join(' | ')} |`).join('\n'); return `${head}\n${body}`; }
function grouped(rows: RecordRow[], field: 'gapBucket' | 'contrast', cases: Case[]): string { const values = field === 'gapBucket' ? ['tie', 'tiny', 'small', 'medium', 'large', 'very large'] : ['ATTRACTIVE vs NEUTRAL', 'ATTRACTIVE vs AVERSIVE', 'NEUTRAL vs SLIGHTLY AVERSIVE', 'NEUTRAL vs STRONGLY AVERSIVE', 'NEUTRAL vs EXTREMELY AVERSIVE', 'ATTRACTIVE vs STRONGLY AVERSIVE', 'ATTRACTIVE vs EXTREMELY AVERSIVE']; const head = `| Scale | ${values.map((v) => v.replace(' vs ', ' / ')).join(' | ')} |\n|---|${values.map(() => '---:|').join('')}`; const body = scales.map((s) => `| ${s} | ${values.map((v) => { const ids = new Set(cases.filter((c) => c[field] === v).map((c) => c.id)); const rs = rows.filter((r) => r.scale === s && ids.has(r.caseId)); return pct(rs.filter((r) => r.tieAwareCorrect).length, rs.length); }).join(' | ')} |`).join('\n'); return `${head}\n${body}`; }
function controls(rows: RecordRow[]): string { const order = rows.filter((r) => r.experiment === 'action-order'); const wording = rows.filter((r) => r.experiment === 'semantic-wording'); const orderRows = scales.map((s) => { const a = order.filter((r) => r.scale === s); return `| ${s} | ${cell(a.filter((r) => r.orderIndex === 0))} | ${cell(a.filter((r) => r.orderIndex === 1))} |`; }).join('\n'); const wordRows = scales.map((s) => `| ${s} | ${cell(wording.filter((r) => r.scale === s && r.condition === 'A1-good-bad'))} | ${cell(wording.filter((r) => r.scale === s && r.condition === 'A2-emotional'))} |`).join('\n'); return `### Action order\n\n| Scale | Original | Reversed |\n|---|---:|---:|\n${orderRows}\n\n### Semantic wording\n\n| Scale | A1 GOOD/BAD | A2 emotional labels |\n|---|---:|---:|\n${wordRows}`; }
function buildSummary(cases: Case[], all: RecordRow[]): string { const rows = all.filter((r) => r.experiment === 'main'); const acc = matrix(rows, 'tieAwareCorrect'); const regret = matrix(rows, 'regret'); const severe = matrix(rows, 'severe5'); const invalid = matrix(rows, 'blockedSelected'); const drops = scales.map((s) => { const a = rows.filter((r) => r.scale === s && r.condition === 'simple'); const b = rows.filter((r) => r.scale === s && r.condition === 'scores'); const f = rows.filter((r) => r.scale === s && r.condition === 'full'); const d = rows.filter((r) => r.scale === s && r.condition === 'full-summary'); return `| ${s} | ${(avg(a.map((r) => Number(r.tieAwareCorrect))) * 100).toFixed(1)}% | ${(avg(b.map((r) => Number(r.tieAwareCorrect))) * 100).toFixed(1)}% | ${(avg(f.map((r) => Number(r.tieAwareCorrect))) * 100).toFixed(1)}% | ${(avg(d.map((r) => Number(r.tieAwareCorrect))) * 100).toFixed(1)}% | ${(avg(a.map((r) => Number(r.tieAwareCorrect))) - avg(f.map((r) => Number(r.tieAwareCorrect))) * 1) * 100 >= 0 ? ((avg(a.map((r) => Number(r.tieAwareCorrect))) - avg(f.map((r) => Number(r.tieAwareCorrect)))) * 100).toFixed(1) : ((avg(a.map((r) => Number(r.tieAwareCorrect))) - avg(f.map((r) => Number(r.tieAwareCorrect)))) * 100).toFixed(1)} pp | ${((avg(d.map((r) => Number(r.tieAwareCorrect))) - avg(f.map((r) => Number(r.tieAwareCorrect)))) * 100).toFixed(1)} pp |`; }).join('\n'); const tokenRows = scales.map((s) => `| ${s} | ${conditions.map((c) => { const rs = rows.filter((r) => r.scale === s && r.condition === c); return `${avg(rs.flatMap((r) => r.promptEvalCount === null ? [] : [r.promptEvalCount])).toFixed(1)} / ${med(rs.flatMap((r) => r.promptEvalCount === null ? [] : [r.promptEvalCount]))}`; }).join(' | ')} |`).join('\n'); return `# EiL Prompt-Interference Benchmark\n\nModel: ${model}; temperature: ${temperature}; think: false on every call; seed/order: ${seed}; production unchanged.\n\n## Design\n\n50 frozen states × 3 scales × 4 conditions × 3 repetitions = ${rows.length} main calls. Expected actions come only from canonical signed scores; ties are tie-aware correct. No maze was run, no mouse moved, no memory was updated, and no adaptive thinking was activated.\n\n## Accuracy\n\n${acc}\n\n## Average regret\n\n${regret}\n\n## Severe errors >=5\n\n${severe}\n\n## Invalid/blocked selections\n\n${invalid}\n\n## Prompt-interference and recovery\n\n| Scale | Simple | Scores only | Full | Full + summary | Simple − Full | Summary − Full |\n|---|---:|---:|---:|---:|---:|---:|\n${drops}\n\n## Gap buckets\n\n${grouped(rows, 'gapBucket', cases)}\n\n## Emotional contrasts\n\n${grouped(rows, 'contrast', cases)}\n\n## Difficult-state subset\n\nThe subset is the benchmark's first 10 states matching score gap ≥3, extreme emotional contrast, medium gap, or ties. See raw records for exact membership.\n\n## Consistency\n\n| Scale | Condition | Unanimous 3/3 | 2/3 agreement | All different |\n|---|---|---:|---:|---:|\n${scales.flatMap((s) => conditions.map((c) => { const rs = rows.filter((r) => r.scale === s && r.condition === c); let u = 0, t = 0, d = 0; for (const x of cases) { const ms = rs.filter((r) => r.caseId === x.id).map((r) => r.move); const n = new Set(ms).size; if (n === 1) u++; else if (n === 2) t++; else d++; } return `| ${s} | ${c} | ${u} | ${t} | ${d} |`; })).join('\n')}\n\n## Prompt tokens and latency\n\nPrompt token metric is Ollama prompt_eval_count; generated token metric is eval_count.\n\n| Scale | Simple | Scores | Full | Full + summary |\n|---|---:|---:|---:|---:|\n${tokenRows}\n\nLatency averages (ms):\n\n${scales.map((s) => `| ${s} | ${conditions.map((c) => { const rs = rows.filter((r) => r.scale === s && r.condition === c); return avg(rs.map((r) => r.applicationLatencyMs)).toFixed(0); }).join(' | ')} |`).join('\n')}\n\n${controls(all)}\n\n## Validation and artifacts\n\n- Existing tests and TypeScript typecheck were run after the benchmark.\n- Production EiL scale remains signed; no production prompt or maze behavior was changed.\n- [dataset.yaml](dataset.yaml) is the copied frozen-state input.\n- [results.jsonl](results.jsonl) contains every prompt and raw response/metric.\n- Representative prompts are in [prompts/representative-state](prompts/representative-state).\n- Controls are in [controls](controls).\n\nInterpret the 16 final questions from the measured tables above; this report deliberately does not infer production changes.\n`; }
