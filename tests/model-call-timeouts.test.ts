/**
 * Model call watchdog timeouts — defaults + config wiring
 *
 * Regression: complex tasks (long prompt prefill / long reasoning before the
 * first visible chunk) tripped the 120s engine idle watchdog and forced
 * `Stream fallback to sync`. Defaults are now idle 300s / absolute 900s and
 * tunable via the `modelCall` section of octopi.json
 * (loadConfig → toGatewayConfig → GatewayConfig → AgentBuilder.modelCallTimeouts).
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MODEL_CALL_IDLE_TIMEOUT_MS,
  DEFAULT_MODEL_CALL_ABSOLUTE_TIMEOUT_MS,
} from '@octopi-agent/core/loop/agent-loop.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import { Agent } from '@octopi-agent/engine/harness/run/agent/agent.js';
import { toGatewayConfig } from '../src/config.js';
import type { NormalizedHarnessConfig, AgentConfig } from '../src/config.js';
import { validateConfig } from '../src/config-schema.js';

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

const minimalEngineRaw = {
  agents: [{ id: 'a1', model: 'gpt-4o' }],
  models: {
    providers: {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        api: 'openai-completions' as const,
        models: [{ id: 'gpt-4o' }],
      },
    },
  },
};

describe('model call timeout defaults', () => {
  it('idle 300s / absolute 900s', () => {
    expect(DEFAULT_MODEL_CALL_IDLE_TIMEOUT_MS).toBe(300_000);
    expect(DEFAULT_MODEL_CALL_ABSOLUTE_TIMEOUT_MS).toBe(900_000);
  });
});

describe('octopi.json modelCall section', () => {
  it('schema accepts modelCall with both timeouts', () => {
    const r = validateConfig({
      ...minimalEngineRaw,
      modelCall: { idleTimeoutMs: 300000, absoluteTimeoutMs: 900000 },
    });
    expect(r.success).toBe(true);
    expect((r.data as { modelCall?: { idleTimeoutMs?: number } }).modelCall?.idleTimeoutMs).toBe(300000);
  });

  it('schema rejects non-positive timeout values', () => {
    const r = validateConfig({
      ...minimalEngineRaw,
      modelCall: { idleTimeoutMs: 0 },
    });
    expect(r.success).toBe(false);
  });

  it('toGatewayConfig maps modelCall onto the flat GatewayConfig fields', () => {
    const gw = toGatewayConfig(
      minimalConfig({
        modelCall: { idleTimeoutMs: 240_000, absoluteTimeoutMs: 600_000 },
      }),
    );

    expect(gw.modelCallIdleTimeoutMs).toBe(240_000);
    expect(gw.modelCallAbsoluteTimeoutMs).toBe(600_000);
  });

  it('toGatewayConfig leaves timeouts undefined when modelCall is absent', () => {
    const gw = toGatewayConfig(minimalConfig());

    expect(gw.modelCallIdleTimeoutMs).toBeUndefined();
    expect(gw.modelCallAbsoluteTimeoutMs).toBeUndefined();
  });
});

describe('Agent options → loop config', () => {
  const stubModel = {
    name: 'stub',
    defaultModel: 'm1',
    models: ['m1'],
    chat: async () => {
      throw new Error('unused in this test');
    },
    stream: async function* () {
      throw new Error('unused in this test');
    },
  } as unknown as ModelProvider;

  it('carries modelCall timeouts into the loop config', () => {
    const agent = new Agent({
      model: stubModel,
      modelCallIdleTimeoutMs: 12_345,
      modelCallAbsoluteTimeoutMs: 67_890,
    });

    expect(agent.config.modelCallIdleTimeoutMs).toBe(12_345);
    expect(agent.config.modelCallAbsoluteTimeoutMs).toBe(67_890);
  });

  it('leaves timeouts undefined when not provided (engine defaults apply)', () => {
    const agent = new Agent({ model: stubModel });

    expect(agent.config.modelCallIdleTimeoutMs).toBeUndefined();
    expect(agent.config.modelCallAbsoluteTimeoutMs).toBeUndefined();
  });
});
