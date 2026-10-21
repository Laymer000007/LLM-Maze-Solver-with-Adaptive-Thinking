import type { Move } from '@/execution/execution';

export type AIProvider = 'ollama' | 'laya';
export type LayaDecisionMode = 'raw' | 'constrained';
export type LLMConfig = {
  provider: AIProvider;
  baseUrl: string;
  model: string;
  temperature: number;
  layaUrl: string;
  layaModel: string;
  layaMode: LayaDecisionMode;
};

export type DecisionRequestContext = { choices: Move[]; mode: LayaDecisionMode };

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  provider: 'ollama',
  baseUrl: 'http://192.168.88.100:11434',
  model: 'qwen3:1.7b',
  temperature: 0.2,
  layaUrl: 'http://192.168.88.100:8000',
  layaModel: 'english',
  layaMode: 'raw',
};

export function sanitizeLLMConfig(input: Partial<LLMConfig>): LLMConfig {
  return {
    provider: input.provider === 'laya' ? 'laya' : DEFAULT_LLM_CONFIG.provider,
    baseUrl: String(input.baseUrl ?? DEFAULT_LLM_CONFIG.baseUrl).replace(/\/$/, ''),
    model: String(input.model ?? DEFAULT_LLM_CONFIG.model),
    temperature: typeof input.temperature === 'number' && Number.isFinite(input.temperature)
      ? Math.max(0, Math.min(2, input.temperature))
      : DEFAULT_LLM_CONFIG.temperature,
    layaUrl: String(input.layaUrl ?? DEFAULT_LLM_CONFIG.layaUrl).replace(/\/$/, ''),
    layaModel: String(input.layaModel ?? DEFAULT_LLM_CONFIG.layaModel),
    layaMode: input.layaMode === 'constrained' ? 'constrained' : DEFAULT_LLM_CONFIG.layaMode,
  };
}

export function publicLLMConfig(config: LLMConfig): LLMConfig {
  return { ...config };
}
