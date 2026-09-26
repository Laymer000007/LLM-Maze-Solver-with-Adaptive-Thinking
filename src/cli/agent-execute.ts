import fs from 'fs/promises';
import path from 'path';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ChatOllama } from '@langchain/ollama';
import { program } from 'commander';
import yaml from 'yaml';
import { AgentMemory } from '@/agent/memory';
import { consumeThinkingDecision, createAdaptiveState, triggerThinking, type AdaptiveState } from '@/agent/adaptive-thinking';
import { DEFAULT_EIL_SCALE, type EiLScale } from '@/agent/eil';
import { buildLocalAgentPrompt, formatScoreChoiceDiagnostic, getDirectionChoices, getScoreChoiceDiagnostic, type DirectionChoice } from '@/agent/prompt';
import { AgentExecutions, createActionSchema, type AgentAction, type AgentExecution, type Move } from '@/execution/execution';
import { Maze, type Position } from '@/maze/maze';

type Metadata = {
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  total_duration?: number;
  [key: string]: unknown;
};
type Step = {
  step: number;
  position: Position;
  currentEiL: ReturnType<AgentMemory['snapshot']>['eil'];
  choices: DirectionChoice[];
  prompt: string;
  rawOllamaResponse: unknown;
  rawThinking: string;
  rawFinalResponse: string;
  selectedMove: Move;
  selectedScore: number | null;
  bestAvailableScore: number | null;
  scoreDifference: number | null;
  anomaly: boolean;
  outcome: string;
  physicalSteps: Array<{ from: Position; to: Position; succeeded: boolean }>;
  eilAfter: ReturnType<AgentMemory['snapshot']>['eil'];
  latencyMs: number;
  metadata: Metadata;
  thinking: boolean;
  thinkingTrigger: string;
  promptChars: number;
  promptBytes: number;
  physicalCellsMoved: number;
  requestStartedAt: string;
  responseEndedAt: string;
  applicationLatencyMs: number;
};

const execFileAsync = promisify(execFile);

program
  .name('agent-execute')
  .description('Run one persistent, locally-perceiving LLM maze agent')
  .requiredOption('-m, --model <name>', 'Ollama model name')
  .requiredOption('-z, --maze <file>', 'Maze file')
  .option('--ollama-url <url>', 'Ollama server URL', 'http://192.168.88.100:11434')
  .option('--max-steps <number>', 'Maximum actions before stopping', '250')
  .option('--think', 'Enable Ollama/Qwen thinking for diagnostic runs', false)
  .option('--eil-scale <scale>', 'EiL display scale: signed, normalized, or positive100', DEFAULT_EIL_SCALE)
  .option('--benchmark', 'Disable the legacy early anomaly stop for bounded benchmark runs', false)
  .option('--run-number <number>', 'Benchmark run number', '1')
  .option('--request-timeout-ms <number>', 'Abort a benchmark request after this many milliseconds', '180000')
  .option('--stall-output <dir>', 'Directory for slow-call and timeout evidence')
  .option('-o, --output <dir>', 'Output directory', './output/agent-executions')
  .action(async (options) => {
    const maze = await Maze.fromFile(options.maze);
    const requestedThink = Boolean(options.think);
    const eilScale = options.eilScale as EiLScale;
    if (!['signed', 'normalized', 'positive100'].includes(eilScale)) throw new Error(`Invalid EiL scale: ${eilScale}`);
    const temperature = 0.2;
    const fastBaseLlm = new ChatOllama({ model: options.model, baseUrl: options.ollamaUrl, think: false, temperature });
    const thinkingBaseLlm = new ChatOllama({ model: options.model, baseUrl: options.ollamaUrl, think: true, temperature });
    const fastCardinalLlm = fastBaseLlm.withStructuredOutput(createActionSchema(false), { includeRaw: true });
    const fastCheeseLlm = fastBaseLlm.withStructuredOutput(createActionSchema(false), { includeRaw: true });
    const thinkingCardinalLlm = thinkingBaseLlm.withStructuredOutput(createActionSchema(false), { includeRaw: true });
    const thinkingCheeseLlm = thinkingBaseLlm.withStructuredOutput(createActionSchema(false), { includeRaw: true });
    const memory = new AgentMemory();
    const steps: Step[] = [];
    let current = { ...maze.startPosition };
    let consecutiveAnomalies = 0;
    let adaptive: AdaptiveState = createAdaptiveState();
    let recentPositions: string[] = [positionKey(current)];
    const runStartedAt = performance.now();
    const callHistory: Array<Record<string, unknown>> = [];
    const diagnosticDir = path.resolve(requestedThink ? 'output/phase-1.7-thinking' : options.output);
    await fs.mkdir(diagnosticDir, { recursive: true });
    const requestConfiguration = {
      model: options.model,
      think: 'adaptive (false normally, one true decision after a trigger)',
      eilScale,
      temperature,
      structuredJsonOutput: true,
      actionSchema: 'move: up|down|left|right (+ cheese only when visible)',
    };
    for (let step = 1; step <= Number(options.maxSteps) && (current.x !== maze.goalPosition.x || current.y !== maze.goalPosition.y) && memory.snapshot().health > 0; step++) {
      const perception = maze.perceive(current);
      memory.rememberPerception(perception, step === 1);
      const memoryState = memory.snapshot();
      const choices = getDirectionChoices(perception, memoryState);
      const prompt = buildLocalAgentPrompt(perception, memoryState, eilScale);
      const started = performance.now();
      const requestStartedAt = new Date().toISOString();
      const cheeseVisible = perception.visibleCells.some((cell) => cell.cell === 'goal');
      const thinking = requestedThink || adaptive.thinking;
      const llm = thinking
        ? cheeseVisible ? thinkingCheeseLlm : thinkingCardinalLlm
        : cheeseVisible ? fastCheeseLlm : fastCardinalLlm;
      const pendingRequestPath = options.output ? path.join(path.resolve(options.output), 'pending-request.yaml') : undefined;
      if (pendingRequestPath) {
        await fs.writeFile(pendingRequestPath, yaml.stringify({
          kind: 'PENDING_REQUEST', scale: eilScale, runNumber: Number(options.runNumber), step,
          prompt, choices, currentEiL: memoryState.eil, thinking, requestStartedAt,
          requestOptions: { model: options.model, temperature, think: thinking, timeoutMs: Number(options.requestTimeoutMs) },
          previousCalls: callHistory.slice(-3),
        }));
      }
      let result: { raw: Record<string, unknown>; parsed: AgentAction };
      try {
        const controller = new AbortController();
        let timeout: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error(`LLM request timeout after ${Number(options.requestTimeoutMs)}ms`));
          }, Number(options.requestTimeoutMs));
        });
        try {
          result = (await Promise.race([llm.invoke(prompt, { signal: controller.signal }), timeoutPromise])) as unknown as { raw: Record<string, unknown>; parsed: AgentAction };
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      } catch (error) {
        await writeStallArtifact(options.stallOutput, options.eilScale, Number(options.runNumber), step, 'TIMEOUT', {
          prompt,
          choices,
          currentEiL: memoryState.eil,
          thinking,
          requestStartedAt,
          responseEndedAt: new Date().toISOString(),
          applicationLatencyMs: performance.now() - started,
          requestOptions: { model: options.model, temperature, think: thinking, timeoutMs: Number(options.requestTimeoutMs) },
          previousCalls: callHistory.slice(-3),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      if (pendingRequestPath) await fs.rm(pendingRequestPath, { force: true });
      const latencyMs = performance.now() - started;
      const responseEndedAt = new Date().toISOString();
      const raw = result.raw || {};
      const metadata = (raw.response_metadata || {}) as Metadata;
      const additional = (raw.additional_kwargs || {}) as Record<string, unknown>;
      const rawThinking = typeof additional.reasoning_content === 'string' ? additional.reasoning_content : '';
      const rawFinalResponse = typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content || '');
      const rawOllamaResponse = {
        model: metadata.model || options.model,
        message: { thinking: rawThinking, content: rawFinalResponse, tool_calls: raw.tool_calls || [] },
        ...metadata,
      };
      const callRecord = { step, thinking, requestStartedAt, responseEndedAt, applicationLatencyMs: latencyMs, metadata, promptChars: prompt.length, promptBytes: Buffer.byteLength(prompt, 'utf8'), eil: memoryState.eil.score };
      callHistory.push(callRecord);
      if (!thinking && latencyMs >= 30_000) {
        await writeStallArtifact(options.stallOutput, options.eilScale, Number(options.runNumber), step, 'SLOW_CALL', {
          prompt,
          choices,
          currentEiL: memoryState.eil,
          thinking,
          requestStartedAt,
          responseEndedAt,
          applicationLatencyMs: latencyMs,
          requestOptions: { model: options.model, temperature, think: thinking },
          ollamaMetadata: metadata,
          rawOllamaResponse,
          previousCalls: callHistory.slice(-4, -1),
          nextSuccessfulCall: null,
          ollamaPs: await ollamaPs(),
        });
      }
      const action = result.parsed as AgentAction;
      if (!requestedThink) adaptive = consumeThinkingDecision(adaptive);
      const visibleCheese = perception.visibleCells.find((cell) => cell.cell === 'goal');
      const targetPath = action.move === 'cheese' && visibleCheese ? maze.directPath(current, visibleCheese.position) : null;
      const selectedMove = action.move === 'cheese' ? (targetPath?.length ? moveBetween(current, targetPath[0]) : null) : action.move;
      if (!selectedMove) {
        const invalidLabel = action.move === 'cheese' ? 'cheese' : 'invalid-action';
        const invalidMessage = action.move === 'cheese' ? 'INVALID CHEESE MOVE. Cheese was not currently visible and directly reachable.' : 'INVALID ACTION.';
        memory.rememberAction({ from: { ...current }, move: 'up', actionLabel: invalidLabel, succeeded: false, to: { ...current }, message: invalidMessage });
        console.error(invalidMessage);
        continue;
      }
      const diagnostic = getScoreChoiceDiagnostic(choices, selectedMove);
      const anomaly = diagnostic.scoreDifference !== null && diagnostic.scoreDifference < 0;
      consecutiveAnomalies = anomaly ? consecutiveAnomalies + 1 : 0;
      const physicalSteps: Array<{ from: Position; to: Position; succeeded: boolean }> = [];
      let outcome = '';
      let goalReached = false;
      while (!goalReached) {
        const from = { ...current };
        const target = targetPath ? targetPath[physicalSteps.length] : nextPosition(from, selectedMove);
        if (!target || (targetPath && !maze.isWalkable(target))) {
          outcome = 'Selected target could not be travelled directly.';
          break;
        }
        const succeeded = maze.isWalkable(target);
        physicalSteps.push({ from, to: succeeded ? target : from, succeeded });
        if (!succeeded) {
          outcome = 'You attempted ' + selectedMove + ' but hit a wall.';
          const beforeEvent = memory.snapshot().eil.score;
          memory.rememberAction({ from, move: selectedMove, succeeded: false, to: from, message: 'WALL COLLISION: ' + outcome, effects: memory.evaluate(maze.perceive(from), selectedMove) });
          if (!requestedThink) adaptive = triggerThinking(adaptive, beforeEvent, memory.snapshot().eil.score);
          break;
        }
        const beforeEvent = memory.snapshot().eil.score;
        current = target;
        goalReached = current.x === maze.goalPosition.x && current.y === maze.goalPosition.y;
        outcome = goalReached ? 'You reached the goal.' : 'You moved ' + selectedMove + ' successfully.';
        // Every physical cell is experienced independently, even inside one corridor action.
        const enteredPerception = maze.perceive(current);
        memory.rememberAction({ from, move: selectedMove, succeeded: true, to: current, message: outcome, goalReached, effects: memory.evaluate(maze.perceive(from), selectedMove) });
        if (!requestedThink) adaptive = triggerThinking(adaptive, beforeEvent, memory.snapshot().eil.score);
        memory.rememberPerception(enteredPerception);
        if (goalReached || (!targetPath && maze.isDecisionPoint(current, selectedMove))) break;
      }
      const eilAfter = memory.snapshot().eil;
      steps.push({
        step,
        position: perception.position,
        currentEiL: memoryState.eil,
        choices,
        prompt,
        rawOllamaResponse,
        rawThinking,
        rawFinalResponse,
        selectedMove,
        selectedScore: diagnostic.selectedScore,
        bestAvailableScore: diagnostic.bestAvailableScore,
        scoreDifference: diagnostic.scoreDifference,
        anomaly,
        outcome,
        physicalSteps,
        eilAfter,
        latencyMs,
        metadata,
        thinking,
        thinkingTrigger: adaptive.lastTrigger,
        promptChars: prompt.length,
        promptBytes: Buffer.byteLength(prompt, 'utf8'),
        physicalCellsMoved: physicalSteps.filter((item) => item.succeeded).length,
        requestStartedAt,
        responseEndedAt,
        applicationLatencyMs: latencyMs,
      });
      if (memory.snapshot().health <= 0) {
        console.error('The mouse died because Health reached 0%.');
        break;
      }
      recentPositions.push(positionKey(current));
      await fs.writeFile(
        path.join(diagnosticDir, 'checkpoint.yaml'),
        yaml.stringify({
          phase: '1.7',
          requestConfiguration,
          mazeFile: path.normalize(options.maze).replace(/\\/g, '/'),
          modelName: options.model,
          temperature,
          think: requestedThink,
          decisionCount: steps.length,
          steps,
        }),
      );
      await fs.writeFile(path.join(diagnosticDir, 'checkpoint-trace.log'), steps.map(formatTraceStep).join('\n\n' + '='.repeat(100) + '\n\n'));
      console.error(
        '\nLLM ACTION ' +
          step +
          '\nPROMPT:\n' +
          prompt +
          '\nRAW RESPONSE:\n' +
          JSON.stringify(rawOllamaResponse, null, 2) +
          '\n' +
          formatScoreChoiceDiagnostic(perception.position, memoryState.eil, choices, selectedMove, eilScale) +
          '\nCORRIDOR TRAVERSAL:\n' +
          physicalSteps
            .map((physical, index) => `physical step ${index + 1}: (${physical.from.x},${physical.from.y}) -> (${physical.to.x},${physical.to.y})`)
            .join('\n'),
      );
      if (goalReached || (!options.benchmark && !requestedThink && consecutiveAnomalies >= 10 && Number(options.maxSteps) < 100)) break;
    }
    const solved = current.x === maze.goalPosition.x && current.y === maze.goalPosition.y;
    const run = {
      phase: '1.7',
      requestConfiguration,
      mazeFile: path.normalize(options.maze).replace(/\\/g, '/'),
      modelName: options.model,
      temperature,
      think: requestedThink,
      adaptiveThinking: !requestedThink,
      eilScale,
      solved,
      finalPosition: current,
      finalEiL: steps.at(-1)?.eilAfter || memory.snapshot().eil,
      decisionCount: steps.length,
      runNumber: Number(options.runNumber),
      elapsedMs: performance.now() - runStartedAt,
      stopReason: solved ? 'GOAL' : steps.length >= Number(options.maxSteps) ? '30_DECISION_LIMIT' : 'STOPPED',
      physicalCellsMoved: steps.reduce((total, step) => total + step.physicalCellsMoved, 0),
      steps,
    };
    await fs.writeFile(path.join(diagnosticDir, 'run.yaml'), yaml.stringify(run));
    await fs.writeFile(path.join(diagnosticDir, 'trace.log'), steps.map(formatTraceStep).join('\n\n' + '='.repeat(100) + '\n\n'));
    await fs.writeFile(path.join(diagnosticDir, 'failure-report.md'), buildFailureReport(run));
    if (!requestedThink) {
      const execution: AgentExecution = {
        mazeFile: run.mazeFile,
        modelName: run.modelName,
        solved,
        steps: steps.map((step) => ({
          step: step.step,
          from: step.position,
          move: step.selectedMove,
          succeeded: !step.outcome.includes('hit a wall'),
          to: step.position,
          observation: step.outcome,
          prompt: step.prompt,
          response: step.rawFinalResponse,
          reward: step.eilAfter.lastReward,
          eil: step.eilAfter,
        })),
      };
      await AgentExecutions.save(execution, options.output);
    }
    console.log(yaml.stringify(run));
    console.error('Agent ' + (solved ? 'solved' : 'stopped') + ' after ' + steps.length + ' actions.');
  });

program.parseAsync().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function nextPosition(position: Position, move: Move): Position {
  if (move === 'up') return { x: position.x, y: position.y - 1 };
  if (move === 'down') return { x: position.x, y: position.y + 1 };
  if (move === 'left') return { x: position.x - 1, y: position.y };
  return { x: position.x + 1, y: position.y };
}
function positionKey(position: Position): string {
  return `${position.x},${position.y}`;
}

async function writeStallArtifact(
  outputDir: string | undefined,
  scale: string,
  runNumber: number,
  step: number,
  kind: 'SLOW_CALL' | 'TIMEOUT',
  evidence: Record<string, unknown>,
): Promise<void> {
  if (!outputDir) return;
  const dir = path.resolve(outputDir);
  await fs.mkdir(dir, { recursive: true });
  const filename = `${scale}-run-${runNumber}-step-${step}-${kind.toLowerCase()}.yaml`;
  await fs.writeFile(path.join(dir, filename), yaml.stringify({ kind, scale, runNumber, step, ...evidence }));
}

async function ollamaPs(): Promise<string> {
  try {
    const result = await execFileAsync('ollama', ['ps']);
    return result.stdout;
  } catch (error) {
    return `ollama ps unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}
function moveBetween(from: Position, to: Position): Move {
  if (to.x > from.x) return 'right';
  if (to.x < from.x) return 'left';
  if (to.y > from.y) return 'down';
  return 'up';
}

function formatTraceStep(step: Step): string {
  return [
    'LLM ACTION ' + step.step,
    'POSITION: (' + step.position.x + ',' + step.position.y + ')',
    'CURRENT EiL: ' + JSON.stringify(step.currentEiL),
    'AVAILABLE MOVES:\n' + step.choices.map((c) => c.direction.toUpperCase() + ': ' + JSON.stringify(c)).join('\n'),
    'EXACT PROMPT:\n' + step.prompt,
    'RAW THINKING:\n' + step.rawThinking,
    'RAW FINAL RESPONSE:\n' + step.rawFinalResponse,
    'RAW OLLAMA RESPONSE:\n' + JSON.stringify(step.rawOllamaResponse, null, 2),
    'SELECTED MOVE: ' + step.selectedMove,
    'SELECTED SCORE: ' + step.selectedScore,
    'BEST AVAILABLE SCORE: ' + step.bestAvailableScore,
    'SCORE DIFFERENCE: ' + step.scoreDifference,
    'ANOMALY: ' + (step.anomaly ? 'YES' : 'NO'),
    'OUTCOME: ' + step.outcome,
    'CORRIDOR TRAVERSAL:\n' +
      step.physicalSteps
        .map(
          (physical, index) =>
            `physical step ${index + 1}: (${physical.from.x},${physical.from.y}) -> (${physical.to.x},${physical.to.y})${physical.succeeded ? '' : ' [blocked]'}`,
        )
        .join('\n'),
    'EiL AFTER: ' + JSON.stringify(step.eilAfter),
    'TIMINGS: ' + JSON.stringify(step.metadata) + ' latency_ms=' + step.latencyMs.toFixed(2),
  ].join('\n\n');
}

function buildFailureReport(run: any): string {
  const bad = run.steps.filter((step: Step) => step.anomaly);
  const latencies = run.steps.map((step: Step) => step.latencyMs);
  const evalCounts = run.steps.map((step: Step) => step.metadata.eval_count || 0);
  const average = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  const section = bad.length ? bad : run.steps;
  const details = section
    .map(
      (step: Step) =>
        '### Decision ' +
        step.step +
        '\n\nPosition: (' +
        step.position.x +
        ',' +
        step.position.y +
        ')\n\nAvailable options:\n' +
        step.choices
          .map(
            (c) =>
              '- ' +
              c.direction.toUpperCase() +
              ': ' +
              (c.blocked
                ? 'blocked'
                : 'score ' +
                  c.score +
                  ' / ' +
                  c.experience +
                  ' / ' +
                  c.eilEffect +
                  ', destination (' +
                  c.destination.x +
                  ',' +
                  c.destination.y +
                  '), visited ' +
                  (c.visited ? 'yes' : 'no') +
                  ', visits ' +
                  c.visitCount),
          )
          .join('\n') +
        '\n\nCurrent EiL: ' +
        JSON.stringify(step.currentEiL) +
        '\n\nRaw Qwen thinking:\n\n' +
        (step.rawThinking || '(empty)') +
        '\n\nFinal answer:\n\n' +
        step.rawFinalResponse +
        '\n\nOutcome: ' +
        step.outcome +
        '\n\nEiL change: ' +
        step.eilAfter.lastReward,
    )
    .join('\n\n');
  return (
    '# Phase 1.7 focused failure report\n\n- Step range: ' +
    (section.length ? section[0].step + '-' + section.at(-1).step : 'none') +
    '\n- Decisions: ' +
    run.decisionCount +
    '\n- Goal reached: ' +
    (run.solved ? 'yes' : 'no') +
    '\n- Final EiL: ' +
    JSON.stringify(run.finalEiL) +
    '\n- Average decision latency: ' +
    average(latencies).toFixed(2) +
    ' ms\n- Longest decision latency: ' +
    (latencies.length ? Math.max(...latencies).toFixed(2) : '0.00') +
    ' ms\n- Average generated/reasoning tokens (Ollama eval_count): ' +
    average(evalCounts).toFixed(2) +
    '\n- Total generated/reasoning tokens: ' +
    evalCounts.reduce((a: number, b: number) => a + b, 0) +
    '\n\nThe raw thinking below is reproduced without interpretation.\n\n' +
    details
  );
}
