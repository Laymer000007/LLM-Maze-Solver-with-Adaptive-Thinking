export type LLMProvider = 'ollama' | 'openai-compatible';

export type LLMConfig = {
  provider: LLMProvider;
  baseUrl: string;
  model: string;
  temperature: number;
  apiKey?: string;
};

export const DEFAULT_LLM_CONFIG: Omit<LLMConfig, 'apiKey'> = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  model: 'qwen3:1.7b',
  temperature: 0.2,
};

export function sanitizeLLMConfig(input: Partial<LLMConfig>): LLMConfig {
  const provider = input.provider === 'openai-compatible' ? 'openai-compatible' : 'ollama';
  return {
    provider,
    baseUrl: String(input.baseUrl ?? DEFAULT_LLM_CONFIG.baseUrl).replace(/\/$/, ''),
    model: String(input.model ?? DEFAULT_LLM_CONFIG.model),
    temperature: typeof input.temperature === 'number' && Number.isFinite(input.temperature)
      ? Math.max(0, Math.min(2, input.temperature))
      : DEFAULT_LLM_CONFIG.temperature,
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
  };
}

export function publicLLMConfig(config: LLMConfig): Omit<LLMConfig, 'apiKey'> & { apiKeyConfigured: boolean } {
  const { apiKey: _apiKey, ...safe } = config;
  return { ...safe, apiKeyConfigured: Boolean(config.apiKey) };
}
