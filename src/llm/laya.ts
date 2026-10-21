import type { AgentAction } from '@/execution/execution';
import type { DecisionRequestContext, LLMConfig } from '@/llm/config';
import type { LLMClient, LLMResponse } from '@/llm/client';

function parseChoice(value: unknown): AgentAction {
  const choice = String(value ?? '').toLowerCase();
  if (!['up', 'down', 'left', 'right'].includes(choice)) throw new Error('Laya returned an invalid movement direction.');
  return { move: choice as AgentAction['move'] };
}

export function createLayaRequest(prompt: string, context: DecisionRequestContext, model: string): Record<string, unknown> {
  const criteria = Object.fromEntries(context.choices.map((move) => [move.toUpperCase(), `${move} movement` ]));
  return { state: { body: prompt }, ...(model ? { model } : {}), questions: { move: { type: 'choice', instructions: 'Choose exactly one movement direction. Return the direction label.', criteria } } };
}

export class LayaClient implements LLMClient {
  constructor(private readonly config: LLMConfig) {}

  private apiKey(): string {
    const value = process.env.LAYA_API_KEY;
    if (!value) throw new Error('Laya is selected but LAYA_API_KEY is not configured on the backend.');
    return value;
  }

  async chooseMove(prompt: string, _thinking: boolean, signal?: AbortSignal, context?: DecisionRequestContext): Promise<LLMResponse> {
    if (!context?.choices.length) throw new Error('Laya requires at least one movement choice.');
    const response = await fetch(`${this.config.layaUrl}/v1/systemone`, { method: 'POST', headers: { authorization: `Bearer ${this.apiKey()}`, 'content-type': 'application/json' }, body: JSON.stringify(createLayaRequest(prompt, context, this.config.layaModel)), signal });
    if (response.status === 401) throw new Error('Laya authentication failed (HTTP 401).');
    if (!response.ok) throw new Error(`Laya request failed (${response.status}).`);
    const body = await response.json() as Record<string, unknown>;
    const answer = (body.answers as Record<string, unknown> | undefined)?.move as Record<string, unknown> | undefined;
    const parsed = parseChoice(answer?.choice);
    return { parsed, raw: { ...body, content: JSON.stringify({ move: parsed.move }), response_metadata: body, provider: 'laya' } };
  }

  async testConnection(): Promise<{ modelAvailable?: boolean; message: string }> {
    const response = await fetch(`${this.config.layaUrl}/health`, { headers: { authorization: `Bearer ${this.apiKey()}` } });
    if (response.status === 401) throw new Error('Laya authentication failed (HTTP 401).');
    if (!response.ok) throw new Error(`Could not connect to Laya at ${this.config.layaUrl} (${response.status}).`);
    return { modelAvailable: true, message: `Connected to Laya at ${this.config.layaUrl}. Model ${this.config.layaModel || 'router'} is available.` };
  }
}
