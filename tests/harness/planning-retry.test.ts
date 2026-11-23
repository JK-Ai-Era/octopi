/**
 * Planning-only 触发器与语义裁决接线测试
 *
 * 语义（arch/semantic-adjudication.md，2026-11-24 拍板）：
 * - 启发式正则仅作**触发器**：命中 → emit `planning_only.suspected`（请 planning-judge 裁判）
 * - **不再**直接注入 `[System: ...]` steer（判据归 planning-judge 子系统的 LLM 裁决）
 * - 无 events 桥：仅计数不注入（裁判缺席宁缺勿滥）
 *
 * 回归用例（2026-11-23 三次实证误伤）：能力清单 / 问答收尾 / 引用讨论
 * ——即便触发器命中，也绝不直接注入（误报只花一次裁判调用）。
 */

import { describe, it, expect } from 'vitest';
import { makeTokenUsage } from '@octopi-agent/core/types/step.js';
import { DefaultEventBus } from '@octopi-agent/core/primitives/event-bus.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import { Agent } from '@octopi-agent/engine/harness/run/agent/agent.js';
import { runAgentWithReliability } from '@octopi-agent/engine/harness/run/reliability/run-agent.js';
import type { ReliabilityHarness, ReliabilityConfig } from '@octopi-agent/engine/harness/run/reliability/run-agent.js';
import type { HarnessLoopEvent } from '@octopi-agent/engine/harness/run/reliability/harness-events.js';
import type { ModelProvider, LLMRequest, LLMResponse, LLMStreamChunk } from '@octopi-agent/core/interfaces/model-provider.js';

// ── Helper ──

function createSequentialProvider(responses: LLMResponse[]): ModelProvider {
  let callIndex = 0;
  return {
    name: 'test',
    defaultModel: 'test',
    getModelInfo: () => null,
    getModelInfos: () => [],
    async chat(_request: LLMRequest): Promise<LLMResponse> {
      return responses[Math.min(callIndex++, responses.length - 1)];
    },
    async *stream(_request: LLMRequest): AsyncGenerator<LLMStreamChunk> {
      const r = responses[Math.min(callIndex++, responses.length - 1)];
      if (r.toolCalls?.length) {
        for (let i = 0; i < r.toolCalls.length; i++) {
          yield { type: 'tool_call', toolCall: { id: r.toolCalls[i].id, name: r.toolCalls[i].name, arguments: JSON.stringify(r.toolCalls[i].arguments), index: i } };
        }
      }
      if (r.content) yield { type: 'content', content: r.content };
      yield { type: 'done', usage: r.usage };
    },
    async isAvailable() { return true; },
  };
}

function createAgentTools() {
  return [{
    name: 'file_list',
    description: 'List files',
    parameters: { type: 'object' as const, properties: { path: { type: 'string', description: 'Path' } }, required: ['path'] },
    execute: async (_id: string, args: any) => ({
      toolCallId: 'call_1',
      name: 'file_list',
      content: `Files in ${args.path}: file1.ts, file2.ts`,
    }),
  }];
}

function assistantText(content: string): LLMResponse {
  return {
    content,
    toolCalls: undefined,
    usage: makeTokenUsage({ promptTokens: 10, completionTokens: 20 }),
    model: 'test',
    finishReason: 'stop',
  };
}

function createHarness(overrides?: Partial<ReliabilityConfig>): ReliabilityHarness {
  return {
    config: {
      planningRetry: { maxAttempts: 2 },
      emptyResponseRetry: { maxAttempts: 0, steerInstruction: '' },
      noopThreshold: 3,
      loopDetection: { enabled: false },
      ...overrides,
    },
  };
}

async function collectEvents(agent: Agent, harness: ReliabilityHarness): Promise<HarnessLoopEvent[]> {
  const events: HarnessLoopEvent[] = [];
  for await (const e of runAgentWithReliability(agent.context, { model: agent.model }, harness)) {
    events.push(e);
  }
  return events;
}

function findDirectSteer(messages: { role?: string; content?: unknown }[]): unknown {
  return messages.find(
    (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('[System:'),
  );
}

/** 三次实证误伤文本（2026-11-23）：触发器可能命中，但绝不允许直接注入 */
const MISFIRE_TEXTS: [name: string, content: string][] = [
  [
    '能力清单（bullet + 「我会…」）',
    'I can do many things:\n- Full-stack development and debugging\n- Code review and refactoring\n- Testing and deployment\nFor complex work, I will first propose a plan before acting.',
  ],
  [
    '问答收尾（「让我…」）',
    'That covers everything you asked about my capabilities. Let me know if you want me to do anything else with these tools available here.',
  ],
  [
    '引用讨论（mention≠use）',
    'You asked why the engine injects reminders. The heuristic matches promise-style wording like "I will do X" or "let me check" even when such phrases are only being discussed.',
  ],
];

// ── Tests ──

describe('Planning-only 触发器（语义裁决接线）', () => {
  it('planning-only 响应只 emit planning_only.suspected 事件，不直接注入', async () => {
    const provider = createSequentialProvider([
      assistantText('I will analyze the project structure. Let me first list the files.'),
      assistantText('Here is the project structure...'),
    ]);
    const agent = new Agent({ model: provider, systemPrompt: 'You are helpful.', tools: createAgentTools() });
    agent.context.messages = [{ role: 'user', content: 'Analyze the project', timestamp: Date.now() }];

    const bus = new DefaultEventBus();
    const emitted: AgentEvent[] = [];
    bus.on('planning_only.suspected', (e) => { emitted.push(e); });

    await collectEvents(agent, createHarness({ events: bus }));

    // 触发器命中 → 请裁判（事件桥）
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(emitted[0].type).toBe('planning_only.suspected');
    expect(String((emitted[0].data as { content?: string }).content)).toContain('I will analyze');

    // 判定权已移交裁判：reliability 不再直接注入 steer
    expect(findDirectSteer(agent.context.messages)).toBeUndefined();
  });

  it.each(MISFIRE_TEXTS)('误伤回归（%s）：不直接注入 [System:] steer', async (_name, content) => {
    const provider = createSequentialProvider([assistantText(content)]);
    const agent = new Agent({ model: provider, systemPrompt: 'You are helpful.', tools: createAgentTools() });
    agent.context.messages = [{ role: 'user', content: 'What can you do?', timestamp: Date.now() }];

    const bus = new DefaultEventBus();
    const emitted: AgentEvent[] = [];
    bus.on('planning_only.suspected', (e) => { emitted.push(e); });

    await collectEvents(agent, createHarness({ events: bus }));

    // 无论触发器命中与否，误报的代价都只能是「多一次裁判调用」，绝不能是注入
    expect(findDirectSteer(agent.context.messages)).toBeUndefined();
  });

  it('触发节流：超过 maxAttempts 不再 emit', async () => {
    const provider = createSequentialProvider([
      assistantText('I will analyze the project. Let me check the files.'),
      assistantText('I will now look at the code. Let me start by reading the main file.'),
    ]);
    const agent = new Agent({ model: provider, systemPrompt: 'You are helpful.', tools: createAgentTools() });
    agent.context.messages = [{ role: 'user', content: 'Analyze the project', timestamp: Date.now() }];

    const bus = new DefaultEventBus();
    const emitted: AgentEvent[] = [];
    bus.on('planning_only.suspected', (e) => { emitted.push(e); });

    await collectEvents(agent, createHarness({ events: bus, planningRetry: { maxAttempts: 1 } }));

    expect(emitted.length).toBe(1);
  });

  it('无 events 桥：不 emit 也不注入（裁判缺席宁缺勿滥）', async () => {
    const provider = createSequentialProvider([
      assistantText('I will analyze the project. Let me check the files.'),
    ]);
    const agent = new Agent({ model: provider, systemPrompt: 'You are helpful.', tools: createAgentTools() });
    agent.context.messages = [{ role: 'user', content: 'Analyze the project', timestamp: Date.now() }];

    await collectEvents(agent, createHarness());

    expect(findDirectSteer(agent.context.messages)).toBeUndefined();
    const agentEnd = (await collectEvents(
      new Agent({ model: provider, systemPrompt: 'x', tools: createAgentTools() }),
      createHarness(),
    )).find((e) => e.type === 'agent_end');
    expect(agentEnd).toBeDefined();
  });

  it('有 tool_calls 的响应不触发', async () => {
    const provider = createSequentialProvider([
      {
        content: '',
        toolCalls: [{ id: 'call_1', name: 'file_list', arguments: { path: '.' } }],
        usage: makeTokenUsage({ promptTokens: 10, completionTokens: 20 }),
        model: 'test',
        finishReason: 'tool_calls',
      },
      assistantText('Here is the project structure...'),
    ]);
    const agent = new Agent({ model: provider, systemPrompt: 'You are helpful.', tools: createAgentTools() });
    agent.context.messages = [{ role: 'user', content: 'List files', timestamp: Date.now() }];

    const bus = new DefaultEventBus();
    const emitted: AgentEvent[] = [];
    bus.on('planning_only.suspected', (e) => { emitted.push(e); });

    await collectEvents(agent, createHarness({ events: bus }));

    expect(emitted.length).toBe(0);
    expect(findDirectSteer(agent.context.messages)).toBeUndefined();
  });

  it('短响应不触发', async () => {
    const provider = createSequentialProvider([assistantText('OK')]);
    const agent = new Agent({ model: provider, systemPrompt: 'You are helpful.', tools: createAgentTools() });
    agent.context.messages = [{ role: 'user', content: 'Hello', timestamp: Date.now() }];

    const bus = new DefaultEventBus();
    const emitted: AgentEvent[] = [];
    bus.on('planning_only.suspected', (e) => { emitted.push(e); });

    await collectEvents(agent, createHarness({ events: bus }));

    expect(emitted.length).toBe(0);
    expect(findDirectSteer(agent.context.messages)).toBeUndefined();
  });

  it('空响应 steer 不受影响（行为信号直判，保留原语义）', async () => {
    const provider = createSequentialProvider([assistantText('')]);
    const agent = new Agent({ model: provider, systemPrompt: 'You are helpful.', tools: createAgentTools() });
    agent.context.messages = [{ role: 'user', content: 'Hello', timestamp: Date.now() }];

    await collectEvents(agent, createHarness({
      emptyResponseRetry: { maxAttempts: 1, steerInstruction: 'You have not provided a response.' },
    }));

    const steer = agent.context.messages.find(
      (m: any) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('You have not provided a response.'),
    );
    expect(steer).toBeDefined();
  });
});
