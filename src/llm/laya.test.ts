import { describe, expect, it, vi } from 'vitest';
import { LayaClient, createLayaRequest } from '@/llm/laya';
import { sanitizeLLMConfig } from '@/llm/config';

describe('Laya client', () => {
  it('creates documented choice requests without secrets', () => {
    const body = createLayaRequest('state text', { choices: ['up', 'right'], mode: 'constrained' }, 'english');
    expect(body).toEqual(expect.objectContaining({ model: 'english', state: { body: 'state text' } }));
    expect((body.questions as any).move.criteria).toEqual({ UP: 'up movement', RIGHT: 'right movement' });
    expect(JSON.stringify(body)).not.toContain('LAYA_API_KEY');
  });

  it('sends the backend Bearer key and parses a choice response', async () => {
    process.env.LAYA_API_KEY = 'test-only-key';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers: { move: { choice: 'RIGHT' } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new LayaClient(sanitizeLLMConfig({ provider: 'laya' }));
    const result = await client.chooseMove('state', false, undefined, { choices: ['right'], mode: 'raw' });
    expect(result.parsed.move).toBe('right');
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer test-only-key');
    delete process.env.LAYA_API_KEY;
    vi.unstubAllGlobals();
  });

  it('reports authentication failures clearly', async () => {
    process.env.LAYA_API_KEY = 'test-only-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    const client = new LayaClient(sanitizeLLMConfig({ provider: 'laya' }));
    await expect(client.testConnection()).rejects.toThrow('HTTP 401');
    delete process.env.LAYA_API_KEY;
    vi.unstubAllGlobals();
  });
});

describe('Laya API key resolution', () => {
  const FAKE_KEY = 'fake-gui-laya-key-0123456789';
  const tempKeyFile = async (content: string) => {
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'laya-key-'));
    const file = path.join(dir, 'api_key');
    await fs.writeFile(file, content, { mode: 0o600 });
    return { file, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
  };

  it('reads and trims the key from LAYA_API_KEY_FILE when LAYA_API_KEY is unset, and never returns it', async () => {
    const { resolveLayaApiKey } = await import('@/llm/laya');
    const { publicLLMConfig } = await import('@/llm/config');
    const { file, cleanup } = await tempKeyFile(`\n  ${FAKE_KEY}  \n`);
    vi.stubEnv('LAYA_API_KEY', '');
    vi.stubEnv('LAYA_API_KEY_FILE', file);
    expect(resolveLayaApiKey()).toBe(FAKE_KEY);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ answers: { move: { choice: 'EAST' } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = sanitizeLLMConfig({ provider: 'laya' });
    const result = await new LayaClient(config).sendRequest({ state: { body: 'x' } });
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(publicLLMConfig(config))).not.toContain(FAKE_KEY);
    expect(String(fetchMock.mock.calls[0][1].body)).not.toContain(FAKE_KEY);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await cleanup();
  });

  it('prefers LAYA_API_KEY over the key file', async () => {
    const { resolveLayaApiKey } = await import('@/llm/laya');
    const { file, cleanup } = await tempKeyFile('file-key-should-not-win');
    vi.stubEnv('LAYA_API_KEY', FAKE_KEY);
    vi.stubEnv('LAYA_API_KEY_FILE', file);
    expect(resolveLayaApiKey()).toBe(FAKE_KEY);
    vi.unstubAllEnvs();
    await cleanup();
  });

  it('fails clearly, without a request, when neither is available', async () => {
    vi.stubEnv('LAYA_API_KEY', '');
    vi.stubEnv('LAYA_API_KEY_FILE', '/nonexistent/laya/api_key');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new LayaClient(sanitizeLLMConfig({ provider: 'laya' }));
    await expect(client.sendRequest({})).rejects.toThrow(/no key is configured on the backend: set LAYA_API_KEY or put the key in \/nonexistent\/laya\/api_key/);
    await expect(client.testConnection()).rejects.toThrow(/no key is configured/);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});
