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
import { join } from 'node:path';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import {
  wireAgentBuilder,
  resolveContextEngine,
  resolveSubsystemAuditDir,
} from '@octopi-agent/engine/harness/agent/wire-agent-builder.js';
import { getOctopiHome } from '@octopi-agent/engine/paths.js';
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

  it('does not auto-wire summarize to summary/mini (session-model cache domain)', async () => {
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
    // 摘要走 AgentBuilder 缺省 session 模型；禁止 pickSummarizeProvider 自动切档
    expect(spySummarize).not.toHaveBeenCalled();
    expect(spyCtx).toHaveBeenCalledTimes(1);
    expect(spySecurity).toHaveBeenCalledTimes(1);
  });
});

// ── 子系统接线契约（audit 缺省 / allow-deny / agentId） ──
//
// 回归背景：`octopi serve` 路径曾整段丢弃 `subsystems` 配置，导致 AuditWriter
// 从未构造、audit 目录永远为空。锁住 wire 出口上的接线调用。

describe('wireAgentBuilder subsystem wiring', () => {
  it('defaults audit dir to <OCTOPI_HOME>/audit and passes allow/deny + agentId', async () => {
    const primary = mockProvider('p');
    const builder = new AgentBuilder();
    const spyAudit = vi.spyOn(AgentBuilder.prototype, 'withSubsystemAuditDir');
    const spyAllow = vi.spyOn(AgentBuilder.prototype, 'subsystemAllowlist');
    const spyDeny = vi.spyOn(AgentBuilder.prototype, 'subsystemDenylist');
    const spyAgentId = vi.spyOn(AgentBuilder.prototype, 'agentId');

    await wireAgentBuilder(builder, {
      model: primary,
      agentId: 'agent-x',
      providers: new Map(),
      subsystemAllowlist: ['memory.steward.*'],
      subsystemDenylist: ['safety-guard'],
    });

    expect(spyAudit).toHaveBeenCalledWith(join(getOctopiHome(), 'audit'));
    expect(spyAllow).toHaveBeenCalledWith('memory.steward.*');
    expect(spyDeny).toHaveBeenCalledWith('safety-guard');
    // agentId 无条件接线（审计分区 / 工具域对称），不以 home 存在为前提
    expect(spyAgentId).toHaveBeenCalledWith('agent-x');
  });

  it('subsystemAuditDir:false disables audit (no withSubsystemAuditDir call)', async () => {
    const primary = mockProvider('p');
    const builder = new AgentBuilder();
    const spyAudit = vi.spyOn(AgentBuilder.prototype, 'withSubsystemAuditDir');

    await wireAgentBuilder(builder, {
      model: primary,
      agentId: 'agent-x',
      providers: new Map(),
      subsystemAuditDir: false,
    });

    expect(spyAudit).not.toHaveBeenCalled();
  });

  it('explicit subsystemAuditDir overrides the default', async () => {
    const primary = mockProvider('p');
    const builder = new AgentBuilder();
    const spyAudit = vi.spyOn(AgentBuilder.prototype, 'withSubsystemAuditDir');

    await wireAgentBuilder(builder, {
      model: primary,
      agentId: 'agent-x',
      providers: new Map(),
      subsystemAuditDir: '/custom/audit',
    });

    expect(spyAudit).toHaveBeenCalledWith('/custom/audit');
  });

  it('resolveSubsystemAuditDir: default / override / false off switch', () => {
    expect(resolveSubsystemAuditDir(undefined)).toBe(join(getOctopiHome(), 'audit'));
    expect(resolveSubsystemAuditDir('/custom/audit')).toBe('/custom/audit');
    expect(resolveSubsystemAuditDir(false)).toBeUndefined();
  });
});
