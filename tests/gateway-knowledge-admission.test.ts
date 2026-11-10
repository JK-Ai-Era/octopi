/**
 * knowledge.required 准入闸门（v0.98.12）— required=true 且知识运行时未达 ready
 * 时拒新 run（run 起点复核，与安全配置漂移守卫同位）。
 *
 * 防回归背景：`knowledge.required` 自声明以来无消费方（docs 曾承诺 fail-closed
 * 但从未实现）；v0.98.12 落地为 admission 语义。本文件锁两层：
 * 1. 判定纯函数（knowledgeRequiredAdmissionError）；
 * 2. 接线（InProcessRunBackend 执行腿咽喉真的调用判定、被拒 run 不到 Runner）。
 *    P0a：咽喉随 wrapInflightTracking 搬入 RunBackend 脚手架，本测试随迁——
 *    并改经 gateway 自己的 runBackend 驱动（覆盖生产端闸门闭包，胜于抓私有方法）。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  Gateway,
  knowledgeRequiredAdmissionError,
} from '@octopi-agent/gateway/gateway/gateway.js';
import type { GatewayConfig } from '@octopi-agent/gateway/types/gateway-config.js';
import type { InProcessRunBackend } from '@octopi-agent/gateway/gateway/run-backend.js';

describe('knowledgeRequiredAdmissionError', () => {
  it('required=true + ready → admits (undefined)', () => {
    expect(knowledgeRequiredAdmissionError(true, 'ready')).toBeUndefined();
  });

  it('required=true + 非 ready 状态 → 拒绝（稳定前缀 knowledge_required:）', () => {
    for (const state of ['degraded', 'disabled', 'starting'] as const) {
      const err = knowledgeRequiredAdmissionError(true, state);
      expect(err, state).toMatch(/^knowledge_required:/);
      expect(err, state).toContain(state);
    }
  });

  it('required 非 true（缺省/false）→ 一切照旧（fail-open）', () => {
    expect(knowledgeRequiredAdmissionError(undefined, 'disabled')).toBeUndefined();
    expect(knowledgeRequiredAdmissionError(false, 'degraded')).toBeUndefined();
  });
});

describe('dispatcher 咽喉接线（InProcessRunBackend 执行腿）', () => {
  function gatewayWithKnowledge(state: 'ready' | 'degraded'): {
    backend: InProcessRunBackend;
    runner: {
      handle: ReturnType<typeof vi.fn>;
      recordAdmissionRefusal: ReturnType<typeof vi.fn>;
    };
  } {
    const gw = new Gateway(
      { agents: [], knowledge: { required: true } } as unknown as GatewayConfig,
      // 显式假 store：不走 createDefaultStore——那会触碰真实 OCTOPI_HOME/sessions，
      // 且其动态 import 尾巴会拖过测试环境拆除（unhandled rejection）
      { load: async () => undefined, save: async () => undefined } as never,
    );
    // getKnowledgeState() 的真实来源：runtime ref 优先，其次 bootState
    (gw as never as { knowledgeRuntimeRef?: unknown }).knowledgeRuntimeRef = { state };
    const runner = {
      handle: vi.fn(() =>
        (async function* () {
          yield 'run-event';
        })(),
      ),
      recordAdmissionRefusal: vi.fn(),
    };
    // gateway 私有 runBackend（P0a 契约缝实例）：闸门闭包是生产 wiring，不另造
    const backend = (gw as never as { runBackend: InProcessRunBackend }).runBackend;
    backend.mount({
      agentId: 'a1',
      agent: {} as never,
      runner: runner as never,
      registerTools: () => undefined,
      runConfigDefaults: {},
    });
    return { backend, runner };
  }

  const runReq = {
    requestId: 'r1',
    agentId: 'a1',
    sessionId: 's1',
    triggers: [
      { id: 't1', type: 'message', payload: { kind: 'user_message', content: 'hi' }, timestamp: 1 },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  } as never;

  it('知识未 ready：run 在咽喉被拒（错误带前缀，Runner 不被触达）+ 三件套记账', async () => {
    const { backend, runner } = gatewayWithKnowledge('degraded');
    const iter = backend.execute(runReq);
    await expect(
      (async () => {
        for await (const _ of iter) void _;
      })(),
    ).rejects.toThrow(/^knowledge_required:/);
    expect(runner.handle).not.toHaveBeenCalled();
    // 三件套对齐（ops P2）：与 security_config_drift / kill_switch_active 同待遇
    expect(runner.recordAdmissionRefusal).toHaveBeenCalledTimes(1);
    expect(runner.recordAdmissionRefusal).toHaveBeenCalledWith(
      'ops.knowledge.run_refused',
      expect.objectContaining({
        state: 'degraded',
        action: 'refuse_new_run',
        reason: expect.stringMatching(/^knowledge_required:/),
        origin: { agentId: 'a1', sessionId: 's1' },
      }),
      { agentId: 'a1', sessionId: 's1' },
    );
  });

  it('知识 ready：run 正常透达 Runner（不记账）', async () => {
    const { backend, runner } = gatewayWithKnowledge('ready');
    const events: unknown[] = [];
    for await (const ev of backend.execute(runReq)) events.push(ev);
    expect(events).toEqual(['run-event']);
    expect(runner.handle).toHaveBeenCalledTimes(1);
    expect(runner.recordAdmissionRefusal).not.toHaveBeenCalled();
  });
});
