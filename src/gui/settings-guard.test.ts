import { describe, expect, it } from 'vitest';

import { settingsChangeError } from '@/gui/settings-guard';
import { sanitizeLLMConfig } from '@/llm/config';

const numbers = sanitizeLLMConfig({});

describe('settings change guard', () => {
  it('keeps the 409 for any change while a request is in flight', () => {
    for (const status of ['THINKING', 'MOVING'] as const) expect(settingsChangeError({ status, startedAt: 1 }, numbers, { model: 'other' })).toMatch(/Stop or reset/);
  });

  it('refuses a prompt style change mid-run, including when paused or stopped, but not before or after a run', () => {
    for (const status of ['WAITING', 'BLOCKED'] as const) expect(settingsChangeError({ status, startedAt: 1 }, numbers, { promptStyle: 'words' })).toMatch(/Reset the maze before changing the prompt style/);
    expect(settingsChangeError({ status: 'WAITING', startedAt: null }, numbers, { promptStyle: 'words' })).toBeNull();
    for (const status of ['SOLVED', 'FAILED'] as const) expect(settingsChangeError({ status, startedAt: 1 }, numbers, { promptStyle: 'words' })).toBeNull();
    expect(settingsChangeError({ status: 'WAITING', startedAt: 1 }, numbers, { promptStyle: 'numbers', model: 'other' })).toBeNull();
  });

  it('defaults the prompt style to numbers', () => {
    expect(numbers.promptStyle).toBe('numbers');
    expect(sanitizeLLMConfig({ promptStyle: 'words' }).promptStyle).toBe('words');
    expect(sanitizeLLMConfig({ promptStyle: 'bogus' as never }).promptStyle).toBe('numbers');
  });
});
