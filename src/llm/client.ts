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
}

export function createLLMClient(config: LLMConfig): LLMClient {
  return new OllamaClient(config);
}
