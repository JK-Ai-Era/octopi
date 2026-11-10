/**
 * RegisteredTool → AgentTool 适配（热更新已 build Agent 的 client tool）。
 *
 * 将 RegisteredTool 转换为 Loop AgentTool（与 builder.convertToAgentTool、
 * think.buildAgentTools 同构）。原居 gateway.ts，P0b 随客户端工具面迁 run 侧时
 * 归位 engine（其全部依赖本就在 engine）。导出供测试覆盖三处映射的
 * executionMode 透传一致性。
 */

import type { RegisteredTool } from '@octopi-agent/core/types.js';
import {
  buildToolLlmParameters,
  prepareHandlerArgs,
  resolveToolCallPurpose,
} from './tool-purpose.js';
import { getRunScope } from '../run/run-scope.js';

export function registeredToolToAgentTool(tool: RegisteredTool): {
  name: string;
  description: string;
  executionMode?: 'parallel' | 'sequential';
  source?: import('@octopi-agent/core/types.js').ToolSource;
  parameters?: Record<string, unknown>;
  execute: (
    toolCallId: string,
    args: unknown,
    signal?: AbortSignal,
    onUpdate?: (partial: { content?: unknown }) => void,
  ) => Promise<{
    toolCallId: string;
    name: string;
    content: unknown;
    isError?: boolean;
    durationMs?: number;
    purpose?: string;
    source?: import('@octopi-agent/core/types.js').ToolSource;
  }>;
} {
  return {
    name: tool.definition.name,
    description: tool.definition.description,
    // 与 convertToAgentTool 同构：purpose 统一装配（arch/tool-call-purpose.md）
    ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    ...(tool.source === undefined ? {} : { source: tool.source }),
    parameters: buildToolLlmParameters(tool.definition.parameters),
    execute: async (toolCallId, args, signal, onUpdate) => {
      const startTime = Date.now();
      try {
        const rawArgs = (args ?? {}) as Record<string, unknown>;
        // schema 已 required purpose；模型漏填时推导，不中断调用
        const purpose = resolveToolCallPurpose(tool.definition.name, rawArgs);
        const handlerArgs = prepareHandlerArgs(rawArgs, tool.definition);
        const scope = getRunScope();
        const { isPluginToolPermitted } = await import(
          '../extension/plugin-ecosystem/tools/plugin-tool.js'
        );
        if (!isPluginToolPermitted(tool, scope?.toolRuntime?.agentToolPolicy)) {
          throw new Error(`Plugin tool "${tool.definition.name}" is not allowed for this agent`);
        }
        const result = await tool.handler(handlerArgs, {
          sessionId: scope?.sessionId ?? 'unknown',
          agentId: scope?.agentId ?? 'unknown',
          messages: scope?.toolRuntime?.messages ?? [],
          abortSignal: signal,
          // 工具部分输出通道（展示用途）；无转发器时不给工具假通道
          ...(onUpdate ? { onUpdate } : {}),
          fileEffects:
            scope?.toolRuntime?.fileEffects
            ?? (await import('../extension/execution-environment/undo-log.js')).createUnconfiguredFileEffects(),
          memoryEffects:
            scope?.toolRuntime?.memoryEffects
            ?? (await import('../extension/execution-environment/undo-log.js')).createUnconfiguredMemoryEffects(),
        });
        return {
          toolCallId,
          name: tool.definition.name,
          content: result,
          purpose,
          ...(tool.source === undefined ? {} : { source: tool.source }),
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        return {
          toolCallId,
          name: tool.definition.name,
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          ...(tool.source === undefined ? {} : { source: tool.source }),
          durationMs: Date.now() - startTime,
        };
      }
    },
  };
}
