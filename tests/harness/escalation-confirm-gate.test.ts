/**
 * ops 确认闸语义面测试（错误语义 ≠ 审计语义回归）。
 *
 * 背景：2026-10-26 实测发现确认窗（askWithTimeout）与工具看门狗（runWithToolLimits）
 * 同为 120s 同秒竞速，超时场景下 LLM 收到 `tool_timeout`（工具卡死）而审计记
 * `confirm_timeout`（确认超时拒绝）——两个消费者看到两个故事，错误语义诱导盲目重试。
 * 修复后语义约定：
 * - 确认窗到期 = `escalation_confirm_timeout`（携带"勿盲重试"语义）；
 * - 人工拒绝 = `escalation_confirm_denied`（同上）；
 * - confirmEffect 意图携带 `timeoutMs`，宿主卡片生命周期据此严格晚于确认窗 settle；
 * - 批准带归因（confirmedBy / confirmChannel）入 `ops.privileged.exec`。
 *
 * 规格：arch/ops-privileged-mode.md §6.2 / §7 / §8.2。
 */
import { describe, it, expect } from 'vitest';

import { createPrivExecTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/privileged-tool.js';
import { runPrivilegedExec } from '@octopi-agent/engine/harness/extension/execution-environment/privileged-exec.js';
import { HitlDecisionCache } from '@octopi-agent/engine/harness/governance/human-in-the-loop/decision-cache.js';
import type { EscalationPolicy } from '@octopi-agent/engine/harness/extension/execution-environment/privileged-exec.js';
import type { ToolExecutionContext } from '@octopi-agent/core/types/tools.js';

interface OpsRecord {
  event: string;
  data: Record<string, unknown>;
}

const confirmRulePolicy: EscalationPolicy = {
  policy: 'allowlist',
  via: 'direct',
  allow: [{ id: 'echo-confirm', cmd: '/bin/echo', args: ['ok'], confirm: true }],
};

const ctx = (over?: Partial<ToolExecutionContext>): ToolExecutionContext =>
  ({
    sessionId: 's1',
    agentId: 'a1',
    cwd: '/tmp',
    escalation: confirmRulePolicy,
    dangerousCommands: { policy: 'confirm', timeoutMs: 50 },
    ...over,
  }) as ToolExecutionContext;

describe('确认闸错误语义面（confirm_timeout / confirm_denied 不可与 tool_timeout 混淆）', () => {
  it('确认窗到期 → escalation_confirm_timeout（含勿盲重试语义）+ why=confirm_timeout 留痕', async () => {
    const tool = createPrivExecTool({ cache: new HitlDecisionCache() });
    const records: OpsRecord[] = [];
    let sawIntentTimeoutMs: number | undefined;

    await expect(
      tool.handler(
        { cmd: '/bin/echo', args: ['ok'] },
        ctx({
          confirmEffect: async (intent) => {
            sawIntentTimeoutMs = intent.timeoutMs;
            // 模拟宿主无人应答：promise 永不 resolve，由确认窗定案
            return new Promise(() => undefined);
          },
          recordOpsEvent: (r) => records.push(r as OpsRecord),
        }),
      ),
    ).rejects.toThrow(/escalation_confirm_timeout:.*do NOT retry/s);

    // 确认窗已随意图传给宿主（卡片生命周期排在它之后）
    expect(sawIntentTimeoutMs).toBe(50);
    expect(records.at(-1)).toMatchObject({
      event: 'ops.escalation.denied',
      data: { why: 'confirm_timeout' },
    });
  });

  it('人工拒绝 → escalation_confirm_denied（含勿盲重试语义）+ why=confirm_denied 留痕', async () => {
    const tool = createPrivExecTool({ cache: new HitlDecisionCache() });
    const records: OpsRecord[] = [];

    await expect(
      tool.handler(
        { cmd: '/bin/echo', args: ['ok'] },
        ctx({
          confirmEffect: async () => 'deny',
          recordOpsEvent: (r) => records.push(r as OpsRecord),
        }),
      ),
    ).rejects.toThrow(/escalation_confirm_denied:.*do NOT retry/s);

    expect(records.at(-1)).toMatchObject({
      event: 'ops.escalation.denied',
      data: { why: 'confirm_denied' },
    });
  });

  it('批准带归因 → ops.privileged.exec 记 confirmedBy/confirmChannel，命令照常执行', async () => {
    const tool = createPrivExecTool({ cache: new HitlDecisionCache() });
    const records: OpsRecord[] = [];

    const result = (await tool.handler(
      { cmd: '/bin/echo', args: ['ok'] },
      ctx({
        confirmEffect: async () => ({ decision: 'approve', approver: 'owner', channel: 'gateway' }),
        recordOpsEvent: (r) => records.push(r as OpsRecord),
      }),
    )) as { ruleId: string; exitCode: number | null; confirmDecision: string; stdout: string };

    expect(result.ruleId).toBe('echo-confirm');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
    expect(result.confirmDecision).toBe('approved');
    expect(records.at(-1)).toMatchObject({
      event: 'ops.privileged.exec',
      data: {
        confirmDecision: 'approved',
        confirmedBy: 'owner',
        confirmChannel: 'gateway',
        executed: true,
      },
    });
  });
});

describe('拒绝来源如实（人工 / 无通道 / 通道异常 / 中止 不得混为一谈）', () => {
  it('无 confirmEffect → 报 confirm_unavailable（绝不称人工拒绝）+ why=channel_error 留痕', async () => {
    const tool = createPrivExecTool({ cache: new HitlDecisionCache() });
    const records: OpsRecord[] = [];

    const err = await tool
      .handler(
        { cmd: '/bin/echo', args: ['ok'] },
        ctx({
          confirmEffect: undefined,
          recordOpsEvent: (r) => records.push(r as OpsRecord),
        }),
      )
      .then(
        () => null,
        (e: Error) => e,
      );

    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/escalation_confirm_unavailable/);
    expect(err!.message).not.toMatch(/a human rejected/);
    expect(records.at(-1)).toMatchObject({
      event: 'ops.escalation.denied',
      data: { why: 'channel_error', reason: 'confirmEffect hook absent' },
    });
  });

  it('confirmEffect 抛异常 → 通道故障标注（why=channel_error），不冒充人工拒绝', async () => {
    const tool = createPrivExecTool({ cache: new HitlDecisionCache() });
    const records: OpsRecord[] = [];

    const err = await tool
      .handler(
        { cmd: '/bin/echo', args: ['ok'] },
        ctx({
          confirmEffect: async () => {
            throw new Error('host exploded');
          },
          recordOpsEvent: (r) => records.push(r as OpsRecord),
        }),
      )
      .then(
        () => null,
        (e: Error) => e,
      );

    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/escalation_confirm_unavailable/);
    expect(err!.message).not.toMatch(/a human rejected/);
    expect(records.at(-1)).toMatchObject({
      event: 'ops.escalation.denied',
      data: { why: 'channel_error' },
    });
  });

  it('run 中止（abortSignal）→ priv_exec_aborted + why=aborted，不再空等确认窗', async () => {
    const tool = createPrivExecTool({ cache: new HitlDecisionCache() });
    const records: OpsRecord[] = [];
    const controller = new AbortController();
    controller.abort();

    const err = await tool
      .handler(
        { cmd: '/bin/echo', args: ['ok'] },
        ctx({
          confirmEffect: async () => new Promise(() => undefined),
          abortSignal: controller.signal,
          recordOpsEvent: (r) => records.push(r as OpsRecord),
        }),
      )
      .then(
        () => null,
        (e: Error) => e,
      );

    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/priv_exec_aborted/);
    expect(records.at(-1)).toMatchObject({
      event: 'ops.escalation.denied',
      data: { why: 'aborted' },
    });
  });
});

describe('并发合流与总线看门狗（F3/F5 回归钉）', () => {
  it('definition 不设总线看门狗（真实时限全部内部强制）', () => {
    const tool = createPrivExecTool({ cache: new HitlDecisionCache() });
    expect(tool.definition.timeoutMs).toBeUndefined();
  });

  it('同 argv 并发两发合流共享结果：双双报 confirm_timeout，第二发不得被误标 confirm_denied', async () => {
    const tool = createPrivExecTool({ cache: new HitlDecisionCache() });
    const records: OpsRecord[] = [];
    const context = ctx({
      confirmEffect: async () => new Promise(() => undefined),
      recordOpsEvent: (r) => records.push(r as OpsRecord),
    });

    const results = await Promise.allSettled([
      tool.handler({ cmd: '/bin/echo', args: ['ok'] }, context),
      tool.handler({ cmd: '/bin/echo', args: ['ok'] }, context),
    ]);

    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason.message).toMatch(/escalation_confirm_timeout/);
      expect((r as PromiseRejectedResult).reason.message).not.toMatch(/a human rejected/);
    }
  });
});

describe('exec 阶段 run 中止即时树杀（不等执行超时兜底）', () => {
  it('abortSignal 触发立即收回，结果标 aborted', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = runPrivilegedExec({
      cmd: '/bin/sleep',
      args: ['30'],
      via: 'direct',
      timeoutMs: 120_000,
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await promise;

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
