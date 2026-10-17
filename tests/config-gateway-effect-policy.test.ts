/**
 * toGatewayConfig effectPolicy wiring (ToolEffectPolicy P3)
 *
 * Regression: `agents[].effectPolicy` and top-level `effectPolicy` must survive
 * the config → GatewayConfig mapping used by `octopi serve` (cli/daemon.ts).
 * If the mapping drops them, gateway.buildAgent resolves `undefined` and the
 * runner silently falls back to DEFAULT_EFFECT_RUN_MODE ('workspace') while the
 * config says otherwise.
 */

import { describe, it, expect } from 'vitest';
import { toGatewayConfig } from '../src/config.js';
import type { NormalizedHarnessConfig, AgentConfig } from '../src/config.js';

function agentConfig(extra: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'default',
    home: 'C:/octopi/agents/default',
    workspace: 'C:/octopi/workspace/default',
    model: { provider: 'test', model: 'm1' },
    ...extra,
  };
}

function minimalConfig(overrides: Record<string, unknown> = {}): NormalizedHarnessConfig {
  return {
    models: { providers: {} },
    flatModels: [],
    agents: [agentConfig()],
    ...overrides,
  } as unknown as NormalizedHarnessConfig;
}

describe('toGatewayConfig effectPolicy wiring', () => {
  it('keeps agents[].effectPolicy on the agent definition', () => {
    const effectPolicy = {
      mode: 'project' as const,
      transactionRoots: ['C:/Projects/octopi'],
    };
    const gw = toGatewayConfig(
      minimalConfig({ agents: [agentConfig({ effectPolicy })] }),
    );

    expect(gw.agents[0]?.effectPolicy).toEqual(effectPolicy);
  });

  it('keeps top-level effectPolicy on the gateway config', () => {
    const effectPolicy = { mode: 'host' as const };

    const gw = toGatewayConfig(minimalConfig({ effectPolicy }));

    expect(gw.effectPolicy).toEqual(effectPolicy);
  });

  it('agent-level effectPolicy rides along even when top-level is absent', () => {
    const effectPolicy = {
      mode: 'untrusted' as const,
      untrustedAdmission: 'degrade' as const,
    };
    const gw = toGatewayConfig(
      minimalConfig({ agents: [agentConfig({ effectPolicy })] }),
    );

    expect(gw.effectPolicy).toBeUndefined();
    expect(gw.agents[0]?.effectPolicy).toEqual(effectPolicy);
  });
});

// ── 字段保全回归（防「边界对象字面量漏字段」复发） ──
//
// 已两次栽在同一种 bug：给 AgentConfig 加了字段，但 `toGatewayConfig` 的显式
// 对象字面量没跟着加，导致 octopi.json 配了也被静默丢弃
// （traits / delegation 即如此）。下面的通用断言让这类遗漏自动失败。

describe('toGatewayConfig agent field preservation (no silent drop)', () => {
  /** 每个 AgentConfig 字段都填一个哨兵值 */
  function fullyPopulatedAgent(): AgentConfig {
    return {
      id: 'default',
      home: 'C:/octopi/agents/default',
      workspace: 'C:/octopi/workspace/default',
      persona: { name: 'p', description: 'd', systemPrompt: 'sys' },
      tools: { allow: ['shell'], deny: ['file_delete'] },
      model: { provider: 'test', model: 'm1' },
      skillDirectory: 'C:/octopi/agents/default/skills',
      skills: ['docx'],
      channelBindings: { http: [{ channel: 'im', userId: 'u1' }] },
      maxSessionRights: { canRun: true, readScope: 'full' },
      knowledge: { recall: 'hybrid' },
      effectPolicy: { mode: 'project' as const, transactionRoots: ['C:/Projects/octopi'] },
      traits: ['research'],
      delegation: {
        callable: true,
        canDelegate: true,
        maxDepth: 2,
        rightsCeiling: { canRun: true, readScope: 'summary_tail' },
        budget: { maxTurns: 3, maxTokens: 1000, timeoutMs: 5000 },
      },
    };
  }

  it('every key on AgentConfig survives the boundary mapping', () => {
    const ac = fullyPopulatedAgent();
    const gw = toGatewayConfig(minimalConfig({ agents: [ac] }));
    const def = gw.agents[0] as Record<string, unknown>;

    // 通用断言：输入有的键，输出必须有（新增字段漏映射会在此失败）
    const missing = Object.keys(ac).filter((k) => !(k in def));
    expect(missing, `toGatewayConfig drops these AgentConfig keys: ${missing.join(', ')}`).toEqual([]);
  });

  it('traits and delegation survive verbatim', () => {
    const ac = fullyPopulatedAgent();
    const gw = toGatewayConfig(minimalConfig({ agents: [ac] }));

    expect(gw.agents[0]?.traits).toEqual(['research']);
    expect(gw.agents[0]?.delegation).toEqual(ac.delegation);
  });

  it('top-level delegation survives onto the gateway config', () => {
    const gw = toGatewayConfig(
      minimalConfig({ delegation: { maxActiveDelegationsPerSession: 4 } }),
    );
    expect(gw.delegation).toEqual({ maxActiveDelegationsPerSession: 4 });
  });
});
