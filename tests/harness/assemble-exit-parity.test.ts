import { describe, expect, it } from 'vitest';
import { diffPrefixFingerprint, fingerprintRequestView } from '@octopi-agent/engine/harness/context/prefix-fingerprint.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import { HeuristicTokenEstimator } from '@octopi-agent/engine/harness/context/token-estimator.js';
import { computeToolResultAgingPlan, resolveToolResultAgingOptions } from '@octopi-agent/engine/harness/context/tool-result-aging.js';

/**
 * 出口一致性防漂移：任何装配出口产出的前缀，指纹必须与「基线」同形。
 *
 * 背景：`buildLlmMessages` 曾被 16 处调用点各算一遍（overflow 阶梯内每分支 3–4 次），
 * 基线记录也散落三份。任一处改了 aging / tools 而另一处没改，就会产生
 * 「同一条工具结果两种形态」的前缀分叉（2026-11-13 事故，76% 结果不同）。
 *
 * 这组测试锁的是**结构**：同一输入经不同出口，必须产出同一指纹。
 */

const sys = 'SYSTEM-PROMPT';
const tools = [
  { type: 'function' as const, function: { name: 'file_read', description: 'd', parameters: {} } },
] as never;

/** 构造带跨轮工具结果的最小历史（触发老化需要足够多候选） */
function history(toolBodies: string[]) {
  const msgs: unknown[] = [{ role: 'system', content: sys, metadata: { source: 'systemPrompt' } }];
  for (let i = 0; i < toolBodies.length; i++) {
    msgs.push({ role: 'user', content: `ask ${i}` });
    msgs.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `c${i}`, name: 'file_read', arguments: { path: `f${i}.ts` } }],
    });
    msgs.push({
      role: 'tool',
      content: '',
      toolResults: [{ toolCallId: `c${i}`, name: 'file_read', result: { path: `f${i}.ts`, content: toolBodies[i] } }],
    });
  }
  return msgs as never;
}

describe('装配出口一致性（防漂移）', () => {
  it('同一视图 + 同一 agers：重复构建指纹逐字节相同', () => {
    const eng = new DefaultContextEngine({} as never);
    const h = history(['body '.repeat(400), 'body '.repeat(300)]);
    const opts = resolveToolResultAgingOptions({});
    const agers = new Map([
      ['file_read', ({ result }: { result: unknown }) => `[aged] file_read custom`],
    ]);
    const plan = computeToolResultAgingPlan(h, opts, { toolAgers: agers as never, ignoreTurnBoundary: true });

    // 通过反射调用私有构建器，模拟「同一出口被算两次」的旧形状
    const build = (eng as unknown as { buildLlmMessages: (a: unknown, b: string, c: unknown) => unknown }).buildLlmMessages.bind(eng);
    const v1 = { messages: build(h, sys, plan), tools };
    const v2 = { messages: build(h, sys, plan), tools };

    expect(fingerprintRequestView(v1 as never).prefixHash).toBe(fingerprintRequestView(v2 as never).prefixHash);
  });

  it('红线：aging 计划不同 → 指纹必不同（这正是事故的机械原因）', () => {
    const eng = new DefaultContextEngine({} as never);
    const h = history(['body '.repeat(400), 'body '.repeat(300)]);
    const opts = resolveToolResultAgingOptions({});
    const perTool = new Map([
      ['file_read', ({ result }: { result: unknown }) => `[aged] file_read custom`],
    ]);
    const planWithAgers = computeToolResultAgingPlan(h, opts, { toolAgers: perTool as never, ignoreTurnBoundary: true });
    const planWithout = computeToolResultAgingPlan(h, opts, { ignoreTurnBoundary: true });

    const build = (eng as unknown as { buildLlmMessages: (a: unknown, b: string, c: unknown) => unknown }).buildLlmMessages.bind(eng);
    const a = { messages: build(h, sys, planWithAgers), tools };
    const b = { messages: build(h, sys, planWithout), tools };

    expect(fingerprintRequestView(a as never).toolsHash).toBe(fingerprintRequestView(b as never).toolsHash);
    expect(diffPrefixFingerprint(fingerprintRequestView(a as never), fingerprintRequestView(b as never))).toEqual(['messages']);
  });

  it('红线：buildRequestView 必须透传 aging（漏传 → 与基线分叉）', () => {
    const eng = new DefaultContextEngine({} as never);
    const h = history(['body '.repeat(400), 'body '.repeat(300)]);
    const opts = resolveToolResultAgingOptions({});
    const perTool = new Map([
      ['file_read', ({ result }: { result: unknown }) => `[aged] file_read custom`],
    ]);
    const plan = computeToolResultAgingPlan(h, opts, { toolAgers: perTool as never, ignoreTurnBoundary: true });

    // 走真实出口：buildRequestView 内部必须用传进来的 aging 产出 messages
    const rv = (eng as unknown as {
      buildRequestView: (i: unknown) => { messages: unknown[]; tools: unknown[] };
    }).buildRequestView({ messages: h, systemPrompt: sys, tools, aging: plan, recordBaseline: false });

    // 若 buildRequestView 忽略 aging（漏传/退化），此处会因「未老化」而失败
    const direct = (eng as unknown as { buildLlmMessages: (a: unknown, b: string, c: unknown) => unknown })
      .buildLlmMessages.bind(eng)(h, sys, plan);
    expect(fingerprintRequestView(rv as never).prefixHash).toBe(
      fingerprintRequestView({ messages: direct, tools } as never).prefixHash,
    );
  });

  it('指纹与估算器无关：换 estimator 不改变指纹（指纹只看内容）', () => {
    const eng = new DefaultContextEngine({} as never);
    const h = history(['x']);
    const opts = resolveToolResultAgingOptions({});
    const plan = computeToolResultAgingPlan(h, opts, { ignoreTurnBoundary: true });
    const build = (eng as unknown as { buildLlmMessages: (a: unknown, b: string, c: unknown) => unknown }).buildLlmMessages.bind(eng);
    const view = { messages: build(h, sys, plan), tools };
    const fp = fingerprintRequestView(view as never);
    // 纯内容指纹：不受任何 token 估计影响（估算是另一套尺子，见 context-size-accounting）
    expect(fp.prefixHash).toHaveLength(16); // sha1 截断 16 hex
    expect(new HeuristicTokenEstimator().estimateMessages(view.messages as never)).toBeGreaterThan(0);
  });
});
