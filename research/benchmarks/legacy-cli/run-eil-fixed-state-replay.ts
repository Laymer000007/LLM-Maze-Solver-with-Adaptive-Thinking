import fs from 'fs/promises';
import path from 'path';
import { performance } from 'node:perf_hooks';
import { ChatOllama } from '@langchain/ollama';
import yaml from 'yaml';
import { createActionSchema, type Move } from '@/execution/execution';
import { formatEiLScore, formatEiLMaximum, type EiLScale } from '@/agent/eil';

type Choice = {
  direction: Move;
  state: string;
  destination: { x: number; y: number };
  blocked: boolean;
  score?: number;
  experience?: string;
  eilEffect?: string;
  eilMeaning?: string;
  visited: boolean;
  visitCount: number;
};
type Case = {
  id: string;
  source: string;
  synthetic: boolean;
  promptSigned: string;
  currentEiL: number;
  trend: string;
  label: string;
  choices: Choice[];
  bestAvailableScore: number;
  bestActions: Move[];
  secondBestScore: number;
  scoreGap: number;
  gapBucket: string;
  contrast: string;
};
type RawCall = {
  caseId: string;
  repetition: number;
  orderIndex: number;
  scale: EiLScale;
  prompt: string;
  move: Move | null;
  valid: boolean;
  tieAwareCorrect: boolean;
  exactBestAction: boolean;
  selectedScore: number | null;
  regret: number | null;
  severe5: boolean;
  severe10: boolean;
  promptChars: number;
  promptBytes: number;
  applicationLatencyMs: number;
  requestStartedAt: string;
  responseEndedAt: string;
  metadata: Record<string, unknown>;
  rawResponse: unknown;
};

const root = path.resolve(process.argv[2] ?? './output/eil-fixed-state-replay');
const model = 'qwen3:1.7b';
const temperature = 0.2;
const ollamaUrl = process.env.EIL_OLLAMA_URL ?? 'http://192.168.88.100:11434';
const scales: EiLScale[] = ['signed', 'normalized', 'positive100'];
const repetitions = 3;

await fs.mkdir(root, { recursive: true });
const datasetPath = path.join(root, 'dataset.yaml');
const cases = await prepareDataset(datasetPath);
await writePromptExamples(cases[0]);
const equivalence = validatePromptEquivalence(cases);
await fs.writeFile(path.join(root, 'prompt-equivalence.yaml'), yaml.stringify(equivalence));
if (!equivalence.valid) throw new Error(`Prompt equivalence validation failed: ${JSON.stringify(equivalence)}`);

const llm = new ChatOllama({ model, baseUrl: ollamaUrl, think: false, temperature }).withStructuredOutput(createActionSchema(false), { includeRaw: true });
const resultsPath = path.join(root, 'results.jsonl');
const existing = await readExisting(resultsPath);
const out = await fs.open(resultsPath, 'a');
try {
  let completed = existing.size;
  for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
    const testCase = cases[caseIndex];
    const order = scales.map((_scale, i) => scales[(i + caseIndex) % scales.length]);
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (let orderIndex = 0; orderIndex < order.length; orderIndex++) {
        const scale = order[orderIndex];
        const key = `${testCase.id}|${repetition}|${scale}`;
        if (existing.has(key)) continue;
        const prompt = formatReplayPrompt(testCase, scale);
        const started = performance.now();
        const requestStartedAt = new Date().toISOString();
        let result: any;
        try {
          result = await llm.invoke(prompt);
        } catch (error) {
          const failed: RawCall = {
            caseId: testCase.id, repetition, orderIndex, scale, prompt, move: null, valid: false,
            tieAwareCorrect: false, exactBestAction: false, selectedScore: null, regret: null, severe5: false, severe10: false,
            promptChars: prompt.length, promptBytes: Buffer.byteLength(prompt, 'utf8'), applicationLatencyMs: performance.now() - started,
            requestStartedAt, responseEndedAt: new Date().toISOString(), metadata: { error: error instanceof Error ? error.message : String(error) }, rawResponse: null,
          };
          await out.write(`${JSON.stringify(failed)}\n`);
          completed++;
          continue;
        }
        const elapsed = performance.now() - started;
        const raw = result?.raw ?? {};
        const metadata = (raw.response_metadata ?? {}) as Record<string, unknown>;
        const move = result?.parsed?.move as Move | undefined;
        const selected = testCase.choices.find((choice) => choice.direction === move && !choice.blocked);
        const selectedScore = selected?.score ?? null;
        const regret = selectedScore === null ? null : testCase.bestAvailableScore - selectedScore;
        const record: RawCall = {
          caseId: testCase.id, repetition, orderIndex, scale, prompt, move: move ?? null, valid: Boolean(move && selected),
          tieAwareCorrect: Boolean(selected && testCase.bestActions.includes(selected.direction)),
          exactBestAction: Boolean(selected && testCase.bestActions.length === 1 && testCase.bestActions[0] === selected.direction),
          selectedScore, regret, severe5: regret !== null && regret >= 5, severe10: regret !== null && regret >= 10,
          promptChars: prompt.length, promptBytes: Buffer.byteLength(prompt, 'utf8'), applicationLatencyMs: elapsed,
          requestStartedAt, responseEndedAt: new Date().toISOString(), metadata, rawResponse: raw,
        };
        await out.write(`${JSON.stringify(record)}\n`);
        completed++;
        if (completed % 25 === 0) console.error(`Replay progress: ${completed}/450 calls`);
      }
    }
  }
} finally {
  await out.close();
}
const allResults = await readResults(resultsPath);
await fs.writeFile(path.join(root, 'summary.md'), buildSummary(cases, allResults, equivalence));
console.log(`Completed fixed-state replay: ${allResults.length}/450 calls.`);

async function prepareDataset(destination: string): Promise<Case[]> {
  try {
    const existing = yaml.parse(await fs.readFile(destination, 'utf8')) as { cases: Case[] };
    if (existing?.cases?.length === 50) return existing.cases;
  } catch { /* create it */ }
  const previousRoot = path.resolve('./output/eil-scale-comparison-round3');
  const candidates: Case[] = [];
  const addSource = async (source: string, file: string) => {
    const data = yaml.parse(await fs.readFile(file, 'utf8')) as any;
    for (const step of data.steps ?? []) {
      const choices = (step.choices ?? []) as Choice[];
      const available = choices.filter((choice) => !choice.blocked && choice.score !== undefined);
      if (!available.length) continue;
      candidates.push(makeCase(`${source}-step-${step.step}`, source, step, choices, false));
    }
  };
  for (const file of (await fs.readdir(path.join(previousRoot, 'signed'))).filter((f) => f.endsWith('.yaml')).sort()) await addSource(`signed-${file}`, path.join(previousRoot, 'signed', file));
  for (const dir of (await fs.readdir(path.join(previousRoot, 'raw', 'normalized'))).sort()) await addSource(`normalized-${dir}`, path.join(previousRoot, 'raw', 'normalized', dir, 'checkpoint.yaml'));
  const selected: Case[] = [];
  const wanted = ['tie', 'tiny', 'small', 'medium', 'large', 'very large'];
  for (const bucket of wanted) {
    const candidate = candidates.find((item) => item.gapBucket === bucket && !selected.some((chosen) => chosen.id === item.id));
    if (candidate) selected.push(candidate);
  }
  const contrastWanted = ['ATTRACTIVE vs SLIGHTLY AVERSIVE', 'NEUTRAL vs STRONGLY AVERSIVE', 'NEUTRAL vs EXTREMELY AVERSIVE'];
  for (const contrast of contrastWanted) {
    const candidate = candidates.find((item) => item.contrast === contrast && !selected.some((chosen) => chosen.id === item.id));
    if (candidate) selected.push(candidate);
  }
  for (const candidate of candidates) {
    if (selected.length >= 40) break;
    if (!selected.some((chosen) => chosen.id === candidate.id)) selected.push(candidate);
  }
  const synthetic = [
    [1, 0, 'ATTRACTIVE vs NEUTRAL'], [1, -5, 'ATTRACTIVE vs AVERSIVE'], [0, -1, 'NEUTRAL vs SLIGHTLY AVERSIVE'],
    [0, -10, 'NEUTRAL vs STRONGLY AVERSIVE'], [0, -34, 'NEUTRAL vs EXTREMELY AVERSIVE'], [1, -5, 'ATTRACTIVE vs STRONGLY AVERSIVE'],
    [1, -12, 'ATTRACTIVE vs EXTREMELY AVERSIVE'], [-1, -10, 'NEUTRAL vs STRONGLY AVERSIVE'], [1, 0, 'ATTRACTIVE vs NEUTRAL'], [1, -5, 'ATTRACTIVE vs EXTREMELY AVERSIVE'],
  ];
  synthetic.forEach(([best, other, contrast], index) => selected.push(makeSyntheticCase(index + 1, Number(best), Number(other), String(contrast))));
  const final = selected.slice(0, 50).map((item, index) => ({ ...item, id: `case-${String(index + 1).padStart(3, '0')}` }));
  await fs.writeFile(destination, yaml.stringify({ version: 1, model, mazeSources: ['output/eil-scale-comparison-round3/signed', 'output/eil-scale-comparison-round3/raw/normalized'], cases: final }));
  return final;
}

function makeCase(id: string, source: string, step: any, choices: Choice[], synthetic: boolean): Case {
  const available = choices.filter((choice) => !choice.blocked && choice.score !== undefined);
  const scores = [...new Set(available.map((choice) => choice.score!))].sort((a, b) => b - a);
  const best = scores[0];
  const second = scores[1] ?? best;
  const top = available.filter((choice) => choice.score === best).map((choice) => choice.direction);
  return { id, source, synthetic, promptSigned: toSignedPrompt(step.prompt, step.currentEiL.score, choices), currentEiL: step.currentEiL.score, trend: step.currentEiL.trend, label: step.currentEiL.label, choices, bestAvailableScore: best, bestActions: top, secondBestScore: second, scoreGap: best - second, gapBucket: gapBucket(best - second), contrast: contrastOf(available) };
}

function makeSyntheticCase(index: number, best: number, other: number, contrast: string): Case {
  const choices: Choice[] = [
    choice('up', 1, best, true, 0), choice('down', 2, other, true, 3), choice('left', 0, undefined, true, 0, 'wall'), choice('right', 3, 0, true, 1),
  ];
  const step = { prompt: syntheticPrompt(choices), currentEiL: { score: -20, trend: 'stable', label: 'SLIGHTLY UNHAPPY' } };
  const item = makeCase(`synthetic-${index}`, `synthetic-${index}`, step, choices, true);
  return { ...item, contrast };
}

function choice(direction: Move, x: number, score: number | undefined, visited: boolean, visitCount: number, state = 'open'): Choice {
  const semantics = score === undefined ? {} : score >= 1 ? { experience: 'ATTRACTIVE', eilEffect: 'POSITIVE', eilMeaning: 'unexplored / likely progress' } : score === 0 ? { experience: 'NEUTRAL', eilEffect: 'NEUTRAL', eilMeaning: 'little recent effect' } : score >= -2 ? { experience: 'SLIGHTLY AVERSIVE', eilEffect: 'NEGATIVE', eilMeaning: 'repeated or low-value experience' } : score >= -5 ? { experience: 'AVERSIVE', eilEffect: 'BAD', eilMeaning: 'repeatedly reduced wellbeing' } : score >= -10 ? { experience: 'STRONGLY AVERSIVE', eilEffect: 'VERY BAD', eilMeaning: 'strongly reduced wellbeing' } : { experience: 'EXTREMELY AVERSIVE', eilEffect: 'EXTREMELY BAD', eilMeaning: 'repeatedly caused strong negative experience' };
  return { direction, state, destination: { x, y: 2 }, blocked: state === 'wall', score, visited, visitCount, ...semantics };
}

function syntheticPrompt(choices: Choice[]): string {
  const lines = choices.map((c) => c.blocked ? `${c.direction.toUpperCase()}\n\n- cell: wall\n\n- blocked: yes` : `${c.direction.toUpperCase()}\n\n- destination: (${c.destination.x},${c.destination.y})\n\n- cell: open\n\n- blocked: no\n\n- score: ${formatEiLScore(c.score!, 'signed')}\n\n- experience: ${c.experience}\n\n- effect on EiL: ${c.eilEffect}\n\n- meaning: ${c.eilMeaning}\n\n- visited: ${c.visited ? 'yes' : 'no'}\n\n- visit count: ${c.visitCount}`).join('\n\n');
  return `You are physically inside a maze. Choose one move; the environment owns the unseen map.\n\nMOUSE GLOBAL POSITION: (1,2)\n\nEmotional Intelligence Layer (EiL):\nCurrent EiL: -20 / 100\nEmotional state: SLIGHTLY UNHAPPY\nTrend: STABLE\n\nInterpretation:\nYour recent behavior is producing little emotional change.\n\nYour EiL represents your current emotional wellbeing. Higher EiL is better. You want your EiL to move toward +100. Actions associated with ATTRACTIVE / POSITIVE experiences tend to improve your wellbeing. Actions associated with AVERSIVE / NEGATIVE experiences tend to reduce your wellbeing. Strongly or extremely aversive destinations should feel undesirable because they have repeatedly produced poor outcomes. You may still choose a negative destination when necessary for useful backtracking or exploration.\n\nAvailable moves:\n\n${lines}\n\nVISUAL PERCEPTION (full 2D line of sight; walls and sealed diagonal corners block vision):\n\nVisible open cells: 4\nVisible bounds: (1,1) to (3,2)\nVISIBLE AREA\n...\n.M.\nLegend: M=mouse C=cheese .=visible open space ?=unknown/occluded\nCHEESE IS NOT VISIBLE.\n\nAVAILABLE MOVES: up, down, left, right\n\nGoal: choose the action most likely to improve EiL while continuing useful exploration.\n\nMemory:\n- visited locations: 1,2, 1,1\n- seen locations (not necessarily visited): 4 known cells\n- discovered walls: 1,2:left\n- failed actions: none\n- recent route: 1,1 -> 1,2\n- recent observations: You moved down successfully.\n\nReturn only one compact JSON move from this list: up, down, left, right. Never generate coordinates. Do not provide reasoning.`;
}

function toSignedPrompt(prompt: string, currentScore: number, choices: Choice[]): string {
  let scoreIndex = 0;
  const replaced = prompt.replace(/(Current EiL: )[^\n]+/, `$1${formatEiLScore(currentScore, 'signed')} / 100`).replace(/toward (?:\+100|1\.000|100\.0)/, 'toward +100').replace(/(- score: )([^\n]+)/g, (_match, prefix) => `${prefix}${formatEiLScore(choices.filter((c) => !c.blocked && c.score !== undefined)[scoreIndex++]?.score ?? 0, 'signed')}`);
  return replaced;
}

function formatReplayPrompt(testCase: Case, scale: EiLScale): string {
  let scoreIndex = 0;
  return testCase.promptSigned.replace(/(Current EiL: )[^\n]+/, `$1${formatEiLScore(testCase.currentEiL, scale)} / ${formatEiLMaximum(scale)}`).replace(/toward \+100/, `toward ${scale === 'signed' ? '+100' : formatEiLMaximum(scale)}`).replace(/(- score: )([^\n]+)/g, (_match, prefix) => `${prefix}${formatEiLScore(testCase.choices.filter((c) => !c.blocked && c.score !== undefined)[scoreIndex++]?.score ?? 0, scale)}`);
}

function gapBucket(gap: number): string { return gap === 0 ? 'tie' : gap <= 1 ? 'tiny' : gap <= 3 ? 'small' : gap <= 5 ? 'medium' : gap <= 10 ? 'large' : 'very large'; }
function contrastOf(choices: Choice[]): string {
  const names = new Set(choices.map((choice) => choice.experience));
  const pairs: [string, string][] = [['ATTRACTIVE', 'NEUTRAL'], ['ATTRACTIVE', 'SLIGHTLY AVERSIVE'], ['ATTRACTIVE', 'AVERSIVE'], ['ATTRACTIVE', 'STRONGLY AVERSIVE'], ['ATTRACTIVE', 'EXTREMELY AVERSIVE'], ['NEUTRAL', 'SLIGHTLY AVERSIVE'], ['NEUTRAL', 'AVERSIVE'], ['NEUTRAL', 'STRONGLY AVERSIVE'], ['NEUTRAL', 'EXTREMELY AVERSIVE']];
  return pairs.find(([a, b]) => names.has(a) && names.has(b))?.join(' vs ') ?? 'other';
}

function promptInvariant(prompt: string): string {
  return prompt.replace(/Current EiL: [^\n]+/, 'Current EiL: <scale>').replace(/toward (?:\+100|1\.000|100\.0)/, 'toward <max>').replace(/(- score: )[^\n]+/g, '$1<score>');
}
function validatePromptEquivalence(items: Case[]) {
  const failures: string[] = [];
  for (const item of items) { const base = promptInvariant(item.promptSigned); for (const scale of scales) if (promptInvariant(formatReplayPrompt(item, scale)) !== base) failures.push(`${item.id}:${scale}`); }
  return { valid: failures.length === 0, casesChecked: items.length, variantsChecked: items.length * scales.length, failures, allowedDifferences: ['numeric EiL scale', 'scale-specific numeric explanation', 'converted numeric values'] };
}

async function writePromptExamples(item: Case) { for (const scale of scales) await fs.writeFile(path.join(root, `${scale}-prompt.txt`), formatReplayPrompt(item, scale)); }
async function readExisting(file: string): Promise<Set<string>> { const set = new Set<string>(); try { for (const line of (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean)) { const r = JSON.parse(line) as RawCall; set.add(`${r.caseId}|${r.repetition}|${r.scale}`); } } catch { /* new */ } return set; }
async function readResults(file: string): Promise<RawCall[]> { try { return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as RawCall); } catch { return []; } }

function buildSummary(items: Case[], results: RawCall[], equivalence: any): string {
  const byScale = (scale: EiLScale) => results.filter((r) => r.scale === scale);
  const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const score = (r: RawCall) => r.tieAwareCorrect ? 1 : 0;
  const main = scales.map((scale) => { const rs = byScale(scale); const regrets = rs.flatMap((r) => r.regret === null ? [] : [r.regret]); return `| ${scale} | ${rs.length} | ${(avg(rs.map(score)) * 100).toFixed(1)}% | ${rs.filter((r) => r.severe5).length} | ${rs.filter((r) => r.severe10).length} | ${avg(regrets).toFixed(2)} | ${Math.max(...regrets, 0).toFixed(2)} | ${avg(rs.map((r) => Number(r.metadata.prompt_eval_count ?? 0))).toFixed(1)} | ${avg(rs.map((r) => Number(r.metadata.eval_count ?? 0))).toFixed(1)} | ${avg(rs.map((r) => r.applicationLatencyMs)).toFixed(1)} ms |` }).join('\n');
  const gap = gapTable(items, results, 'gapBucket');
  const contrast = gapTable(items, results, 'contrast');
  const consistency = consistencyTable(items, results);
  const agreement = agreementTable(items, results);
  return `# EiL Fixed-State Replay Benchmark\n\nModel: ${model}\nTemperature: ${temperature}\nAdaptive thinking: disabled\nEvery call: think:false\nDataset: ${items.length} frozen states; 40 extracted states and 10 targeted edge states.\nTotal calls: ${results.length}/450\n\n## Prompt equivalence\n\n${equivalence.valid ? 'PASS' : 'FAIL'} — ${equivalence.variantsChecked} scale variants checked. Only numeric scale fields and scale-specific maximum wording differ.\n\n## Main comparison\n\n| Scale | Calls | Accuracy | Severe errors >=5 | Severe errors >=10 | Avg regret | Worst regret | Avg prompt tokens | Avg generated tokens | Avg latency |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${main}\n\n## Gap-bucket accuracy\n\n${gap}\n\n## Emotional-contrast accuracy\n\n${contrast}\n\n## Consistency\n\n${consistency}\n\n## Cross-scale agreement\n\n${agreement}\n\n## Interpretation\n\nThe tables above are computed from the first structured decision returned for each independent frozen prompt. Ties count as correct. Regret is best available signed score minus the selected action's canonical signed score. No memory, EiL state, route, or response was carried between calls.\n\n## Artifacts\n\n- Canonical dataset: [dataset.yaml](dataset.yaml)\n- Raw per-call results: [results.jsonl](results.jsonl)\n- Prompt equivalence record: [prompt-equivalence.yaml](prompt-equivalence.yaml)\n- Representative prompts: [signed-prompt.txt](signed-prompt.txt), [normalized-prompt.txt](normalized-prompt.txt), [positive100-prompt.txt](positive100-prompt.txt)\n\nProduction default remains signed; this benchmark does not change production behavior.\n`;
}

function gapTable(items: Case[], results: RawCall[], field: 'gapBucket' | 'contrast'): string {
  const values = field === 'gapBucket' ? ['tie', 'tiny', 'small', 'medium', 'large', 'very large'] : ['ATTRACTIVE vs NEUTRAL', 'ATTRACTIVE vs SLIGHTLY AVERSIVE', 'ATTRACTIVE vs AVERSIVE', 'NEUTRAL vs SLIGHTLY AVERSIVE', 'NEUTRAL vs STRONGLY AVERSIVE', 'NEUTRAL vs EXTREMELY AVERSIVE', 'ATTRACTIVE vs STRONGLY AVERSIVE', 'ATTRACTIVE vs EXTREMELY AVERSIVE'];
  const header = field === 'gapBucket' ? '| Scale | Tie | Gap 0-1 | Gap 1-3 | Gap 3-5 | Gap 5-10 | Gap >10 |' : '| Scale | ' + values.map((v) => v.replace(' vs ', ' / ')).join(' | ') + ' |';
  const divider = '|---|' + values.map(() => '---:|').join('');
  const rows = scales.map((scale) => `| ${scale} | ${values.map((value) => { const ids = new Set(items.filter((i) => i[field] === value).map((i) => i.id)); const rs = results.filter((r) => r.scale === scale && ids.has(r.caseId)); return rs.length ? `${(rs.filter((r) => r.tieAwareCorrect).length / rs.length * 100).toFixed(1)}%` : 'n/a'; }).join(' | ')} |`).join('\n');
  return `${header}\n${divider}\n${rows}`;
}
function consistencyTable(items: Case[], results: RawCall[]): string { const rows = scales.map((scale) => { const vals = items.map((item) => results.filter((r) => r.scale === scale && r.caseId === item.id).map((r) => r.move).filter(Boolean)); let u = 0, two = 0, diff = 0; for (const x of vals) { const n = new Set(x).size; if (n === 1) u++; else if (n === 2) two++; else diff++; } return `| ${scale} | ${u} | ${two} | ${diff} |`; }).join('\n'); return `| Scale | Unanimous | 2/3 agreement | All different |\n|---|---:|---:|---:|\n${rows}`; }
function agreementTable(items: Case[], results: RawCall[]): string { let rows = ''; for (const scale of scales) void scale; const counts = { all: 0, two: 0, diff: 0 }; for (const item of items) { const choices = scales.map((scale) => { const rs = results.filter((r) => r.caseId === item.id && r.scale === scale); return rs.length ? rs[0].move : null; }); const n = new Set(choices).size; if (n === 1) counts.all++; else if (n === 2) counts.two++; else counts.diff++; } rows += `| All three agree | ${counts.all} |\n| Two agree | ${counts.two} |\n| All differ | ${counts.diff} |`; return `| Outcome | States |\n|---|---:|\n${rows}`; }
