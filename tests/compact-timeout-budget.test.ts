/**
 * compact op 传输层预算（UI 压缩超时误报修复）：
 * compact 三段时长不可预算——session 锁等待（上界=run 时长）+ 首次 mount 装配 +
 * summarize LLM 调用（任务层 summarizeTimeoutMs 兜底降级）。传输层设任何固定界都会
 * 把「还在排队/跑」误报成「aborted due to timeout」（任务侧照常落盘）——恒显式 null
 * （不设限）。UI 侧「压缩中…」+ 计时即反馈通道，非零反馈假死。
 *
 * transport 三态语义（MAJ-2 回归锚）：options 缺省 = 30s；显式 null = 不设限；
 * number = 该预算。`??` 兜底会把显式 null 兜回 30s——退回误报症状，禁止。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { AgentDefinition } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';
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

type ControlCall = { op: { type: string }; options?: { timeoutMs?: number | null } };

function stubFleet(calls: ControlCall[]): unknown {
  return {
    list: () => [{ instanceId: 'run-0' }],
    startRun: () => (async function* () {})(),
    control: async (op: { type: string }, options?: { timeoutMs?: number | null }) => {
      calls.push({ op, options });
      return { ok: true, result: { compacted: true } };
    },
  };
}

async function makeGateway(summarizeTimeoutMs?: number): Promise<Gateway> {
  const store = new InMemorySessionStore();
  await store.save('s-compact', {
    id: 's-compact',
    agentId: 'assistant',
    meta: {
      id: 's-compact',
      agentId: 'assistant',
      channelId: 'web',
      peerId: 'ui',
      status: 'idle',
      createdAt: Date.now(),
      sessionStartedAt: Date.now(),
      lastInteractionAt: Date.now(),
      updatedAt: Date.now(),
    },
    messages: [],
    steps: [],
    metadata: {},
  });
  const gateway = new Gateway(
    {
      agents: [makeAgent('assistant')],
      knowledge: { service: { manageLocal: false } },
      ...(summarizeTimeoutMs === undefined
        ? {}
        : { contextEngine: { summarizeTimeoutMs } }),
    },
    store,
  );
  gateway.registerProvider(makeProvider());
  return gateway;
}

describe('compact op 传输层预算（恒不设限）', () => {
  const gateways: Gateway[] = [];
  afterEach(async () => {
    for (const g of gateways) await g.stop();
    gateways.length = 0;
  });

  it('默认配置：control 收到显式 null（不设传输限）', async () => {
    const calls: ControlCall[] = [];
    const gateway = await makeGateway();
    gateways.push(gateway);
    (gateway as unknown as { fleet: unknown }).fleet = stubFleet(calls);

    await gateway.compactSession('s-compact');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.op.type).toBe('compact');
    // 必须是显式 null（undefined 会被 transport 兜回 30s——MAJ-2 症状）
    expect(calls[0]!.options?.timeoutMs).toBeNull();
  });

  it('任务预算变化（300s/120s/0）都不改变传输层恒 null——锁等待无上界', async () => {
    for (const budget of [300_000, 120_000, 0]) {
      const calls: ControlCall[] = [];
      const gateway = await makeGateway(budget);
      gateways.push(gateway);
      (gateway as unknown as { fleet: unknown }).fleet = stubFleet(calls);

      await gateway.compactSession('s-compact');

      expect(calls[0]!.options?.timeoutMs).toBeNull();
    }
  });
});

describe('RemoteRunBackend.control 传输预算三态（MAJ-2）', () => {
  const g = globalThis as { fetch: unknown };
  const originalFetch = g.fetch;

  afterEach(() => {
    g.fetch = originalFetch;
  });

  function stubFetchCapture(): Array<{ init?: RequestInit | undefined }> {
    const captured: Array<{ init?: RequestInit | undefined }> = [];
    g.fetch = async (_url: unknown, init?: RequestInit) => {
      captured.push({ init });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    };
    return captured;
  }

  async function makeBackend(): Promise<{
    control: (op: unknown, options?: { timeoutMs?: number | null }) => Promise<unknown>;
  }> {
    // transport 三态逻辑在 prototype 上（fetchJson/control）——最小对象借用测语义，
    // 不起真 child。
    const { RemoteRunBackend } = await import(
      '@octopi-agent/gateway/gateway/remote-run-backend.js'
    );
    const proto = RemoteRunBackend.prototype as unknown as {
      control: (op: unknown, options?: { timeoutMs?: number | null }) => Promise<unknown>;
      fetchJson: (m: string, p: string, b?: unknown, t?: number | null) => Promise<Response>;
    };
    // control 内部经 this.fetchJson 发请求——借用对象两个方法都须挂上
    return { control: proto.control, fetchJson: proto.fetchJson } as never;
  }

  it('options 缺省 → 30s signal；显式 null → 无 signal（不设限）；number → 该预算', async () => {
    const captured = stubFetchCapture();
    const backend = await makeBackend();

    await backend.control({ type: 'abort', sessionId: 's' });
    await backend.control({ type: 'compact', sessionId: 's' }, { timeoutMs: null });
    await backend.control({ type: 'compact', sessionId: 's' }, { timeoutMs: 12_345 });

    expect(captured).toHaveLength(3);
    // 缺省 = 30s（有 signal）
    expect(captured[0]!.init?.signal).toBeDefined();
    // 显式 null = 不设限（无 signal）——MAJ-2 核心断言
    expect(captured[1]!.init?.signal).toBeUndefined();
    // 显式 number = 该预算（有 signal）
    expect(captured[2]!.init?.signal).toBeDefined();
  });
});
