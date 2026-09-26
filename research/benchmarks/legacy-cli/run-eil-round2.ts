import { spawn } from 'node:child_process';
import fs from 'fs/promises';
import path from 'path';
import yaml from 'yaml';

const outputRoot = process.argv[2] ?? './output/eil-scale-comparison-round2';
const model = process.env.EIL_MODEL ?? 'qwen3:1.7b';
const maze = process.env.EIL_MAZE ?? './mazes/11x11_corridor_dead-end.txt';
const ollamaUrl = process.env.EIL_OLLAMA_URL ?? 'http://192.168.88.100:11434';
const scales = ['signed', 'normalized', 'positive100'] as const;
const runsPerScale = 5;
const maxAttempts = 3;
const timeoutMs = 240_000;

type Run = { decisionCount?: number; stopReason?: string; [key: string]: unknown };

await fs.mkdir(outputRoot, { recursive: true });
const retryLog: string[] = [];

for (const scale of scales) {
  await fs.mkdir(path.join(outputRoot, scale), { recursive: true });
  for (let runNumber = 1; runNumber <= runsPerScale; runNumber++) {
    const destination = path.join(outputRoot, scale, `run-${runNumber}.yaml`);
    if (await exists(destination)) continue;
    let complete: Run | null = null;
    for (let attempt = 1; attempt <= maxAttempts && !complete; attempt++) {
      const rawDir = path.join(outputRoot, 'raw', scale, `run-${runNumber}-attempt-${attempt}`);
      await fs.mkdir(rawDir, { recursive: true });
      const started = new Date().toISOString();
      const exitCode = await execute(rawDir, scale, runNumber);
      const rawFile = path.join(rawDir, 'run.yaml');
      if (exitCode === 0 && await exists(rawFile)) {
        const parsed = yaml.parse(await fs.readFile(rawFile, 'utf8')) as Run;
        if (parsed.decisionCount && parsed.stopReason) {
          complete = { ...parsed, scale, runNumber, attempt, benchmarkMaze: maze, benchmarkModel: model, benchmarkTemperature: 0.2 };
          await fs.writeFile(destination, yaml.stringify(complete));
          break;
        }
      }
      retryLog.push(`${new Date().toISOString()} scale=${scale} run=${runNumber} attempt=${attempt} exit=${exitCode ?? 'timeout'} raw=${rawDir}`);
    }
    if (!complete) throw new Error(`Unable to complete ${scale} run ${runNumber} after ${maxAttempts} attempts.`);
  }
}

await fs.writeFile(path.join(outputRoot, 'retries.log'), retryLog.length ? retryLog.join('\n') + '\n' : 'No infrastructure retries were needed.\n');
console.log(`Completed ${scales.length * runsPerScale} benchmark runs in ${outputRoot}`);

async function execute(rawDir: string, scale: string, runNumber: number): Promise<number | null> {
  const args = [
    'run', 'agent-execute', '--',
    '--model', model,
    '--maze', maze,
    '--max-steps', '30',
    '--eil-scale', scale,
    '--ollama-url', ollamaUrl,
    '--output', rawDir,
    '--benchmark',
    '--run-number', String(runNumber),
  ];
  return await new Promise((resolve) => {
    const child = spawn('npm', args, { cwd: process.cwd(), stdio: 'ignore', detached: true });
    let settled = false;
    const finish = (code: number | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(code); } };
    const killGroup = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch { child.kill(signal); } } };
    const timer = setTimeout(() => { killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 5_000); finish(null); }, timeoutMs);
    child.on('error', () => finish(1));
    child.on('exit', (code) => finish(code));
  });
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}
