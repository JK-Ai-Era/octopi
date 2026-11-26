/**
 * registry→AgentDefinition 桥（arch/multi-tenancy.md §2 不变量 2/3、§4）：
 * registry 记录是归属与身份权威；home/workspace 由派生决定；effectPolicy 缺省 workspace。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRegistryAgentBridge } from '../src/registry-bridge.js';
import type { AgentRecord } from '@octopi-agent/engine/harness/governance/registry/types.js';
import { mergeEffectPolicy, resolveEffectiveEffectPolicy } from '@octopi-agent/engine';
import type { EffectPolicyConfig } from '@octopi-agent/engine';

const RAW_CONFIG = {
  models: {
    providers: {
      mock: {
        baseUrl: 'http://localhost:9/v1',
        apiKey: 'test-key',
        api: 'openai-completions',
        models: [{ id: 'm', name: 'm', contextWindow: 8000, maxTokens: 512 }],
      },
    },
  },
};

const VALID_ENTRY = JSON.stringify({
  model: 'mock/m',
  persona: { name: 'n', description: 'd', systemPrompt: 'hi' },
  tools: { allow: ['*'] },
});

function record(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: 'a-1' as AgentRecord['agentId'],
    tenantId: 't-x' as AgentRecord['tenantId'],
    ownerUserId: 'u-1' as AgentRecord['ownerUserId'],
    visibility: 'private',
    name: 'agent',
    definition: VALID_ENTRY,
    homeRef: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('registry-bridge', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'reg-bridge-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  function bridge() {
    return createRegistryAgentBridge({ getRawConfig: () => RAW_CONFIG, homeDir });
  }

  it('身份与路径由 registry 记录 + 派生注入', async () => {
    const rec = record({ agentId: 'a-1' as AgentRecord['agentId'], tenantId: 't-x' as AgentRecord['tenantId'] });
    const def = await bridge().materialize(rec);

    expect(def.id).toBe('a-1');
    expect(def.tenantId).toBe('t-x');
    expect(def.home).toBe(join(homeDir, 'agents', 'a-1'));
    expect(def.workspace).toBe(join(homeDir, 'workspace', 't-x', 'a-1'));
    expect(def.model).toEqual(expect.objectContaining({ provider: 'mock', model: 'm' }));
  });

  it('家当物化：home 与租户段 workspace 均落盘', async () => {
    const def = await bridge().materialize(record());
    expect(existsSync(def.home)).toBe(true);
    expect(existsSync(def.workspace!)).toBe(true);
  });

  it('effectPolicy 宿主派生：definition 携带 effectPolicy 一律拒绝（MAJ-5 自提权锚）', async () => {
    for (const policy of [{ mode: 'workspace' }, { mode: 'host', jail: 'none' }, { mode: 'untrusted' }]) {
      const rec = record({
        definition: JSON.stringify({ ...JSON.parse(VALID_ENTRY), effectPolicy: policy }),
      });
      await expect(bridge().materialize(rec)).rejects.toThrow(/"effectPolicy" is host-governed/);
    }
    // 缺省恒 workspace（secure-by-default；不继承平台 host）
    const def = await bridge().materialize(record());
    expect((def as { effectPolicy?: { mode?: string } }).effectPolicy).toEqual({ mode: 'workspace' });
  });

  it('F-1 租户隔离：standalone 标记 + 平台 host 旋钮不泄漏给租户生效策略', async () => {
    const def = await bridge().materialize(record());
    // 宿主派生的标记（config/definition 无法伪造：resolveAgentDefinition 显式挑字段）
    expect((def as { effectPolicyStandalone?: boolean }).effectPolicyStandalone).toBe(true);

    // 平台顶层带 host 旋钮（放宽围栏 + 全局根）——逐键兜底下这些会泄漏给 `{mode:'workspace'}`
    const platformHost: EffectPolicyConfig = {
      mode: 'host',
      pathContainment: 'none',
      toolIsolation: 'none',
      shellEscape: 'allow',
      transactionRoots: ['/platform-root'],
      pathDenylist: ['**/platform-secret/**'],
    };
    const effective = mergeEffectPolicy(platformHost, def.effectPolicy, {
      agentStandalone: def.effectPolicyStandalone === true,
    });
    // 生效策略仍 workspace 预设：宿主旋钮一个都不进（含并集清单键）
    expect(effective).toEqual({ mode: 'workspace' });
    const resolved = resolveEffectiveEffectPolicy(effective!, '/base/ws');
    expect(resolved.mode).toBe('workspace');
    expect(resolved.pathContainment).toBe('strict');
    expect(resolved.toolIsolation).toBe('session-subdir');
    expect(resolved.shellEscape).toBe('deny');
    expect(resolved.allowRoots).toEqual(['/base/ws']);
  });

  it('治理/能力键 fail-loud（maxSessionRights/delegation/channelBindings/knowledge…）', async () => {
    for (const key of ['maxSessionRights', 'delegation', 'channelBindings', 'knowledge', 'subsystems', 'traits']) {
      const rec = record({ definition: JSON.stringify({ ...JSON.parse(VALID_ENTRY), [key]: {} }) });
      await expect(bridge().materialize(rec)).rejects.toThrow(new RegExp(`"${key}" is host-governed`));
    }
  });

  it('env 引用拒绝（MAJ-6：宿主 env 对租户输入不可见）', async () => {
    const rec = record({
      definition: JSON.stringify({
        ...JSON.parse(VALID_ENTRY),
        persona: { name: 'n', description: 'd', systemPrompt: 'key=${OPENAI_API_KEY}' },
      }),
    });
    await expect(bridge().materialize(rec)).rejects.toThrow(/env references are not allowed/);
  });

  it('禁用键 fail-loud（身份/机器坐标不进 definition，§2.6）', async () => {
    for (const key of ['id', 'home', 'workspace', 'skillDirectory', 'tenantId']) {
      const rec = record({ definition: JSON.stringify({ ...JSON.parse(VALID_ENTRY), [key]: 'x' }) });
      await expect(bridge().materialize(rec)).rejects.toThrow(new RegExp(`"${key}" is host-governed`));
    }
  });

  it('非法 JSON / 非对象 definition fail-loud', async () => {
    await expect(bridge().materialize(record({ definition: '{oops' }))).rejects.toThrow(/valid JSON/);
    await expect(bridge().materialize(record({ definition: '[]' }))).rejects.toThrow(/JSON object/);
  });

  it('两租户家当互不可见：workspace 前缀隔离（T2 判据的物理基础）', async () => {
    const a = await bridge().materialize(record({ agentId: 'a-a' as AgentRecord['agentId'], tenantId: 't-a' as AgentRecord['tenantId'] }));
    const b = await bridge().materialize(record({ agentId: 'a-b' as AgentRecord['agentId'], tenantId: 't-b' as AgentRecord['tenantId'] }));

    expect(a.workspace).toBe(join(homeDir, 'workspace', 't-a', 'a-a'));
    expect(b.workspace).toBe(join(homeDir, 'workspace', 't-b', 'a-b'));
    expect(a.workspace!.startsWith(b.workspace!)).toBe(false);
    expect(b.workspace!.startsWith(a.workspace!)).toBe(false);
  });
});
