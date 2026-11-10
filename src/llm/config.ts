export type LLMConfig = {
  baseUrl: string;
  model: string;
  temperature: number;
};

/** Ollama on this machine; override with the OLLAMA_URL environment variable or in AI Settings. */
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/** The Ollama URL from OLLAMA_URL, or the local default. */
export const configuredOllamaUrl = (env: Record<string, string | undefined> = process.env) => env.OLLAMA_URL?.trim() || DEFAULT_OLLAMA_URL;

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  baseUrl: DEFAULT_OLLAMA_URL,
  model: 'qwen3:1.7b',
  temperature: 0.2,
};

export function sanitizeLLMConfig(input: Partial<LLMConfig>): LLMConfig {
  return {
    baseUrl: String(input.baseUrl ?? DEFAULT_LLM_CONFIG.baseUrl).replace(/\/$/, ''),
    model: String(input.model ?? DEFAULT_LLM_CONFIG.model),
    temperature:
      typeof input.temperature === 'number' && Number.isFinite(input.temperature)
        ? Math.max(0, Math.min(2, input.temperature))
        : DEFAULT_LLM_CONFIG.temperature,
  };
}
