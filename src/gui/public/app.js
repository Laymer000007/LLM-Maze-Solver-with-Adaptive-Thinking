const $ = (id) => document.getElementById(id);
const canvas = $('maze');
const ctx = canvas.getContext('2d');
const mouseSprite = new Image();
const cheeseSprite = new Image();
const catSprite = new Image();
mouseSprite.src = '/assets/mouse.png';
cheeseSprite.src = '/assets/cheese.png';
catSprite.src = '/assets/cat.svg';
let latest = null;
let spriteCell = 0;

function post(action) {
  fetch('/api/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, delayMs: Number($('delay').value) }) });
}
['start', 'pause', 'resume', 'step', 'stop', 'reset'].forEach((id) => ($(id).onclick = () => post(id)));
$('delay').oninput = () => {
  $('delayValue').value = `${$('delay').value} ms`;
  post('delay');
};

async function loadMazes() {
  const files = await (await fetch(`/api/mazes?level=${$('levelSelect').value}`)).json();
  $('mazeSelect').innerHTML = files.map((file) => `<option value="${file}">${file}</option>`).join('');
  if (latest && files.includes(latest.mazeFile)) $('mazeSelect').value = latest.mazeFile;
}
$('levelSelect').onchange = () => loadMazes();
$('loadMaze').onclick = () =>
  fetch('/api/new-maze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: $('levelSelect').value, file: $('mazeSelect').value }) });
let variants = {};
let firstState = true;

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const label = (direction) => direction.toUpperCase();

function render(s) {
  if (firstState) {
    firstState = false;
    $('levelSelect').value = String(s.level);
    loadMazes();
  }
  if (latest && latest.mazeFile !== s.mazeFile) catFrom = catTo = null;
  latest = s;
  $('aiIndicator').textContent = variants[s.level] ? `AI: Ollama / ${variants.model} · level ${s.level} · prompt: ${variants[s.level]}` : 'AI: —';
  $('catBox').hidden = s.level !== 2;
  $('catLine').textContent = s.catLine || '—';
  $('catPenalty').textContent = s.lastCatPenalty === null ? '—' : String(s.lastCatPenalty);
  $('status').textContent = s.status;
  $('status').className = `badge ${s.status.toLowerCase()}`;
  $('mazeName').textContent = s.mazeFile;
  $('moodScore').textContent = `${s.mood} / 1000`;
  $('moodWord').textContent = s.moodWord;
  $('moodChange').textContent = s.lastMoodChange === null ? '—' : `${s.lastMoodChange > 0 ? '+' : ''}${s.lastMoodChange}`;
  $('closeness').textContent = s.closeness.replace('The cheese smell is ', '').replace(/\.$/, '');
  $('offered').textContent = s.offered.length ? s.offered.map((o) => `${label(o.direction)}: ${o.level}`).join('\n') : '—';
  $('answer').textContent = s.lastAnswer ? (s.stayed ? 'STAY (stays put)' : label(s.lastAnswer)) : '—';
  $('error').textContent = s.error || '—';
  $('prompt').textContent = s.prompt || '—';
  $('response').textContent = s.response || '—';
  $('moves').textContent = s.moveLog.length ? s.moveLog.join('\n') : 'No moves yet.';
  const stats = [
    ['POSITION', `(${s.current.x}, ${s.current.y})`],
    ['STEP', `${s.step} / ${s.stepCap}`],
    [s.level === 2 ? 'SHORTEST SAFE' : 'OPTIMAL', s.optimal],
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
  // Sprites keep a readable size on big maps by spilling over into the neighbouring cells.
  spriteCell = Math.max(cell, 24);
  ctx.fillStyle = '#0d1521';
  ctx.fillRect(0, 0, box.width, box.height);
  const visited = new Set(s.visited.map((p) => `${p.x},${p.y}`));
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const ch = s.layout[y][x] || '#';
      // Small cells: solid, brighter walls without gaps, so corridors stay readable on the big maps.
      const small = cell < 14;
      ctx.fillStyle = ch === '#' ? (small ? '#3b5574' : '#26364b') : visited.has(`${x},${y}`) ? '#1d3445' : '#111c2a';
      const gap = small ? 0 : 1;
      ctx.fillRect(ox + x * cell + gap, oy + y * cell + gap, cell - 2 * gap + (small ? 0.5 : 0), cell - 2 * gap + (small ? 0.5 : 0));
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
  if (!drawSprite(cheeseSprite, center(s.goal), spriteCell)) marker(center(s.goal), cell, '#f37bff', 'G');
  if (s.status === 'BLOCKED') {
    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 3;
    ctx.strokeRect(ox + s.current.x * cell + 2, oy + s.current.y * cell + 2, cell - 4, cell - 4);
  }
  if (s.stayed) {
    ctx.strokeStyle = '#ffda79';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(...center(s.current), spriteCell * 0.45, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // The mouse image has wide transparent margins, so it is drawn larger than the cell.
  if (!drawSprite(mouseSprite, center(s.current), spriteCell, 1.25)) marker(center(s.current), cell, '#5de4d1', 'M');
  if (s.cat) drawCat(catPosition(s.cat), cell, ox, oy);
}

// The cat glides from its last drawn cell to the new one after the mouse has moved.
let catFrom = null;
let catTo = null;
let catStart = 0;
const CAT_GLIDE_MS = 250;
function catPosition(cat) {
  if (!catTo || catTo.x !== cat.x || catTo.y !== cat.y) {
    catFrom = catTo ?? cat;
    catTo = { ...cat };
    catStart = performance.now();
    requestAnimationFrame(function tick() {
      if (latest) draw(latest);
      if (performance.now() - catStart < CAT_GLIDE_MS) requestAnimationFrame(tick);
    });
  }
  const t = Math.min(1, (performance.now() - catStart) / CAT_GLIDE_MS);
  return { x: catFrom.x + (catTo.x - catFrom.x) * t, y: catFrom.y + (catTo.y - catFrom.y) * t };
}

/** The cat sprite (assets/cat.svg, an original sitting cat in side view), slightly larger than the mouse so it stands out. */
function drawCat(p, cell, ox, oy) {
  const centre = [ox + (p.x + 0.5) * cell, oy + (p.y + 0.5) * cell];
  if (!drawSprite(catSprite, centre, spriteCell, 0.95)) marker(centre, cell, '#f0a24b', 'C');
}

function marker([x, y], cell, color, text) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, cell * 0.3, 0, Math.PI * 2);
  ctx.fill();
  // On big maps the cells are too small for a letter; the coloured dot alone marks the cell.
  if (cell < 16) return;
  ctx.fillStyle = '#07121a';
  ctx.font = `bold ${cell * 0.32}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

function drawSprite(image, [x, y], cell, fill = 0.82) {
  if (!image.complete || !image.naturalWidth) return false;
  const scale = Math.min((cell * fill) / image.naturalWidth, (cell * fill) / image.naturalHeight);
  ctx.drawImage(image, x - (image.naturalWidth * scale) / 2, y - (image.naturalHeight * scale) / 2, image.naturalWidth * scale, image.naturalHeight * scale);
  return true;
}

new EventSource('/api/events').onmessage = (e) => render(JSON.parse(e.data));
window.onresize = () => latest && draw(latest);
mouseSprite.onload = cheeseSprite.onload = catSprite.onload = () => latest && draw(latest);
fetch('/api/settings')
  .then((r) => r.json())
  .then(({ config, variants: v }) => {
    variants = { ...v, model: config.model };
    if (latest) render(latest);
  })
  .catch(() => {});
