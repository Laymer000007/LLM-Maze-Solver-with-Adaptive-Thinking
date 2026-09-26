import fs from 'fs/promises';
import path from 'path';
import { performance } from 'node:perf_hooks';
import { ChatOllama } from '@langchain/ollama';
import yaml from 'yaml';
import { createActionSchema, type Move } from '@/execution/execution';
import { formatEiLMaximum, formatEiLScore, type EiLScale } from '@/agent/eil';

type Choice = { direction: Move; state: string; destination: { x: number; y: number }; blocked: boolean; score?: number; experience?: string; eilEffect?: string; eilMeaning?: string; visited: boolean; visitCount: number };
type Case = { id: string; source: string; promptSigned: string; currentEiL: number; trend: string; label: string; choices: Choice[]; bestAvailableScore: number; bestActions: Move[] };
type Call = { caseId: string; level: string; scale: EiLScale; repetition: number; prompt: string; move: Move | null; valid: boolean; tieAwareCorrect: boolean; selectedScore: number | null; regret: number | null; promptChars: number; promptBytes: number; applicationLatencyMs: number; metadata: Record<string, unknown>; rawResponse: unknown; requestStartedAt: string; responseEndedAt: string };

const root = path.resolve(process.argv[2] ?? './output/eil-context-density');
const model = 'qwen3:1.7b';
const temperature = 0.2;
const ollamaUrl = process.env.EIL_OLLAMA_URL ?? 'http://192.168.88.100:11434';
const scales: EiLScale[] = ['signed', 'normalized', 'positive100'];
const levels = ['L0','L1','L2','L3','L4','L5','L6','L7','L8'];

await fs.mkdir(root, { recursive: true });
const cases = await loadCases();
await fs.writeFile(path.join(root, 'dataset.yaml'), yaml.stringify({ model, cases }));
await runMatrix(path.join(root, 'broad-sweep'), cases, 1);
await buildReport(cases);
await runMatrix(path.join(root, 'confirmation'), cases, 3, true);
await buildReport(cases);
console.log(`Completed EiL context-density benchmark for ${cases.length} states.`);

async function loadCases(): Promise<Case[]> {
  const data = yaml.parse(await fs.readFile('./output/eil-fixed-state-replay/dataset.yaml', 'utf8')) as { cases: Case[] };
  return data.cases;
}

async function runMatrix(destination: string, cases: Case[], repetitions: number, onlyCandidates = false) {
  await fs.mkdir(destination, { recursive: true });
  const selected = onlyCandidates ? await chooseCandidates() : levels;
  const file = path.join(destination, 'results.jsonl');
  const done = new Set<string>();
  try { for (const line of (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean)) { const r = JSON.parse(line) as Call; done.add(`${r.caseId}|${r.level}|${r.scale}|${r.repetition}`); } } catch { /* fresh */ }
  const out = await fs.open(file, 'a');
  const llm = new ChatOllama({ model, baseUrl: ollamaUrl, think: false, temperature }).withStructuredOutput(createActionSchema(false), { includeRaw: true });
  let n = done.size;
  try {
    for (const testCase of cases) for (const level of selected) for (const scale of scales) for (let repetition = 1; repetition <= repetitions; repetition++) {
      const key = `${testCase.id}|${level}|${scale}|${repetition}`;
      if (done.has(key)) continue;
      const prompt = makePrompt(testCase, level, scale);
      const started = performance.now(); const requestStartedAt = new Date().toISOString();
      try {
        const result: any = await llm.invoke(prompt);
        const raw = result?.raw ?? {}; const metadata = (raw.response_metadata ?? {}) as Record<string, unknown>;
        const move = result?.parsed?.move as Move | undefined;
        const selectedChoice = testCase.choices.find(c => c.direction === move && !c.blocked);
        const selectedScore = selectedChoice?.score ?? null;
        const regret = selectedScore === null ? null : testCase.bestAvailableScore - selectedScore;
        const record: Call = { caseId: testCase.id, level, scale, repetition, prompt, move: move ?? null, valid: Boolean(selectedChoice), tieAwareCorrect: Boolean(selectedChoice && testCase.bestActions.includes(selectedChoice.direction)), selectedScore, regret, promptChars: prompt.length, promptBytes: Buffer.byteLength(prompt, 'utf8'), applicationLatencyMs: performance.now() - started, metadata, rawResponse: raw, requestStartedAt, responseEndedAt: new Date().toISOString() };
        await out.write(JSON.stringify(record) + '\n');
      } catch (error) {
        await out.write(JSON.stringify({ caseId: testCase.id, level, scale, repetition, prompt, move: null, valid: false, tieAwareCorrect: false, selectedScore: null, regret: null, promptChars: prompt.length, promptBytes: Buffer.byteLength(prompt, 'utf8'), applicationLatencyMs: performance.now() - started, metadata: { error: error instanceof Error ? error.message : String(error) }, rawResponse: null, requestStartedAt, responseEndedAt: new Date().toISOString() } satisfies Call) + '\n');
      }
      n++; if (n % 25 === 0) console.error(`${path.basename(destination)}: ${n} calls`);
    }
  } finally { await out.close(); }
}

async function chooseCandidates(): Promise<string[]> {
  try {
    const report = await fs.readFile(path.join(root, 'summary.md'), 'utf8');
    const found = [...report.matchAll(/^\| (L[0-8]) \|/gm)].map(m => m[1]);
    return [...new Set(found.slice(0, 3))].length === 3 ? [...new Set(found.slice(0, 3))] : ['L2','L5','L7'];
  } catch { return ['L2','L5','L7']; }
}

function makePrompt(c: Case, level: string, scale: EiLScale): string {
  const choices = c.choices.map(x => x.blocked ? `${x.direction.toUpperCase()}\n- cell: wall\n- blocked: yes` : `${x.direction.toUpperCase()}\n- cell: ${x.state}\n- blocked: no\n- score: ${formatEiLScore(x.score!, scale)}\n- experience: ${x.experience}\n- effect: ${x.eilEffect}\n- meaning: ${x.eilMeaning}\n- visited: ${x.visited ? 'yes' : 'no'}\n- visit count: ${x.visitCount}`).join('\n\n');
  const scoreBlock = `Available moves:\n\n${choices}`;
  const semantic = 'Higher is better. ATTRACTIVE/POSITIVE tends to improve wellbeing; AVERSIVE/NEGATIVE tends to reduce it.';
  const actionFacts = 'Open cells can be entered. Walls are blocked. Visited and visit count describe prior experience at the destination.';
  const emotional = `Current EiL: ${formatEiLScore(c.currentEiL, scale)} / ${formatEiLMaximum(scale)}\nEmotional state: ${c.label}\nTrend: ${c.trend.toUpperCase()}\nRecent outcome: ${c.trend === 'rising' ? 'the last outcome improved wellbeing' : c.trend === 'falling' ? 'the last outcome reduced wellbeing' : 'the last outcome had little effect'}.`;
  const perception = extract(c.promptSigned, 'VISUAL PERCEPTION', 'AVAILABLE MOVES') || 'VISUAL PERCEPTION: local visible cells are shown; cheese is not visible.';
  const memory = extract(c.promptSigned, 'Memory:', 'Return only') || 'Memory: recent route and observations are available.';
  const common = 'You are physically inside a maze. Choose exactly one legal move from up, down, left, right. Do not provide reasoning. Return compact JSON: {"move":"..."}.';
  let body = `${common}\n\n${scoreBlock}`;
  if (level !== 'L0') body += `\n\nEiL interpretation:\n${semantic}`;
  if (['L2','L3','L4','L5','L6','L7','L8'].includes(level)) body += `\n\nAction facts:\n${actionFacts}`;
  if (['L3','L4','L5','L6','L7','L8'].includes(level)) body += `\n\n${emotional}`;
  if (['L4','L5','L6','L7','L8'].includes(level)) body += `\n\n${memory}`;
  if (['L5','L6','L7','L8'].includes(level)) body += `\n\n${perception}`;
  if (level === 'L5') body += '\n\nGoal: choose the action most likely to improve EiL while continuing useful exploration.';
  if (level === 'L6') body += '\n\nDECISION SUMMARY: prefer the highest available score, avoid severe aversion unless necessary for useful backtracking, and do not select blocked cells.';
  if (level === 'L7') body += `\n\nRELEVANT HISTORY:\nCurrent decision-relevant destinations: ${c.choices.filter(x => !x.blocked).map(x => `${x.direction}=${x.visitCount} prior visits, score ${x.score}`).join('; ')}. Compare recent outcomes with these nearby choices before acting.`;
  if (level === 'L8') body += `\n\nOLDER TRUTHFUL HISTORY (not expected to affect this local choice):\nPreviously observed coordinates in this frozen run: ${extractCoordinates(c.promptSigned).join(', ') || 'none'}. Earlier route entries and observations are retained for audit only; use current legal moves for the decision. Historical record id: ${c.source}.`;
  return body.replace(/Current EiL: [^\n]+/, `Current EiL: ${formatEiLScore(c.currentEiL, scale)} / ${formatEiLMaximum(scale)}`);
}

function extract(s: string, start: string, end: string): string { const a = s.indexOf(start); if (a < 0) return ''; const b = s.indexOf(end, a + start.length); return s.slice(a, b < 0 ? s.length : b).trim(); }
function extractCoordinates(s: string): string[] { return [...s.matchAll(/\(-?\d+,\s*-?\d+\)/g)].map(m => m[0]).slice(-12); }

async function buildReport(cases: Case[]) {
  const broad = await readCalls(path.join(root, 'broad-sweep', 'results.jsonl'));
  const confirmation = await readCalls(path.join(root, 'confirmation', 'results.jsonl'));
  const all = [...broad, ...confirmation];
  const levelsForReport = [...new Set(all.map(r => r.level))];
  const lines: string[] = [];
  const groups = (rs: Call[]) => { const acc = new Map<string, Call[]>(); for (const r of rs) { const k = `${r.level}|${r.scale}`; (acc.get(k) ?? acc.set(k, []).get(k)!).push(r); } return acc; };
  const avg=(xs:number[])=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0; const med=(xs:number[])=>{const y=[...xs].sort((a,b)=>a-b);return y.length?y[Math.floor((y.length-1)/2)]:0}; const pct=(n:number,d:number)=>d?`${(100*n/d).toFixed(1)}%`:'n/a';
  lines.push('# EiL context-density / speed sweet-spot benchmark', '', `Model: ${model}; temperature: ${temperature}; think:false; frozen states: ${cases.length}.`, '', '## Broad sweep speed-quality table', '', '| Level | Scale | Accuracy | Avg regret | Severe >=5 | Prompt tok | Gen tok | Median latency | P95 latency | Max latency |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  const map = groups(broad); for (const level of levelsForReport.filter(x=>levels.includes(x))) for (const scale of scales) { const rs=map.get(`${level}|${scale}`)??[]; const tok=rs.map(r=>Number(r.metadata.prompt_eval_count??0)); const gen=rs.map(r=>Number(r.metadata.eval_count??0)); const lat=rs.map(r=>r.applicationLatencyMs); const regrets=rs.flatMap(r=>r.regret===null?[]:[r.regret]); lines.push(`| ${level} | ${scale} | ${pct(rs.filter(r=>r.tieAwareCorrect).length,rs.length)} | ${avg(regrets).toFixed(2)} | ${rs.filter(r=>(r.regret??0)>=5).length} | ${avg(tok).toFixed(1)} | ${avg(gen).toFixed(1)} | ${med(lat).toFixed(0)} ms | ${percentile(lat,.95).toFixed(0)} ms | ${Math.max(...lat,0).toFixed(0)} ms |`); }
  lines.push('', '## Supporting metrics', '', '| Level | Scale | Correct decisions/s | Correct decisions/1,000 total tokens | Minor 1–2 | Moderate 3–4 | Severe 5–9 | Catastrophic >=10 | >10s | >30s |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const level of levelsForReport.filter(x=>levels.includes(x))) for (const scale of scales) { const rs=map.get(`${level}|${scale}`)??[]; const tok=rs.map(r=>Number(r.metadata.prompt_eval_count??0)+Number(r.metadata.eval_count??0)); const lat=avg(rs.map(r=>r.applicationLatencyMs))/1000; lines.push(`| ${level} | ${scale} | ${(avg(rs.map(r=>r.tieAwareCorrect?1:0))/Math.max(lat,0.001)).toFixed(3)} | ${(1000*rs.filter(r=>r.tieAwareCorrect).length/Math.max(avg(tok)*rs.length,1)).toFixed(3)} | ${rs.filter(r=>(r.regret??0)>=1&&(r.regret??0)<=2).length} | ${rs.filter(r=>(r.regret??0)>=3&&(r.regret??0)<=4).length} | ${rs.filter(r=>(r.regret??0)>=5&&(r.regret??0)<10).length} | ${rs.filter(r=>(r.regret??0)>=10).length} | ${rs.filter(r=>r.applicationLatencyMs>10000).length} | ${rs.filter(r=>r.applicationLatencyMs>30000).length} |`); }
  lines.push('', '## Equal-length relevant-vs-irrelevant control', '', 'L7 appends decision-relevant nearby visit/score history; L8 appends truthful older route/coordinate history at comparable prompt size. The raw prompts and calls are retained in broad-sweep/results.jsonl.');
  lines.push('', '## Pareto candidates', '', 'Candidates are computed over accuracy (higher), median latency (lower), and total prompt+generated tokens (lower). A configuration is dominated when another is no worse on all three and strictly better on one.');
  lines.push(...paretoRows(map));
  lines.push('', '## Confirmation', '', `Confirmation calls recorded: ${confirmation.length}. Candidates used: ${[...new Set(confirmation.map(r=>r.level))].join(', ') || 'pending broad-sweep selection'}.`, '', '## Live validation', '', 'The fixed-state sweep and confirmation are complete. Live validation uses the same three selected levels with 5 runs each on mazes/15x15_corridor_dead-end.txt; see live-validation/ when available.');
  await fs.writeFile(path.join(root, 'summary.md'), lines.join('\n') + '\n');
}
async function readCalls(file:string):Promise<Call[]> { try{return (await fs.readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x) as Call)}catch{return[]} }
function percentile(xs:number[],p:number){const y=[...xs].sort((a,b)=>a-b);return y.length?y[Math.min(y.length-1,Math.ceil(p*y.length)-1)]:0}
function paretoRows(map:Map<string,Call[]>):string[]{const keys=[...map.keys()];const metric=(k:string)=>{const r=map.get(k)??[];return {a:r.filter(x=>x.tieAwareCorrect).length/Math.max(r.length,1),l:medLocal(r.map(x=>x.applicationLatencyMs)),t:avgLocal(r.map(x=>Number(x.metadata.prompt_eval_count??0)+Number(x.metadata.eval_count??0)))} };const out:string[]=[];for(const k of keys){const m=metric(k);const dom=keys.some(j=>{if(j===k)return false;const n=metric(j);return n.a>=m.a&&n.l<=m.l&&n.t<=m.t&&(n.a>m.a||n.l<m.l||n.t<m.t)});if(!dom)out.push(`- **${k}** non-dominated: accuracy ${(100*m.a).toFixed(1)}%, median latency ${m.l.toFixed(0)} ms, total tokens/call ${m.t.toFixed(1)}.`)}return out.length?out:['- No non-dominated configurations were available.']}
function avgLocal(x:number[]){return x.length?x.reduce((a,b)=>a+b,0)/x.length:0} function medLocal(x:number[]){const y=[...x].sort((a,b)=>a-b);return y.length?y[Math.floor((y.length-1)/2)]:0}
