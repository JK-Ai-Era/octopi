/**
 * delegate_* 工具 — 经 DelegateService 委派任务给子 agent
 *
 * @layer harness/extension/plugin-ecosystem/tools
 * 设计权威：`arch/delegation.md` §7 / §14。
 *
 * **非阻塞**（§7）：`delegate_dispatch` 立即返回 `delegationId`，不等子 Run 结束。
 * 结果回收走 `delegate_get`（poll）或 notify 通道（P3）。
 *
 * 工具与 `DelegateService` 分离：服务可被嵌入方直接用，不经 LLM 工具面。
 */

import type { RegisteredTool } from '@octopi-agent/core/types.js';
import type { DelegateService } from '../../../collaboration/delegation/service.js';
import { DelegateResolutionError } from '../../../collaboration/delegation/service.js';
import type {
  Delegation,
  DelegationContextMode,
  DelegationStatus,
} from '../../../collaboration/delegation/types.js';

/** 委派单摘要（进 LLM 结果，字段名 snake_case 对齐其他工具） */
function delegationSummary(d: Delegation) {
  return {
    delegation_id: d.id,
    status: d.status,
    target: d.target.agentId ?? d.resolvedAgentId ?? d.target.trait,
    resolved_agent_id: d.resolvedAgentId,
    task: d.task,
    depth: d.depth,
    child_session_id: d.childSessionId,
    output: d.output,
    artifacts: d.artifacts,
    error: d.error,
    usage: d.usage,
    created_at: d.createdAt,
    started_at: d.startedAt,
    completed_at: d.completedAt,
    deadline_at: d.deadlineAt,
    cancelable: d.cancelable,
    cascade: d.cascade,
    notified: d.notified,
  };
}

/**
 * 读取**本 Run** 的 effective session rights（D3：权限随调用传播）
 *
 * 经 RunScope ALS 取，保证并发 session 下拿到的是本 Run 的权威值（I1）。
 * 不在 Run 中（或未启用 ACL）时返回 undefined —— 不叠加父约束。
 *
 * @returns 本 Run 的有效权限
 */
async function readRunSessionRights() {
  const { getRunScope } = await import('../../../run/run-scope.js');
  return getRunScope()?.toolRuntime?.sessionRights;
}

/**
 * 把服务层解析错误转成 LLM 可读的失败结果（不抛栈）
 *
 * 解析失败时**一并回传可用目标**（traits / agents），
 * 让调用方一次就能改对（改用 `agent:` 或换个 trait），而不是瞎猜重试。
 */
function resolutionFailure(err: unknown): Record<string, unknown> {
  if (err instanceof DelegateResolutionError) {
    return {
      ok: false,
      reason: err.reason,
      error: err.message,
      ...(err.available ? { available_targets: err.available } : {}),
      hint:
        err.reason === 'not_found'
          ? 'No agent matched. Retry with `agent: <id>` using an id from available_targets, or use a trait that exists.'
          : undefined,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: message };
}

/** 创建 delegate_* 工具集 */
export function createDelegationTools(service: DelegateService): RegisteredTool[] {
  return [
    createDelegateDispatchTool(service),
    createDelegateListTool(service),
    createDelegateGetTool(service),
    createDelegateCancelTool(service),
  ];
}

/**
 * `delegate_dispatch` — 非阻塞派发委派
 */
export function createDelegateDispatchTool(service: DelegateService): RegisteredTool {
  return {
    definition: {
      name: 'delegate_dispatch',
      // 委派不写文件：不借用 fs-* 能力标签，避免 denyCapabilities:['fs-write'] 误禁委派
      capabilities: [],
      description:
        'Delegate a task to another agent and return IMMEDIATELY with a delegation_id. ' +
        'Non-blocking: the child runs in its own session and this call does NOT wait for the result. ' +
        'Use delegate_get later (or wait for a delegation_status notice) to collect the result. ' +
        'Specify exactly one of `agent` (explicit id) or `trait` (resolve by trait tag).',
      parameters: {
        agent: {
          type: 'string',
          description: 'Target agentId (mutually exclusive with `trait`)',
        },
        trait: {
          type: 'string',
          description: 'Trait tag to resolve the target (mutually exclusive with `agent`)',
        },
        task: {
          type: 'string',
          description: 'What the child should accomplish (goes into the child user message)',
          required: true,
        },
        input: {
          type: 'string',
          description:
            'Explicit input material for the task. The child does NOT inherit your context.',
          required: true,
        },
        context: {
          type: 'string',
          enum: ['clean', 'fork'],
          description:
            "Context mode. 'clean' (default) starts the child with no parent history; 'fork' passes your message history for background.",
        },
        max_turns: {
          type: 'number',
          description: 'Turn budget for the child run (intersected with the target ceiling)',
        },
        max_tokens: {
          type: 'number',
          description: 'Token budget for the child run (intersected with the target ceiling)',
        },
        timeout_ms: {
          type: 'number',
          description: 'Delegation timeout in milliseconds',
        },
      },
    },
    handler: async (args, context) => {
      const agent = args.agent ? String(args.agent) : undefined;
      const trait = args.trait ? String(args.trait) : undefined;
      if ((agent && trait) || (!agent && !trait)) {
        return {
          ok: false,
          error: 'delegate_dispatch requires exactly one of `agent` or `trait`',
        };
      }

      const contextMode = args.context === 'fork' ? 'fork' : 'clean';
      const timeoutMs = args.timeout_ms != null ? Number(args.timeout_ms) : undefined;
      const maxTurns = args.max_turns != null ? Number(args.max_turns) : undefined;
      const maxTokens = args.max_tokens != null ? Number(args.max_tokens) : undefined;

      try {
        const { delegation, resolvedAgentId } = await service.dispatch({
          parent: {
            agentId: context.agentId,
            sessionId: context.sessionId,
            runId: context.runId ?? '',
          },
          // D3 权限随调用传播：父的有效权限作为子的天花板，不得借委派提权
          parentRights: await readRunSessionRights(),
          target: agent ? { agentId: agent } : { trait },
          task: String(args.task ?? ''),
          input: String(args.input ?? ''),
          context: contextMode as DelegationContextMode,
          // D1：传快照而非活数组引用——父 run 在子起跑后仍会 append
          parentMessages: contextMode === 'fork' ? context.messages.map((m) => ({ ...m })) : undefined,
          budget:
            maxTurns != null || maxTokens != null || timeoutMs != null
              ? { maxTurns, maxTokens, timeoutMs }
              : undefined,
          timeoutMs,
        });

        return {
          ok: true,
          delegation_id: delegation.id,
          resolved_agent_id: resolvedAgentId,
          status: delegation.status,
          note: 'Non-blocking: use delegate_get to collect the result later.',
        };
      } catch (err) {
        return resolutionFailure(err);
      }
    },
  };
}

/**
 * `delegate_list` — 列出委派单（poll 通道 / 全景）
 */
export function createDelegateListTool(service: DelegateService): RegisteredTool {
  return {
    definition: {
      name: 'delegate_list',
      capabilities: [],
      description:
        'List delegations issued from this session. Use to check progress of child agents ' +
        'you dispatched, or to find delegation ids to collect with delegate_get.',
      parameters: {
        status: {
          type: 'string',
          enum: ['queued', 'running', 'completed', 'failed', 'cancelled', 'timeout'],
          description: 'Filter by status',
        },
        active_only: {
          type: 'boolean',
          description: 'Only un-closed delegations (queued + running). Default false',
        },
      },
    },
    handler: async (args, context) => {
      const status = args.status as DelegationStatus | undefined;
      const activeOnly = Boolean(args.active_only);
      const items = service.list({
        parentSessionId: context.sessionId,
        status,
        activeOnly,
      });
      return {
        delegations: items.map(delegationSummary),
        total: items.length,
      };
    },
  };
}

/**
 * `delegate_get` — 取委派单详情 / 结果
 */
export function createDelegateGetTool(service: DelegateService): RegisteredTool {
  return {
    definition: {
      name: 'delegate_get',
      capabilities: [],
      description:
        'Get one delegation by id, including its result when finished. ' +
        'Returns status immediately if still running (this call does not block).',
      parameters: {
        delegation_id: {
          type: 'string',
          description: 'Delegation id from delegate_dispatch',
          required: true,
        },
      },
    },
    handler: async (args, context) => {
      const id = String(args.delegation_id ?? '');
      const record = service.get(id);
      if (!record) {
        return { ok: false, error: `Delegation not found: ${id}` };
      }
      // 归属校验：只能取本 session 发起的委派单
      if (record.parent.sessionId !== context.sessionId) {
        return { ok: false, error: `Delegation not owned by this session: ${id}` };
      }
      return { ok: true, ...delegationSummary(record) };
    },
  };
}

/**
 * `delegate_cancel` — 取消委派
 */
export function createDelegateCancelTool(service: DelegateService): RegisteredTool {
  return {
    definition: {
      name: 'delegate_cancel',
      capabilities: [],
      description:
        'Cancel a running or queued delegation. Fails if the delegation already reached a terminal state.',
      parameters: {
        delegation_id: {
          type: 'string',
          description: 'Delegation id to cancel',
          required: true,
        },
        reason: {
          type: 'string',
          description: 'Why it is being cancelled (recorded on the delegation)',
        },
      },
    },
    handler: async (args, context) => {
      const id = String(args.delegation_id ?? '');
      const existing = service.get(id);
      if (!existing) {
        return { ok: false, error: `Delegation not found: ${id}` };
      }
      if (existing.parent.sessionId !== context.sessionId) {
        return { ok: false, error: `Delegation not owned by this session: ${id}` };
      }
      try {
        const record = service.cancel(id, String(args.reason ?? 'cancelled by parent'));
        return { ok: true, ...delegationSummary(record) };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
