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
