import fs from 'fs/promises';
import path from 'path';

import yaml from 'yaml';
import { z } from 'zod';

import type { EiLState } from '@/agent/eil';
import type { Direction, Position } from '@/maze/maze';

export const MOVES = ['up', 'down', 'left', 'right'] as const;
export type Move = (typeof MOVES)[number];

export const MoveActionSchema = z.object({
  move: z.enum(MOVES),
});
export type MoveAction = z.infer<typeof MoveActionSchema>;
export const AGENT_MOVES = [...MOVES, 'cheese'] as const;
export type AgentMove = (typeof AGENT_MOVES)[number];
export const createActionSchema = (cheeseVisible: boolean) =>
  z.object({
    move: z.enum(cheeseVisible ? AGENT_MOVES : MOVES),
  });
// Kept as the broad schema for callers that need a stable schema at module load time.
export const ActionSchema = createActionSchema(true);
export type AgentAction = { move: AgentMove };

export function directionToMove(direction: Direction): Move {
  if (direction.dx === 0 && direction.dy === -1) return 'up';
  if (direction.dx === 0 && direction.dy === 1) return 'down';
  if (direction.dx === -1 && direction.dy === 0) return 'left';
  if (direction.dx === 1 && direction.dy === 0) return 'right';
  throw new Error(`Invalid direction: ${JSON.stringify(direction)}`);
}

export type CellResult = {
  position: Position;
  isCorrect: boolean;
  llmMove: Move | null;
  correctMoves: Move[];
  timeMs?: number;
};

export type Execution = {
  mazeFile: string;
  modelName: string;
  strategyName: string;
  includeHistory: boolean;
  cellResults: CellResult[];
};

export type ExecutionFilter = {
  model?: string;
  maze?: string;
  strategy?: string;
  includeHistory?: boolean;
};

export type AgentStep = {
  step: number;
  from: Position;
  move: Move;
  succeeded: boolean;
  to: Position;
  observation: string;
  prompt: string;
  response?: string;
  reward: number;
  eil: EiLState;
};

export type AgentExecution = {
  mazeFile: string;
  modelName: string;
  solved: boolean;
  steps: AgentStep[];
};

export const DEFAULT_OUTPUT_DIR = './output/executions';

export class Executions {
  static async all(outputDir = DEFAULT_OUTPUT_DIR): Promise<Execution[]> {
    const yamlFiles = await findYamlFiles(outputDir);
    const executions: Execution[] = [];
    for (const file of yamlFiles) {
      const content = await fs.readFile(file, 'utf-8');
      executions.push(yaml.parse(content) as Execution);
    }
    return executions;
  }

  static async find(filter: ExecutionFilter, outputDir = DEFAULT_OUTPUT_DIR): Promise<Execution[]> {
    let executions = await this.all(outputDir);

    if (filter.model) {
      executions = executions.filter((e) => e.modelName.includes(filter.model!));
    }
    if (filter.maze) {
      executions = executions.filter((e) => e.mazeFile.includes(filter.maze!));
    }
    if (filter.strategy) {
      executions = executions.filter((e) => e.strategyName === filter.strategy);
    }
    if (filter.includeHistory !== undefined) {
      executions = executions.filter((e) => e.includeHistory === filter.includeHistory);
    }

    return executions;
  }

  static async save(execution: Execution, outputDir = DEFAULT_OUTPUT_DIR): Promise<string> {
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const modelId = execution.modelName.replace(/[:/]/g, '_');
    const mazeName = path.basename(execution.mazeFile, '.txt');
    const destDir = path.join(outputDir, modelId, execution.strategyName, mazeName);
    await fs.mkdir(destDir, { recursive: true });

    const filePath = path.join(destDir, `${timestamp}.yaml`);
    await fs.writeFile(filePath, yaml.stringify(execution));
    return filePath;
  }
}

export class AgentExecutions {
  static async save(execution: AgentExecution, outputDir = './output/agent-executions'): Promise<string> {
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const modelId = execution.modelName.replace(/[:/]/g, '_');
    const mazeName = path.basename(execution.mazeFile, '.txt');
    const destDir = path.join(outputDir, modelId, mazeName);
    await fs.mkdir(destDir, { recursive: true });
    const filePath = path.join(destDir, `${timestamp}.yaml`);
    await fs.writeFile(filePath, yaml.stringify(execution));
    return filePath;
  }
}

async function findYamlFiles(dir: string): Promise<string[]> {
  let files: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files = files.concat(await findYamlFiles(fullPath));
      } else if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  return files;
}
