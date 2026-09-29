export type LLMConfig = {
  baseUrl: string;
  model: string;
  temperature: number;
};

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  baseUrl: 'http://localhost:11434',
  model: 'qwen3:1.7b',
  temperature: 0.2,
};

export function sanitizeLLMConfig(input: Partial<LLMConfig>): LLMConfig {
  return {
    baseUrl: String(input.baseUrl ?? DEFAULT_LLM_CONFIG.baseUrl).replace(/\/$/, ''),
    model: String(input.model ?? DEFAULT_LLM_CONFIG.model),
    temperature: typeof input.temperature === 'number' && Number.isFinite(input.temperature)
      ? Math.max(0, Math.min(2, input.temperature))
      : DEFAULT_LLM_CONFIG.temperature,
  };
}

export function publicLLMConfig(config: LLMConfig): LLMConfig {
  return { ...config };
}
