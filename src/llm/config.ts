/** numbers: the existing prompt. words: the warmer/colder word prompt from the benchmark (src/llm/word-prompt-requests.ts). */
export type PromptStyle = 'numbers' | 'words';
export type LLMConfig = {
  baseUrl: string;
  model: string;
  temperature: number;
  promptStyle: PromptStyle;
};

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  baseUrl: 'http://192.168.88.100:11434',
  model: 'qwen3:1.7b',
  temperature: 0.2,
  promptStyle: 'numbers',
};

export function sanitizeLLMConfig(input: Partial<LLMConfig>): LLMConfig {
  return {
    baseUrl: String(input.baseUrl ?? DEFAULT_LLM_CONFIG.baseUrl).replace(/\/$/, ''),
    model: String(input.model ?? DEFAULT_LLM_CONFIG.model),
    temperature: typeof input.temperature === 'number' && Number.isFinite(input.temperature)
      ? Math.max(0, Math.min(2, input.temperature))
      : DEFAULT_LLM_CONFIG.temperature,
    promptStyle: input.promptStyle === 'words' ? 'words' : DEFAULT_LLM_CONFIG.promptStyle,
  };
}

export function publicLLMConfig(config: LLMConfig): LLMConfig {
  return { ...config };
}
