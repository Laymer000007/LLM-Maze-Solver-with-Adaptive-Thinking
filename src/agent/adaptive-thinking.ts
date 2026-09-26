/** Sensor-driven thinking: only a single large emotional event can activate it. */
export type ThinkingTrigger = 'none' | 'single-event EiL drop >= 100';
export type AdaptiveState = { thinking: boolean; thinkingDecisions: number; totalThinkingDecisions: number; lastTrigger: ThinkingTrigger; decisionHistory: unknown[] };
export type DecisionDiagnostic = { drop?: number; trigger: ThinkingTrigger; selectedMove?: string; selectedScore: number|null; bestAvailableScore: number|null; scoreDifference: number|null; largeScoreAnomaly: boolean; strongEmotionalContradiction: boolean; repeatedTwoCellBehavior: boolean; poorDecision: boolean };
export const THINKING_WINDOW_SIZE = 2;
export function createAdaptiveState(): AdaptiveState { return { thinking: false, thinkingDecisions: 0, totalThinkingDecisions: 0, lastTrigger: 'none', decisionHistory: [] }; }
export function diagnoseEvent(eilBefore: number, eilAfter: number): DecisionDiagnostic { const drop = eilBefore - eilAfter; return { drop, trigger: drop >= 100 ? 'single-event EiL drop >= 100' : 'none', selectedScore: null, bestAvailableScore: null, scoreDifference: null, largeScoreAnomaly: false, strongEmotionalContradiction: false, repeatedTwoCellBehavior: false, poorDecision: false }; }
export function diagnoseDecision(..._args: unknown[]): DecisionDiagnostic { return { drop: 0, trigger: 'none', selectedScore: null, bestAvailableScore: null, scoreDifference: null, largeScoreAnomaly: false, strongEmotionalContradiction: false, repeatedTwoCellBehavior: false, poorDecision: false }; }
export function triggerThinking(state: AdaptiveState, eilBefore: number, eilAfter: number): AdaptiveState { const event = diagnoseEvent(eilBefore, eilAfter); return (event.drop ?? 0) >= 100 ? { ...state, thinking: true, thinkingDecisions: 0, totalThinkingDecisions: 0, lastTrigger: event.trigger } : { ...state, lastTrigger: 'none' }; }
export function consumeThinkingDecision(state: AdaptiveState): AdaptiveState { if (!state.thinking) return state; const used = state.thinkingDecisions + 1; return used >= THINKING_WINDOW_SIZE ? { ...state, thinking: false, thinkingDecisions: 0, totalThinkingDecisions: 0, lastTrigger: 'none' } : { ...state, thinkingDecisions: used, totalThinkingDecisions: used }; }
export function formatThinkingTransition(from: boolean, to: boolean, trigger: ThinkingTrigger): string { return `THINKING MODE ${from ? 'ON' : 'OFF'} → ${to ? 'ON' : 'OFF'}${to ? ` (${trigger})` : ''}`; }
// Compatibility shims for historical report scripts. They no longer inspect choices or loops.
export function updateAdaptiveState(state: AdaptiveState, diagnostic: DecisionDiagnostic): AdaptiveState { return (diagnostic.drop ?? 0) >= 100 ? triggerThinking(state, diagnostic.drop ?? 0, 0) : state; }
export function shouldRecover(state: AdaptiveState): boolean { return !state.thinking; }
export function capThinkingWindow(state: AdaptiveState): AdaptiveState { return state; }
export function experienceIsStronglyAversive(_experience?: unknown): boolean { return false; }
