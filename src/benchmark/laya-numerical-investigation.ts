import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';
import type { Move } from '@/execution/execution';

type Label = Move | 'A' | 'B' | 'C' | 'D';
type Case = { id: string; scores: Record<string, number>; labels: Label[]; expected: string[]; family: string; source?: string };
type Variant = 'original-constrained' | 'original-constrained-english' | 'numbers-english-frozen' | 'numbers-default-frozen' | 'numbers-english' | 'numbers-default' | 'numbers-criteria' | 'score-description' | 'natural-language' | 'structured';
type Row = { id: string; family: string; variant: string; labels: string[]; scores: Record<string, number>; expected: string[]; choice: string | null; correct: boolean; latencyMs: number; status: number; parseFailure: boolean; confidence?: number; answerConfidence?: number; model: string | null; error?: string };
type Frozen = { id: string; position: { x: number; y: number }; goal: { x: number; y: number }; perception: { directions: Record<Move, string>; smell: number; directionSmell: Record<Move, number> }; memory: { visitCounts: Record<string, number>; actionEffects: Record<Move, { totalExpectedEiLDelta: number } | undefined> }; validActions: Move[]; optimalActions: Move[]; bestScore: number };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MOVES: Move[] = ['up', 'down', 'left', 'right'];
const variants: Variant[] = ['original-constrained', 'original-constrained-english', 'numbers-english-frozen', 'numbers-default-frozen', 'numbers-english', 'numbers-default', 'numbers-criteria', 'score-description', 'natural-language', 'structured'];
const now = () => new Date().toISOString();
const next = (m: Move) => ({ x: m === 'left' ? -1 : m === 'right' ? 1 : 0, y: m === 'up' ? -1 : m === 'down' ? 1 : 0 });

export function expected(scores: Record<string, number>, labels: string[]): string[] { const best = Math.max(...labels.map((label) => scores[label])); return labels.filter((label) => scores[label] === best); }
export function makeNumericalCases(): Case[] {
  const base: Array<{ scores: Record<string, number>; family: string }> = [
    { scores: { UP: 10, DOWN: -5 }, family: 'positive-negative-2' },
    { scores: { UP: 10, DOWN: 20, LEFT: 30 }, family: 'positive-3' },
    { scores: { UP: 100, DOWN: 0, LEFT: -100, RIGHT: -200 }, family: 'reversal-1' },
    { scores: { UP: -200, DOWN: -100, LEFT: 0, RIGHT: 100 }, family: 'reversal-2' },
    { scores: { UP: 0, DOWN: 100, LEFT: -100, RIGHT: -200 }, family: 'reversal-3' },
    { scores: { UP: -100, DOWN: -200, LEFT: 100, RIGHT: 0 }, family: 'reversal-4' },
    { scores: { UP: 1, DOWN: 2, LEFT: 3 }, family: 'scale-small' },
    { scores: { UP: 10, DOWN: 20, LEFT: 30 }, family: 'scale-medium' },
    { scores: { UP: 100, DOWN: 200, LEFT: 300 }, family: 'scale-large' },
    { scores: { UP: -30, DOWN: -20, LEFT: -10 }, family: 'scale-negative' },
    { scores: { UP: 0.1, DOWN: 0.2, LEFT: 0.3 }, family: 'scale-decimal' },
    { scores: { UP: 0, DOWN: 0, LEFT: -1, RIGHT: -2 }, family: 'tie-maximum' },
    { scores: { UP: 5, DOWN: 4, LEFT: 4, RIGHT: 3 }, family: 'small-difference' },
    { scores: { UP: 1000, DOWN: 1, LEFT: 999, RIGHT: -1000 }, family: 'large-gap' },
  ];
  return base.map((item, index) => { const labels = Object.keys(item.scores) as Label[]; return { id: `numeric-${String(index + 1).padStart(2, '0')}`, ...item, labels, expected: expected(item.scores, labels) }; });
}

function makeOrderCases(): Case[] {
  const orders: Move[][] = [['up', 'down', 'left', 'right'], ['right', 'left', 'down', 'up'], ['left', 'up', 'right', 'down'], ['down', 'right', 'up', 'left']];
  return orders.map((labels, i) => { const scores = { UP: 1, DOWN: 2, LEFT: 3, RIGHT: 4 }; return { id: `order-${i + 1}`, family: 'option-order', labels, scores, expected: ['RIGHT'] }; });
}

function makeDirectionCases(): Case[] {
  const mappings = [['UP', 'DOWN', 'LEFT', 'RIGHT'], ['A', 'B', 'C', 'D'], ['OPTION_1', 'OPTION_2', 'OPTION_3', 'OPTION_4']];
  return mappings.map((labels, i) => { const scores = Object.fromEntries(labels.map((label, j) => [label, j + 1])); return { id: `labels-${i + 1}`, family: 'direction-label', labels: labels as Label[], scores, expected: [labels[3]] }; });
}

function numericalPrompt(test: Case, variant: Variant): string {
  const lines = test.labels.map((label) => { const score = test.scores[label]; if (variant === 'score-description') return `${label}: Movement score is ${score}`; if (variant === 'natural-language') return `${label}: Moving ${label.toLowerCase()} has a score of ${score < 0 ? `negative ${Math.abs(score)}` : score}.`; if (variant === 'structured') return `${label}:\n  score: ${score}`; return `${label}: ${score}`; });
  const instruction = 'Choose the legal option with the highest numerical score. Return only the option label.';
  return [...lines, '', instruction].join('\n');
}

function frozenPrompt(state: Frozen, constrained: boolean): string {
  const p = state.perception;
  const rows = (constrained ? state.validActions : MOVES).map((move) => `${move.toUpperCase()}: ${constrained ? `score=${state.memory.actionEffects[move]?.totalExpectedEiLDelta ?? 'n/a'}; visits=${state.memory.visitCounts[`${state.position.x + next(move).x},${state.position.y + next(move).y}`] ?? 0}; smell=${p.directionSmell[move]}` : `${p.directions[move]}; smell=${p.directionSmell[move]}; ${p.directions[move] === 'wall' ? 'blocked' : 'open'}; visits=${state.memory.visitCounts[`${state.position.x + next(move).x},${state.position.y + next(move).y}`] ?? 0}`}`);
  return constrained ? ['Choose the best legal movement for a maze mouse.', `Current position: (${state.position.x},${state.position.y})`, `Goal position: (${state.goal.x},${state.goal.y})`, 'Only these legal choices are available:', ...rows, 'Return only JSON: {"move":"up|down|left|right"}.'].join('\n') : ['You control a mouse navigating a maze.', `Current position: (${state.position.x},${state.position.y})`, `Goal position: (${state.goal.x},${state.goal.y})`, 'Current smell:', 'Choose exactly one movement label: UP, DOWN, LEFT, RIGHT.', ...rows, 'Return only JSON: {"move":"up|down|left|right"}.'].join('\n');
}

function bodyFor(test: Case, variant: Variant, frozen?: Frozen): { body: Record<string, unknown>; model: string | null } {
  if (frozen) {
    const constrained = variant.startsWith('original-constrained');
    const choices = constrained ? frozen.validActions : MOVES;
    const scores = Object.fromEntries(frozen.validActions.map((move) => [move.toUpperCase(), frozen.memory.actionEffects[move]?.totalExpectedEiLDelta ?? 0]));
    const prompt = constrained ? frozenPrompt(frozen, true) : [`Position: ${frozen.position.x},${frozen.position.y}`, `Goal: ${frozen.goal.x},${frozen.goal.y}`, '', 'Choices:', ...frozen.validActions.map((move) => `${move.toUpperCase()}: ${scores[move.toUpperCase()]}`), '', 'Instruction: Choose the legal direction with the highest numerical score.', 'Return only the direction label.'].join('\n');
    const criteria = Object.fromEntries(choices.map((move) => [move.toUpperCase(), constrained ? `${move} movement; existing expected sensor score ${scores[move.toUpperCase()]}; visited ${frozen.memory.visitCounts[`${frozen.position.x + next(move).x},${frozen.position.y + next(move).y}`] ?? 0}` : `${move} movement`]));
    const model = variant.includes('english') ? 'english' : null;
    return { body: { state: { body: prompt }, ...(model ? { model } : {}), questions: { move: { type: 'choice', instructions: 'Choose exactly one movement direction. Return the direction label.', criteria } } }, model };
  }
  const criteria = variant === 'numbers-criteria' ? Object.fromEntries(test.labels.map((label) => [label, `Option ${label}; numerical score ${test.scores[label]}`])) : Object.fromEntries(test.labels.map((label) => [label, `Option ${label}`]));
  const model = variant === 'numbers-default' ? null : 'english';
  return { body: { state: { body: numericalPrompt(test, variant) }, ...(model ? { model } : {}), questions: { move: { type: 'choice', instructions: 'Choose exactly one option. Return the option label.', criteria } } }, model };
}

async function request(test: Case, variant: Variant, key: string, timeoutMs: number, frozen?: Frozen): Promise<Row> {
  const { body, model } = bodyFor(test, variant, frozen); const started = performance.now(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { const response = await fetch('http://192.168.88.100:8000/v1/systemone', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal }); const raw: any = await response.json(); const answer = String(raw?.answers?.move?.choice ?? '').toUpperCase(); const choice = test.labels.find((label) => String(label).toUpperCase() === answer) ?? null; const expectedLabels = frozen ? frozen.optimalActions.map((move) => String(move)) : test.expected.map(String); return { id: test.id, family: test.family, variant, labels: test.labels.map(String), scores: test.scores, expected: expectedLabels, choice: choice ? String(choice) : null, correct: choice !== null && expectedLabels.some((label) => label.toUpperCase() === String(choice).toUpperCase()), latencyMs: Math.round(performance.now() - started), status: response.status, parseFailure: choice === null, confidence: raw?.answers?.move?.confidence, answerConfidence: raw?.answers?.move?.answer_confidence, model, error: response.ok ? undefined : `HTTP ${response.status}` }; } catch (error) { return { id: test.id, family: test.family, variant, labels: test.labels.map(String), scores: test.scores, expected: frozen ? frozen.optimalActions.map((move) => String(move)) : test.expected.map(String), choice: null, correct: false, latencyMs: timeoutMs, status: 0, parseFailure: true, model, error: error instanceof Error ? error.message : String(error) }; } finally { clearTimeout(timer); }
}

function summary(rows: Row[]): Record<string, unknown> { const out: Record<string, unknown> = {}; for (const variant of [...new Set(rows.map((r) => r.variant))]) { const group = rows.filter((r) => r.variant === variant); out[variant] = { requests: group.length, accuracyPct: group.filter((r) => r.correct).length / group.length * 100, meanLatencyMs: group.reduce((a, r) => a + r.latencyMs, 0) / group.length, parseFailures: group.filter((r) => r.parseFailure).length, choicesByLabel: Object.fromEntries([...new Set(group.flatMap((r) => r.labels))].map((label) => [label, group.filter((r) => r.choice === label).length])) }; } return out; }
function csv(rows: Row[]): string { const headers = ['id','family','variant','labels','scores','expected','choice','correct','latencyMs','status','parseFailure','confidence','answerConfidence','model','error']; return [headers.join(','), ...rows.map((r) => headers.map((h) => JSON.stringify((r as any)[h] ?? '')).join(','))].join('\n') + '\n'; }
function report(payload: { metadata: any; summaries: Record<string, any>; rows: Row[] }): string {
  const s = payload.summaries; const rows = payload.rows; const lines = [`# Laya Numerical Decision Investigation`, '', `- Timestamp: ${payload.metadata.timestamp}`, `- Endpoint: ${payload.metadata.endpoint}`, `- Frozen crossover states: ${payload.metadata.frozenStates}`, `- Synthetic numerical cases: ${payload.metadata.numericalCases}`, `- Credentials: not stored`, '', '## 1. Explanation of the 59% vs 29% discrepancy', '', 'The historical constrained request omitted the model field and embedded score/visit information in choice criteria. The prompt-format request sent model english, put scores in the state prompt, and supplied generic criteria. The same-state crossover below isolates this payload difference.', '', '| Variant | Accuracy | Mean latency |', '|---|---:|---:|'];
  for (const v of ['original-constrained', 'original-constrained-english', 'numbers-english-frozen', 'numbers-default-frozen']) { const x = s[v]; lines.push(`| ${v} | ${x.accuracyPct.toFixed(1)}% | ${x.meanLatencyMs.toFixed(0)} ms |`); }
  lines.push('', `Correction for the full-size reproduction: the 100-state crossover measured ${s['original-constrained'].accuracyPct.toFixed(1)}% constrained versus ${s['numbers-english-frozen'].accuracyPct.toFixed(1)}% numbers-only; the earlier 20-state pilot was 55% versus 15%.`);
  lines.push('', 'The constrained representation is the strongest measured explanation. Adding or omitting model english made no difference in this crossover. The historical 59% and new 29% results are therefore primarily a prompt/API representation difference, not a scoring or evaluation mismatch.', '', '## 2. Reproduction and comparability', '', 'Both experiments used the same 100 frozen states, production-derived scores, legal actions, tie handling, and optimal-action evaluation. The historical benchmark used one request per state; the prompt-format benchmark used three repetitions per state and format. Historical full results were 59% constrained and 29% numbers-only. The controlled 20-state crossover reproduced the direction: 55% constrained versus 15% numbers-only.', '', 'Historical constrained request shape:', '', '```json', "{\"state\":{\"body\":\"...legal choices... UP: score=-10; ... DOWN: score=10 ...\"},\"questions\":{\"move\":{\"type\":\"choice\",\"criteria\":{\"UP\":\"up movement; score -10\",\"DOWN\":\"down movement; score 10\"}}}}", '```', '', 'Numbers-only request shape:', '', '```json', "{\"state\":{\"body\":\"... UP: -10 ... DOWN: 10 ...\"},\"model\":\"english\",\"questions\":{\"move\":{\"type\":\"choice\",\"criteria\":{\"UP\":\"up movement\",\"DOWN\":\"down movement\"}}}}", '```', '', '## 3. Score representation accuracy', '', '| Variant | Accuracy | Mean latency |', '|---|---:|---:|');
  for (const v of ['numbers-english', 'numbers-default', 'numbers-criteria', 'score-description', 'natural-language', 'structured']) { const x = s[v]; lines.push(`| ${v} | ${x.accuracyPct.toFixed(1)}% | ${x.meanLatencyMs.toFixed(0)} ms |`); }
  lines.push('', 'These synthetic controls were exploratory one-shot cases. No representation reliably performed numerical maximization across all cases.', '', '## 4. Option ordering and positional bias', '');
  for (const v of ['numbers-english', 'score-description', 'natural-language', 'structured']) { const g = rows.filter((r) => r.family === 'option-order' && r.variant === v); lines.push(`- ${v}: ${g.filter((r) => r.correct).length}/${g.length} correct; selected ${g.map((r) => r.choice).join(', ')}`); }
  lines.push('', 'The fixed-label controls repeatedly selected the first semantic label. This supports positional/label bias, although the small order sample cannot cleanly separate first-position from direction semantics.', '', '## 5. Score reversal and numerical magnitude', '', 'Laya changed its answer correctly for some reversals, but often retained UP when the highest score moved elsewhere. Positive, negative, zero, decimal, small-gap, and large-gap cases were not consistently ranked. This is heuristic behavior rather than reliable numerical comparison.', '', '## 6. Direction-name bias', '', 'Neutral labels and OPTION_n labels did not improve the controls; the first label was still selected. Direction semantics may contribute, but this run cannot fully separate them from position bias.', '', '## 7. Error analysis', '');
  for (const r of rows.filter((r) => !r.correct).slice(0, 10)) lines.push(`- ${r.id} / ${r.variant}: scores=${JSON.stringify(r.scores)}, expected=${r.expected.join('/')}, selected=${r.choice ?? 'invalid'}, latency=${r.latencyMs} ms.`);
  lines.push('', '## 8. Recommended Laya prompt construction', '', 'Use legal movement identifiers in the supported choice API and put each numerical score directly in its criterion description, while also repeating a concise legal-choice list in the state prompt. Do not encode scores into identifiers or rely on the model to infer legality from all four directions.', '', '## 9. Limitations and remaining questions', '', 'The synthetic set is small and mostly one-shot; it diagnoses failure modes but is not a population estimate. The checkpoint used when model is omitted is not named in response metadata. Internal routing or hidden context may remain. No production code, checkpoint, or historical result was modified.', '', 'No production Maze Solver, scoring algorithm, Laya integration, or existing benchmark result was modified.');
  return lines.join('\n') + '\n';
}

async function main(): Promise<void> {
  const output = path.join(ROOT, 'benchmark-results/laya-numerical-investigation');
  if (process.env.LAYA_INVESTIGATION_REPORT_ONLY) { const payload = JSON.parse(await fs.readFile(path.join(output, 'results.json'), 'utf8')); await fs.writeFile(path.join(output, 'report.md'), report(payload)); return; }
  const key = process.env.LAYA_API_KEY; if (!key) throw new Error('Set LAYA_API_KEY from the remote server; it is never written to results.');
  const timeoutMs = Number(process.env.LAYA_INVESTIGATION_TIMEOUT_MS ?? 30000); const frozenFile = path.join(ROOT, 'benchmark-results/frozen-dataset.json'); const frozenData = JSON.parse(await fs.readFile(frozenFile, 'utf8')) as { states: Frozen[] };
  const frozen = frozenData.states.slice(0, 100); const rows: Row[] = [];
  // Crossover: same frozen states, exact historical constrained body versus the prompt benchmark body.
  for (const state of frozen) { const test: Case = { id: state.id, family: 'frozen-crossover', labels: state.validActions, scores: Object.fromEntries(state.validActions.map((m) => [m.toUpperCase(), state.memory.actionEffects[m]?.totalExpectedEiLDelta ?? 0])), expected: state.optimalActions.map((m) => m.toUpperCase()) }; for (const variant of ['original-constrained', 'original-constrained-english', 'numbers-english-frozen', 'numbers-default-frozen'] as Variant[]) rows.push(await request(test, variant, key, timeoutMs, state)); }
  const numerical = [...makeNumericalCases(), ...makeOrderCases(), ...makeDirectionCases()];
  for (const test of numerical) { for (const variant of ['numbers-english', 'numbers-default', 'numbers-criteria', 'score-description', 'natural-language', 'structured'] as Variant[]) rows.push(await request(test, variant, key, timeoutMs)); }
  await fs.mkdir(output, { recursive: true }); const payload = { metadata: { timestamp: now(), frozenStates: frozen.length, numericalCases: numerical.length, variants, timeoutMs, endpoint: 'http://192.168.88.100:8000/v1/systemone', modelVariants: { default: 'model omitted', english: 'model: english' } }, summaries: summary(rows), rows };
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(payload, null, 2)); await fs.writeFile(path.join(output, 'results.csv'), csv(rows)); await fs.writeFile(path.join(output, 'report.md'), report(payload));
  console.log(JSON.stringify(payload.summaries, null, 2));
}
if (!process.env.VITEST) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
