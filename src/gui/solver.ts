import { Game, closenessSentence, moodWord, type Option } from '@/game/game';
import { buildRequest, label, parseAnswer, shuffleOptions, type Variant } from '@/game/prompt';
import { rng, runSeed } from '@/game/random';
import type { LLMConfig } from '@/llm/config';
import { OllamaClient } from '@/llm/ollama';
import { Maze, type Position } from '@/maze/maze';

/** The prompt variant the GUI sends (see benchmark-results/final). */
export const GUI_VARIANT: Variant = 'full';
/** Fixed seed for the option shuffle, per maze, so a GUI run is repeatable. */
const SHUFFLE_SEED = 20261109;

type SolverStatus = 'WAITING' | 'ASKING' | 'MOVING' | 'BLOCKED' | 'SOLVED' | 'FAILED';
export type SolverState = {
  status: SolverStatus;
  mazeFile: string;
  layout: string[];
  start: Position;
  goal: Position;
  current: Position;
  /** Every cell reached, in order; consecutive cells may be diagonal neighbours. */
  path: Position[];
  visited: Position[];
  step: number;
  invalidMoves: number;
  optimal: number;
  stepCap: number;
  mood: number;
  moodWord: string;
  lastMoodChange: number | null;
  closeness: string;
  /** The options offered at the latest step, in the order shown. */
  offered: Option[];
  lastAnswer: string;
  /** The exact request sent at the latest step. */
  prompt: string;
  response: string;
  error: string;
  startedAt: number | null;
  elapsedMs: number;
  llmCalls: number;
  averageResponseMs: number;
  moveLog: string[];
};

function describeOptions(options: Option[]): string {
  return options.map((option) => `${label(option.direction)} ${option.level}`).join(' · ');
}

export class ObservableMazeSolver {
  public state: SolverState;
  private game: Game;
  private random: () => number;
  private readonly client: OllamaClient;
  private paused = true;
  private stepRequested = false;
  private loopRunning = false;
  private wake: (() => void) | null = null;
  private activeAbortController: AbortController | null = null;
  /** Bumped by stop and reset; an answer that arrives for an older run is dropped. */
  private runId = 0;

  constructor(
    private readonly maze: Maze,
    mazeFile: string,
    private readonly config: LLMConfig,
    private readonly delayMs: () => number,
    private readonly onChange: (state: SolverState) => void,
  ) {
    this.client = new OllamaClient(config);
    this.game = new Game(maze);
    this.random = rng(runSeed(SHUFFLE_SEED, mazeFile));
    this.state = this.freshState(mazeFile);
  }

  private freshState(mazeFile: string): SolverState {
    return {
      status: 'WAITING',
      mazeFile,
      layout: this.maze.layout,
      start: { ...this.maze.startPosition },
      goal: { ...this.maze.goalPosition },
      current: { ...this.game.position },
      path: [...this.game.path],
      visited: [{ ...this.game.position }],
      step: 0,
      invalidMoves: 0,
      optimal: this.game.optimal,
      stepCap: this.game.stepCap,
      mood: this.game.mood,
      moodWord: moodWord(this.game.mood),
      lastMoodChange: null,
      closeness: closenessSentence(this.game.distance),
      offered: [],
      lastAnswer: '',
      prompt: '',
      response: '',
      error: '',
      startedAt: null,
      elapsedMs: 0,
      llmCalls: 0,
      averageResponseMs: 0,
      moveLog: [],
    };
  }

  start(): void {
    this.paused = false;
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
    this.resume();
  }
  stop(): void {
    this.runId++;
    this.paused = true;
    this.activeAbortController?.abort();
    this.wake?.();
    if (this.state.status !== 'SOLVED' && this.state.status !== 'FAILED') {
      this.state.status = 'WAITING';
      this.state.error = 'Stopped by user.';
    }
    this.emit();
  }
  reset(): void {
    this.stop();
    this.stepRequested = false;
    this.game = new Game(this.maze);
    this.random = rng(runSeed(SHUFFLE_SEED, this.state.mazeFile));
    this.state = this.freshState(this.state.mazeFile);
    this.emit();
  }

  private emit(): void {
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
    if (this.loopRunning || this.game.status !== 'running') return;
    this.loopRunning = true;
    const token = this.runId;
    if (!this.state.startedAt) this.state.startedAt = Date.now();
    try {
      while (this.game.status === 'running') {
        await this.waitUntilRunnable();
        if (token !== this.runId) return;
        const offered = shuffleOptions(this.game.options(), this.random);
        const body = buildRequest(
          this.config.model,
          { distance: this.game.distance, mood: this.game.mood, options: offered },
          GUI_VARIANT,
          this.config.temperature,
        );
        this.state.status = 'ASKING';
        this.state.offered = offered;
        this.state.prompt = `POST ${this.config.baseUrl}/api/chat\n${JSON.stringify(body, null, 2)}`;
        this.emit();
        const controller = new AbortController();
        this.activeAbortController = controller;
        const requestAt = Date.now();
        let text: string;
        try {
          text = (await this.client.chat(body, controller.signal)).text;
        } catch (error) {
          if (token !== this.runId) return;
          // No fallback: an Ollama error ends the run.
          this.state.status = 'FAILED';
          this.state.error = `Ollama request failed: ${error instanceof Error ? error.message : String(error)}`;
          this.emit();
          return;
        } finally {
          this.activeAbortController = null;
        }
        if (token !== this.runId) return;
        const latency = Date.now() - requestAt;
        this.state.llmCalls++;
        this.state.averageResponseMs = Math.round((this.state.averageResponseMs * (this.state.llmCalls - 1) + latency) / this.state.llmCalls);
        this.state.response = text;
        const answer = parseAnswer(text);
        this.state.lastAnswer = answer ?? text;
        this.state.status = 'MOVING';
        this.emit();
        await this.waitDelay();
        if (token !== this.runId) return;
        const result = this.game.apply(answer, offered);
        this.state.step = result.step;
        this.state.current = { ...result.to };
        this.state.path = [...this.game.path];
        if (result.valid && !this.state.visited.some((p) => p.x === result.to.x && p.y === result.to.y)) this.state.visited.push({ ...result.to });
        this.state.invalidMoves = this.game.invalid;
        this.state.mood = result.mood;
        this.state.moodWord = moodWord(result.mood);
        this.state.lastMoodChange = result.moodChange;
        this.state.closeness = closenessSentence(this.game.distance);
        const change = `${result.moodChange > 0 ? '+' : ''}${result.moodChange}`;
        this.state.moveLog.unshift(
          [
            `#${String(result.step).padStart(3, '0')} (${result.from.x},${result.from.y}) → (${result.to.x},${result.to.y})`,
            `  offered: ${describeOptions(offered)}`,
            `  answer: ${answer ? label(answer) : JSON.stringify(text)} · ${result.valid ? `valid, ${result.level}` : 'INVALID, the mouse stays put'} · mood ${result.mood} ${moodWord(result.mood)} (${change}) · ${latency} ms`,
          ].join('\n'),
        );
        this.state.status = result.valid ? 'MOVING' : 'BLOCKED';
        if (result.status === 'solved') this.state.status = 'SOLVED';
        if (result.status === 'step-cap') {
          this.state.status = 'FAILED';
          this.state.error = `Step cap reached: ${this.game.stepCap} steps (optimal ${this.game.optimal}).`;
        }
        if (result.status === 'stuck') {
          this.state.status = 'FAILED';
          this.state.error = `Stuck: no new cell in ${this.game.stuckWindow} steps.`;
        }
        if (this.stepRequested && result.status === 'running') {
          this.stepRequested = false;
          this.paused = true;
          this.state.status = 'WAITING';
        }
        this.emit();
      }
    } finally {
      this.loopRunning = false;
    }
  }
}
