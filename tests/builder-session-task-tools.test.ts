/**
 * AgentBuilder 自动注册 task_* 工具
 * 回归：工具必须在 buildAgent 之前进入 toolBus，否则 Agent 快照不含 task 工具。
 */

import { describe, it, expect } from 'vitest';
import { AgentBuilder } from '../src/harness/agent-building/builder.js';
import type { ModelProvider } from '../src/core/interfaces/model-provider.js';

const stubProvider: ModelProvider = {
  name: 'stub',
  chat: async () => ({ content: 'ok' }),
  isAvailable: async () => true,
  getModelInfo: () => null,
  getModelInfos: () => [],
} as unknown as ModelProvider;

describe('AgentBuilder session task tools', () => {
  it('build() 后 Agent 工具列表包含 task_*', async () => {
    const built = await new AgentBuilder().model(stubProvider).build();
    const names = (built.agent.context.tools ?? []).map((t) => t.name);
    expect(names).toContain('task_list');
    expect(names).toContain('task_create');
    expect(names).toContain('task_complete');
    expect(names).toContain('task_plan');
  });
});
