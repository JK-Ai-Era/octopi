/**
 * DelegationNotifier — notify 通道投递器
 *
 * @layer harness/collaboration/delegation
 * 设计权威：`arch/delegation.md` §7.1。
 *
 * 子 Run 终态 → 写 `DelegationStore`（已由 service 完成）→ **本模块投递**
 * → `emitAgentSignal` → `AgentSignalSource` → `AgentRuntime.dispatch`
 * → Compiler 编译成 user 消息进父 session 队列。
 *
 * **复用既有 Trigger 模型，不新造父子通道**（`arch/agent-runtime.md`）。
 *
 * 不打断父 Run：同 session 运行中再来 Trigger 由 Runner FIFO 锁排队，
 * 禁止在调用链上 await（`arch/agent-runtime.md` 重入策略）。
 */

import type { EventBus } from '@octopi-agent/core/primitives/event-bus.js';
import type { Delegation } from './types.js';
import type { DelegationNotifier } from './service.js';
import {
  emitAgentSignal,
  hasAgentSignalReceiver,
} from '../../activation/sources/agent-signal.js';

/** notify 投递器配置 */
export interface DelegationNotifierConfig {
  /** 事件总线（须与挂载 `AgentSignalSource` 的总线同一条） */
  events: EventBus;
  /** 自定义内容渲染（缺省用 `renderDelegationNotice`） */
  render?: (delegation: Delegation) => string;
}

/**
 * 渲染委派终态通知（§7.1：`<delegation_completed …/>`）
 *
 * @param delegation - 终态委派单
 * @returns 通知文本
 */
export function renderDelegationNotice(delegation: Delegation): string {
  const attrs = [
    `id="${escapeAttr(delegation.id)}"`,
    `status="${delegation.status}"`,
    `agent="${escapeAttr(delegation.resolvedAgentId ?? delegation.target.agentId ?? '')}"`,
    `task="${escapeAttr(truncate(delegation.task, 120))}"`,
    `parent_run_id="${escapeAttr(delegation.parent.runId)}"`,
    `child_run_id="${escapeAttr(delegation.childRunId ?? '')}"`,
  ];
  const body: string[] = [];

  if (delegation.output) {
    body.push(`<output>${escapeText(truncate(delegation.output, 4000))}</output>`);
  }
  if (delegation.error) {
    body.push(`<error>${escapeText(truncate(delegation.error, 1000))}</error>`);
  }
  if (delegation.artifacts?.length) {
    body.push(
      `<artifacts>${delegation.artifacts.map((a) => escapeText(a)).join(', ')}</artifacts>`,
    );
  }

  return body.length > 0
    ? `<delegation_result ${attrs.join(' ')}>${body.join('')}</delegation_result>`
    : `<delegation_result ${attrs.join(' ')}/>`;
}

/** 委派终态 → notify 通道 reason */
export function delegationReason(delegation: Delegation): string {
  return delegation.status === 'completed' ? 'delegation_completed' : `delegation_${delegation.status}`;
}

/**
 * 创建 notify 投递器
 *
 * 投递前提：总线上有存活的 `AgentSignalSource` 接收端。`bus.emit` 对有无监听者
 * 零反馈，不校验就会把发进空总线的通知误标已送达（2026-10-22 断链根因）。
 * 无接收端时抛出，由 `DelegateService.notify` 按投递失败处理（留 `deliveryState` 为 pending
 * 给状态提示兜底并打 warn）。
 *
 * @param config - 事件总线与渲染器
 * @returns 可注入 `DelegateServiceConfig.notifier` 的投递器
 */
export function createDelegationNotifier(config: DelegationNotifierConfig): DelegationNotifier {
  const render = config.render ?? renderDelegationNotice;
  return (delegation: Delegation) => {
    if (!hasAgentSignalReceiver(config.events)) {
      throw new Error('delegation notify not delivered: no AgentSignalSource receiver on the bus');
    }
    emitAgentSignal(config.events, {
      fromAgentId: delegation.resolvedAgentId ?? delegation.target.agentId ?? 'child',
      toAgentId: delegation.parent.agentId,
      sessionId: delegation.parent.sessionId,
      payload: { kind: 'system_note', content: render(delegation) },
      reason: delegationReason(delegation),
      delegationId: delegation.id,
    });
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
