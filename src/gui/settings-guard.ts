import type { SolverState } from '@/gui/solver';

/** Why a settings change must be refused (HTTP 409), or null: no change while a request or move is in flight. */
export function settingsChangeError(state: Pick<SolverState, 'status'>): string | null {
  if (state.status === 'ASKING' || state.status === 'MOVING') return 'Stop or reset the active maze before changing AI settings.';
  return null;
}
