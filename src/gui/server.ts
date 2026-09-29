import fs from 'fs/promises';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Maze } from '@/maze/maze';
import { Mazes } from '@/maze/mazes';
import { ObservableMazeSolver, type SolverState } from '@/gui/solver';
import { createLLMClient } from '@/llm/client';
import { DEFAULT_LLM_CONFIG, publicLLMConfig, sanitizeLLMConfig, type LLMConfig } from '@/llm/config';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? fallback : fallback; };
const cliModel = option('--model', DEFAULT_LLM_CONFIG.model);
const cliOllamaUrl = option('--ollama-url', DEFAULT_LLM_CONFIG.baseUrl);
let mazeFile = option('--maze', './mazes/7x7_open_empty.txt');
const port = Number(option('--port', '4173'));
let delayMs = 500;
let llmConfig: LLMConfig = sanitizeLLMConfig({ ...DEFAULT_LLM_CONFIG, model: cliModel, baseUrl: cliOllamaUrl });
let configured = args.includes('--model') || args.includes('--ollama-url') || process.env.LLM_CONFIGURED === '1';
let maze = await Maze.fromFile(mazeFile);
let state: SolverState;
const clients = new Set<http.ServerResponse>();
let solver: ObservableMazeSolver;
function createSolver(): void {
  solver = new ObservableMazeSolver(maze, mazeFile, llmConfig, () => delayMs, (next) => { state = next; broadcast(); });
  state = solver.state;
}
createSolver();
function broadcast(): void { const data = `data: ${JSON.stringify(state)}\n\n`; for (const client of clients) client.write(data); }
async function body(req: http.IncomingMessage): Promise<any> { let text = ''; for await (const chunk of req) text += chunk; return text ? JSON.parse(text) : {}; }
async function serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname === '/api/mazes') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await Mazes.all())); return; }
  if (url.pathname === '/api/status') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ name: 'LLM Maze Solver with Adaptive Thinking', version: '3.0.0', configured })); return; }
  if (url.pathname === '/api/state') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state)); return; }
  if (url.pathname === '/api/settings' && req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ configured, config: publicLLMConfig(llmConfig) })); return; }
  if (url.pathname === '/api/settings' && req.method === 'POST') {
    const data = await body(req);
    if (typeof data.baseUrl !== 'string' || !data.baseUrl.trim() || typeof data.model !== 'string' || !data.model.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Enter an Ollama server URL and model before saving.' }));
      return;
    }
    llmConfig = sanitizeLLMConfig(data);
    configured = true;
    solver.stop();
    createSolver();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, config: publicLLMConfig(llmConfig) }));
    return;
  }
  if (url.pathname === '/api/llm/test' && req.method === 'POST') {
    try {
      const data = await body(req);
      const result = await createLLMClient(sanitizeLLMConfig(data)).testConnection();
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, ...result }));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, message: error instanceof Error ? error.message : 'Connection test failed.' }));
    }
    return;
  }
  if (url.pathname === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); clients.add(res); res.write(`data: ${JSON.stringify(state)}\n\n`); req.on('close', () => clients.delete(res)); return; }
  if (url.pathname === '/api/control' && req.method === 'POST') { const data = await body(req); if (typeof data.delayMs === 'number') delayMs = Math.max(0, Math.min(3000, data.delayMs)); if ((data.action === 'start' || data.action === 'step') && !configured) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Configure an LLM before starting the maze.' })); return; } if (data.action === 'start') solver.start(); if (data.action === 'pause') solver.pause(); if (data.action === 'resume') solver.resume(); if (data.action === 'step') solver.step(); if (data.action === 'stop') solver.stop(); if (data.action === 'reset') solver.reset(); res.end(JSON.stringify({ ok: true })); return; }
  if (url.pathname === '/api/new-maze' && req.method === 'POST') { const data = await body(req); const files = await Mazes.find(data.pattern); const nextFile = data.file ?? files[0]; solver.stop(); mazeFile = nextFile; maze = await Maze.fromFile(mazeFile); createSolver(); broadcast(); res.end(JSON.stringify({ ok: true })); return; }
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); const file = path.resolve(publicDir, requested); if (!file.startsWith(publicDir)) { res.writeHead(403); res.end(); return; }
  try { const content = await fs.readFile(file); res.setHeader('Content-Type', requested.endsWith('.css') ? 'text/css' : requested.endsWith('.js') ? 'text/javascript' : 'text/html'); res.end(content); } catch { res.writeHead(404); res.end('Not found'); }
}
http.createServer((req, res) => { void serve(req, res).catch((error) => { res.writeHead(500); res.end(String(error)); }); }).listen(port, () => console.log(`LLM Maze Solver with Adaptive Thinking v3.0.0: http://localhost:${port}`));
