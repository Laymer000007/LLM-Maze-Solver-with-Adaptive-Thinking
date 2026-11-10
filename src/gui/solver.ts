import { Game, closenessSentence, moodWord } from '@/game/game';
import { Level2Game, filterNearCat, level2Situation, type CatState, type Option2 } from '@/game/level2';
import {
  buildLevel2Request,
  buildRequest,
  catLine,
  filtersNearCat,
  label,
  parseAnswer,
  parseLevel2Answer,
  senseRangeFor,
  shuffleOptions,
  type Level2Variant,
  type Variant,
} from '@/game/prompt';
import { rng, runSeed } from '@/game/random';
import type { LLMConfig } from '@/llm/config';
import { OllamaClient } from '@/llm/ollama';
import { Maze, type Position } from '@/maze/maze';

/** The prompt variant the GUI sends on level 1 (see benchmark-results/final). */
export const GUI_VARIANT: Variant = 'full';
/** The prompt variant the GUI sends on level 2 (C5; see benchmark-results/level2). Its sensing range and filter come with it. */
export const LEVEL2_VARIANT: Level2Variant = 'cat-danger-range5';
/** Fixed seed for the option shuffle, per maze, so a GUI run is repeatable. */
const SHUFFLE_SEED = 20261109;

type SolverStatus = 'WAITING' | 'ASKING' | 'MOVING' | 'BLOCKED' | 'SOLVED' | 'FAILED';
export type SolverState = {
  level: 1 | 2;
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
  /** Level 1: the plain optimum. Level 2: the shortest safe number of steps. */
  optimal: number;
  stepCap: number;
  mood: number;
  moodWord: string;
  lastMoodChange: number | null;
  closeness: string;
  /** The options offered at the latest step, in the order shown. */
  offered: Option2[];
  lastAnswer: string;
  /** The latest valid answer was "stay". */
  stayed: boolean;
  /** Level 2 only: the cat's cell (null on level 1). */
  cat: Position | null;
  /** Level 2 only: the cat line as given to the mouse at the latest step. */
  catLine: string;
  /** Level 2 only: the mood penalty for being near the cat after the latest step. */
  lastCatPenalty: number | null;
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

const describeOptions = (options: Option2[]) => options.map((option) => `${label(option.direction)} ${option.level}`).join(' · ');
const at = (p: Position) => `(${p.x},${p.y})`;
const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;

/** Plays level 1, or level 2 when a cat is given, one Ollama decision per step. */
export class ObservableMazeSolver {
  public state: SolverState;
  private game: Game | Level2Game;
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
    private readonly cat: CatState | null = null,
  ) {
    this.client = new OllamaClient(config);
    this.game = this.newGame();
    this.random = rng(runSeed(SHUFFLE_SEED, mazeFile));
    this.state = this.freshState(mazeFile);
  }

  private newGame(): Game | Level2Game {
    return this.cat ? new Level2Game(this.maze, this.cat, senseRangeFor(LEVEL2_VARIANT)) : new Game(this.maze);
  }

  private freshState(mazeFile: string): SolverState {
    const game = this.game;
    return {
      level: game instanceof Level2Game ? 2 : 1,
      status: 'WAITING',
      mazeFile,
      layout: this.maze.layout,
      start: { ...this.maze.startPosition },
      goal: { ...this.maze.goalPosition },
      current: { ...game.position },
      path: [...game.path],
      visited: [{ ...game.position }],
      step: 0,
      invalidMoves: 0,
      optimal: game instanceof Level2Game ? game.shortestSafe : game.optimal,
      stepCap: game.stepCap,
      mood: game.mood,
      moodWord: moodWord(game.mood),
      lastMoodChange: null,
      closeness: closenessSentence(game.distance),
      offered: [],
      lastAnswer: '',
      stayed: false,
      cat: game instanceof Level2Game ? { ...game.cat.position } : null,
      catLine: game instanceof Level2Game ? catLine(game.sense(), LEVEL2_VARIANT !== 'cat-position') : '',
      lastCatPenalty: null,
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
    this.game = this.newGame();
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
  private async waitDelay(fraction = 1): Promise<void> {
    const ms = Math.max(0, Math.min(3000, this.delayMs())) * fraction;
    if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** The options and the exact request for the next step. */
  private prepare(): { offered: Option2[]; body: Record<string, unknown> } {
    const game = this.game;
    if (game instanceof Level2Game) {
      const shuffled = shuffleOptions(game.options(), this.random);
      const offered = filtersNearCat(LEVEL2_VARIANT) ? filterNearCat(game, shuffled).options : shuffled;
      const situation = level2Situation(game, offered);
      this.state.catLine = catLine(situation.sensed, LEVEL2_VARIANT !== 'cat-position');
      return { offered, body: buildLevel2Request(this.config.model, situation, LEVEL2_VARIANT, this.config.temperature) };
    }
    const offered = shuffleOptions(game.options(), this.random);
    return {
      offered,
      body: buildRequest(this.config.model, { distance: game.distance, mood: game.mood, options: offered }, GUI_VARIANT, this.config.temperature),
    };
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
        const { offered, body } = this.prepare();
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
        this.state.status = 'MOVING';
        this.emit();
        await this.waitDelay();
        if (token !== this.runId) return;
        const finished =
          this.game instanceof Level2Game
            ? await this.applyLevel2(this.game, text, offered, latency, token)
            : this.applyLevel1(this.game, text, offered, latency);
        if (!finished) return;
        if (this.stepRequested && this.game.status === 'running') {
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

  private applyLevel1(game: Game, text: string, offered: Option2[], latency: number): boolean {
    const answer = parseAnswer(text);
    this.state.lastAnswer = answer ?? text;
    const result = game.apply(answer, offered as Parameters<Game['apply']>[1]);
    this.state.step = result.step;
    this.state.current = { ...result.to };
    this.state.path = [...game.path];
    if (result.valid && !this.state.visited.some((p) => p.x === result.to.x && p.y === result.to.y)) this.state.visited.push({ ...result.to });
    this.state.invalidMoves = game.invalid;
    this.state.mood = result.mood;
    this.state.moodWord = moodWord(result.mood);
    this.state.lastMoodChange = result.moodChange;
    this.state.closeness = closenessSentence(game.distance);
    this.state.moveLog.unshift(
      [
        `#${String(result.step).padStart(3, '0')} ${at(result.from)} → ${at(result.to)}`,
        `  offered: ${describeOptions(offered)}`,
        `  answer: ${answer ? label(answer) : JSON.stringify(text)} · ${result.valid ? `valid, ${result.level}` : 'INVALID, the mouse stays put'} · mood ${result.mood} ${moodWord(result.mood)} (${signed(result.moodChange)}) · ${latency} ms`,
      ].join('\n'),
    );
    this.state.status = result.valid ? 'MOVING' : 'BLOCKED';
    this.finish(result.status, game);
    return true;
  }

  /** Level 2: the mouse moves first and is drawn there, then the cat moves. */
  private async applyLevel2(game: Level2Game, text: string, offered: Option2[], latency: number, token: number): Promise<boolean> {
    const answer = parseLevel2Answer(text);
    this.state.lastAnswer = answer ?? text;
    const catLineShown = this.state.catLine;
    const result = game.apply(answer, offered);
    this.state.step = result.step;
    this.state.stayed = result.valid && answer === 'stay';
    this.state.current = { ...result.to };
    this.state.path = [...game.path];
    if (!this.state.visited.some((p) => p.x === result.to.x && p.y === result.to.y)) this.state.visited.push({ ...result.to });
    this.state.invalidMoves = game.invalid;
    // Show the mouse's move with the cat where it was, then animate the cat.
    this.state.cat = { ...result.catFrom };
    this.state.status = result.valid ? 'MOVING' : 'BLOCKED';
    this.emit();
    await this.waitDelay(0.5);
    if (token !== this.runId) return false;
    this.state.cat = { ...result.catTo };
    this.state.mood = result.mood;
    this.state.moodWord = moodWord(result.mood);
    this.state.lastMoodChange = result.smellMoodChange + result.catPenalty;
    this.state.lastCatPenalty = result.catPenalty;
    this.state.closeness = closenessSentence(game.distance);
    const answerText = answer === 'stay' && result.valid ? 'STAY (stays put)' : answer ? label(answer) : JSON.stringify(text);
    const penalty = result.catPenalty ? `, cat ${result.catPenalty}` : '';
    this.state.moveLog.unshift(
      [
        `#${String(result.step).padStart(3, '0')} mouse ${at(result.from)} → ${at(result.to)} · cat ${at(result.catFrom)} → ${at(result.catTo)} (${result.catMove ?? 'did not move'})`,
        `  cat: ${result.sensed ? `sensed, ${result.sensed.distance} block${result.sensed.distance > 1 ? 's' : ''} ${result.sensed.direction}` : 'not sensed'} · told: "${catLineShown}"`,
        `  offered: ${describeOptions(offered)}`,
        `  answer: ${answerText} · ${result.valid ? `valid, ${result.level}` : 'INVALID, the mouse stays put'} · mood ${result.mood} ${moodWord(result.mood)} (smell ${signed(result.smellMoodChange)}${penalty}) · ${latency} ms`,
        ...(result.catchCase ? [`  CAUGHT: ${result.catchCase}`] : []),
      ].join('\n'),
    );
    if (result.status === 'caught') {
      this.state.status = 'FAILED';
      this.state.error = 'The cat caught the mouse.';
    }
    this.finish(result.status, game);
    if (game.status === 'running') this.state.catLine = catLine(game.sense(), LEVEL2_VARIANT !== 'cat-position');
    return true;
  }

  private finish(status: string, game: Game | Level2Game): void {
    if (status === 'solved') this.state.status = 'SOLVED';
    if (status === 'step-cap') {
      this.state.status = 'FAILED';
      this.state.error = `Step cap reached: ${game.stepCap} steps (${game instanceof Level2Game ? 'shortest safe' : 'optimal'} ${this.state.optimal}).`;
    }
    if (status === 'stuck') {
      this.state.status = 'FAILED';
      this.state.error = `Stuck: no new cell in ${game.stuckWindow} steps.`;
    }
  }
}
