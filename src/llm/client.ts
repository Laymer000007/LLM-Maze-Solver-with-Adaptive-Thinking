import type { DecisionRequestContext, LLMConfig } from '@/llm/config';
import { OllamaClient } from '@/llm/ollama';
import { LayaClient } from '@/llm/laya';
import type { AgentAction } from '@/execution/execution';

export type LLMResponse = {
  parsed: AgentAction;
  raw: Record<string, unknown>;
};

export interface LLMClient {
  chooseMove(prompt: string, thinking: boolean, signal?: AbortSignal, context?: DecisionRequestContext): Promise<LLMResponse>;
  testConnection(): Promise<{ modelAvailable?: boolean; message: string }>;
}

export function createLLMClient(config: LLMConfig): LLMClient {
  return config.provider === 'laya' ? new LayaClient(config) : new OllamaClient(config);
}
