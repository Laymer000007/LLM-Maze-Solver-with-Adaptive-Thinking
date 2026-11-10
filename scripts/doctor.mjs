// `npm run doctor`: checks that this machine can run the maze solver, and says how to fix what is missing.
// Plain JavaScript run by node directly, so it also works on Node versions too old for the app itself.

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const url = (process.env.OLLAMA_URL || '').trim() || DEFAULT_OLLAMA_URL;
const model = (process.env.OLLAMA_MODEL || '').trim() || 'qwen3:1.7b';
let failed = 0;

const ok = (message) => console.log(`  ✓ ${message}`);
const fail = (message, fixes) => {
  failed++;
  console.log(`  ✗ ${message}`);
  for (const fix of fixes) console.log(`      → ${fix}`);
};

console.log('LLM Maze Solver doctor\n');

const major = Number(process.versions.node.split('.')[0]);
if (major >= 24) ok(`Node ${process.versions.node}`);
else fail(`Node ${process.versions.node} is too old; version 24 or newer is needed.`, ['Install Node 24 or newer from https://nodejs.org/en/download (or with nvm: nvm install 24).']);

const pointAt = `To use an Ollama server elsewhere: OLLAMA_URL=http://<server>:11434 npm run doctor (and the same for npm start).`;
let models = null;
if (typeof fetch !== 'function') fail(`Can't check Ollama at ${url}: this Node has no fetch.`, ['Upgrade Node first (see above).']);
else {
  try {
    const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    models = ((await response.json()).models ?? []).map((m) => m.name);
    ok(`Ollama is reachable at ${url}`);
  } catch (error) {
    fail(`Ollama is not reachable at ${url} (${error?.cause?.code ?? error?.name ?? error}).`, [
      'Install Ollama from https://ollama.com/download and start it (ollama serve, or the Ollama app).',
      pointAt,
    ]);
  }
}

if (models) {
  if (models.includes(model) || models.includes(`${model}:latest`)) ok(`Model ${model} is pulled`);
  else
    fail(`Model ${model} is not pulled on ${url}${models.length ? ` (it has: ${models.join(', ')})` : ''}.`, [
      `ollama pull ${model}${url === DEFAULT_OLLAMA_URL ? '' : `   (run it on the Ollama server, or: OLLAMA_HOST=${url} ollama pull ${model})`}`,
    ]);
}

console.log(failed ? `\n${failed} problem${failed > 1 ? 's' : ''} found.` : '\nAll good. Run: npm start');
process.exitCode = failed ? 1 : 0;
