const $ = (id) => document.getElementById(id);
const values = () => ({ baseUrl: $('baseUrl').value.trim(), model: $('model').value.trim(), temperature: Number($('temperature').value) });

async function loadModels(selected) {
  const data = await (await fetch('/api/ollama/models')).json();
  const choices = [...new Set([selected, ...(data.models || [])].filter(Boolean))];
  $('model').innerHTML = choices.map((model) => `<option value="${model}">${model}</option>`).join('');
  $('model').value = selected;
}

async function load() {
  const { config } = await (await fetch('/api/settings')).json();
  $('baseUrl').value = config.baseUrl;
  $('temperature').value = config.temperature;
  await loadModels(config.model);
}

$('baseUrl').onchange = () => loadModels($('model').value).catch(() => {});
$('test').onclick = async () => {
  $('status').textContent = 'Testing connection…';
  try {
    const result = await (await fetch('/api/llm/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values()) })).json();
    $('status').textContent = result.message || 'Connection failed.';
  } catch {
    $('status').textContent = 'Connection test failed.';
  }
};
$('save').onclick = async () => {
  const config = values();
  if (!config.baseUrl || !config.model) {
    $('status').textContent = 'Enter the Ollama server URL and model before saving.';
    return;
  }
  try {
    const result = await (await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) })).json();
    $('status').textContent = result.ok ? 'AI settings saved. You can return to the maze.' : result.error || 'Could not save settings.';
  } catch {
    $('status').textContent = 'Could not save settings.';
  }
};
load().catch(() => ($('status').textContent = 'Could not load current settings.'));
