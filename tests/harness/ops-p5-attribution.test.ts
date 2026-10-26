/**
 * ops P5 确认人身份入账测试：谁批的、经哪条通道（gateway | webhook）随决策定格入审计。
 * 规格：arch/ops-privileged-mode.md §5 P5。
 */
import { describe, it, expect } from 'vitest';

import { createPrivExecTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/privileged-tool.js';
import { HitlDecisionCache } from '@octopi-agent/engine/harness/governance/human-in-the-loop/decision-cache.js';
import type { ToolExecutionContext } from '@octopi-agent/core/types/tools.js';

describe('确认归因（P5：谁批的 / 哪条通道）', () => {
  const tool = createPrivExecTool({ cache: new HitlDecisionCache() });
  const ctx = (over?: Partial<ToolExecutionContext>): ToolExecutionContext =>
    ({
      sessionId: 's1',
      agentId: 'a1',
      cwd: '/tmp',
      ...over,
    }) as ToolExecutionContext;

  it('ConfirmOutcome 归因入 ops.privileged.exec（confirmedBy/confirmChannel）', async () => {
    const records: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = (await tool.handler({ cmd: '/bin/echo', args: ['attributed'] }, ctx({
      escalation: {
        policy: 'allowlist',
        via: 'direct',
        allow: [{ id: 'echo-attr', cmd: '/bin/echo', args: ['attributed'], confirm: true }],
      },
      // 宿主经 webhook 回执批准（P5 双通道之一）
      confirmEffect: async () => ({
        decision: 'approve' as const,
        approver: 'owner-alice',
        channel: 'webhook',
      }),
      recordOpsEvent: (r) => records.push(r),
    }))) as Record<string, unknown>;
    expect(result.confirmDecision).toBe('approved');
    const exec = records.find((r) => r.event === 'ops.privileged.exec');
    expect(exec?.data.confirmedBy).toBe('owner-alice');
    expect(exec?.data.confirmChannel).toBe('webhook');
  });

  it('裸 HitlDecision 仍合法：无归因时审计如实缺省（不编造）', async () => {
    const records: Array<{ event: string; data: Record<string, unknown> }> = [];
    await tool.handler({ cmd: '/bin/echo', args: ['bare'] }, ctx({
      escalation: {
        policy: 'allowlist',
        via: 'direct',
        allow: [{ cmd: '/bin/echo', args: ['bare'], confirm: true }],
      },
      confirmEffect: async () => 'approve',
      recordOpsEvent: (r) => records.push(r),
    }));
    const exec = records.find((r) => r.event === 'ops.privileged.exec');
    expect(exec?.data.confirmDecision).toBe('approved');
    expect(exec?.data.confirmedBy).toBeUndefined();
    expect(exec?.data.confirmChannel).toBeUndefined();
  });
});
