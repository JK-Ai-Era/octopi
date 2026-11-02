/**
 * knowledge.required 准入闸门（v0.98.12）— required=true 且知识运行时未达 ready
 * 时拒新 run（run 起点复核，与安全配置漂移守卫同位）。
 *
 * 防回归背景：`knowledge.required` 自声明以来无消费方（docs 曾承诺 fail-closed
 * 但从未实现）；v0.98.12 落地为 admission 语义。本文件锁两层：
 * 1. 判定纯函数（knowledgeRequiredAdmissionError）；
 * 2. 接线（wrapInflightTracking.execute 咽喉真的调用判定、被拒 run 不到 inner）。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  Gateway,
  knowledgeRequiredAdmissionError,
} from '@octopi-agent/gateway/gateway/gateway.js';
import type { GatewayConfig } from '@octopi-agent/gateway/types/gateway-config.js';

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

describe('dispatcher 咽喉接线（wrapInflightTracking.execute）', () => {
  function gatewayWithKnowledge(state: 'ready' | 'degraded'): Gateway {
    const gw = new Gateway({ agents: [], knowledge: { required: true } } as unknown as GatewayConfig);
    // getKnowledgeState() 的真实来源：runtime ref 优先，其次 bootState
    (gw as never as { knowledgeRuntimeRef?: unknown }).knowledgeRuntimeRef = { state };
    return gw;
  }

  function fakeInner() {
    const execute = vi.fn(() =>
      (async function* () {
        yield 'run-event';
      })(),
    );
    return { inbox: undefined, execute } as never;
  }

  it('知识未 ready：run 在咽喉被拒（错误带前缀，inner 不被触达）+ 三件套记账', async () => {
    const gw = gatewayWithKnowledge('degraded');
    const inner = fakeInner();
    const recordAdmissionRefusal = vi.fn();
    const wrapped = (
      gw as never as {
        wrapInflightTracking(r: unknown, i: unknown): { execute(req: unknown): AsyncIterable<unknown> };
      }
    ).wrapInflightTracking({ recordAdmissionRefusal } as never, inner);

    const iter = wrapped.execute({ agentId: 'a1', sessionId: 's1' } as never);
    await expect(
      (async () => {
        for await (const _ of iter) void _;
      })(),
    ).rejects.toThrow(/^knowledge_required:/);
    expect((inner as never as { execute: ReturnType<typeof vi.fn> }).execute).not.toHaveBeenCalled();
    // 三件套对齐（ops P2）：与 security_config_drift / kill_switch_active 同待遇
    expect(recordAdmissionRefusal).toHaveBeenCalledTimes(1);
    expect(recordAdmissionRefusal).toHaveBeenCalledWith(
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

  it('知识 ready：run 正常透达 inner（不记账）', async () => {
    const gw = gatewayWithKnowledge('ready');
    const inner = fakeInner();
    const recordAdmissionRefusal = vi.fn();
    const wrapped = (
      gw as never as {
        wrapInflightTracking(r: unknown, i: unknown): { execute(req: unknown): AsyncIterable<unknown> };
      }
    ).wrapInflightTracking({ recordAdmissionRefusal } as never, inner);

    const events: unknown[] = [];
    for await (const ev of wrapped.execute({} as never)) events.push(ev);
    expect(events).toEqual(['run-event']);
    expect((inner as never as { execute: ReturnType<typeof vi.fn> }).execute).toHaveBeenCalledTimes(1);
    expect(recordAdmissionRefusal).not.toHaveBeenCalled();
  });
});
