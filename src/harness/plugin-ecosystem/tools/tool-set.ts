import type { RegisteredTool } from '../../../core/types.js';
import type { MemoryStore } from '../../memory/types.js';
import type { SessionTaskService } from '../../session-tasks/service.js';
import type { SessionHistoryPort } from '../../session-history/index.js';
import type { WebSearchProvider } from './web-search-types.js';
import type { AskUserCallback } from './ask-user.js';

import { getBuiltinTools } from './builtin.js';
import { createMemoryTools } from './memory.js';
import { createSessionTaskTools } from '../../session-tasks/tools.js';
import { createAskUserTool } from './ask-user.js';
import { createWebSearchTool } from './web-search.js';
import { createSessionHistoryTools } from './session-history.js';

export interface ToolSetConfig {
  memoryStore?: MemoryStore;
  /** memory 工具的 confidence/gates 覆盖（与 octopi.json memory 段对齐） */
  memory?: import('./memory.js').MemoryToolOptions;
  /** SessionTaskService — 会话任务唯一写入口 */
  sessionTaskService?: SessionTaskService;
  /**
   * @deprecated 使用 sessionTaskService
   */
  taskTracker?: SessionTaskService;
  askUser?: AskUserCallback;
  /** 已解析的 web search 实现；未提供时不注册 web_search */
  webSearch?: {
    provider: WebSearchProvider;
    defaultLimit?: number;
    timeoutMs?: number;
  };
  /** Summary 公用能力（http_request / file_read L1/L2） */
  summary?: import('../../capabilities/summary/index.js').ToolSummarySupport;
  /** Information 历史检索（session_search / session_read） */
  sessionHistory?: SessionHistoryPort;
}

export interface ToolSet {
  builtin: RegisteredTool[];
  extensions: RegisteredTool[];
  all: RegisteredTool[];
}

export function createToolSet(config?: ToolSetConfig): ToolSet {
  const taskService = config?.sessionTaskService ?? config?.taskTracker;
  const builtin = getBuiltinTools({ summary: config?.summary });
  const extensions: RegisteredTool[] = [
    ...(config?.memoryStore ? createMemoryTools(config.memoryStore, config?.memory) : []),
    ...(taskService ? createSessionTaskTools(taskService) : []),
    ...(config?.askUser ? [createAskUserTool(config.askUser)] : []),
    ...(config?.webSearch
      ? [
          createWebSearchTool(config.webSearch.provider, {
            defaultLimit: config.webSearch.defaultLimit,
            timeoutMs: config.webSearch.timeoutMs,
          }),
        ]
      : []),
    ...(config?.sessionHistory
      ? createSessionHistoryTools({
          history: config.sessionHistory,
          summary: config?.summary,
        })
      : []),
  ];

  return { builtin, extensions, all: [...builtin, ...extensions] };
}
