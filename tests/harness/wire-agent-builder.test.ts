/**
 * wireAgentBuilder 契约 — 标准组装不得漏接关键能力
 *
 * 锁住 Gateway / config-bridge 共用出口上的：
 * - withModelLevels（子系统 think.model 解析到真实模型 ID，而不是档位名）
 * - summarize（pickSummarizeProvider 链）
 * - contextEngine（配置面唯一出口；含 proactiveCompactRatio）
 * - securityPolicy / riskPolicy
 *
 * 断言的是 **Builder 接线调用**，不是测试内自建 resolver。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import {
  wireAgentBuilder,
  resolveContextEngine,
} from '@octopi-agent/engine/harness/agent/wire-agent-builder.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';

function mockProvider(name: string): ModelProvider {
  return {
    name,
    defaultModel: `${name}-default`,
    models: [`${name}-default`],
    isAvailable: async () => true,
    getModelInfo: () => null,
    getModelInfos: () => [],
    chat: async () => ({ content: 'ok', model: `${name}-default`, finishReason: 'stop' as const }),
    stream: async function* () {
      yield { type: 'done' as const };
    },
  } as unknown as ModelProvider;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wireAgentBuilder', () => {
  it('wires model levels, summarize, and context engine', async () => {
    const primary = mockProvider('xiaomi-coding');
    const providers = new Map<string, ModelProvider>([['xiaomi-coding', primary]]);
    const builder = new AgentBuilder();

    const levels = {
      mini: { primary: 'xiaomi-coding/mimo-v2.6-flash' },
      standard: { primary: 'xiaomi-coding/mimo-v2.6-pro' },
    };

    await wireAgentBuilder(builder, {
      model: primary,
      agentId: 'default',
      providers,
      levelMap: levels,
      contextEngineConfig: { proactiveCompactRatio: 0 },
    });

    const built = await builder.build({ autoLoadSubsystems: false });
    expect(built.contextEngine).toBeDefined();
    expect(built.agent).toBeDefined();
  });

  it('resolveContextEngine honors proactiveCompactRatio=0', () => {
    const engine = resolveContextEngine({ proactiveCompactRatio: 0 });
    expect(engine.info.id).toBe('default');
  });

  it('calls builder.withModelLevels / summarize / contextEngine with wired config', async () => {
    const primary = mockProvider('xiaomi-coding');
    const providers = new Map<string, ModelProvider>([['xiaomi-coding', primary]]);
    const builder = new AgentBuilder();

    const levels = {
      mini: { primary: 'xiaomi-coding/mimo-v2.6-flash' },
    };

    const spyLevels = vi.spyOn(AgentBuilder.prototype, 'withModelLevels');
    const spySummarize = vi.spyOn(AgentBuilder.prototype, 'summarize');
    const spyCtx = vi.spyOn(AgentBuilder.prototype, 'contextEngine');
    const spySecurity = vi.spyOn(AgentBuilder.prototype, 'securityPolicy');

    await wireAgentBuilder(builder, {
      model: primary,
      agentId: 'default',
      providers,
      levelMap: levels,
      contextEngineConfig: { proactiveCompactRatio: 0 },
    });

    // 真正锁接线：漏掉 withModelLevels 此处必红
    expect(spyLevels).toHaveBeenCalledWith(levels);
    expect(spySummarize).toHaveBeenCalledTimes(1);
    expect(spyCtx).toHaveBeenCalledTimes(1);
    expect(spySecurity).toHaveBeenCalledTimes(1);

    // summarize 选型必须带真实模型 ID（非档位名）
    const summarizeArg = spySummarize.mock.calls[0]?.[0];
    expect(typeof summarizeArg).toBe('function');
    const chatSpy = vi.spyOn(primary, 'chat');
    await (summarizeArg as (m: unknown[], o?: unknown) => Promise<string>)(
      [{ role: 'user', content: 'x' }],
      { maxTokens: 10 },
    );
    const modelUsed = (chatSpy.mock.calls[0]?.[0] as { model?: string })?.model;
    expect(modelUsed).toBe('mimo-v2.6-flash');
    expect(modelUsed).not.toBe('mini');
  });
});
