const $ = (id) => document.getElementById(id);
const canvas = $('maze');
const ctx = canvas.getContext('2d');
const mouseSprite = new Image();
const cheeseSprite = new Image();
mouseSprite.src = '/assets/mouse.png';
cheeseSprite.src = '/assets/cheese.png';
let latest = null;

function post(action) {
  fetch('/api/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, delayMs: Number($('delay').value) }) });
}
['start', 'pause', 'resume', 'step', 'stop', 'reset'].forEach((id) => ($(id).onclick = () => post(id)));
$('delay').oninput = () => {
  $('delayValue').value = `${$('delay').value} ms`;
  post('delay');
};

async function loadMazes() {
  const files = await (await fetch('/api/mazes')).json();
  $('mazeSelect').innerHTML = files.map((file) => `<option value="${file}">${file}</option>`).join('');
  if (latest) $('mazeSelect').value = latest.mazeFile;
}
$('loadMaze').onclick = () => fetch('/api/new-maze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: $('mazeSelect').value }) });
loadMazes();

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const label = (direction) => direction.toUpperCase();

function render(s) {
  latest = s;
  $('status').textContent = s.status;
  $('status').className = `badge ${s.status.toLowerCase()}`;
  $('mazeName').textContent = s.mazeFile;
  $('moodScore').textContent = `${s.mood} / 1000`;
  $('moodWord').textContent = s.moodWord;
  $('moodChange').textContent = s.lastMoodChange === null ? '—' : `${s.lastMoodChange > 0 ? '+' : ''}${s.lastMoodChange}`;
  $('closeness').textContent = s.closeness.replace('The cheese smell is ', '').replace(/\.$/, '');
  $('offered').textContent = s.offered.length ? s.offered.map((o) => `${label(o.direction)}: ${o.level}`).join('\n') : '—';
  $('answer').textContent = s.lastAnswer ? label(s.lastAnswer) : '—';
  $('error').textContent = s.error || '—';
  $('prompt').textContent = s.prompt || '—';
  $('response').textContent = s.response || '—';
  $('moves').textContent = s.moveLog.length ? s.moveLog.join('\n') : 'No moves yet.';
  const stats = [
    ['POSITION', `(${s.current.x}, ${s.current.y})`],
    ['STEP', `${s.step} / ${s.stepCap}`],
    ['OPTIMAL', s.optimal],
    ['CELLS VISITED', s.visited.length],
    ['INVALID ANSWERS', s.invalidMoves],
    ['ELAPSED', seconds(s.elapsedMs)],
    ['AI CALLS', s.llmCalls],
    ['AVG RESPONSE', s.averageResponseMs ? `${s.averageResponseMs} ms` : '—'],
  ];
  $('stats').innerHTML = stats.map(([k, v]) => `<div class="stat"><small>${k}</small><b>${v}</b></div>`).join('');
  draw(s);
}

function draw(s) {
  const rows = s.layout.length;
  const cols = Math.max(...s.layout.map((r) => r.length));
  const box = canvas.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  canvas.width = box.width * dpr;
  canvas.height = box.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cell = Math.min(box.width / cols, box.height / rows);
  const ox = (box.width - cell * cols) / 2;
  const oy = (box.height - cell * rows) / 2;
  const center = (p) => [ox + (p.x + 0.5) * cell, oy + (p.y + 0.5) * cell];
  ctx.fillStyle = '#0d1521';
  ctx.fillRect(0, 0, box.width, box.height);
  const visited = new Set(s.visited.map((p) => `${p.x},${p.y}`));
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const ch = s.layout[y][x] || '#';
      ctx.fillStyle = ch === '#' ? '#26364b' : visited.has(`${x},${y}`) ? '#1d3445' : '#152333';
      ctx.fillRect(ox + x * cell + 1, oy + y * cell + 1, cell - 2, cell - 2);
    }
  // The path joins cell centres, so diagonal moves show as diagonal lines.
  ctx.strokeStyle = '#4d7891';
  ctx.lineWidth = Math.max(2, cell * 0.12);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  s.path.forEach((p, i) => (i ? ctx.lineTo(...center(p)) : ctx.moveTo(...center(p))));
  ctx.stroke();
  marker(center(s.start), cell, '#ffda79', 'S');
  if (!drawSprite(cheeseSprite, center(s.goal), cell)) marker(center(s.goal), cell, '#f37bff', 'G');
  if (s.status === 'BLOCKED') {
    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 3;
    ctx.strokeRect(ox + s.current.x * cell + 2, oy + s.current.y * cell + 2, cell - 4, cell - 4);
  }
  if (!drawSprite(mouseSprite, center(s.current), cell)) marker(center(s.current), cell, '#5de4d1', 'M');
}

function marker([x, y], cell, color, text) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, cell * 0.27, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#07121a';
  ctx.font = `bold ${Math.max(10, cell * 0.28)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

function drawSprite(image, [x, y], cell) {
  if (!image.complete || !image.naturalWidth) return false;
  const scale = Math.min((cell * 0.82) / image.naturalWidth, (cell * 0.82) / image.naturalHeight);
  ctx.drawImage(image, x - (image.naturalWidth * scale) / 2, y - (image.naturalHeight * scale) / 2, image.naturalWidth * scale, image.naturalHeight * scale);
  return true;
}

new EventSource('/api/events').onmessage = (e) => render(JSON.parse(e.data));
window.onresize = () => latest && draw(latest);
mouseSprite.onload = cheeseSprite.onload = () => latest && draw(latest);
fetch('/api/settings')
  .then((r) => r.json())
  .then(({ config, variant }) => ($('aiIndicator').textContent = `AI: Ollama / ${config.model} · prompt: ${variant}`))
  .catch(() => {});
