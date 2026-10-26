/**
 * priv_exec 工具 — 白名单提权执行（ops P3，§5 P3 / §8）
 *
 * 独立 privileged 通道：引擎侧 execFile 执行完整 argv，不经 shell、不包 jail、
 * env 消毒、**cwd 钉住**（规则显式或 `/`，绝不取 agent 的 cwd）、超时真树杀。
 * shell 工具保持原牢笼语义不动（原则 6：提权不与牢笼抢轴）。
 *
 * 安全闸门（全 fail-closed）：
 * 1. **匹配面**（effect-policy `matchEscalationRule`）：`allowlist` 档 cmd 绝对路径 +
 *    args 逐项全等；`full` 档（P4，需 privilegedAck + jail=none + mode=host）无
 *    allowlist 面，但 `via: sudo` 仍必须显式 `sudo -n` 形态（裸跑 = 非特权通道假象）。
 *    未命中/形态非法 → 拒绝 + `ops.escalation.denied` 留痕（不留痕的拒绝等于没拒）。
 * 2. **确认闸门**：规则 `confirm: true`（allowlist）或 §6 危险分类命中（full 档）走
 *    HitlDecision 单模型（§8.2），缓存 key 含**完整 argv 全等**（§5 P3：防一次批准
 *    放行整类）；特权通道把 `approve_always` 降格为 `approve_session`。
 *    **确认超时一律 deny**（T1 硬约束，outcome 不可配）。
 * 3. **请求者授权**（§8.6 拍板）：由 SEC-2 `toolRights.deny('priv_exec')` 表达——
 *    缺权参与者在 toolRights 层即拒，连确认闸都到不了。
 * 4. **审计**（§7）：`ops.escalation.requested` → `ops.privileged.exec` / `denied`。
 *
 * `full` 档的 §6 分类是**减速带不是安全边界**（只拦事故不拦攻击）：未命中自动放行，
 * 不做「未知即危险」；真正的边界是 privilegedAck + 常驻 PRIVILEGED 标记 + 审计。
 */

import { isAbsolute } from 'node:path';
import type { HitlDecision } from '@octopi-agent/core/types.js';
import type { RegisteredTool } from '@octopi-agent/core/types.js';
import { matchEscalationRule } from '../../execution-environment/effect-policy.js';
import { classifyDangerousArgv } from '../../execution-environment/dangerous-commands.js';
import {
  runPrivilegedExec,
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
 * 确认闸计时（T1 硬约束：超时 = 拒绝，outcome 不可配）。
 * 超时后宿主再批也无效（decision 已按 deny 定案）——宁可重请求，不可放马后炮。
 *
 * @param ask - 宿主确认回调
 * @param timeoutMs - 超时毫秒
 * @returns 决策 + 是否超时（审计 why: confirm_timeout / confirm_denied 可分辨）
 */
async function askWithTimeout(
  ask: () => Promise<HitlDecision>,
  timeoutMs: number,
): Promise<{ decision: HitlDecision; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ decision: HitlDecision; timedOut: boolean }>((res) => {
    timer = setTimeout(() => res({ decision: 'deny', timedOut: true }), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      ask().then((decision) => ({ decision, timedOut: false })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
        'Execute a privileged command through the engine-side privileged channel. ' +
        'Under effectPolicy.escalation.policy=allowlist the argv must match an allow rule exactly (absolute cmd + identical args); ' +
        'under policy=full any absolute argv is accepted (via:sudo must spell `sudo -n <target…>`). ' +
        'Runs without a shell or jail; env scrubbed; cwd pinned by the rule (default /); timeout + tree-kill. ' +
        'Refused argv is audited (ops.escalation.denied). Rules with confirm:true — and any argv hitting the ' +
        'dangerous-command table under full — pass a HITL gate keyed on the full argv; confirm timeout is deny. ' +
        'This is the only privilege-escalation channel.',
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
        // ops P5「参与者身份入账」：请求者是谁（SEC-2 角色绑定）——确认 ≠ 请求者可信
        participants: context?.sessionParticipants ?? [],
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
        throw new Error('priv_exec disabled: effectPolicy.escalation.policy=none (enable allowlist/full to use priv_exec)');
      }

      // 匹配面：allowlist = cmd+args 全等；full（P4）= 全量档，仅校验形态（绝对路径 + sudo 显式形态）
      let ruleId: string;
      let ruleConfirm = false;
      let ruleCwd: string | undefined;
      if (escalation.policy === 'full') {
        if (!isAbsolute(cmdStr)) {
          context?.recordOpsEvent?.({
            event: 'ops.escalation.denied',
            data: { argv, why: 'invalid_args', origin },
          });
          throw new Error('priv_exec: cmd must be an absolute path (PATH resolution = replaceable binary)');
        }
        if (escalation.via === 'sudo') {
          // full 档仍必须显式 `sudo -n <target…>` 形态：裸跑 = 非特权通道假象（与 allowlist 形态规则同构）
          const base = cmdStr.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
          const spellsSudo = base === 'sudo' || base === 'doas';
          if (!spellsSudo || argvTail[0] !== '-n') {
            context?.recordOpsEvent?.({
              event: 'ops.escalation.denied',
              data: { argv, why: 'invalid_args', origin },
            });
            throw new Error(
              'priv_exec: full policy via=sudo must spell `sudo -n <target…>` explicitly (cmd = /usr/bin/sudo, args[0] = "-n")',
            );
          }
        }
        ruleId = 'full';
      } else {
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
        ruleId = match.ruleId;
        ruleConfirm = match.rule.confirm === true;
        ruleCwd = match.rule.cwd;
      }

      // §6 危险分类（full 档 pre-exec 闸）：命中走确认/deny，未命中放行（不做「未知即危险」）。
      // allowlist 档由规则 confirm 显式表态，不叠加分类——规则作者已逐条裁决。
      let dangerousPattern: string | undefined;
      let needsConfirm = ruleConfirm;
      if (escalation.policy === 'full') {
        const verdict = classifyDangerousArgv(argv);
        if (verdict.dangerous) {
          dangerousPattern = verdict.pattern;
          const gatePolicy = context?.dangerousCommands?.policy ?? 'confirm';
          if (gatePolicy === 'deny') {
            context?.recordOpsEvent?.({
              event: 'ops.escalation.denied',
              data: { ruleId, argv, why: 'dangerous_denied', dangerous: dangerousPattern, origin },
            });
            throw new Error(
              `escalation_dangerous_denied: ${JSON.stringify(argv)} hit \`${dangerousPattern}\` (dangerousCommands.policy=deny)`,
            );
          }
          if (gatePolicy === 'confirm') needsConfirm = true;
          // 'off'：分类关闭——命中仍入审计（留痕不设闸），但不拦
        }
      }

      context?.recordOpsEvent?.({
        event: 'ops.escalation.requested',
        data: {
          ruleId,
          argv,
          via: escalation.via,
          decision: 'pending',
          requester: origin,
          ...(dangerousPattern !== undefined ? { dangerous: dangerousPattern } : {}),
        },
      });

      let confirmDecision: 'approved' | 'auto' = 'auto';
      // P5 确认人入账：谁批的、经哪条通道（宿主归因；未知如实缺省，不编造）
      let confirmedBy: string | undefined;
      let confirmChannel: string | undefined;
      if (needsConfirm) {
        // 确认超时一律 deny（T1 硬约束，outcome 不可配）；超时/显式 deny 在审计里可分辨
        const confirmTimeoutMs = context?.dangerousCommands?.timeoutMs ?? 120_000;
        let timedOut = false;
        const allowed = await resolveHitlDecision({
          // 缓存 key 含完整 argv 全等（§5 P3）：一次 approve_session 只覆盖这一条命令
          key: `priv:${JSON.stringify(argv)}`,
          channel: 'effect',
          // session/always 缓存需要归属（缺归属 = 退化 one-shot）
          sessionId: context?.sessionId,
          agentId: context?.agentId,
          cache: options?.cache,
          ask: async () => {
            const outcome = await askWithTimeout(async () => {
              const raw =
                (await context?.confirmEffect?.({
                  kind: 'shell',
                  // 无歧义渲染：argv 数组的 JSON 形式（join(' ') 无法区分 args 边界与换行注入）
                  command: JSON.stringify(argv),
                  cwd: ruleCwd ?? '/',
                })) ?? 'deny';
              // 裸 HitlDecision 或 ConfirmOutcome（带归因）都合法
              const normalized: { decision: HitlDecision; approver?: string; channel?: string } =
                typeof raw === 'string' ? { decision: raw } : raw;
              if (normalized.approver !== undefined) confirmedBy = normalized.approver;
              if (normalized.channel !== undefined) confirmChannel = normalized.channel;
              // 特权通道保守语义：approve_always 永久放行特权 argv 过宽 → 降格 session 级
              return normalized.decision === 'approve_always' ? 'approve_session' : normalized.decision;
            }, confirmTimeoutMs);
            timedOut = outcome.timedOut;
            return outcome.decision;
          },
        });
        if (!allowed) {
          context?.recordOpsEvent?.({
            event: 'ops.escalation.denied',
            data: {
              ruleId,
              argv,
              why: timedOut ? 'confirm_timeout' : 'confirm_denied',
              ...(dangerousPattern !== undefined ? { dangerous: dangerousPattern } : {}),
              origin,
            },
          });
          throw new Error(
            timedOut
              ? `escalation_confirm_timeout: no decision within ${confirmTimeoutMs}ms — timeout is deny (not configurable): ${JSON.stringify(argv)}`
              : `escalation_confirm_denied: ${JSON.stringify(argv)}`,
          );
        }
        confirmDecision = 'approved';
      }

      const result = await runPrivilegedExec({
        cmd: cmdStr,
        args: argvTail,
        via: escalation.via,
        // cwd 钉住：规则显式或 `/`——agent 的 cwd 无权决定特权进程在哪解析相对路径
        cwd: ruleCwd ?? '/',
        timeoutMs: 120_000,
      });

      context?.recordOpsEvent?.({
        event: 'ops.privileged.exec',
        data: {
          ruleId,
          argv,
          via: escalation.via,
          confirmDecision,
          executed: result.executed,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          ...(dangerousPattern !== undefined ? { dangerous: dangerousPattern } : {}),
          ...(confirmedBy !== undefined ? { confirmedBy } : {}),
          ...(confirmChannel !== undefined ? { confirmChannel } : {}),
          origin,
        },
      });

      if (!result.executed) {
        // 「未执行」≠「执行失败」：spawn 都没起来，业务结果不冒充执行
        throw new Error(`priv_exec_spawn_failed: ${result.stderr}`);
      }

      return {
        ruleId,
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
