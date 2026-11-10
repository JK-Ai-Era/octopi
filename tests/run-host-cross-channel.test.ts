/**
 * RunHost 跨通道配对与可见性快照语义（P0b 修复面回归锚）：
 * - ask_user 配对：askQuestion → askUserReply（ok:false 拒接 → 工具 fail-loud）
 * - 客户端工具：setClientTools 注册表 + mount 重放 + 快照过期 fail-safe（M2-5）
 */
import { describe, it, expect, vi } from 'vitest';
import { RunHost } from '@octopi-agent/engine/harness/run/run-host.js';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';

function makeHost(overrides: Record<string, unknown> = {}): RunHost {
  return new RunHost({ redispatch: () => undefined, ...overrides } as never);
}

function runReq(): never {
  return {
    requestId: 'r1',
    triggers: [{ id: 't1', type: 'message', agentId: 'a1', sessionId: 's1', timestamp: 1 }],
    agentId: 'a1',
    sessionId: 's1',
    messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
  } as never;
}

function fakeRunner(handleImpl: () => AsyncGenerator<unknown>) {
  return {
    handle: vi.fn(handleImpl),
    dispose: vi.fn(),
    recordAdmissionRefusal: vi.fn(),
  };
}

describe('ask_user 跨通道配对（fail-loud）', () => {
  it('ok:false 拒接 → askQuestion 拒绝（工具调用面 fail-loud）', async () => {
    const notifies: Array<Record<string, unknown>> = [];
    const host = makeHost({
      notify: (n: Record<string, unknown>) => {
        notifies.push(n);
      },
    });
    const pending = host.askQuestion({ sessionId: 's1', agentId: 'a1', question: 'q?' });
    const ask = notifies.find((n) => n.type === 'ask_user_request') as {
      askId: string;
    };
    expect(ask).toBeDefined();
    await host.handleControl({
      type: 'askUserReply',
      askId: ask.askId,
      outcome: { ok: false, error: { message: 'ui gone' } },
    } as never);
    await expect(pending).rejects.toThrow(/ui gone/);
  });

  it('ok:true 作答 → resolve；未知 askId → ok:false（不静默吞）', async () => {
    const notifies: Array<Record<string, unknown>> = [];
    const host = makeHost({
      notify: (n: Record<string, unknown>) => {
        notifies.push(n);
      },
    });
    const pending = host.askQuestion({ sessionId: 's1', agentId: 'a1', question: 'q?' });
    const ask = notifies.find((n) => n.type === 'ask_user_request') as {
      askId: string;
    };
    const res = await host.handleControl({
      type: 'askUserReply',
      askId: ask.askId,
      outcome: { ok: true, answer: 'A' },
    } as never);
    expect(res).toEqual({ ok: true });
    await expect(pending).resolves.toBe('A');
    const unknown = await host.handleControl({
      type: 'askUserReply',
      askId: 'nope',
      outcome: { ok: true, answer: 'x' },
    } as never);
    expect(unknown.ok).toBe(false);
  });
});

describe('客户端工具快照语义（注册表 + mount 重放 + 过期 fail-safe）', () => {
  const clientTool = (name: string) =>
    ({
      definition: { name, description: 'd', parameters: { type: 'object' as const } },
    }) as never;

  it('setClientTools 登记注册表，晚到 mount 重放（B3）', () => {
    const host = makeHost();
    void host.handleControl({
      type: 'setClientTools',
      ops: [{ op: 'add', tool: clientTool('html_ui') }],
      visibility: { installed: ['html_ui'], live: [], expiresAt: Date.now() + 60_000 },
    } as never);
    const added: string[] = [];
    const agent = {
      tools: [],
      setToolVisibilityFilter: vi.fn(),
      setTools: vi.fn((tools: Array<{ name: string }>) => {
        added.push(...tools.map((t) => t.name));
      }),
    };
    host.mount({
      agentId: 'a1',
      agent,
      runner: fakeRunner(async function* () {}) as never,
      registerTools: () => undefined,
      runConfigDefaults: {},
    } as never);
    // B3：注册表现况重放进新挂载 agent
    expect(added).toContain('html_ui');
    expect(agent.setToolVisibilityFilter).toHaveBeenCalled();
  });

  it('快照过期 → 已安装客户端工具 fail-safe 隐藏；未过期按 live 对（M2-5）', () => {
    const host = makeHost();
    void host.handleControl({
      type: 'setClientTools',
      ops: [{ op: 'add', tool: clientTool('html_ui') }],
      visibility: {
        installed: ['html_ui'],
        live: [{ sessionId: 's1', toolName: 'html_ui' }],
        expiresAt: Date.now() + 60_000,
      },
    } as never);
    const fresh = host.buildVisibilityPredicate();
    expect(fresh('s1', 'html_ui')).toBe(true);
    expect(fresh('s1', 'shell')).toBe(true); // 非安装名单恒可见
    void host.handleControl({
      type: 'setClientTools',
      ops: [],
      visibility: {
        installed: ['html_ui'],
        live: [{ sessionId: 's1', toolName: 'html_ui' }],
        expiresAt: Date.now() - 1,
      },
    } as never);
    const stale = host.buildVisibilityPredicate();
    expect(stale('s1', 'html_ui')).toBe(false); // 过期 = liveness 未知 → 宁缺勿滥
    expect(stale('s1', 'shell')).toBe(true);
  });
});
