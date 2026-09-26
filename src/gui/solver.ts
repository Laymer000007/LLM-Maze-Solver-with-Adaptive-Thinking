import {
  consumeThinkingDecision,
  createAdaptiveState,
  triggerThinking,
  formatThinkingTransition,
  type AdaptiveState,
  type ThinkingTrigger,
} from '@/agent/adaptive-thinking';
import { AgentMemory } from '@/agent/memory';
import { buildLocalAgentPrompt, formatScoreChoiceDiagnostic, getDirectionChoices } from '@/agent/prompt';
import type { AgentAction, Move } from '@/execution/execution';
import { createLogger } from '@/logger/logger';
import { Maze, type Position } from '@/maze/maze';
import { createLLMClient, type LLMClient } from '@/llm/client';
import type { LLMConfig } from '@/llm/config';

export type SolverStatus = 'WAITING' | 'THINKING' | 'MOVING' | 'BLOCKED' | 'SOLVED' | 'FAILED';
export type SolverState = {
  status: SolverStatus;
  mazeFile: string;
  layout: string[];
  current: Position;
  previous: Position | null;
  start: Position;
  goal: Position;
  visited: Position[];
  seen: Position[];
  visible: Position[];
  path: Position[];
  invalidMoves: number;
  step: number;
  lastMove: Move | null;
  lastMoveSucceeded: boolean | null;
  intendedMove: Move | null;
  intendedTarget: Position | null;
  prompt: string;
  response: string;
  parsedAction: string;
  parseError: string;
  error: string;
  startedAt: number | null;
  elapsedMs: number;
  llmCalls: number;
  averageResponseMs: number;
  moveLog: string[];
  llmLog: string[];
  memory: ReturnType<AgentMemory['snapshot']>;
  eil: ReturnType<AgentMemory['snapshot']>['eil'];
  thinking: boolean;
  thinkingDecisions: number;
  thinkingMovesRemaining: number;
  thinkingTrigger: ThinkingTrigger;
  selectedScore: number | null;
  bestAvailableScore: number | null;
  scoreDifference: number | null;
  rawThinking: string;
  tokenCount: number | null;
  diagnosticLog: string[];
  health: number;
  physicalSteps: number;
  currentSmell: number;
};

const emptyState = (maze: Maze, mazeFile: string): SolverState => ({
  status: 'WAITING',
  mazeFile,
  layout: maze.layout,
  current: { ...maze.startPosition },
  previous: null,
  start: { ...maze.startPosition },
  goal: { ...maze.goalPosition },
  visited: [{ ...maze.startPosition }],
  seen: [],
  visible: maze.perceive(maze.startPosition).visibleCells.map((cell) => ({ ...cell.position })),
  path: [{ ...maze.startPosition }],
  invalidMoves: 0,
  step: 0,
  lastMove: null,
  lastMoveSucceeded: null,
  intendedMove: null,
  intendedTarget: null,
  prompt: '',
  response: '',
  parsedAction: '',
  parseError: '',
  error: '',
  startedAt: null,
  elapsedMs: 0,
  llmCalls: 0,
  averageResponseMs: 0,
  moveLog: [],
  llmLog: [],
  memory: {
    visited: [],
    seen: [],
    newlySeen: [],
    visitCounts: {},
    locationScores: {},
    walls: [],
    wallAttempts: {},
    failedActions: [],
    route: [],
    recentObservations: [],
    actionEffects: {},
    health: 100,
    physicalSteps: 0,
    eil100HealthPenaltyApplied: false,
    eil50HealthPenaltyApplied: false,
    eil0HealthPenaltyApplied: false,
    eil: { score: 500, label: 'NEUTRAL', lastReward: 0, trend: 'stable' },
  },
  eil: { score: 500, label: 'NEUTRAL', lastReward: 0, trend: 'stable' },
  thinking: false,
  thinkingDecisions: 0,
  thinkingMovesRemaining: 0,
  thinkingTrigger: 'none',
  selectedScore: null,
  bestAvailableScore: null,
  scoreDifference: null,
  rawThinking: '',
  tokenCount: null,
  diagnosticLog: [],
  health: 100,
  physicalSteps: 0,
  currentSmell: maze.smellAt(maze.startPosition),
});

function positionKey(p: Position): string {
  return `${p.x},${p.y}`;
}
function nextPosition(p: Position, move: Move): Position {
  if (move === 'up') return { x: p.x, y: p.y - 1 };
  if (move === 'down') return { x: p.x, y: p.y + 1 };
  if (move === 'left') return { x: p.x - 1, y: p.y };
  return { x: p.x + 1, y: p.y };
}
function moveBetween(from: Position, to: Position): Move {
  if (to.x > from.x) return 'right';
  if (to.x < from.x) return 'left';
  if (to.y > from.y) return 'down';
  return 'up';
}

export class ObservableMazeSolver {
  public state: SolverState;
  private readonly maze: Maze;
  private readonly model: string;
  private readonly delayMs: () => number;
  private readonly onChange: (state: SolverState) => void;
  private readonly llm: LLMClient;
  private readonly memory = new AgentMemory();
  private paused = true;
  private stepRequested = false;
  private loopRunning = false;
  private wake: (() => void) | null = null;
  private stopRequested = false;
  private activeAbortController: AbortController | null = null;
  private adaptive: AdaptiveState = createAdaptiveState();
  private recentPositions: string[] = [];
  private readonly logger = createLogger('gui-solver');

  constructor(
    maze: Maze,
    mazeFile: string,
    config: LLMConfig,
    delayMs: () => number,
    onChange: (state: SolverState) => void,
  ) {
    this.maze = maze;
    this.model = config.model;
    this.delayMs = delayMs;
    this.onChange = onChange;
    this.state = emptyState(maze, mazeFile);
    this.llm = createLLMClient(config);
  }

  start(): void {
    this.stopRequested = false;
    this.paused = false;
    this.state.status = 'WAITING';
    this.state.error = '';
    this.emit();
    void this.run();
  }
  pause(): void {
    this.paused = true;
    if (this.state.status !== 'SOLVED' && this.state.status !== 'FAILED') this.state.status = 'WAITING';
    this.emit();
  }
  resume(): void {
    this.paused = false;
    this.wake?.();
    this.emit();
    void this.run();
  }
  step(): void {
    this.stepRequested = true;
    this.paused = false;
    this.wake?.();
    this.emit();
    void this.run();
  }
  stop(): void {
    this.stopRequested = true;
    this.paused = true;
    this.activeAbortController?.abort();
    this.state.status = 'WAITING';
    this.state.error = 'Stopped by user.';
    this.logger.warn('Solver stopped by user.');
    this.emit();
  }
  reset(): void {
    this.paused = true;
    this.stepRequested = false;
    this.memory.reset();
    this.adaptive = createAdaptiveState();
    this.recentPositions = [];
    this.state = emptyState(this.maze, this.state.mazeFile);
    this.emit();
  }

  private emit(): void {
    const memory = this.memory.snapshot();
    this.state.memory = memory;
    this.state.eil = memory.eil;
    this.state.health = memory.health;
    this.state.physicalSteps = memory.physicalSteps;
    this.state.currentSmell = this.maze.smellAt(this.state.current);
    this.state.thinkingMovesRemaining = this.adaptive.thinking ? 2 - this.adaptive.thinkingDecisions : 0;
    this.state.thinkingTrigger = this.adaptive.lastTrigger;
    this.state.elapsedMs = this.state.startedAt ? Date.now() - this.state.startedAt : 0;
    this.onChange({ ...this.state });
  }
  private async waitUntilRunnable(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((resolve) => {
      this.wake = resolve;
    });
    this.wake = null;
  }
  private async waitDelay(): Promise<void> {
    const ms = Math.max(0, Math.min(3000, this.delayMs()));
    if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
  }
  private async run(): Promise<void> {
    if (this.loopRunning || this.state.status === 'SOLVED' || this.state.status === 'FAILED') return;
    this.loopRunning = true;
    if (!this.state.startedAt) this.state.startedAt = Date.now();
    try {
      while ((this.state.current.x !== this.state.goal.x || this.state.current.y !== this.state.goal.y) && this.memory.snapshot().health > 0) {
        await this.waitUntilRunnable();
        if (this.state.current.x === this.state.goal.x && this.state.current.y === this.state.goal.y) break;
        this.state.status = 'THINKING';
        this.state.intendedMove = null;
        this.state.intendedTarget = null;
        this.state.parseError = '';
        this.emit();
        const perception = this.maze.perceive(this.state.current);
        if (this.recentPositions.length === 0) this.recentPositions.push(positionKey(this.state.current));
        this.memory.rememberPerception(perception, this.state.step === 0);
        this.state.visible = perception.visibleCells.map((cell) => cell.position);
        this.state.seen = this.memory.snapshot().seen.map((value) => {
          const [x, y] = value.split(',').map(Number);
          return { x, y };
        });
        const memoryState = this.memory.snapshot();
        const choices = getDirectionChoices(perception, memoryState);
        const prompt = buildLocalAgentPrompt(perception, memoryState);
        this.state.prompt = prompt;
        const requestAt = Date.now();
        this.emit();
        let action: AgentAction;
        let decisionResult: { raw?: Record<string, unknown>; parsed: AgentAction };
        const controller = new AbortController();
        this.activeAbortController = controller;
        this.logger.info(`LLM request started at position (${this.state.current.x},${this.state.current.y})`);
        try {
          const response = await this.llm.chooseMove(prompt, this.adaptive.thinking, controller.signal);
          decisionResult = response as unknown as { raw?: Record<string, unknown>; parsed: AgentAction };
          action = decisionResult.parsed;
          const raw = decisionResult.raw ?? {};
          const additional = (raw.additional_kwargs ?? {}) as Record<string, unknown>;
          const metadata = (raw.response_metadata ?? {}) as Record<string, unknown>;
          this.state.rawThinking = typeof additional.reasoning_content === 'string' ? additional.reasoning_content : '';
          this.state.tokenCount = typeof metadata.eval_count === 'number' ? metadata.eval_count : typeof metadata.usage === 'object' ? null : null;
          this.state.response = typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content ?? decisionResult.parsed);
          this.state.parsedAction = `move ${action.move}`;
          if (this.adaptive.thinking && !response.thinkingSupported) this.state.llmLog.unshift('Adaptive thinking requested, but provider does not expose a thinking toggle.');
        } catch (error) {
          this.activeAbortController = null;
          if (this.stopRequested) {
            this.emit();
            return;
          }
          this.state.status = 'FAILED';
          this.state.error = error instanceof Error ? error.message : String(error);
          this.state.parseError = this.state.error;
          this.state.llmLog.unshift(`${new Date().toLocaleTimeString()} ERROR ${this.state.error}`);
          this.logger.error('LLM request failed:', error);
          this.emit();
          return;
        }
        this.activeAbortController = null;
        const duration = Date.now() - requestAt;
        this.state.llmCalls++;
        this.state.averageResponseMs = Math.round((this.state.averageResponseMs * (this.state.llmCalls - 1) + duration) / this.state.llmCalls);
        this.state.llmLog.unshift(
          `${new Date().toLocaleTimeString()} ${duration}ms ${this.model} think=${this.adaptive.thinking} tokens=${this.state.tokenCount ?? 'n/a'} → ${this.state.response}`,
        );
        const visibleCheese = perception.visibleCells.find((cell) => cell.cell === 'goal');
        const requestedCheese = action.move === 'cheese';
        const directPath = requestedCheese && visibleCheese ? this.maze.directPath(this.state.current, visibleCheese.position) : null;
        const selectedMove: Move | null = requestedCheese
          ? directPath?.length
            ? moveBetween(this.state.current, directPath[0])
            : null
          : action.move === 'cheese'
            ? null
            : action.move;
        this.state.intendedMove = selectedMove;
        this.state.intendedTarget = requestedCheese && visibleCheese ? { ...visibleCheese.position } : null;
        if (!selectedMove) {
          const message = requestedCheese ? 'Invalid cheese move: cheese is not visible and directly reachable.' : 'Invalid action.';
          this.state.parseError = message;
          this.state.invalidMoves++;
          this.state.status = 'BLOCKED';
          this.memory.rememberAction({
            from: { ...this.state.current },
            move: 'up',
            actionLabel: requestedCheese ? 'cheese' : 'invalid-action',
            succeeded: false,
            to: { ...this.state.current },
            message,
          });
          this.state.llmLog.unshift(`${new Date().toLocaleTimeString()} INVALID ACTION ${message}`);
          this.emit();
          continue;
        }
        this.state.moveLog.unshift(
          `LLM ACTION ${this.state.step + 1}\n${formatScoreChoiceDiagnostic(perception.position, memoryState.eil, choices, selectedMove)}${requestedCheese ? '\nCHEESE DIRECT TRAVEL' : ''}`,
        );
        const selectedChoice = choices.find((choice) => choice.direction === selectedMove);
        const expectedScores = choices.map((choice) => choice.totalExpectedEiLDelta).filter((score): score is number => score !== undefined);
        this.state.selectedScore = selectedChoice?.totalExpectedEiLDelta ?? null;
        this.state.bestAvailableScore = expectedScores.length ? Math.max(...expectedScores) : null;
        this.state.scoreDifference = this.state.selectedScore !== null && this.state.bestAvailableScore !== null ? this.state.selectedScore - this.state.bestAvailableScore : null;
        this.adaptive = consumeThinkingDecision(this.adaptive);
        this.state.thinking = this.adaptive.thinking;
        this.state.thinkingDecisions = this.adaptive.thinkingDecisions;
        this.state.status = 'MOVING';
        this.logger.info(`LLM response received in ${duration}ms; parsed action: ${this.state.parsedAction}`);
        this.emit();
        let success = false;
        let message = '';
        const targetPath = requestedCheese ? directPath! : null;
        const planned = targetPath ?? [nextPosition(this.state.current, selectedMove)];
        for (const plannedTarget of planned) {
          await this.waitDelay();
          const from = { ...this.state.current };
          const target = plannedTarget;
          success = this.maze.isWalkable(target);
          this.state.step++;
          this.state.previous = from;
          this.state.lastMove = moveBetween(from, target);
          this.state.lastMoveSucceeded = success;
          if (!success) {
            message = `You attempted ${this.state.lastMove} but hit a wall.`;
            const beforeEvent = this.memory.snapshot().eil.score;
            const effects = this.memory.evaluate(this.maze.perceive(from), this.state.lastMove);
            this.memory.rememberAction({ from, move: this.state.lastMove, succeeded: false, to: from, message: `WALL COLLISION: ${message}`, effects });
            const afterEvent = this.memory.snapshot().eil.score;
            const wasThinking = this.adaptive.thinking;
            this.adaptive = triggerThinking(this.adaptive, beforeEvent, afterEvent);
            if (!wasThinking && this.adaptive.thinking) this.state.diagnosticLog.unshift(`${formatThinkingTransition(false, true, this.adaptive.lastTrigger)} after wall collision`);
            this.state.invalidMoves++;
            this.state.status = 'BLOCKED';
            this.logger.warn(`Blocked move at (${from.x},${from.y}): ${this.state.lastMove}`);
            if (this.memory.snapshot().health <= 0) this.state.status = 'FAILED';
            break;
          }
          const beforeEvent = this.memory.snapshot().eil.score;
          this.state.current = target;
          const revisited = this.state.visited.some((p) => positionKey(p) === positionKey(target));
          const goalReached = target.x === this.maze.goalPosition.x && target.y === this.maze.goalPosition.y;
          message = goalReached
            ? 'You reached the goal.'
            : revisited
              ? `You moved ${this.state.lastMove} and returned to a previously visited location.`
              : `You moved ${this.state.lastMove} successfully.`;
          const entered = this.maze.perceive(target);
          this.memory.rememberAction({ from, move: this.state.lastMove, succeeded: true, to: target, message, goalReached, effects: this.memory.evaluate(this.maze.perceive(from), this.state.lastMove) });
          const afterEvent = this.memory.snapshot().eil.score;
          const wasThinking = this.adaptive.thinking;
          this.adaptive = triggerThinking(this.adaptive, beforeEvent, afterEvent);
          if (!wasThinking && this.adaptive.thinking) this.state.diagnosticLog.unshift(`${formatThinkingTransition(false, true, this.adaptive.lastTrigger)} after movement`);
          if (this.memory.snapshot().health <= 0) { this.state.status = 'FAILED'; break; }
          this.memory.rememberPerception(entered);
          this.recentPositions.push(positionKey(target));
          this.recentPositions = this.recentPositions.slice(-16);
          this.state.visited.push({ ...target });
          const last = this.state.path.findIndex((p) => positionKey(p) === positionKey(target));
          if (last >= 0) this.state.path.splice(last + 1);
          else this.state.path.push({ ...target });
          this.state.visible = entered.visibleCells.map((cell) => cell.position);
          this.state.seen = this.memory.snapshot().seen.map((value) => {
            const [x, y] = value.split(',').map(Number);
            return { x, y };
          });
          this.state.moveLog.unshift(`${String(this.state.step).padStart(3, '0')}  (${from.x},${from.y}) → ${this.state.lastMove.toUpperCase()} → ${message}`);
          this.emit();
          if (!requestedCheese && (goalReached || this.maze.isDecisionPoint(target, this.state.lastMove))) break;
          if (goalReached) break;
        }
        this.state.memory = this.memory.snapshot();
        this.state.eil = this.state.memory.eil;
        if (this.state.memory.health <= 0) {
          this.state.status = 'FAILED';
          this.state.error = 'The mouse died because Health reached 0%.';
          this.logger.error(this.state.error);
          this.emit();
          return;
        }
        this.state.thinking = this.adaptive.thinking;
        this.state.thinkingDecisions = this.adaptive.thinkingDecisions;
        this.emit();
        if (this.stepRequested) {
          this.stepRequested = false;
          this.paused = true;
          this.state.status = 'WAITING';
          this.emit();
        }
      }
      if (this.state.current.x === this.state.goal.x && this.state.current.y === this.state.goal.y) {
        this.state.status = 'SOLVED';
        this.emit();
      } else if (this.memory.snapshot().health <= 0) {
        this.state.status = 'FAILED';
        this.state.error = 'The mouse died because Health reached 0%.';
        this.emit();
      }
    } catch (error) {
      this.state.status = 'FAILED';
      this.state.error = error instanceof Error ? error.message : String(error);
      this.emit();
    } finally {
      this.loopRunning = false;
    }
  }
}
