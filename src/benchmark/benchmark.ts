import fs from 'fs/promises';
import path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';
import { AgentMemory, type AgentMemoryState } from '@/agent/memory';
import { buildLocalAgentPrompt } from '@/agent/prompt';
import { Maze, type LocalPerception, type Position } from '@/maze/maze';
import { MOVES, type Move } from '@/execution/execution';

type Experiment = 'A-raw' | 'B-constrained' | 'C-repeated';
type Mode = 'smoke' | 'pilot' | 'full';
type Choice = Move | null;
type FrozenState = {
  id: string; seed: number; mazeFile: string; layout: string[]; position: Position; goal: Position;
  perception: LocalPerception; memory: AgentMemoryState; validActions: Move[]; bestScore: number;
  optimalActions: Move[]; category: string;
};
type ResultRow = {
  experiment: Experiment; stateId: string; model: 'laya' | 'ollama'; repetition: number;
  choice: Choice; latencyMs: number; valid: boolean; wallSelection: boolean; optimal: boolean;
  score: number | null; regret: number | null; previouslyVisited: boolean; timeout: boolean;
  httpFailure: boolean; parseFailure: boolean; error?: string;
};
type Config = { mode: Mode; seed: number; timeoutMs: number; ollamaUrl: string; ollamaModel: string; layaUrl: string; outputDir: string; };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MOVES4 = [...MOVES] as Move[];
const now = () => new Date().toISOString();
const key = (p: Position) => `${p.x},${p.y}`;
const opposite: Record<Move, Move> = { up: 'down', down: 'up', left: 'right', right: 'left' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(): Config {
  const args = process.argv.slice(2); const get = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? fallback : fallback; };
  const mode = get('--mode', 'full') as Mode;
  if (!['smoke', 'pilot', 'full'].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  return { mode, seed: Number(get('--seed', '20261014')), timeoutMs: Number(get('--timeout-ms', '45000')), ollamaUrl: get('--ollama-url', process.env.OLLAMA_URL ?? 'http://192.168.88.100:11434'), ollamaModel: get('--ollama-model', process.env.OLLAMA_MODEL ?? 'qwen3:1.7b'), layaUrl: get('--laya-url', process.env.LAYA_URL ?? 'http://192.168.88.100:8000'), outputDir: get('--output-dir', path.join(ROOT, 'benchmark-results')) };
}

function rng(seed: number): () => number { let value = seed >>> 0; return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) / 0x100000000; }; }
function choose<T>(random: () => number, values: T[]): T { return values[Math.floor(random() * values.length) % values.length]; }
function nextPosition(position: Position, move: Move): Position { return move === 'up' ? { x: position.x, y: position.y - 1 } : move === 'down' ? { x: position.x, y: position.y + 1 } : move === 'left' ? { x: position.x - 1, y: position.y } : { x: position.x + 1, y: position.y }; }

function buildState(maze: Maze, file: string, seed: number, random: () => number, index: number): FrozenState {
  const memory = new AgentMemory(); let position = { ...maze.startPosition };
  const steps = 4 + Math.floor(random() * 42);
  for (let step = 0; step < steps; step++) {
    const perception = maze.perceive(position); memory.rememberPerception(perception, step === 0);
    const legal = MOVES4.filter((move) => perception.directions[move] !== 'wall');
    const walls = MOVES4.filter((move) => perception.directions[move] === 'wall');
    const move = step % 7 === 0 && walls.length ? choose(random, walls) : choose(random, legal.length ? legal : MOVES4);
    const target = nextPosition(position, move); const succeeded = maze.isWalkable(target);
    const effects = memory.evaluate(perception, move);
    memory.rememberAction({ from: position, move, succeeded, to: succeeded ? target : position, message: succeeded ? `benchmark move ${move}` : `benchmark wall ${move}`, effects });
    if (succeeded) position = target;
    if (key(position) === key(maze.goalPosition)) position = { ...maze.startPosition };
  }
  const perception = maze.perceive(position); memory.rememberPerception(perception); const snapshot = memory.snapshot();
  const validActions = MOVES4.filter((move) => perception.directions[move] !== 'wall');
  const scored = validActions.map((move) => snapshot.actionEffects[move]?.totalExpectedEiLDelta ?? -Infinity); const bestScore = Math.max(...scored);
  const optimalActions = validActions.filter((move) => (snapshot.actionEffects[move]?.totalExpectedEiLDelta ?? -Infinity) === bestScore);
  const openCount = validActions.length; const visited = validActions.some((move) => (snapshot.visitCounts[key(nextPosition(position, move))] ?? 0) > 0);
  const category = openCount <= 1 ? 'dead-end' : openCount === 2 ? 'corridor-or-corner' : openCount >= 3 ? 'junction' : 'state';
  return { id: `state-${String(index + 1).padStart(3, '0')}`, seed, mazeFile: file, layout: maze.layout, position, goal: maze.goalPosition, perception, memory: snapshot, validActions, bestScore, optimalActions, category: `${category}${visited ? '-visited' : '-unexplored'}` };
}

async function createDataset(seed: number): Promise<FrozenState[]> {
  const files = (await fs.readdir(path.join(ROOT, 'mazes'))).filter((file) => file.endsWith('.txt')).sort();
  const random = rng(seed); const states: FrozenState[] = []; let index = 0;
  while (states.length < 100) { const file = files[index % files.length]; const maze = await Maze.fromFile(path.join(ROOT, 'mazes', file)); states.push(buildState(maze, `mazes/${file}`, seed + index, random, index)); index++; }
  return states;
}

function rawPrompt(state: FrozenState): string {
  const p = state.perception; const directions = MOVES4.map((move) => `${move.toUpperCase()}: ${p.directions[move]}; smell=${p.directionSmell[move]}; ${p.directions[move] === 'wall' ? 'blocked' : 'open'}; visits=${state.memory.visitCounts[key(nextPosition(state.position, move))] ?? 0}`).join('\n');
  return ['You control a mouse navigating a maze.', `Current position: (${state.position.x},${state.position.y})`, `Goal position: (${state.goal.x},${state.goal.y})`, `Current smell: ${p.smell}`, 'Choose exactly one movement label: UP, DOWN, LEFT, RIGHT.', directions, 'Return only JSON: {"move":"up|down|left|right"}.'].join('\n');
}
function constrainedPrompt(state: FrozenState): string {
  const choices = state.validActions.map((move) => `${move.toUpperCase()}: score=${state.memory.actionEffects[move]?.totalExpectedEiLDelta ?? 'n/a'}; visits=${state.memory.visitCounts[key(nextPosition(state.position, move))] ?? 0}; smell=${state.perception.directionSmell[move]}`).join('\n');
  return ['Choose the best legal movement for a maze mouse.', `Current position: (${state.position.x},${state.position.y})`, `Goal position: (${state.goal.x},${state.goal.y})`, 'Only these legal choices are available:', choices, 'Return only JSON: {"move":"up|down|left|right"}.'].join('\n');
}
function layaBody(state: FrozenState, experiment: Experiment): Record<string, unknown> {
  const legal = experiment === 'A-raw' ? MOVES4 : state.validActions; const descriptions = Object.fromEntries(legal.map((move) => [move.toUpperCase(), experiment === 'A-raw' ? `${move} movement; local state ${state.perception.directions[move]}, smell ${state.perception.directionSmell[move]}` : `${move} movement; existing expected sensor score ${state.memory.actionEffects[move]?.totalExpectedEiLDelta}; visited ${state.memory.visitCounts[key(nextPosition(state.position, move))] ?? 0}`]));
  const prompt = experiment === 'A-raw' ? rawPrompt(state) : constrainedPrompt(state);
  return { state: { body: prompt }, questions: { move: { type: 'choice', instructions: 'Choose exactly one movement direction. Return the direction label.', criteria: descriptions } } };
}

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<{ response: Response; latencyMs: number }> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); const started = performance.now();
  try { const response = await fetch(url, { ...init, signal: controller.signal }); return { response, latencyMs: performance.now() - started }; } finally { clearTimeout(timer); }
}
export function parseMove(value: unknown): Choice { const text = typeof value === 'string' ? value : JSON.stringify(value); const match = text.match(/\b(up|down|left|right)\b/i); return match ? match[1].toLowerCase() as Move : null; }

async function callLaya(state: FrozenState, experiment: Experiment, config: Config): Promise<{ choice: Choice; latencyMs: number; failure: Partial<ResultRow> }> {
  const keyValue = process.env.LAYA_API_KEY; if (!keyValue) throw new Error('LAYA_API_KEY is required and is never written to results.');
  try { const result = await request(`${config.layaUrl}/v1/systemone`, { method: 'POST', headers: { authorization: `Bearer ${keyValue}`, 'content-type': 'application/json' }, body: JSON.stringify(layaBody(state, experiment)) }, config.timeoutMs); const body = await result.response.json() as any; if (!result.response.ok) return { choice: null, latencyMs: result.latencyMs, failure: { httpFailure: true, error: `HTTP ${result.response.status}` } }; const choice = parseMove(body?.answers?.move?.choice); return { choice, latencyMs: result.latencyMs, failure: { parseFailure: choice === null } }; } catch (error) { return { choice: null, latencyMs: config.timeoutMs, failure: { timeout: error instanceof Error && error.name === 'AbortError', httpFailure: !(error instanceof Error && error.name === 'AbortError'), error: error instanceof Error ? error.message : String(error) } }; }
}

async function callOllama(state: FrozenState, experiment: Experiment, config: Config): Promise<{ choice: Choice; latencyMs: number; failure: Partial<ResultRow> }> {
  const prompt = experiment === 'A-raw' ? rawPrompt(state) : constrainedPrompt(state);
  try { const result = await request(`${config.ollamaUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: config.ollamaModel, messages: [{ role: 'user', content: prompt }], stream: false, format: 'json', think: false, options: { temperature: 0.2 } }) }, config.timeoutMs); const body = await result.response.json() as any; if (!result.response.ok) return { choice: null, latencyMs: result.latencyMs, failure: { httpFailure: true, error: `HTTP ${result.response.status}` } }; let parsed: unknown; try { parsed = JSON.parse(body?.message?.content ?? ''); } catch { parsed = null; } const choice = parseMove((parsed as any)?.move); return { choice, latencyMs: result.latencyMs, failure: { parseFailure: choice === null } }; } catch (error) { return { choice: null, latencyMs: config.timeoutMs, failure: { timeout: error instanceof Error && error.name === 'AbortError', httpFailure: !(error instanceof Error && error.name === 'AbortError'), error: error instanceof Error ? error.message : String(error) } }; }
}

function evaluate(state: FrozenState, choice: Choice): Omit<ResultRow, 'experiment' | 'stateId' | 'model' | 'repetition' | 'latencyMs' | 'timeout' | 'httpFailure' | 'parseFailure' | 'error'> {
  const valid = choice !== null && state.validActions.includes(choice); const wallSelection = choice !== null && !valid; const score = choice ? state.memory.actionEffects[choice]?.totalExpectedEiLDelta ?? null : null; const optimal = choice !== null && state.optimalActions.includes(choice); return { choice, valid, wallSelection, optimal, score, regret: score === null ? null : state.bestScore - score, previouslyVisited: choice ? (state.memory.visitCounts[key(nextPosition(state.position, choice))] ?? 0) > 0 : false };
}

async function runRows(states: FrozenState[], experiment: Experiment, model: 'laya' | 'ollama', config: Config, repetitions = 1): Promise<ResultRow[]> {
  const rows: ResultRow[] = []; for (const state of states) for (let repetition = 1; repetition <= repetitions; repetition++) { const result = model === 'laya' ? await callLaya(state, experiment, config) : await callOllama(state, experiment, config); rows.push({ experiment, stateId: state.id, model, repetition, latencyMs: Math.round(result.latencyMs), ...evaluate(state, result.choice), timeout: Boolean(result.failure.timeout), httpFailure: Boolean(result.failure.httpFailure), parseFailure: Boolean(result.failure.parseFailure), error: result.failure.error }); await sleep(10); } return rows;
}

function summary(rows: ResultRow[]): Record<string, unknown> {
  const grouped = new Map<string, ResultRow[]>(); for (const row of rows) { const id = `${row.experiment}/${row.model}`; grouped.set(id, [...(grouped.get(id) ?? []), row]); }
  const output: Record<string, unknown> = {}; for (const [id, group] of grouped) { const latencies = group.map((r) => r.latencyMs).sort((a, b) => a - b); const ok = (fn: (r: ResultRow) => boolean) => group.length ? group.filter(fn).length / group.length : 0; const byState = new Map<string, ResultRow[]>(); for (const row of group) byState.set(row.stateId, [...(byState.get(row.stateId) ?? []), row]); const consistency = byState.size ? [...byState.values()].filter((reps) => new Set(reps.map((r) => r.choice)).size <= 1).length / byState.size * 100 : null; output[id] = { requests: group.length, validPct: ok((r) => r.valid) * 100, wallPct: ok((r) => r.wallSelection) * 100, optimalPct: ok((r) => r.optimal) * 100, visitedPct: ok((r) => r.previouslyVisited) * 100, consistencyPct: id.startsWith('C-') ? consistency : null, meanLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null, medianLatencyMs: latencies[Math.floor(latencies.length / 2)] ?? null, p95LatencyMs: latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? null, minLatencyMs: latencies[0] ?? null, maxLatencyMs: latencies.at(-1) ?? null, timeoutCount: group.filter((r) => r.timeout).length, httpFailureCount: group.filter((r) => r.httpFailure).length, parseFailureCount: group.filter((r) => r.parseFailure).length, meanRegret: group.filter((r) => r.regret !== null).reduce((sum, r, _, all) => sum + (r.regret ?? 0) / all.length, 0) }; } return output;
}
function csv(rows: ResultRow[]): string { const headers = ['experiment','stateId','model','repetition','choice','latencyMs','valid','wallSelection','optimal','score','regret','previouslyVisited','timeout','httpFailure','parseFailure','error']; return [headers.join(','), ...rows.map((row) => headers.map((header) => JSON.stringify((row as any)[header] ?? '')).join(','))].join('\n') + '\n'; }
function markdown(config: Config, dataset: FrozenState[], rows: ResultRow[], summaries: Record<string, unknown>): string { const lines = [`# Laya vs Ollama Maze Decision Benchmark`, ``, `- Timestamp: ${now()}`, `- Mode: ${config.mode}`, `- Dataset seed: ${config.seed}`, `- Frozen states: ${dataset.length}`, `- Ollama: ${config.ollamaModel} at ${config.ollamaUrl}`, `- Laya endpoint: ${config.layaUrl}/v1/systemone`, `- Ollama settings: temperature 0.2, think=false`, ``, `## Results`, ``, '| Experiment/model | Requests | Valid % | Wall % | Optimal % | Consistency % | Mean ms | Median ms | P95 ms | Mean regret |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|']; for (const [id, value] of Object.entries(summaries) as [string, any][]) lines.push(`| ${id} | ${value.requests} | ${value.validPct.toFixed(1)} | ${value.wallPct.toFixed(1)} | ${value.optimalPct.toFixed(1)} | ${value.consistencyPct?.toFixed(1) ?? 'n/a'} | ${value.meanLatencyMs?.toFixed(0) ?? 'n/a'} | ${value.medianLatencyMs ?? 'n/a'} | ${value.p95LatencyMs ?? 'n/a'} | ${value.meanRegret.toFixed(2)} |`); lines.push('', '## Methodology', '', 'Scores, legal actions, ties, perception, smell, visits, and memory are derived from the production `Maze` and `AgentMemory` implementations. Raw decisions expose sensor state but not calculated scores; constrained decisions expose only legal actions and their existing scores. Illegal outputs are recorded before evaluation. Laya uses documented `/v1/systemone` choice criteria; Ollama uses `/api/chat` with JSON output. No credentials are written to artifacts.', '', '## Limitations', '', 'This is a sequential client-observed benchmark. It measures complete HTTP latency, not internal inference time. The frozen dataset is deterministic but generated from the repository’s static maze layouts using a seeded walk; it is not a claim about all mazes.'); return lines.join('\n') + '\n'; }

async function main(): Promise<void> {
  const config = parseArgs(); if (!process.env.LAYA_API_KEY) throw new Error('Set LAYA_API_KEY from the remote /opt/laya/.env before running the benchmark.');
  const dataset = await createDataset(config.seed); const count = config.mode === 'smoke' ? 5 : config.mode === 'pilot' ? 20 : 100; const states = dataset.slice(0, count); const repeated = dataset.filter((_, index) => index % Math.max(1, Math.floor(dataset.length / 20)) === 0).slice(0, 20); const rows: ResultRow[] = [];
  console.log(`Frozen ${dataset.length} states; running ${config.mode} (${count} A/B states, ${repeated.length} repeated states).`);
  for (const model of ['laya', 'ollama'] as const) { console.log(`${model}: warm-up`); await (model === 'laya' ? callLaya(states[0], 'A-raw', config) : callOllama(states[0], 'A-raw', config)); rows.push(...await runRows(states, 'A-raw', model, config)); rows.push(...await runRows(states, 'B-constrained', model, config)); rows.push(...await runRows(repeated, 'C-repeated', model, config, 3)); }
  await fs.mkdir(config.outputDir, { recursive: true }); const stamp = now().replace(/[:.]/g, '-'); const payload = { metadata: { timestamp: now(), mode: config.mode, seed: config.seed, stateCount: dataset.length, model: config.ollamaModel, ollamaUrl: config.ollamaUrl, layaUrl: config.layaUrl, gitCommit: '84eeb926bf2baa15fee1091f2bfe260a0a483d12' }, dataset, rows, summaries: summary(rows) }; await fs.writeFile(path.join(config.outputDir, 'frozen-dataset.json'), JSON.stringify({ seed: config.seed, states: dataset }, null, 2)); await fs.writeFile(path.join(config.outputDir, `benchmark-${stamp}.json`), JSON.stringify(payload, null, 2)); await fs.writeFile(path.join(config.outputDir, `benchmark-${stamp}.csv`), csv(rows)); await fs.writeFile(path.join(config.outputDir, `benchmark-${stamp}.md`), markdown(config, dataset, rows, payload.summaries)); await fs.writeFile(path.join(config.outputDir, 'latest.json'), JSON.stringify(payload, null, 2)); await fs.writeFile(path.join(config.outputDir, 'latest.csv'), csv(rows)); await fs.writeFile(path.join(config.outputDir, 'latest.md'), markdown(config, dataset, rows, payload.summaries)); console.log(JSON.stringify(payload.summaries, null, 2));
}
if (!process.env.VITEST) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
