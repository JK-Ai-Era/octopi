/**
 * priv_exec 工具 — 白名单提权执行（ops P3，§5 P3 / §8）
 *
 * 独立 privileged 通道：引擎侧 execFile 执行完整 argv，不经 shell、不包 jail、
 * env 消毒、**cwd 钉住**（规则显式或 `/`，绝不取 agent 的 cwd）、超时真树杀。
 * shell 工具保持原牢笼语义不动（原则 6：提权不与牢笼抢轴）。
 *
 * 安全闸门（四道，全 fail-closed）：
 * 1. **全等匹配**（effect-policy `matchEscalationRule`）：cmd 绝对路径 + args 逐项全等；
 *    未命中/参数形态非法 → 拒绝 + `ops.escalation.denied` 留痕（不留痕的拒绝等于没拒）。
 * 2. **确认闸门**（规则 `confirm: true`）：HitlDecision 单模型（§8.2），缓存 key 含
 *    **完整 argv 全等**（§5 P3：防一次批准放行整类）；特权通道把 `approve_always`
 *    降格为 `approve_session`（永久放行特权 argv 过宽，保守语义）。
 * 3. **请求者授权**（§8.6 拍板）：由 SEC-2 `toolRights.deny('priv_exec')` 表达——
 *    缺权参与者在 toolRights 层即拒，连确认闸都到不了。
 * 4. **审计**（§7）：`ops.escalation.requested` → `ops.privileged.exec` / `denied`。
 *
 * `escalation.policy: full` 档属 P4（需 privilegedAck + 常驻 UI 标记并用），本工具不提供。
 */

import type { HitlDecision } from '@octopi-agent/core/types.js';
import type { RegisteredTool } from '@octopi-agent/core/types.js';
import { matchEscalationRule } from '../../execution-environment/effect-policy.js';
import {
  runPrivilegedExec,
  type EscalationRule,
  type EscalationPolicy,
} from '../../execution-environment/privileged-exec.js';
import {
  resolveHitlDecision,
  type HitlDecisionCache,
} from '../../../governance/human-in-the-loop/decision-cache.js';

/** 创建选项 */
export interface CreatePrivExecToolOptions {
  /** HITL 决策缓存（缺省全局 defaultHitlCache；测试/宿主可注入独立实例） */
  cache?: HitlDecisionCache;
}

/**
 * 创建 priv_exec 工具
 *
 * 参数：
 * - cmd (string, required)：可执行文件**绝对路径**（与规则逐字相同）
 * - args (string[], optional)：argv 尾部（与规则逐项全等）
 *
 * 返回：ruleId / exitCode / stdout / stderr / durationMs / confirmDecision。
 *
 * @param options - 可注入 HITL 缓存
 * @returns 注册好的提权工具
 */
export function createPrivExecTool(options?: CreatePrivExecToolOptions): RegisteredTool {
  return {
    definition: {
      name: 'priv_exec',
      // exec 标签：reduced 工具面（untrusted 降级）剥掉提权通道（降能力不降墙）
      capabilities: ['exec'],
      description:
        'Execute an allowlisted privileged command (exact match against effectPolicy.escalation.allow: absolute cmd + identical args). ' +
        'Runs engine-side without a shell or jail; env scrubbed; cwd pinned by the rule (default /); timeout + tree-kill. ' +
        'Commands not matching a rule are refused and audited (ops.escalation.denied). ' +
        'Rules with confirm:true pass a HITL gate keyed on the full argv. ' +
        'This is the only privilege-escalation channel — the shell tool stays jailed.',
      parameters: {
        cmd: {
          type: 'string',
          required: true,
          description: 'Absolute path of the executable, exactly as configured in the allow rule',
        },
        args: {
          type: 'array',
          items: { type: 'string', description: 'argument' },
          description: 'Arguments after cmd — must match the rule element-by-element (no prefix/regex matching)',
        },
      },
      timeoutMs: 120_000,
    },
    handler: async (args, context) => {
      const cmd = args.cmd;
      const rawArgs = args.args;
      const origin = {
        sessionId: context?.sessionId,
        agentId: context?.agentId,
        runId: context?.runId ?? null,
      };

      // 参数形态非法也必须留痕（拒了没记 = 盲区）
      const invalid = ((): string | null => {
        if (typeof cmd !== 'string' || cmd === '') return 'cmd must be a non-empty string';
        if (rawArgs !== undefined && (!Array.isArray(rawArgs) || rawArgs.some((a) => typeof a !== 'string'))) {
          return 'args must be an array of strings';
        }
        return null;
      })();
      if (invalid) {
        context?.recordOpsEvent?.({
          event: 'ops.escalation.denied',
          data: { argv: [String(cmd), ...(Array.isArray(rawArgs) ? rawArgs.map(String) : [])], why: 'invalid_args', origin },
        });
        throw new Error(`priv_exec: ${invalid}`);
      }
      const argvTail = (rawArgs as string[] | undefined) ?? [];
      // invalid 守卫已保证 cmd 为非空 string（TS 无法穿透闭包收窄，String() 为恒等转换）
      const cmdStr = String(cmd);
      const argv = [cmdStr, ...argvTail];

      const escalation: EscalationPolicy | undefined = context?.escalation;
      if (!escalation || escalation.policy === 'none') {
        context?.recordOpsEvent?.({
          event: 'ops.escalation.denied',
          data: { argv, why: 'policy_none', origin },
        });
        throw new Error('priv_exec disabled: effectPolicy.escalation.policy=none (enable allowlist to use priv_exec)');
      }

      const match = matchEscalationRule(escalation, cmdStr, argvTail);
      if (!match) {
        // 未命中即拒绝并留痕：拒绝必须可查（§7），否则注入探测就成了盲区
        context?.recordOpsEvent?.({
          event: 'ops.escalation.denied',
          data: { argv, why: 'not_allowlisted', origin },
        });
        throw new Error(
          'escalation_not_allowlisted: no allow rule matches this argv exactly (cmd absolute path + args element-by-element)',
        );
      }

      context?.recordOpsEvent?.({
        event: 'ops.escalation.requested',
        data: { ruleId: match.ruleId, argv, via: escalation.via, decision: 'pending', requester: origin },
      });

      let confirmDecision: 'approved' | 'auto' = 'auto';
      if (match.rule.confirm) {
        const allowed = await resolveHitlDecision({
          // 缓存 key 含完整 argv 全等（§5 P3）：一次 approve_session 只覆盖这一条命令
          key: `priv:${JSON.stringify(argv)}`,
          channel: 'effect',
          // session/always 缓存需要归属（缺归属 = 退化 one-shot）
          sessionId: context?.sessionId,
          agentId: context?.agentId,
          cache: options?.cache,
          ask: async () => {
            const decision: HitlDecision = await context?.confirmEffect?.({
              kind: 'shell',
              // 无歧义渲染：argv 数组的 JSON 形式（join(' ') 无法区分 args 边界与换行注入）
              command: JSON.stringify(argv),
              cwd: match.rule.cwd ?? '/',
            }) ?? 'deny';
            // 特权通道保守语义：approve_always 永久放行特权 argv 过宽 → 降格 session 级
            return decision === 'approve_always' ? 'approve_session' : decision;
          },
        });
        if (!allowed) {
          context?.recordOpsEvent?.({
            event: 'ops.escalation.denied',
            data: { ruleId: match.ruleId, argv, why: 'confirm_denied', origin },
          });
          throw new Error(`escalation_confirm_denied: ${JSON.stringify(argv)}`);
        }
        confirmDecision = 'approved';
      }

      const result = await runPrivilegedExec({
        cmd: cmdStr,
        args: argvTail,
        via: escalation.via,
        // cwd 钉住：规则显式或 `/`——agent 的 cwd 无权决定特权进程在哪解析相对路径
        cwd: (match.rule as EscalationRule).cwd ?? '/',
        timeoutMs: 120_000,
      });

      context?.recordOpsEvent?.({
        event: 'ops.privileged.exec',
        data: {
          ruleId: match.ruleId,
          argv,
          via: escalation.via,
          confirmDecision,
          executed: result.executed,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          origin,
        },
      });

      if (!result.executed) {
        // 「未执行」≠「执行失败」：spawn 都没起来，业务结果不冒充执行
        throw new Error(`priv_exec_spawn_failed: ${result.stderr}`);
      }

      return {
        ruleId: match.ruleId,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        confirmDecision,
      };
    },
  };
}
