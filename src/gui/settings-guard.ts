import type { SolverState } from '@/gui/solver';
import type { LLMConfig } from '@/llm/config';

/**
 * Why a settings change must be refused (HTTP 409), or null. A request in flight blocks any change, as before; a prompt
 * style change is also refused while a run is under way (started, not solved or failed), even if paused or stopped.
 */
export function settingsChangeError(state: Pick<SolverState, 'status' | 'startedAt'>, current: LLMConfig, next: Partial<LLMConfig>): string | null {
  if (state.status === 'THINKING' || state.status === 'MOVING') return 'Stop or reset the active maze before switching AI providers.';
  const nextStyle = next.promptStyle === 'words' ? 'words' : 'numbers';
  const midRun = state.startedAt !== null && state.status !== 'SOLVED' && state.status !== 'FAILED';
  if (nextStyle !== current.promptStyle && midRun) return 'Reset the maze before changing the prompt style. A style change mid-run is refused.';
  return null;
}
