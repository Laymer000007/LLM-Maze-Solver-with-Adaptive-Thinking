import type { AgentAction } from '@/execution/execution';
import type { LLMClient, LLMResponse } from '@/llm/client';
import type { LLMConfig } from '@/llm/config';

function parseAction(value: unknown): AgentAction {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  const move = (parsed as { move?: unknown })?.move;
  if (!['up', 'down', 'left', 'right'].includes(String(move))) throw new Error('The model returned an invalid move.');
  return { move: move as AgentAction['move'] };
}

export class OllamaClient implements LLMClient {
  constructor(private readonly config: LLMConfig) {}

  async chooseMove(prompt: string, thinking: boolean, signal?: AbortSignal): Promise<LLMResponse> {
    const response = await fetch(`${this.config.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.config.model, messages: [{ role: 'user', content: prompt }], stream: false, format: 'json', think: thinking, options: { temperature: this.config.temperature } }),
      signal,
    });
    if (!response.ok) throw new Error(`Ollama request failed (${response.status}).`);
    const body = await response.json() as { message?: { content?: string; thinking?: string }; [key: string]: unknown };
    const content = body.message?.content ?? '';
    return { parsed: parseAction(content), raw: { ...body, content, additional_kwargs: { reasoning_content: body.message?.thinking ?? '' }, response_metadata: body } };
  }

  /** Posts a ready-made /api/chat body unchanged (word-prompt style) and returns message.content as text. */
  async sendRequest(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; raw: Record<string, unknown> }> {
    const response = await fetch(`${this.config.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(`Ollama request failed (${response.status}).`);
    const raw = (await response.json()) as { message?: { content?: string; thinking?: string }; [key: string]: unknown };
    const content = raw.message?.content ?? '';
    return { text: content, raw: { ...raw, content, additional_kwargs: { reasoning_content: raw.message?.thinking ?? '' }, response_metadata: raw } };
  }

  async testConnection(): Promise<{ modelAvailable?: boolean; message: string }> {
    const response = await fetch(`${this.config.baseUrl}/api/tags`);
    if (!response.ok) throw new Error(`Could not connect to Ollama at ${this.config.baseUrl}`);
    const body = await response.json() as { models?: Array<{ name?: string }> };
    const modelAvailable = Boolean(body.models?.some((model) => model.name === this.config.model));
    return { modelAvailable, message: modelAvailable ? `Connected to Ollama. Model ${this.config.model} is available.` : `Connected to Ollama, but model ${this.config.model} was not found.` };
  }
}
