import type { AgentAction } from '@/execution/execution';
import type { LLMClient, LLMResponse } from '@/llm/client';
import type { LLMConfig } from '@/llm/config';

function parseAction(value: unknown): AgentAction {
  const parsed = typeof value === 'string' ? JSON.parse(value.replace(/^```(?:json)?\s*|\s*```$/g, '')) : value;
  const move = (parsed as { move?: unknown })?.move;
  if (!['up', 'down', 'left', 'right'].includes(String(move))) throw new Error('The model returned an invalid move.');
  return { move: move as AgentAction['move'] };
}

export class OpenAICompatibleClient implements LLMClient {
  constructor(private readonly config: LLMConfig) {}

  async chooseMove(prompt: string, _thinking: boolean, signal?: AbortSignal): Promise<LLMResponse> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.config.model, temperature: this.config.temperature, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
      signal,
    });
    if (!response.ok) throw new Error(`OpenAI-compatible request failed (${response.status}).`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }>; [key: string]: unknown };
    const content = body.choices?.[0]?.message?.content ?? '';
    return { parsed: parseAction(content), raw: { ...body, content }, thinkingSupported: false };
  }

  async testConnection(): Promise<{ modelAvailable?: boolean; message: string }> {
    const response = await fetch(`${this.config.baseUrl}/models`, { headers: this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {} });
    if (!response.ok) throw new Error(`Could not connect to OpenAI-compatible endpoint at ${this.config.baseUrl}`);
    return { message: `Connected to OpenAI-compatible provider. Model availability depends on the provider.` };
  }
}
