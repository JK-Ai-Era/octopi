import type { RegisteredTool } from '../../../core/types.js';
import type { MemoryStore } from '../../memory/types.js';
import type { TaskTracker as ITaskTracker } from '../../task-system/tasks/types.js';
import type { AskUserCallback } from './ask-user.js';

import { getBuiltinTools } from './builtin.js';
import { createMemoryTools } from './memory.js';
import { createTaskTools } from './task-tools.js';
import { createAskUserTool } from './ask-user.js';

export interface ToolSetConfig {
  memoryStore?: MemoryStore;
  taskTracker?: ITaskTracker;
  askUser?: AskUserCallback;
}

export interface ToolSet {
  builtin: RegisteredTool[];
  extensions: RegisteredTool[];
  all: RegisteredTool[];
}

export function createToolSet(config?: ToolSetConfig): ToolSet {
  const builtin = getBuiltinTools();
  const extensions: RegisteredTool[] = [
    ...(config?.memoryStore ? createMemoryTools(config.memoryStore) : []),
    ...(config?.taskTracker ? createTaskTools(config.taskTracker) : []),
    ...(config?.askUser ? [createAskUserTool(config.askUser)] : []),
  ];

  return { builtin, extensions, all: [...builtin, ...extensions] };
}
