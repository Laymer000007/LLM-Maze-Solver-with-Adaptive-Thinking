import { describe, expect, it } from 'vitest';

import { settingsChangeError } from '@/gui/settings-guard';

describe('settings change guard', () => {
  it('refuses a change while a request or move is in flight, and allows it otherwise', () => {
    for (const status of ['ASKING', 'MOVING'] as const) expect(settingsChangeError({ status })).toMatch(/Stop or reset/);
    for (const status of ['WAITING', 'BLOCKED', 'SOLVED', 'FAILED'] as const) expect(settingsChangeError({ status })).toBeNull();
  });
});
