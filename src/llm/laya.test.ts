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
