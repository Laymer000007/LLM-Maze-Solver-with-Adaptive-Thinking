import { describe, expect, it } from 'vitest';
import { parseMove } from '@/benchmark/benchmark';

describe('benchmark protocol parsing', () => {
  it('accepts Laya labels and Ollama JSON moves', () => {
    expect(parseMove('RIGHT')).toBe('right');
    expect(parseMove({ move: 'down' })).toBe('down');
  });

  it('does not turn unrelated output into a movement', () => {
    expect(parseMove('{"answer":"unknown"}')).toBeNull();
  });
});
