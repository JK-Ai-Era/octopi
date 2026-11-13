/**
 * RegisteredTool.ageResult 透传一致性 + per-tool 老化行为
 *
 * `RegisteredTool.ageResult` 是唯一声明源，经三处同构映射进入 Loop AgentTool
 * （与 executionMode 同款约束）：
 *   1. AgentBuilder convertToAgentTool（build 通路）
 *   2. gateway registeredToolToAgentTool（HTTP 热更新通路）
 *   3. think buildAgentTools（自主子系统通路）
 *
 * 任一处丢透传 → 该通路的工具静默退回默认长度规则（老化策略失效且无报错）。
 */

import { describe, it, expect, vi } from 'vitest';
import { makeTokenUsage } from '@octopi-agent/core/types/step.js';
import type { ModelProvider, RegisteredTool, ToolResultAger } from '@octopi-agent/core/index.js';
import type { LLMStreamChunk } from '@octopi-agent/core/interfaces/model-provider.js';
import { AgentBuilder } from '@octopi-agent/engine/harness/index.js';
import { ThinkExecutor } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/think/executor.js';
import { ModelResolver } from '@octopi-agent/engine/harness/collaboration/autonomous-subsystem/think/model-resolver.js';
import { registeredToolToAgentTool } from '@octopi-agent/gateway/gateway/gateway.js';
import {
  collectToolAgers,
  computeToolResultAgingPlan,
  resolveToolResultAgingOptions,
} from '@octopi-agent/engine/harness/context/tool-result-aging.js';
import { createTaskListTool } from '@octopi-agent/engine/harness/session/tasks/tools.js';
import {
  createGitDiffTool,
  createGitStatusTool,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/git-tools.js';
import type { Message } from '@octopi-agent/core/types.js';

const AGER: ToolResultAger = () => '[stale] replaced';

type MappedTool = { name: string; ageResult?: ToolResultAger };

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
    getModelInfos: () => [],
  };
}

function makeRegisteredTool(name: string, ageResult?: ToolResultAger): RegisteredTool {
  return {
    definition: { name, description: 'test tool', parameters: {} },
    ...(ageResult ? { ageResult } : {}),
    handler: async () => 'result',
  };
}

describe('RegisteredTool.ageResult 透传（三处同构映射）', () => {
  it('AgentBuilder 通路：build 后 agent.tools 保留 ageResult', async () => {
    const { agent } = await new AgentBuilder()
      .model(createMockModelProvider())
      .tool(makeRegisteredTool('aged_tool', AGER))
      .tool(makeRegisteredTool('plain_tool'))
      .buildAgent();

    expect(agent.tools.find((t) => t.name === 'aged_tool')?.ageResult).toBe(AGER);
    expect(agent.tools.find((t) => t.name === 'plain_tool')?.ageResult).toBeUndefined();
  });

  it('gateway 通路：registeredToolToAgentTool 保留 ageResult', () => {
    const aged = registeredToolToAgentTool(makeRegisteredTool('aged_tool', AGER)) as MappedTool;
    const plain = registeredToolToAgentTool(makeRegisteredTool('plain_tool')) as MappedTool;
    expect(aged.ageResult).toBe(AGER);
    expect(plain.ageResult).toBeUndefined();
  });

  it('think 通路：buildAgentTools 保留 ageResult', () => {
    const executor = new ThinkExecutor({
      modelResolver: new ModelResolver({ levels: {} }),
      modelProvider: {} as never,
      errorStrategy: {} as never,
    });
    const buildAgentTools = (
      executor as unknown as { buildAgentTools(tools?: Map<string, RegisteredTool>): MappedTool[] }
    ).buildAgentTools.bind(executor);

    const mapped = buildAgentTools(
      new Map<string, RegisteredTool>([
        ['aged_tool', makeRegisteredTool('aged_tool', AGER)],
        ['plain_tool', makeRegisteredTool('plain_tool')],
      ]),
    );
    expect(mapped.find((t) => t.name === 'aged_tool')?.ageResult).toBe(AGER);
    expect(mapped.find((t) => t.name === 'plain_tool')?.ageResult).toBeUndefined();
  });

  it('collectToolAgers：只收有声明的工具，空表返回 undefined', () => {
    const map = collectToolAgers([
      { name: 'aged_tool', ageResult: AGER },
      { name: 'plain_tool' },
    ]);
    expect(map?.get('aged_tool')).toBe(AGER);
    expect(map?.has('plain_tool')).toBe(false);
    expect(collectToolAgers([])).toBeUndefined();
    expect(collectToolAgers(undefined)).toBeUndefined();
  });
});

/** 构造「旧轮结果」消息序列：user 锚点之后又来一个 user（本轮），使前者成为候选 */
function ageingMessages(calls: Array<{ id: string; name: string; args: Record<string, unknown>; result: unknown }>): Message[] {
  const messages: Message[] = [{ role: 'user', content: 'q0', timestamp: 1 } as Message];
  for (const c of calls) {
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: c.id, name: c.name, arguments: c.args }],
      timestamp: 2,
    } as unknown as Message);
    messages.push({
      role: 'tool',
      content: '',
      toolResults: [{ toolCallId: c.id, name: c.name, result: c.result }],
      timestamp: 3,
    } as unknown as Message);
  }
  // 新 turn 起点 → 之前的结果都「跨轮」
  messages.push({ role: 'user', content: 'q1', timestamp: 9 } as Message);
  return messages;
}

describe('per-tool 老化策略：跳过长度预筛、保留不膨胀守卫', () => {
  const opts = resolveToolResultAgingOptions({ rawWindow: 0, freezeBatch: 1 });

  it('有声明的工具即使结果很短（< maxPointerChars）也会被老化', () => {
    // 470 字符的 git_status：默认规则下 ≤400? 否；用 300 字符确保默认规则会跳过
    const stdout = `## main\n${' M a.ts\n'.repeat(40)}`;
    const messages = ageingMessages([
      { id: 'c1', name: 'git_status', args: {}, result: { stdout, exitCode: 0 } },
    ]);
    expect(stdout.length).toBeLessThan(opts.maxPointerChars + 200);

    const withAger = computeToolResultAgingPlan(messages, opts, {
      toolAgers: collectToolAgers([{ name: 'git_status', ageResult: createGitStatusTool().ageResult }]),
    });
    expect(withAger.agedIds.has('c1')).toBe(true);
    // 无声明 → 默认规则按长度判定，短结果不老化
    const withoutAger = computeToolResultAgingPlan(messages, opts);
    expect(withoutAger.agedIds.has('c1')).toBe(false);
  });

  it('ager 返回 undefined = 保留原文（作者显式声明不老化）', () => {
    const messages = ageingMessages([
      { id: 'c1', name: 'keep_me', args: {}, result: 'x'.repeat(5000) },
    ]);
    const plan = computeToolResultAgingPlan(messages, opts, {
      toolAgers: collectToolAgers([{ name: 'keep_me', ageResult: () => undefined }]),
    });
    expect(plan.agedIds.has('c1')).toBe(false);
  });

  it('不膨胀守卫：ager 返回更长的文本 → 不老化', () => {
    const messages = ageingMessages([
      { id: 'c1', name: 'shrink', args: {}, result: 'x'.repeat(20) },
    ]);
    const plan = computeToolResultAgingPlan(messages, opts, {
      toolAgers: collectToolAgers([{ name: 'shrink', ageResult: () => 'y'.repeat(200) }]),
    });
    expect(plan.agedIds.has('c1')).toBe(false);
  });

  it('error 结果红线：有声明的工具也不老化', () => {
    const messages: Message[] = [
      { role: 'user', content: 'q0', timestamp: 1 } as Message,
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'e1', name: 'git_status', arguments: {} }],
        timestamp: 2,
      } as unknown as Message,
      {
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: 'e1', name: 'git_status', error: 'boom' }],
        timestamp: 3,
      } as unknown as Message,
      { role: 'user', content: 'q1', timestamp: 9 } as Message,
    ];
    const plan = computeToolResultAgingPlan(messages, opts, {
      toolAgers: collectToolAgers([{ name: 'git_status', ageResult: createGitStatusTool().ageResult }]),
    });
    expect(plan.agedIds.has('e1')).toBe(false);
  });
});

describe('三个 ager 的输出语义', () => {
  const gitStatus = createGitStatusTool().ageResult!;
  const gitDiff = createGitDiffTool().ageResult!;
  const taskList = createTaskListTool({} as never).ageResult!;

  it('task_list：整体丢弃为最小标记（无计数——计数器无时态，会被读成当前事实）', () => {
    const out = taskList({
      args: {},
      result: { tasks: [{ id: 'a' }, { id: 'b' }], total: 2, goals: 1 },
      chars: 15000,
    });
    expect(out).toBe('[stale task_list] call task_list again for current tasks');
    expect(out).not.toMatch(/\d/);
  });

  it('git_status：计数 + 分支名 + 重调提示', () => {
    const stdout = '## main...origin/main\n M a.ts\n M b.ts\n?? c.ts\n';
    const out = gitStatus({ args: {}, result: { stdout, exitCode: 0 }, chars: 5000 })!;
    expect(out).toContain('3 changed entries');
    expect(out).toContain('branch main');
    expect(out).toContain('call git_status again');
  });

  it('git_diff unstaged：正文丢弃，只留文件数与增删行数', () => {
    const stdout = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '+added line',
      '+another',
      '-removed line',
    ].join('\n');
    const out = gitDiff({ args: { mode: 'unstaged' }, result: { stdout }, chars: 9000 })!;
    expect(out).toContain('1 file(s)');
    expect(out).toContain('+2 −1');
    expect(out).not.toContain('added line');
  });

  it('git_diff --commit <sha>：不可变事实 → 保留原文（返回 undefined）', () => {
    const sha = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
    expect(gitDiff({ args: { mode: 'commit', revision: sha }, result: { stdout: 'diff --git a/x b/x' }, chars: 9000 })).toBeUndefined();
  });

  it('git_diff --commit HEAD：浮动 revision → 仍按「会过时」处理', () => {
    const out = gitDiff({ args: { mode: 'commit', revision: 'HEAD' }, result: { stdout: 'diff --git a/x b/x' }, chars: 9000 });
    expect(out).toContain('stale git_diff');
  });

  it('空输出不制造噪音', () => {
    expect(gitStatus({ args: {}, result: { stdout: '  \n' }, chars: 10 })).toBe('[aged git_status] (no output)');
  });
});
