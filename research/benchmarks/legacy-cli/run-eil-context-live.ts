import fs from 'fs/promises';
import path from 'path';
import { performance } from 'node:perf_hooks';
import { ChatOllama } from '@langchain/ollama';
import yaml from 'yaml';
import { AgentMemory } from '@/agent/memory';
import { buildLocalAgentPrompt, getDirectionChoices } from '@/agent/prompt';
import { createActionSchema, type Move } from '@/execution/execution';
import { Maze } from '@/maze/maze';
import type { EiLScale } from '@/agent/eil';

const root = path.resolve(process.argv[2] ?? './output/eil-context-density');
const mazeFile = 'mazes/15x15_corridor_dead-end.txt';
const model = 'qwen3:1.7b'; const temperature = 0.2;
const url = process.env.EIL_OLLAMA_URL ?? 'http://192.168.88.100:11434';
const levels = process.argv.slice(3).filter(x => /^L[0-8]$/.test(x));
const selected = levels.length ? levels : ['L2','L5','L7'];
const maze = await Maze.fromFile(mazeFile);
await fs.mkdir(path.join(root, 'live-validation'), { recursive: true });
const llm = new ChatOllama({ model, baseUrl: url, think: false, temperature });
const cardinal = llm.withStructuredOutput(createActionSchema(false), { includeRaw: true });
const cheese = llm.withStructuredOutput(createActionSchema(true), { includeRaw: true });
for (const level of selected) for (let run = 1; run <= 5; run++) await runOne(level, run);
await writeSummary();

async function runOne(level: string, run: number) {
  const memory = new AgentMemory(); let current = { ...maze.startPosition }; const steps: any[] = []; const started = performance.now();
  while ((current.x !== maze.goalPosition.x || current.y !== maze.goalPosition.y) && steps.length < 15) {
    const perception = maze.perceive(current); memory.rememberPerception(perception); const state = memory.snapshot();
    const choices = getDirectionChoices(perception, state); const prompt = adapt(buildLocalAgentPrompt(perception, state, 'signed'), level, choices);
    const t = performance.now(); let result: any; let error = '';
    try {
      const active = perception.visibleCells.some(c => c.cell === 'goal') ? cheese : cardinal;
      result = await Promise.race([active.invoke(prompt), new Promise((_, reject) => setTimeout(() => reject(new Error('live request timeout after 60000ms')), 60000))]);
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    const raw = result?.raw ?? {}; const metadata = (raw.response_metadata ?? {}) as Record<string, unknown>; const action = result?.parsed?.move as Move | undefined;
    const visibleGoal = perception.visibleCells.find(c => c.cell === 'goal'); const move: Move | undefined = (action as string) === 'cheese' ? (visibleGoal ? directionBetween(current, visibleGoal.position) : undefined) : action;
    const choice = choices.find(c => c.direction === move); const best = Math.max(...choices.filter(c => !c.blocked && c.score !== undefined).map(c => c.score!));
    let succeeded = false; let physicalSteps = 0;
    if (move) {
      do {
        const from = { ...current }; const target = next(current, move);
        if (!maze.isWalkable(target)) { memory.rememberAction({ from, move, succeeded: false, to: from, message: 'hit wall' }); break; }
        current = target; physicalSteps++; succeeded = true;
        const entered = maze.perceive(current); memory.rememberPerception(entered);
        memory.rememberAction({ from, move, succeeded: true, to: { ...current }, message: 'moved' });
        if (current.x === maze.goalPosition.x && current.y === maze.goalPosition.y) break;
      } while (!maze.isDecisionPoint(current, move));
    }
    steps.push({ step: steps.length + 1, prompt, selectedMove: move ?? null, selectedScore: choice?.score ?? null, bestAvailableScore: best, regret: choice?.score === undefined ? null : best - choice.score, valid: Boolean(choice && !choice.blocked), succeeded, physicalSteps, error, applicationLatencyMs: performance.now() - t, metadata, promptChars: prompt.length, promptBytes: Buffer.byteLength(prompt, 'utf8'), thinking: false });
    console.error(`live ${level} run ${run}: decision ${steps.length}`);
    if (!result && error) break;
  }
  await fs.writeFile(path.join(root, 'live-validation', `${level}-run-${run}.yaml`), yaml.stringify({ level, run, maze: mazeFile, model, temperature, think: false, solved: current.x === maze.goalPosition.x && current.y === maze.goalPosition.y, elapsedMs: performance.now() - started, decisions: steps.length, physicalSteps: steps.filter(s => s.succeeded).length, steps, totalPromptTokens: steps.reduce((n,s)=>n+Number(s.metadata.prompt_eval_count??0),0), totalGeneratedTokens: steps.reduce((n,s)=>n+Number(s.metadata.eval_count??0),0), catastrophicErrors: steps.filter(s => (s.regret??0)>=10).length }));
}
function next(p: {x:number;y:number}, move: Move | {x:number;y:number}) { if (typeof move === 'string') return move==='up'?{x:p.x,y:p.y-1}:move==='down'?{x:p.x,y:p.y+1}:move==='left'?{x:p.x-1,y:p.y}:{x:p.x+1,y:p.y}; return move; }
function directionBetween(a:{x:number;y:number}, b:{x:number;y:number}): Move | undefined { if (b.x===a.x && b.y===a.y-1) return 'up'; if (b.x===a.x && b.y===a.y+1) return 'down'; if (b.x===a.x-1 && b.y===a.y) return 'left'; if (b.x===a.x+1 && b.y===a.y) return 'right'; return undefined; }
function adapt(prompt: string, level: string, choices: any[]): string { if (level === 'L5') return prompt; const parts = prompt.split('\n\n'); const idx = (s:string) => parts.findIndex(x=>x.startsWith(s)); if (level === 'L2') return [parts[0], parts[1], parts[3], parts[parts.length-1]].filter(Boolean).join('\n\n'); if (level === 'L6') return prompt + '\n\nDECISION SUMMARY: choose the highest available score, avoid severe aversion, and never choose blocked cells.'; if (level === 'L7') return prompt + `\n\nRELEVANT HISTORY: nearby choices and visit counts are current evidence: ${choices.filter(c=>!c.blocked).map(c=>`${c.direction} visits=${c.visitCount} score=${c.score}`).join('; ')}.`; return prompt; }
async function writeSummary() { const files = (await fs.readdir(path.join(root,'live-validation'))).filter(x=>x.endsWith('.yaml')&&x.includes('-run-')); const rows:any[]=[]; for(const f of files) rows.push(yaml.parse(await fs.readFile(path.join(root,'live-validation',f),'utf8'))); const lines=['# Live validation','',`Maze: ${mazeFile}; model: ${model}; temperature: ${temperature}; think:false.` ,'','| Level | Goal success | Median time to cheese | Average time to cheese | Total tokens | Catastrophic errors |','|---|---:|---:|---:|---:|---:|']; for(const l of selected){const g=rows.filter(r=>r.level===l);const times=g.filter(r=>r.solved).map(r=>r.elapsedMs);const tok=g.reduce((n,r)=>n+r.totalPromptTokens+r.totalGeneratedTokens,0);const med=times.sort((a,b)=>a-b)[Math.floor((times.length-1)/2)]??0;lines.push(`| ${l} | ${g.filter(r=>r.solved).length}/5 | ${(med/1000).toFixed(2)} s | ${(times.reduce((a,b)=>a+b,0)/Math.max(times.length,1)/1000).toFixed(2)} s | ${tok} | ${g.reduce((n,r)=>n+r.catastrophicErrors,0)} |`);} await fs.writeFile(path.join(root,'live-validation','summary.md'),lines.join('\n')+'\n'); }
