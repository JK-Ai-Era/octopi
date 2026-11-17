/**
 * A16 — agents[].tools.denyCapabilities 接线：schema 保留 + 工具漏斗生效。
 */
import { describe, expect, it } from 'vitest';
import { ToolPolicySchema } from '../../packages/engine/src/config-schema/shared.js';
import { isToolPermitted } from '@octopi-agent/engine/harness/governance/session-acl/tool-rights.js';

describe('agents[].tools.denyCapabilities', () => {
  it('ToolPolicySchema 保留 denyCapabilities（此前被 zod 静默剥离）', () => {
    const parsed = ToolPolicySchema.parse({ allow: ['*'], deny: ['x'], denyCapabilities: ['exec'] });
    expect(parsed.denyCapabilities).toEqual(['exec']);
  });

  it('ToolPolicy.denyCapabilities 走同一漏斗：命中能力标签即拒', () => {
    const policy = { allow: ['*'], denyCapabilities: ['exec'] };
    expect(isToolPermitted('shell', ['exec'], [policy])).toBe(false);
    expect(isToolPermitted('file_read', ['fs-read'], [policy])).toBe(true);
  });

  it('denyCapabilities 设定且能力标签未知（null）→ fail-closed', () => {
    const policy = { allow: ['*'], denyCapabilities: ['exec'] };
    expect(isToolPermitted('mystery_tool', null, [policy])).toBe(false);
  });

  it('与 session toolRights 层求交：任一层拒绝即拒绝', () => {
    const policy = { allow: ['*'], denyCapabilities: ['exec'] };
    const rights = { allow: ['shell'], denyCapabilities: ['egress'] };
    expect(isToolPermitted('shell', ['exec'], [policy, rights])).toBe(false);
    expect(isToolPermitted('shell', [], [policy, rights])).toBe(true);
  });
});
