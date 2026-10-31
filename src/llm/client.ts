import type { LLMConfig } from '@/llm/config';
import { OllamaClient } from '@/llm/ollama';
import type { AgentAction } from '@/execution/execution';

export type LLMResponse = {
  parsed: AgentAction;
  raw: Record<string, unknown>;
};

export interface LLMClient {
  chooseMove(prompt: string, thinking: boolean, signal?: AbortSignal): Promise<LLMResponse>;
  testConnection(): Promise<{ modelAvailable?: boolean; message: string }>;
  /** Sends a complete, ready-made request body unchanged; used by the word-prompt style. */
  sendRequest(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; raw: Record<string, unknown> }>;
}

export function createLLMClient(config: LLMConfig): LLMClient {
  return new OllamaClient(config);
}
