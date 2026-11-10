import { spawn } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadLevel2, type CatState } from '@/game/level2';
import { settingsChangeError } from '@/gui/settings-guard';
import { GUI_VARIANT, LEVEL2_VARIANT, ObservableMazeSolver, type SolverState } from '@/gui/solver';
import { DEFAULT_LLM_CONFIG, configuredOllamaUrl, sanitizeLLMConfig, type LLMConfig } from '@/llm/config';
import { OllamaClient } from '@/llm/ollama';
import { Maze } from '@/maze/maze';

const MAZE_DIRS = { 1: { dir: './mazes', ext: '.txt' }, 2: { dir: './mazes/level2', ext: '.json' } } as const;
type LevelNumber = keyof typeof MAZE_DIRS;
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => (args.includes(name) ? (args[args.indexOf(name) + 1] ?? fallback) : fallback);
const port = Number(option('--port', '4173'));
let mazeFile = option('--maze', './mazes/7x7_open_detour.txt');
let delayMs = 500;
let llmConfig: LLMConfig = sanitizeLLMConfig({
  ...DEFAULT_LLM_CONFIG,
  model: option('--model', DEFAULT_LLM_CONFIG.model),
  baseUrl: option('--ollama-url', configuredOllamaUrl()),
});
let level: LevelNumber = 1;
let maze: Maze;
let cat: CatState | null = null;
await loadMaze(mazeFile);
let state: SolverState;
let solver: ObservableMazeSolver;
const clients = new Set<http.ServerResponse>();

function createSolver(): void {
  solver = new ObservableMazeSolver(
    maze,
    mazeFile,
    llmConfig,
    () => delayMs,
    (next) => {
      state = next;
      broadcast();
    },
    cat,
  );
  state = solver.state;
}
createSolver();

function broadcast(): void {
  const data = `data: ${JSON.stringify(state)}\n\n`;
  for (const client of clients) client.write(data);
}
async function readBody(req: http.IncomingMessage): Promise<any> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}
function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}
async function loadMaze(file: string): Promise<void> {
  if (file.endsWith('.json')) {
    const loaded = await loadLevel2(file);
    [level, maze, cat] = [2, loaded.maze, loaded.cat];
  } else [level, maze, cat] = [1, await Maze.fromFile(file), null];
}
async function mazeFiles(forLevel: LevelNumber): Promise<string[]> {
  const { dir, ext } = MAZE_DIRS[forLevel];
  return (await fs.readdir(dir))
    .filter((file) => file.endsWith(ext))
    .sort()
    .map((file) => path.join(dir, file));
}
const levelParam = (value: unknown): LevelNumber => (String(value) === '2' ? 2 : 1);

async function serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname === '/api/mazes') return json(res, 200, await mazeFiles(levelParam(url.searchParams.get('level') ?? level)));
  if (url.pathname === '/api/state') return json(res, 200, state);
  if (url.pathname === '/api/settings' && req.method === 'GET') return json(res, 200, { config: llmConfig, variants: { 1: GUI_VARIANT, 2: LEVEL2_VARIANT } });
  if (url.pathname === '/api/settings' && req.method === 'POST') {
    const refusal = settingsChangeError(state);
    if (refusal) return json(res, 409, { ok: false, error: refusal });
    const data = await readBody(req);
    if (typeof data.baseUrl !== 'string' || !data.baseUrl.trim() || typeof data.model !== 'string' || !data.model.trim())
      return json(res, 400, { ok: false, error: 'Enter an Ollama server URL and model before saving.' });
    llmConfig = sanitizeLLMConfig(data);
    solver.stop();
    createSolver();
    broadcast();
    return json(res, 200, { ok: true, config: llmConfig });
  }
  if (url.pathname === '/api/ollama/models') {
    try {
      return json(res, 200, { models: await new OllamaClient(llmConfig).listModels() });
    } catch (error) {
      return json(res, 502, { models: [], error: error instanceof Error ? error.message : 'Could not load Ollama models.' });
    }
  }
  if (url.pathname === '/api/llm/test' && req.method === 'POST') {
    try {
      return json(res, 200, { success: true, message: await new OllamaClient(sanitizeLLMConfig(await readBody(req))).testConnection() });
    } catch (error) {
      return json(res, 400, { success: false, message: error instanceof Error ? error.message : 'Connection test failed.' });
    }
  }
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    clients.add(res);
    res.write(`data: ${JSON.stringify(state)}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/api/control' && req.method === 'POST') {
    const data = await readBody(req);
    if (typeof data.delayMs === 'number') delayMs = Math.max(0, Math.min(3000, data.delayMs));
    const actions: Record<string, () => void> = {
      start: () => solver.start(),
      pause: () => solver.pause(),
      resume: () => solver.resume(),
      step: () => solver.step(),
      stop: () => solver.stop(),
      reset: () => solver.reset(),
    };
    actions[data.action]?.();
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/new-maze' && req.method === 'POST') {
    const data = await readBody(req);
    if (!(await mazeFiles(levelParam(data.level))).includes(data.file)) return json(res, 400, { ok: false, error: 'Unknown maze.' });
    solver.stop();
    mazeFile = data.file;
    await loadMaze(mazeFile);
    createSolver();
    broadcast();
    return json(res, 200, { ok: true });
  }
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.resolve(publicDir, requested);
  if (!file.startsWith(publicDir)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const content = await fs.readFile(file);
    const type = { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(file)] ?? 'text/html';
    res.setHeader('Content-Type', type);
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

http
  .createServer((req, res) => {
    void serve(req, res).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  })
  .listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`LLM Maze Solver: ${url} (Ollama ${llmConfig.model} at ${llmConfig.baseUrl})`);
    if (args.includes('--open')) openBrowser(url);
  });

/** `npm start`: open the GUI in the default browser where there is one; otherwise the URL above is enough. */
function openBrowser(url: string): void {
  const [command, ...rest] = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
  try {
    const child = spawn(command, rest, { detached: true, stdio: 'ignore' });
    child.on('error', () => console.log(`Open ${url} in your browser.`));
    child.unref();
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}
