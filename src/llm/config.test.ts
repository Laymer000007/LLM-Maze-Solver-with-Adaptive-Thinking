import { describe, expect, it } from 'vitest';
import { DEFAULT_LLM_CONFIG, sanitizeLLMConfig } from '@/llm/config';

describe('AI provider configuration', () => {
  it('preserves legacy Ollama settings while adding provider defaults', () => {
    const config = sanitizeLLMConfig({ model: 'qwen3:1.7b', baseUrl: 'http://ollama/' });
    expect(config.provider).toBe('ollama');
    expect(config.model).toBe('qwen3:1.7b');
    expect(config.baseUrl).toBe('http://ollama');
    expect(config.layaMode).toBe(DEFAULT_LLM_CONFIG.layaMode);
  });

  it('sanitizes an explicitly selected constrained Laya provider', () => {
    const config = sanitizeLLMConfig({ provider: 'laya', layaUrl: 'http://laya/', layaModel: 'english', layaMode: 'constrained' });
    expect(config.provider).toBe('laya');
    expect(config.layaUrl).toBe('http://laya');
    expect(config.layaMode).toBe('constrained');
  });
});
