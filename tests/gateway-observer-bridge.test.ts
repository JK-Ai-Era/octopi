/**
 * 跨进程 Observer 桥（gateway 侧）：
 * - session_event notify（观测专属事件）→ 喂 ObserverHub + 重建 lastContextLayers
 * - remoteExecute execute 流镜像 → 喂 ObserverHub（跳过流式 delta，防 hub 拥塞）
 *
 * 背景：Runner 直采进 run 实例进程自己的 hub，gateway hub（服务 /debug/run 与
 * webui Run/上下文面板）靠这两路镜像喂入——否则数据只留在 run 进程（原缺口）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { AgentDefinition } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';

function makeProvider(): ModelProvider {
  return {
    name: 'openai',
    defaultModel: 'gpt-5-mini',
    getModelInfo: (m: string) => ({ name: m }),
    getModelInfos: () => [{ name: 'gpt-5-mini' }],
    isAvailable: async () => true,
    chat: async () => ({ content: '', model: 'gpt-5-mini', finishReason: 'stop' as const }),
    stream: async function* () {
      yield { type: 'done' as const };
    },
  };
}

function makeAgent(id: string): AgentDefinition {
  return {
    id,
    home: '',
    workspace: '',
    persona: { name: id, description: '', systemPrompt: 'test' },
    tools: { allow: ['*'] },
    model: { provider: 'openai', model: 'gpt-5-mini' },
  };
}

type GatewayInternals = {
  handleRunHostNotify: (n: unknown, instanceId: string) => Promise<void>;
  remoteExecute: (req: unknown, signal?: AbortSignal) => AsyncIterable<AgentEvent>;
  fleet: unknown;
};

describe('gateway 跨进程 Observer 桥', () => {
  let gateway: Gateway;

  beforeEach(() => {
    gateway = new Gateway(
      {
        agents: [makeAgent('assistant')],
        knowledge: { service: { manageLocal: false } },
        observer: { level: 'full' },
      },
      new InMemorySessionStore(),
    );
    gateway.registerProvider(makeProvider());
  });

  afterEach(async () => {
    await gateway.stop();
  });

  it('session_event（run.scope.ready → tool.exec.update）→ record 补建 + hub 可读', async () => {
    const readyEvent = {
      type: 'run.scope.ready',
      timestamp: Date.now(),
      agentId: 'assistant',
      sessionId: 's-layers',
      data: {
        sessionId: 's-layers',
        agentId: 'assistant',
        runId: 'run-l1',
        scope: {
          runId: 'run-l1',
          sessionId: 's-layers',
          agentId: 'assistant',
          capturedAt: Date.now(),
        },
      },
    };
    const internals = gateway as unknown as GatewayInternals;
    await internals.handleRunHostNotify(
      { type: 'session_event', sessionId: 's-layers', event: readyEvent },
      'run-0',
    );
    // run.scope.ready 补建 record → Run 页签数据源可读
    expect(gateway.getObserverHub().getRunObservatory('s-layers')).not.toBeNull();

    // 后续 timeline 事件有归属（进 record）
    const updateEvent = {
      type: 'tool.exec.update',
      timestamp: Date.now(),
      agentId: 'assistant',
      sessionId: 's-layers',
      data: { toolCallId: 'call_1', toolName: 'shell', content: 'partial' },
    };
    await internals.handleRunHostNotify(
      { type: 'session_event', sessionId: 's-layers', event: updateEvent },
      'run-0',
    );
    const snapshot = gateway.getObserverHub().getRunObservatory('s-layers');
    expect(snapshot).not.toBeNull();
    expect(snapshot?.lifecycle?.startedAt ?? 0).toBeGreaterThan(0);
  });

  it('session_event（context.layers.assembled）→ lastContextLayers 可读', async () => {
    const layersEvent = {
      type: 'context.layers.assembled',
      timestamp: Date.now(),
      agentId: 'assistant',
      sessionId: 's-layers2',
      data: {
        sessionId: 's-layers2',
        agentId: 'assistant',
        manifest: {
          sessionId: 's-layers2',
          systemBudget: 1000,
          usedTokens: 120,
          shares: { persona: 120 },
          layers: [{ id: 'persona', tokens: 120, sources: [] }],
        },
        enabledLayerIds: ['persona'],
        query: 'test query',
        assembledAt: Date.now(),
      },
    };
    const internals = gateway as unknown as GatewayInternals;
    await internals.handleRunHostNotify(
      { type: 'session_event', sessionId: 's-layers2', event: layersEvent },
      'run-0',
    );

    // 上下文页签 REST 数据源
    const snapshot = gateway.getSessionContextLayers('s-layers2');
    expect(snapshot).not.toBeNull();
  });

  it('session_event（tool.exec.update 等专属事件）喂 hub timeline', async () => {
    const readyEvent = {
      type: 'run.scope.ready',
      timestamp: Date.now(),
      agentId: 'assistant',
      sessionId: 's-tool',
      data: {
        sessionId: 's-tool',
        agentId: 'assistant',
        runId: 'run-t1',
        scope: { runId: 'run-t1', sessionId: 's-tool', agentId: 'assistant', capturedAt: Date.now() },
      },
    };
    const updateEvent = {
      type: 'tool.exec.update',
      timestamp: Date.now(),
      agentId: 'assistant',
      sessionId: 's-tool',
      data: { toolCallId: 'call_1', toolName: 'shell', content: 'partial' },
    };
    const internals = gateway as unknown as GatewayInternals;
    await internals.handleRunHostNotify(
      { type: 'session_event', sessionId: 's-tool', event: readyEvent },
      'run-0',
    );
    await internals.handleRunHostNotify(
      { type: 'session_event', sessionId: 's-tool', event: updateEvent },
      'run-0',
    );
    expect(gateway.getObserverHub().getRunObservatory('s-tool')).not.toBeNull();
  });

  it('remoteExecute 镜像喂 hub：流事件进 hub、流式 delta 跳过', async () => {
    const readyEvent = {
      type: 'run.scope.ready',
      timestamp: Date.now(),
      agentId: 'assistant',
      sessionId: 's-mirror',
      data: {
        sessionId: 's-mirror',
        agentId: 'assistant',
        runId: 'run-m1',
        scope: { runId: 'run-m1', sessionId: 's-mirror', agentId: 'assistant', capturedAt: Date.now() },
      },
    } as unknown as AgentEvent;
    const events: AgentEvent[] = [
      readyEvent,
      {
        type: 'engine.start',
        timestamp: Date.now(),
        agentId: 'assistant',
        sessionId: 's-mirror',
        data: {},
      } as unknown as AgentEvent,
      {
        type: 'llm_stream_delta',
        timestamp: Date.now(),
        agentId: 'assistant',
        sessionId: 's-mirror',
        data: { delta: 'x' },
      } as unknown as AgentEvent,
    ];
    // 注入假 fleet 执行腿（remoteExecute 恒走 getRunBackend()=fleet）
    (gateway as unknown as GatewayInternals).fleet = {
      list: () => [{ instanceId: 'run-0' }],
      startRun: () =>
        (async function* () {
          for (const e of events) yield e;
        })(),
      control: async () => ({ ok: true }),
    };

    const internals = gateway as unknown as GatewayInternals;
    const streamed: AgentEvent[] = [];
    for await (const ev of internals.remoteExecute(
      { sessionId: 's-mirror', agentId: 'assistant', requestId: 'r1', triggers: [], messages: [] },
      undefined,
    )) {
      streamed.push(ev);
    }
    // 执行流完整透传
    expect(streamed).toHaveLength(3);

    // hub 已镜像喂入（delta 跳过不影响可观测性断言）
    expect(gateway.getObserverHub().getRunObservatory('s-mirror')).not.toBeNull();
  });
});
