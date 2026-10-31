import { describe, expect, it } from 'vitest';
import { DEFAULT_LLM_CONFIG, sanitizeLLMConfig } from '@/llm/config';

describe('AI configuration', () => {
  it('sanitizes Ollama settings and defaults the prompt style to numbers', () => {
    const config = sanitizeLLMConfig({ model: 'qwen3:1.7b', baseUrl: 'http://ollama/' });
    expect(config.model).toBe('qwen3:1.7b');
    expect(config.baseUrl).toBe('http://ollama');
    expect(config.promptStyle).toBe(DEFAULT_LLM_CONFIG.promptStyle);
    expect(config.promptStyle).toBe('numbers');
  });

  it('keeps only the known settings', () => {
    const config = sanitizeLLMConfig({ promptStyle: 'words', staleField: 'x' } as never);
    expect(config).toEqual({ baseUrl: DEFAULT_LLM_CONFIG.baseUrl, model: DEFAULT_LLM_CONFIG.model, temperature: DEFAULT_LLM_CONFIG.temperature, promptStyle: 'words' });
  });
});
