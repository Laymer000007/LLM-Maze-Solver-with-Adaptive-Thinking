import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_LLM_CONFIG, DEFAULT_OLLAMA_URL, configuredOllamaUrl, sanitizeLLMConfig } from '@/llm/config';

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

  it('defaults to Ollama on localhost, overridable with OLLAMA_URL', () => {
    expect(DEFAULT_LLM_CONFIG.baseUrl).toBe('http://localhost:11434');
    expect(configuredOllamaUrl({})).toBe('http://localhost:11434');
    expect(configuredOllamaUrl({ OLLAMA_URL: ' ' })).toBe('http://localhost:11434');
    expect(configuredOllamaUrl({ OLLAMA_URL: 'http://gpu-box:11434' })).toBe('http://gpu-box:11434');
  });

  it('uses the same default URL in the doctor script', () => {
    expect(fs.readFileSync(path.resolve(__dirname, '../../scripts/doctor.mjs'), 'utf-8')).toContain(`'${DEFAULT_OLLAMA_URL}'`);
  });
});
