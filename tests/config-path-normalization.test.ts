/**
 * 配置路径规范化（留观②）：workspace / transactionRoots 拒绝相对路径，
 * `~` 形态（`~`、`~/x`、`~\x`）跨平台展开为用户主目录。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';

import {
  expandHomePath,
  isConfigPathShape,
  ConfigPathSchema,
} from '@octopi-agent/engine/config-schema/shared.js';
import { AgentConfigSchema } from '@octopi-agent/engine/config-schema/agent.js';
import { EffectPolicyConfigSchema } from '@octopi-agent/engine/config-schema/governance.js';
import { resolveEffectiveEffectPolicy } from '@octopi-agent/engine/harness/extension/execution-environment/effect-policy.js';
import { resolveToolIsolationCwd } from '@octopi-agent/engine/harness/extension/execution-environment/isolation.js';
import { validateConfigOrThrow, OctopiConfigSchema } from '../src/config-schema.js';
import { loadConfig } from '../src/config.js';

describe('expandHomePath（Windows/Linux/macOS 通用）', () => {
  it('展开 `~`、`~/x`、`~\\x`；绝对路径与不支持形态原样返回', () => {
    expect(expandHomePath('~')).toBe(homedir());
    expect(expandHomePath('~/a')).toBe(join(homedir(), 'a'));
    expect(expandHomePath('~\\a')).toBe(join(homedir(), 'a'));
    expect(expandHomePath('/abs/x')).toBe('/abs/x');
    expect(expandHomePath('~user/x')).toBe('~user/x'); // 不支持 ~user 形态
    expect(expandHomePath('')).toBe('');
    // 幂等：展开后再展开不变
    const once = expandHomePath('~/a');
    expect(expandHomePath(once)).toBe(once);
  });
});

describe('ConfigPathSchema（拒相对路径，fail fast）', () => {
  it('放行绝对路径与 ~ 形态', () => {
    for (const good of ['/abs/x', '~', '~/x', '~\\x']) {
      expect(isConfigPathShape(good), good).toBe(true);
      expect(ConfigPathSchema.safeParse(good).success, good).toBe(true);
    }
  });

  it('拒绝相对路径与 ~user 形态', () => {
    for (const bad of ['rel/x', './x', '..', '~user/x', '']) {
      expect(isConfigPathShape(bad), bad).toBe(false);
      expect(ConfigPathSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('AgentConfigSchema.workspace / home / skillDirectory 与 EffectPolicyConfigSchema.transactionRoots 同规', () => {
    const agent = (patch: Record<string, unknown>) => ({
      id: 'a',
      model: { provider: 'mock', model: 'm' },
      ...patch,
    });
    expect(AgentConfigSchema.safeParse(agent({ workspace: 'rel' })).success).toBe(false);
    expect(AgentConfigSchema.safeParse(agent({ workspace: '~/w' })).success).toBe(true);
    // home / skillDirectory：相对路径同样 fail fast（否则 agent.db / skills 会绑到进程 cwd）
    for (const field of ['home', 'skillDirectory'] as const) {
      expect(AgentConfigSchema.safeParse(agent({ [field]: 'rel' })).success, field).toBe(false);
      expect(AgentConfigSchema.safeParse(agent({ [field]: './rel' })).success, field).toBe(false);
      expect(AgentConfigSchema.safeParse(agent({ [field]: '~user/x' })).success, field).toBe(false);
      expect(AgentConfigSchema.safeParse(agent({ [field]: '' })).success, field).toBe(false);
      expect(AgentConfigSchema.safeParse(agent({ [field]: '~/x' })).success, field).toBe(true);
      expect(AgentConfigSchema.safeParse(agent({ [field]: '/abs/x' })).success, field).toBe(true);
    }
    expect(
      EffectPolicyConfigSchema.safeParse({ transactionRoots: ['rel'] }).success,
    ).toBe(false);
    expect(
      EffectPolicyConfigSchema.safeParse({ transactionRoots: ['/a', '~/b'] }).success,
    ).toBe(true);
  });
});

describe('resolveEffectiveEffectPolicy 入口展开', () => {
  it('baseWorkspace 与 transactionRoots 的 ~ 形态进 allowRoots 前已展开', () => {
    const eff = resolveEffectiveEffectPolicy(
      { mode: 'workspace', transactionRoots: ['~/x'] },
      '~/ws',
    );
    expect(eff.allowRoots).toContain(join(homedir(), 'ws'));
    expect(eff.allowRoots).toContain(join(homedir(), 'x'));
    expect(eff.allowRoots.some((r) => r.startsWith('~'))).toBe(false);
  });
});

describe('loadConfig 路径归一化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octopi-cfgpath-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('agents[].workspace / home / skillDirectory 与两级 transactionRoots 的 ~ 形态全部展开', () => {
    const p = join(dir, 'octopi.json');
    writeFileSync(
      p,
      JSON.stringify({
        models: { providers: {} },
        agents: [
          {
            id: 'a1',
            home: '~/h',
            workspace: '~/w',
            skillDirectory: '~/s',
            model: { provider: 'mock', model: 'm' },
            effectPolicy: { transactionRoots: ['~/t'] },
          },
        ],
        effectPolicy: { transactionRoots: ['~/g'] },
      }),
    );
    const config = loadConfig(p) as unknown as {
      effectPolicy?: { transactionRoots?: string[] };
      agents: Array<{
        workspace?: string;
        home?: string;
        skillDirectory?: string;
        effectPolicy?: { transactionRoots?: string[] };
      }>;
    };
    expect(config.agents[0]!.home).toBe(join(homedir(), 'h'));
    expect(config.agents[0]!.workspace).toBe(join(homedir(), 'w'));
    expect(config.agents[0]!.skillDirectory).toBe(join(homedir(), 's'));
    expect(config.agents[0]!.effectPolicy?.transactionRoots).toEqual([join(homedir(), 't')]);
    expect(config.effectPolicy?.transactionRoots).toEqual([join(homedir(), 'g')]);
  });

  it('相对 home / skillDirectory 加载即拒绝（不再隐式 resolve 到进程 cwd）', () => {
    for (const field of ['home', 'skillDirectory'] as const) {
      const p = join(dir, `bad-${field}.json`);
      writeFileSync(
        p,
        JSON.stringify({
          models: { providers: {} },
          agents: [{ id: 'a1', [field]: 'relative', model: { provider: 'mock', model: 'm' } }],
        }),
      );
      expect(() => loadConfig(p), field).toThrow();
    }
  });

  it('相对 workspace 加载即拒绝（不再隐式 resolve 到进程 cwd）', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(
      p,
      JSON.stringify({
        models: { providers: {} },
        agents: [{ id: 'a1', workspace: 'relative', model: { provider: 'mock', model: 'm' } }],
      }),
    );
    expect(() => loadConfig(p)).toThrow();
  });
});

describe('库调用面一致性（P1-1 / P2-3 / P2-4 修复锁）', () => {
  it('resolveToolIsolationCwd 展开 `~`：tool cwd 与 allowRoots 同源', () => {
    const r = resolveToolIsolationCwd({
      mode: 'session-subdir',
      sessionId: 's1',
      baseCwd: '~/ws',
    });
    expect(r.cwd).toBe(join(homedir(), 'ws', 's1'));
  });

  it('多段 Windows 形态 `~\\a\\b` 归一展开（不留字面反斜杠）', () => {
    expect(expandHomePath('~\\a\\b')).toBe(join(homedir(), 'a', 'b'));
  });

  it('trim → expand：带空白的库输入同样归一', () => {
    const eff = resolveEffectiveEffectPolicy(
      { mode: 'workspace', transactionRoots: [' ~/x '] },
      ' ~/ws ',
    );
    expect(eff.allowRoots).toContain(join(homedir(), 'x'));
    expect(eff.allowRoots).toContain(join(homedir(), 'ws'));
    expect(eff.allowRoots.some((r) => r.includes('~'))).toBe(false);
  });

  it('legacy persona 字符串与 home 同契约（拒相对 + 展开 ~）', () => {
    expect(AgentConfigSchema.safeParse({ id: 'a', persona: 'rel', model: { provider: 'p', model: 'm' } }).success).toBe(false);
    expect(AgentConfigSchema.safeParse({ id: 'a', persona: '~/p', model: { provider: 'p', model: 'm' } }).success).toBe(true);
    const config = validateConfigOrThrow({
      models: { providers: {} },
      agents: [{ id: 'a1', persona: '~/p', model: { provider: 'p', model: 'm' } }],
    }) as unknown as { agents: Array<{ persona?: string }> };
    expect(config.agents[0]!.persona).toBe(join(homedir(), 'p'));
  });

  it('validateConfigOrThrow 后置条件：返回值已展开（与 loadConfig 同规）', () => {
    const config = validateConfigOrThrow({
      models: { providers: {} },
      agents: [{ id: 'a1', workspace: '~/w', model: { provider: 'p', model: 'm' } }],
    }) as unknown as { agents: Array<{ workspace?: string }> };
    expect(config.agents[0]!.workspace).toBe(join(homedir(), 'w'));
  });
});

describe('canonical template 守卫', () => {
  it('octopi.example.json 永远过 OctopiConfigSchema', () => {
    const raw = JSON.parse(
      readFileSync(new URL('../octopi.example.json', import.meta.url), 'utf-8'),
    );
    const result = OctopiConfigSchema.safeParse(raw);
    expect(result.success, JSON.stringify(result.error?.issues ?? [], null, 2)).toBe(true);
  });
});
