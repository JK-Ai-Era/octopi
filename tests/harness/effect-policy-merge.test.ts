/**
 * mergeEffectPolicy — effectPolicy 逐键兜底合并（2026-11-26 拍板）
 *
 * 语义：agent 写了的顶层键整键赢、没写的键跟宿主缺省；`undefined` 视为未写；
 * 嵌套对象整值替换（不深合并）。路径清单两键按并集叠加：
 * - transactionRoots（授权）：宿主根 + agent 追加根，「跟随全局 + 自带目录」可表达；
 * - pathDenylist（拒绝）：跨层只收紧不放松。
 */
import { describe, it, expect } from 'vitest';
import { mergeEffectPolicy } from '@octopi-agent/engine';
import type { EffectPolicyConfig } from '@octopi-agent/engine';

describe('mergeEffectPolicy 逐键兜底', () => {
  it('agent 未写的键跟宿主缺省、写了的键整键赢', () => {
    const host: EffectPolicyConfig = { mode: 'host', shellEscape: 'deny', network: 'open' };
    const agent: EffectPolicyConfig = { mode: 'workspace' };
    expect(mergeEffectPolicy(host, agent)).toEqual({
      mode: 'workspace',
      shellEscape: 'deny',
      network: 'open',
    });
  });

  it('agent 侧 undefined 视为未写（不覆盖宿主值）', () => {
    const host: EffectPolicyConfig = { mode: 'host' };
    const agent = { mode: undefined } as EffectPolicyConfig;
    expect(mergeEffectPolicy(host, agent)).toEqual({ mode: 'host' });
  });

  it('嵌套对象整键替换（不深合并）', () => {
    const host: EffectPolicyConfig = {
      escalation: { policy: 'allowlist', via: 'sudo' },
    };
    const agent: EffectPolicyConfig = { escalation: { policy: 'none' } };
    expect(mergeEffectPolicy(host, agent)).toEqual({ escalation: { policy: 'none' } });
  });

  it('transactionRoots 并集：宿主根不因 agent 自带根丢失（F2/F3 场景）', () => {
    const host: EffectPolicyConfig = { mode: 'host', transactionRoots: ['/shared'] };
    const agent: EffectPolicyConfig = { transactionRoots: ['/proj'] };
    expect(mergeEffectPolicy(host, agent)).toEqual({
      mode: 'host',
      transactionRoots: ['/shared', '/proj'],
    });
  });

  it('transactionRoots 并集去重', () => {
    const host: EffectPolicyConfig = { transactionRoots: ['/a', '/b'] };
    const agent: EffectPolicyConfig = { transactionRoots: ['/b', '/c'] };
    expect(mergeEffectPolicy(host, agent)?.transactionRoots).toEqual(['/a', '/b', '/c']);
  });

  it('pathDenylist 并集：agent 级拒绝不能放松宿主拒绝', () => {
    const host: EffectPolicyConfig = { pathDenylist: ['**/.env'] };
    const agent: EffectPolicyConfig = { pathDenylist: ['**/secrets/**'] };
    expect(mergeEffectPolicy(host, agent)?.pathDenylist).toEqual(['**/.env', '**/secrets/**']);
  });

  it('单侧缺省：另一侧原样返回；双侧缺省返回 undefined', () => {
    const host: EffectPolicyConfig = { mode: 'host' };
    expect(mergeEffectPolicy(host, undefined)).toBe(host);
    expect(mergeEffectPolicy(undefined, host)).toBe(host);
    expect(mergeEffectPolicy(undefined, undefined)).toBeUndefined();
  });

  it('agentStandalone（MAJ-5 租户隔离）：不兜底宿主键、不并集宿主根/拒绝清单', () => {
    const host: EffectPolicyConfig = {
      mode: 'host',
      pathContainment: 'none',
      toolIsolation: 'none',
      shellEscape: 'allow',
      transactionRoots: ['/host-root'],
      pathDenylist: ['**/host-secret/**'],
    };
    const agent: EffectPolicyConfig = { mode: 'workspace' };
    // 恒 workspace 姿态：agent 自成一套，宿主任何旋钮/清单都不得进入
    expect(mergeEffectPolicy(host, agent, { agentStandalone: true })).toEqual({ mode: 'workspace' });
    // 对照：不带标记时宿主旋钮按逐键兜底泄漏（这就是 F-1 要堵的形态）
    expect(mergeEffectPolicy(host, agent)).toEqual({
      mode: 'workspace',
      pathContainment: 'none',
      toolIsolation: 'none',
      shellEscape: 'allow',
      transactionRoots: ['/host-root'],
      pathDenylist: ['**/host-secret/**'],
    });
    // agent 自带清单同样原样保留（不与宿主并集）
    expect(
      mergeEffectPolicy(host, { mode: 'workspace', transactionRoots: ['/tenant'] }, { agentStandalone: true }),
    ).toEqual({ mode: 'workspace', transactionRoots: ['/tenant'] });
  });

  it('F-4 回归锚：嵌套旋钮必须整组重写（部分写入静默丢宿主子键，已知 give-up）', () => {
    const host: EffectPolicyConfig = {
      mode: 'host',
      undoLimit: { maxEntries: 10, maxBlobBytes: 5 },
    };
    // agent 只写 maxEntries → 宿主 maxBlobBytes 被整值替换丢弃（不深合并，文档已声明）
    expect(mergeEffectPolicy(host, { undoLimit: { maxEntries: 5 } } as EffectPolicyConfig)).toEqual({
      mode: 'host',
      undoLimit: { maxEntries: 5 },
    });
  });
});
