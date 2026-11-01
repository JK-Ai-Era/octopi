/**
 * buildFromConfig 契约 — 顶层 effectPolicy（宿主默认）不得在 config-bridge 路径丢失
 *
 * 防回归背景（arch/config-key-audit-2026-11-01.md §3）：Gateway 路径接了
 * `agentDef.effectPolicy ?? config.effectPolicy`，config-bridge 的 shared 面却漏传，
 * 库嵌入用户配顶层 effectPolicy 静默不生效。tool-effect-policy.md 拍板：
 * 「粒度 per-agent 为主；**宿主可给默认**」——两条装配路径必须能力一致。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentBuilder } from '@octopi-agent/engine/harness/agent/builder.js';
import { buildFromConfig } from '@octopi-agent/engine/harness/agent/config-bridge.js';

function baseConfig(): Record<string, unknown> {
  return {
    models: {
      providers: {
        p: {
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:1',
          apiKey: '',
          models: [{ name: 'm' }],
        },
      },
    },
    agents: [{ id: 'a1', model: { provider: 'p', model: 'm' } }],
    effectPolicy: { mode: 'host' },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildFromConfig 顶层 effectPolicy', () => {
  it('宿主默认传入 wire 面（agents[].effectPolicy 缺省时生效）', async () => {
    const spy = vi.spyOn(AgentBuilder.prototype, 'effectPolicy');
    const built = await buildFromConfig(baseConfig() as never, { delegation: false });
    expect(built.has('a1')).toBe(true);
    expect(spy).toHaveBeenCalledWith({ mode: 'host' });
  });

  it('agents[].effectPolicy 覆盖宿主默认（per-agent 粒度优先）', async () => {
    const spy = vi.spyOn(AgentBuilder.prototype, 'effectPolicy');
    const cfg = baseConfig();
    (cfg.agents as Array<Record<string, unknown>>)[0]!.effectPolicy = { mode: 'workspace' };
    await buildFromConfig(cfg as never, { delegation: false });
    expect(spy).toHaveBeenCalledWith({ mode: 'workspace' });
  });
});
