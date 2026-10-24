import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';

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

const layaKeyFile = () => process.env.LAYA_API_KEY_FILE || path.join(os.homedir(), '.config', 'laya', 'api_key');
/**
 * LAYA_API_KEY, else the trimmed contents of LAYA_API_KEY_FILE (default ~/.config/laya/api_key), as in the benchmark
 * harness. Backend only: never logged, sent to the browser or returned in an API response.
 */
export function resolveLayaApiKey(): string | null {
  if (process.env.LAYA_API_KEY) return process.env.LAYA_API_KEY;
  try {
    return readFileSync(layaKeyFile(), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

export class LayaClient implements LLMClient {
  constructor(private readonly config: LLMConfig) {}

  private apiKey(): string {
    const value = resolveLayaApiKey();
    if (!value) throw new Error(`Laya is selected but no key is configured on the backend: set LAYA_API_KEY or put the key in ${layaKeyFile()}.`);
    return value;
  }

  /** Posts a ready-made /v1/systemone body unchanged (word-prompt style) and returns answers.move.choice as text. */
  async sendRequest(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; raw: Record<string, unknown> }> {
    const response = await fetch(`${this.config.layaUrl}/v1/systemone`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (response.status === 401) throw new Error('Laya authentication failed (HTTP 401).');
    if (!response.ok) throw new Error(`Laya request failed (${response.status}).`);
    const raw = (await response.json()) as Record<string, unknown>;
    const choice = ((raw.answers as Record<string, unknown> | undefined)?.move as Record<string, unknown> | undefined)?.choice;
    if (typeof choice !== 'string') throw new Error('Laya returned no choice.');
    return { text: choice, raw: { ...raw, content: choice, response_metadata: raw, provider: 'laya' } };
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
