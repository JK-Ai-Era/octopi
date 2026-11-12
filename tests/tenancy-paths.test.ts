/**
 * 家当路径派生（arch/multi-tenancy.md §4 隔离矩阵的单一来源）。
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { agentHomeDir, agentWorkspaceDir } from '@octopi-agent/engine/paths.js';
import { DEFAULT_TENANT_ID } from '@octopi-agent/core/types.js';

describe('tenancy path derivation', () => {
  it('home = agents/<agentId>/（不带租户段，registry 标注 tenantId）', () => {
    expect(agentHomeDir('/home/x', 'agent-1')).toBe(join('/home/x', 'agents', 'agent-1'));
  });

  it('workspace = workspace/<tenantId>/<agentId>/（前缀隔离）', () => {
    expect(agentWorkspaceDir('/home/x', 't-a', 'agent-1')).toBe(
      join('/home/x', 'workspace', 't-a', 'agent-1'),
    );
  });

  it('缺省租户 = DEFAULT_TENANT_ID（存量/未接身份层）', () => {
    expect(agentWorkspaceDir('/home/x', undefined, 'agent-1')).toBe(
      join('/home/x', 'workspace', DEFAULT_TENANT_ID, 'agent-1'),
    );
  });

  it('路径段守卫：穿越/分隔符/空段 fail-loud', () => {
    expect(() => agentWorkspaceDir('/home/x', '..', 'agent-1')).toThrow(/invalid tenant id/);
    expect(() => agentWorkspaceDir('/home/x', 'a/b', 'agent-1')).toThrow(/invalid tenant id/);
    expect(() => agentWorkspaceDir('/home/x', 'a\\b', 'agent-1')).toThrow(/invalid tenant id/);
    expect(() => agentWorkspaceDir('/home/x', '', 'agent-1')).toThrow(/invalid tenant id/);
    expect(() => agentWorkspaceDir('/home/x', 't', '../evil')).toThrow(/invalid agent id/);
    expect(() => agentHomeDir('/home/x', '')).toThrow(/invalid agent id/);
  });
});
