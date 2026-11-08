/**
 * P3 红线 7（arch/overflow-redesign.md §2.3 + §6）：
 *
 * 「A 类不吞：前馈溢出触发时告警含『proactive 失效』语义（症状可见，不当日常）」
 *
 * - T1 前馈溢出（视图超已知窗口触发收敛阶梯）→ 必须发 context.overflow.alert，
 *   symptom='proactive_failed' 且 message 含「proactive 失效」语义
 * - 保护段超限（infeasible）→ symptom='config_missing'（配置病语义）
 * - T2 F 类回填/收缩（配置漂移/缺失）→ symptom='config_drift'/'config_missing'
 * - 告警走 emit/onAlert 通道（Hub/EventBus 可见），不是吞进日志
 *
 * 测试纪律（沿用）：状态级直接校验，不硬造真溢出；工具活动成对构造。
 */

import { describe, it, expect } from 'vitest';
import type { Message } from '@octopi-agent/core/types.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import { InMemoryTransformStore } from '@octopi-agent/engine/harness/session/transform-store.js';
import type {
  ContextCompactEvent,
  OverflowAlertEvent,
} from '@octopi-agent/engine/harness/context/types.js';
import { classifyError } from '@octopi-agent/core/loop/error-classifier.js';
import { applyContextLengthFeedback } from '@octopi-agent/engine/harness/run/reliability/context-length-feedback.js';
import {
  withResolvedModel,
  resetWindowTruth,
  type ResolvedModel,
} from '@octopi-agent/engine/harness/run/model/index.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: Date.now() };
}

/** 溢出形态：user 起头 + 孤立工具结果（overflow 走 selector，不受 tail 对齐影响） */
function overflowHistory(rounds: number, resultChars: number): Message[] {
  const out: Message[] = [userMsg('GO ' + 'h'.repeat(200))];
  for (let i = 0; i < rounds; i++) {
    out.push({
      role: 'tool',
      content: '',
      toolResults: [{ toolCallId: `call_${i}`, name: 'read_file', result: 'R'.repeat(resultChars) }],
      timestamp: Date.now(),
    });
  }
  return out;
}

function fakeProvider(): ModelProvider {
  return {
    name: 'mock',
    defaultModel: 'm',
    getModelInfo: () => null,
    getModelInfos: () => [],
    isAvailable: async () => true,
    chat: async () => {
      throw new Error('not_implemented: test stub');
    },
    stream: async function* () {
      throw new Error('not_implemented: test stub');
    },
  } as unknown as ModelProvider;
}

async function assembleOverflow(opts: {
  budgetTokens: number;
  contextWindow?: number;
}): Promise<{ alerts: OverflowAlertEvent[]; events: ContextCompactEvent[] }> {
  const alerts: OverflowAlertEvent[] = [];
  const events: ContextCompactEvent[] = [];
  const store = new InMemoryTransformStore();
  const engine = new DefaultContextEngine({
    transformStore: store,
    // 关 aging（第 0 轮不介入，聚焦阶梯触发）+ proactive 禁用（测守门，不测摘要）
    historyAging: undefined,
  });
  const messages = overflowHistory(40, 2000); // 40×2000 chars = 80k chars ≈ 20k tokens
  await engine.assemble({
    sessionId: 's-alert',
    agentId: 'a',
    modelKey: 'mock/m',
    messages,
    systemPrompt: 'sys',
    tools: [],
    // 显式 target 窗口：预算小到视图必然超限 → 触发收敛阶梯
    contextWindow: opts.contextWindow,
    compactTargetTokens: opts.budgetTokens,
    emit: (e) => {
      if (e.type === 'context.overflow.alert') alerts.push(e);
      else events.push(e);
    },
  });
  return { alerts, events };
}

describe('红线 7：A 类不吞——前馈溢出必须打 proactive 失效告警', () => {
  it('T1 前馈溢出 → context.overflow.alert，symptom=proactive_failed 且含「proactive 失效」语义', async () => {
    const { alerts } = await assembleOverflow({ budgetTokens: 5000, contextWindow: 5000 });
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    const a = alerts[0];
    expect(a.type).toBe('context.overflow.alert');
    expect(a.symptom).toBe('proactive_failed');
    expect(a.message).toContain('proactive 失效');
    expect(a.trigger).toBe('T1');
  });

  it('症状可见：告警经 emit 通道发出（不是吞进日志）', async () => {
    const { alerts, events } = await assembleOverflow({ budgetTokens: 5000, contextWindow: 5000 });
    // emit 通道拿到告警；compact 事件照常配对（告警不替代压缩事件）
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === 'context.compact.start')).toBe(true);
  });

  it('每次触发都打告警（不当日常 = 不去重不吞）', async () => {
    // 连续两次装配都溢出 → 两次都发告警
    const { alerts: a1 } = await assembleOverflow({ budgetTokens: 5000, contextWindow: 5000 });
    const { alerts: a2 } = await assembleOverflow({ budgetTokens: 5000, contextWindow: 5000 });
    expect(a1.length).toBeGreaterThanOrEqual(1);
    expect(a2.length).toBeGreaterThanOrEqual(1);
  });

  it('保护段超限（infeasible）→ symptom=structural_over_budget、trigger=T3', async () => {
    // 窗口极小（500）连 system+tools+输出预留都放不下 → infeasible
    const { alerts } = await assembleOverflow({ budgetTokens: 500, contextWindow: 500 });
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].symptom).toBe('structural_over_budget');
    expect(alerts[0].trigger).toBe('T3');
    expect(alerts[0].message).toContain('配置');
  });

  it('B1 回归：infeasible + 小视图（早退路径）也必须发 T3 告警', async () => {
    // 视图装得下 1000 地板 → 走早退不进阶梯；但 infeasible 是配置病，告警不得漏发
    const alerts: OverflowAlertEvent[] = [];
    const store = new InMemoryTransformStore();
    const engine = new DefaultContextEngine({ transformStore: store });
    await engine.assemble({
      sessionId: 's-early',
      agentId: 'a',
      modelKey: 'mock/m',
      messages: [userMsg('hello')],
      systemPrompt: 'sys',
      tools: [],
      contextWindow: 500,
      compactTargetTokens: 500,
      emit: (e) => {
        if (e.type === 'context.overflow.alert') alerts.push(e);
      },
    });
    expect(alerts.length).toBe(1);
    expect(alerts[0].symptom).toBe('structural_over_budget');
    expect(alerts[0].trigger).toBe('T3');
  });
});

// ── T2：F 类反馈环的配置漂移/缺失告警 ──

function fakeSnapshot(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    ref: 'testprov/testmodel',
    providerName: 'testprov',
    modelName: 'testmodel',
    provider: fakeProvider(),
    contextWindow: 200_000,
    source: 'config',
    known: true,
    isOverride: false,
    ...overrides,
  };
}

async function inRunScope<T>(snapshot: ResolvedModel, fn: () => T): Promise<T> {
  let result!: T;
  const gen = (async function* () {
    result = fn();
  })();
  for await (const _ of withResolvedModel(snapshot, gen)) {
    // drain
  }
  return result;
}

function providerError(status: number, message: string): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

describe('红线 7 族：T2 配置漂移/缺失告警', () => {
  it('真值回填且配置不一致 → symptom=config_drift 经 onAlert 发出', async () => {
    resetWindowTruth();
    const alerts: Array<{ symptom: string; message: string; trigger?: string }> = [];
    const err = classifyError(
      providerError(400, "This model's maximum context length is 128000 tokens."),
    );
    await inRunScope(fakeSnapshot({ contextWindow: 200_000 }), () =>
      applyContextLengthFeedback(err, {
        sessionId: 's1',
        onAlert: (a) => alerts.push(a),
      }),
    );
    expect(alerts.length).toBe(1);
    expect(alerts[0].symptom).toBe('config_drift');
    expect(alerts[0].trigger).toBe('T2');
    expect(alerts[0].message).toContain('配置漂移');
  });

  it('配置缺失 + 真值回填 → symptom=config_missing', async () => {
    resetWindowTruth();
    const alerts: Array<{ symptom: string }> = [];
    const err = classifyError(
      providerError(400, "This model's maximum context length is 128000 tokens."),
    );
    await inRunScope(fakeSnapshot({ contextWindow: undefined, known: false }), () =>
      applyContextLengthFeedback(err, {
        sessionId: 's2',
        onAlert: (a) => alerts.push(a),
      }),
    );
    expect(alerts.length).toBe(1);
    expect(alerts[0].symptom).toBe('config_missing');
  });

  it('收缩上界路径也发告警（配置病同样可见）', async () => {
    resetWindowTruth();
    const alerts: Array<{ symptom: string }> = [];
    const err = classifyError(providerError(400, 'context length exceeded'));
    await inRunScope(fakeSnapshot({ contextWindow: 200_000 }), () =>
      applyContextLengthFeedback(err, {
        sessionId: 's3',
        lastSuccessActual: 150_000,
        onAlert: (a) => alerts.push(a),
      }),
    );
    expect(alerts.length).toBe(1);
    // 无实证不造病名：收缩是保守兜底，语义为「归因未定」（配置或尺子偏差待查）
    expect(alerts[0].symptom).toBe('window_mismatch');
    // 收缩是保守猜测：不写真值表（防持久化削窗）——P2 语义保持
    const { getWindowTruth } = await import('@octopi-agent/engine/harness/run/model/window-truth.js');
    expect(getWindowTruth('testprov/testmodel')).toBeUndefined();
  });

  it('配置与真值一致 → 不告警（无病不造警）', async () => {
    resetWindowTruth();
    const alerts: Array<{ symptom: string }> = [];
    const err = classifyError(
      providerError(400, "This model's maximum context length is 200000 tokens."),
    );
    await inRunScope(fakeSnapshot({ contextWindow: 200_000 }), () =>
      applyContextLengthFeedback(err, {
        sessionId: 's4',
        onAlert: (a) => alerts.push(a),
      }),
    );
    expect(alerts.length).toBe(0);
  });
});

// ── 守卫：未构造溢出时不发告警（不当日常的反向） ──

describe('反向：正常装配不发告警', () => {
  it('视图装得下 → 零 overflow 告警', async () => {
    const alerts: OverflowAlertEvent[] = [];
    const events: ContextCompactEvent[] = [];
    const store = new InMemoryTransformStore();
    const engine = new DefaultContextEngine({ transformStore: store });
    const messages = [userMsg('hello')];
    await engine.assemble({
      sessionId: 's-quiet',
      agentId: 'a',
      modelKey: 'mock/m',
      messages,
      systemPrompt: 'sys',
      tools: [],
      compactTargetTokens: 100000,
        emit: (e) => {
        if (e.type === 'context.overflow.alert') alerts.push(e);
        else events.push(e);
      },
    });
    expect(alerts.length).toBe(0);
    // 静默路径不产生假 compacted（既有语义不破）
    expect(events.filter((e) => e.type === 'context.compact.end').length).toBeLessThanOrEqual(1);
  });
});
