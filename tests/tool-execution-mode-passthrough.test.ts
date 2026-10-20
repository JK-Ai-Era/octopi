/**
 * executionMode 透传一致性 + fs 写工具串行声明回归
 *
 * RegisteredTool.executionMode 是唯一声明源，经三处同构映射进入 Loop AgentTool：
 *   1. AgentBuilder convertToAgentTool（build 通路）
 *   2. gateway registeredToolToAgentTool（HTTP 热更新通路）
 *   3. think buildAgentTools（自主子系统通路）
 * 任一处丢透传都会让 fs 写工具批次退化为并行 → 同文件读改写互相覆盖（丢编辑）。
 */

import { describe, it, expect, vi } from 'vitest';
import { makeTokenUsage } from '@octopi-agent/core/types/turn.js';
import type {
  ModelProvider,
  LLMStreamChunk,
  RegisteredTool,
} from '@octopi-agent/core/index.js';
import { AgentBuilder } from '@octopi-agent/engine/harness/index.js';
import {
  ThinkExecutor,
} from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/think/executor.js';
import {
  ModelResolver,
} from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/think/model-resolver.js';
import { registeredToolToAgentTool } from '@octopi-agent/gateway/gateway/gateway.js';
import {
  createFileWriteTool,
  createFileDeleteTool,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/builtin.js';
import {
  createFileMkdirTool,
  createFileRenameTool,
  createFileCopyTool,
  createFileRmdirTool,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/file-ops.js';
import {
  createFileEditTool,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/file-edit.js';
import {
  createPackageEditTool,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/package-tools.js';
import {
  createTaskCreateTool,
  createTaskPlanTool,
  createTaskCompleteTool,
  createTaskPauseTool,
  createTaskResumeTool,
  createTaskDropTool,
  createTaskNoteTool,
} from '@octopi-agent/engine/harness/session/tasks/tools.js';

type MappedTool = { name: string; executionMode?: 'parallel' | 'sequential' };

function createMockModelProvider(): ModelProvider {
  return {
    name: 'mock',
    chat: vi.fn().mockResolvedValue({
      content: 'Hello!',
      model: 'mock-model',
      finishReason: 'stop',
      usage: makeTokenUsage({ promptTokens: 10, completionTokens: 5 }),
    }),
    stream: async function* (): AsyncGenerator<LLMStreamChunk> {
      yield { type: 'content', content: 'Hello!' };
      yield { type: 'done', usage: makeTokenUsage({ promptTokens: 10, completionTokens: 5 }) };
    },
    isAvailable: vi.fn().mockResolvedValue(true),
    getModelInfo: () => null,
  };
}

function makeRegisteredTool(name: string, executionMode?: 'parallel' | 'sequential'): RegisteredTool {
  return {
    definition: { name, description: 'test tool', parameters: {} },
    ...(executionMode && { executionMode }),
    handler: async () => 'result',
  };
}

describe('RegisteredTool.executionMode 透传（三处同构映射）', () => {
  it('AgentBuilder 通路：build 后 agent.tools 保留 executionMode', async () => {
    const { agent } = await new AgentBuilder()
      .model(createMockModelProvider())
      .tool(makeRegisteredTool('seq_tool', 'sequential'))
      .tool(makeRegisteredTool('default_tool'))
      .buildAgent();

    const seq = agent.tools.find((t) => t.name === 'seq_tool');
    const plain = agent.tools.find((t) => t.name === 'default_tool');
    expect(seq?.executionMode).toBe('sequential');
    expect(plain?.executionMode).toBeUndefined();
  });

  it('gateway 通路：registeredToolToAgentTool 保留 executionMode', () => {
    const seq = registeredToolToAgentTool(makeRegisteredTool('seq_tool', 'sequential')) as MappedTool;
    const plain = registeredToolToAgentTool(makeRegisteredTool('default_tool')) as MappedTool;
    expect(seq.executionMode).toBe('sequential');
    expect(plain.executionMode).toBeUndefined();
  });

  it('think 通路：buildAgentTools 保留 executionMode', () => {
    const executor = new ThinkExecutor({
      modelResolver: new ModelResolver({ levels: {}, defaultProvider: 'mock' }),
      modelProvider: {} as never,
      errorStrategy: {} as never,
    });
    // buildAgentTools 是私有装配函数；这里经类型逃逸直测映射结果
    const buildAgentTools = (
      executor as unknown as {
        buildAgentTools(tools?: Map<string, RegisteredTool>): MappedTool[];
      }
    ).buildAgentTools.bind(executor);

    const tools = new Map<string, RegisteredTool>([
      ['seq_tool', makeRegisteredTool('seq_tool', 'sequential')],
      ['default_tool', makeRegisteredTool('default_tool')],
    ]);
    const mapped = buildAgentTools(tools);
    expect(mapped.find((t) => t.name === 'seq_tool')?.executionMode).toBe('sequential');
    expect(mapped.find((t) => t.name === 'default_tool')?.executionMode).toBeUndefined();
  });
});

describe('写工具串行声明回归（防丢编辑 / 丢更新）', () => {
  // task_* 只读静态 executionMode 字段，service 不会被调用
  const taskService = {} as never;
  const writeTools: Array<[string, RegisteredTool]> = [
    ['file_write', createFileWriteTool()],
    ['file_edit', createFileEditTool()],
    ['file_delete', createFileDeleteTool()],
    ['file_mkdir', createFileMkdirTool()],
    ['file_rename', createFileRenameTool()],
    ['file_copy', createFileCopyTool()],
    ['file_rmdir', createFileRmdirTool()],
    ['package_edit', createPackageEditTool()],
    ['task_create', createTaskCreateTool(taskService)],
    ['task_plan', createTaskPlanTool(taskService)],
    ['task_complete', createTaskCompleteTool(taskService)],
    ['task_pause', createTaskPauseTool(taskService)],
    ['task_resume', createTaskResumeTool(taskService)],
    ['task_drop', createTaskDropTool(taskService)],
    ['task_note', createTaskNoteTool(taskService)],
  ];

  it.each(writeTools)('%s 声明 executionMode=sequential', (_name, tool) => {
    expect(tool.executionMode).toBe('sequential');
  });
});
