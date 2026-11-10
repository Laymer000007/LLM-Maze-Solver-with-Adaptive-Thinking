import { describe, expect, it } from 'vitest';

import { DEFAULT_LLM_CONFIG, sanitizeLLMConfig } from '@/llm/config';

describe('AI configuration', () => {
  it('keeps only URL, model and temperature, with defaults', () => {
    expect(sanitizeLLMConfig({ model: 'qwen3:1.7b', baseUrl: 'http://ollama/', promptStyle: 'words' } as never)).toEqual({
      baseUrl: 'http://ollama',
      model: 'qwen3:1.7b',
      temperature: 0.2,
    });
    expect(sanitizeLLMConfig({})).toEqual(DEFAULT_LLM_CONFIG);
    expect(sanitizeLLMConfig({ temperature: 9 }).temperature).toBe(2);
  });
});
