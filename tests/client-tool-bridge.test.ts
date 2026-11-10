/**
 * m2 客户端工具桥载荷/中止锚（OP-P0B-1 ⑥ 残余）：
 * - run 侧：桥 handler 的 abortSignal → client_tool_cancel 通知 + 结算 cancelled（不挂 TTL）
 * - gateway 侧：client_tool_call 载荷还原（messages 真实透传、per-call AbortSignal、
 *   效应账本 fail-loud 桩而非 as never）；client_tool_cancel 撤销执行腿
 */
import { describe, it, expect, vi } from 'vitest';
import { RunHost } from '@octopi-agent/engine/harness/run/run-host.js';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { InMemorySessionStore } from '@octopi-agent/engine/integration/storage/memory.js';
import type { AgentDefinition } from '@octopi-agent/engine/harness/shared/types/agent-definition.js';

function makeHost(overrides: Record<string, unknown> = {}): RunHost {
  return new RunHost({ redispatch: () => undefined, ...overrides } as never);
}

function fakeRunner() {
  return {
    handle: vi.fn(async function* () {}),
    dispose: vi.fn(),
    recordAdmissionRefusal: vi.fn(),
  };
}

const wireTool = (name: string) =>
  ({
    definition: { name, description: 'd', parameters: { type: 'object' as const } },
  }) as never;

describe('run 侧桥配对（m2）', () => {
  it('abort → client_tool_cancel（同 callId）+ 结算 cancelled，不悬挂', async () => {
    const notifies: Array<Record<string, unknown>> = [];
    const host = makeHost({
      notify: (n: Record<string, unknown>) => {
        notifies.push(n);
      },
    });
    await host.handleControl({
      type: 'setClientTools',
      ops: [{ op: 'add', tool: wireTool('html_ui') }],
      visibility: { installed: ['html_ui'], live: [], expiresAt: Date.now() + 60_000 },
    } as never);

    let captured: {
      execute: (
        id: string,
        args: unknown,
        signal?: AbortSignal,
      ) => Promise<{ content: unknown; isError?: boolean }>;
    } | undefined;
    const agent = {
      tools: [],
      setToolVisibilityFilter: vi.fn(),
      setTools: vi.fn(
        (
          tools: Array<{
            name: string;
            execute: (
              id: string,
              args: unknown,
              signal?: AbortSignal,
            ) => Promise<{ content: unknown; isError?: boolean }>;
          }>,
        ) => {
          captured = tools.find((t) => t.name === 'html_ui');
        },
      ),
    };
    host.mount({
      agentId: 'a1',
      agent,
      runner: fakeRunner() as never,
      registerTools: () => undefined,
      runConfigDefaults: {},
    } as never);
    expect(captured).toBeDefined();

    const ac = new AbortController();
    const pending = captured!.execute('tc1', {}, ac.signal);
    // 适配器 execute 含动态 import，notify 异步到达——等配对请求出现
    await vi.waitFor(() => {
      expect(notifies.some((n) => n.type === 'client_tool_call')).toBe(true);
    });
    const call = notifies.find((n) => n.type === 'client_tool_call') as {
      callId: string;
      messages: unknown[];
    };
    // 载荷忠实随行：messages 来自 handler context（空 scope = 空数组，非伪数据）
    expect(call).toBeDefined();
    expect(Array.isArray(call.messages)).toBe(true);

    // run 中止 → 桥撤销通知 + 立即结算（不等 clientToolResult）
    ac.abort();
    const cancel = notifies.find((n) => n.type === 'client_tool_cancel') as { callId: string };
    expect(cancel?.callId).toBe(call.callId);
    const result = await pending;
    expect(result.content).toMatchObject({ error: 'cancelled' });
    // 幂等：重复 abort 不再补发通知
    ac.abort();
    expect(notifies.filter((n) => n.type === 'client_tool_cancel')).toHaveLength(1);
  });
});

describe('gateway 侧桥载荷还原（m2）', () => {
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

  it('messages 真实透传 + per-call AbortSignal；cancel 撤销；效应账本 fail-loud', async () => {
    const gateway = new Gateway(
      { agents: [makeAgent('assistant')], knowledge: { service: { manageLocal: false } } },
      new InMemorySessionStore(),
    );
    const controls: Array<Record<string, unknown>> = [];
    (gateway as unknown as { runBackend: unknown }).runBackend = {
      control: async (op: Record<string, unknown>) => {
        controls.push(op);
        return { ok: true };
      },
      stop: async () => undefined,
    };

    const seen: Array<{
      messages: unknown;
      abortSignal: AbortSignal;
      fileEffects: { writeFile: () => Promise<never> };
    }> = [];
    let release: ((v: unknown) => void) | undefined;
    (gateway as unknown as { tools: unknown[] }).tools.push({
      definition: { name: 'html_ui', description: 'd', parameters: { type: 'object' } },
      handler: (_args: Record<string, unknown>, ctx: (typeof seen)[number]) => {
        seen.push(ctx);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });

    const gw = gateway as unknown as {
      handleRunHostNotify(n: unknown): Promise<void>;
    };
    const messages = [{ role: 'user', content: 'hi', timestamp: 1 }];
    void gw.handleRunHostNotify({
      type: 'client_tool_call',
      callId: 'c1',
      sessionId: 's1',
      agentId: 'assistant',
      toolName: 'html_ui',
      args: {},
      messages,
    });
    await Promise.resolve();

    // 载荷还原：不再是 messages: [] / abortSignal: undefined / as never
    expect(seen).toHaveLength(1);
    expect(seen[0]!.messages).toBe(messages);
    expect(seen[0]!.abortSignal).toBeInstanceOf(AbortSignal);
    // 效应账本 = fail-loud 桩（not_implemented，同步 throw），不是静默空账本
    expect(() => seen[0]!.fileEffects.writeFile()).toThrow(/not_implemented/);

    // client_tool_cancel → per-call 中止信号生效
    await gw.handleRunHostNotify({ type: 'client_tool_cancel', callId: 'c1', reason: 'run aborted' });
    expect(seen[0]!.abortSignal.aborted).toBe(true);

    // handler 结算后结果经 control 'clientToolResult' 回执（桩已记录）
    release!({ ok: true });
    await vi.waitFor(() => {
      expect(controls.some((op) => op.type === 'clientToolResult' && op.callId === 'c1')).toBe(true);
    });
  });
});
