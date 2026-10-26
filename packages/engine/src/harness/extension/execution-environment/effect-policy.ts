/**
 * ToolEffectPolicy P3 — 运行模式预设与有效策略
 *
 * 命名模式（workspace / project / host / untrusted）展开为正交旋钮。
 * 见 arch/tool-effect-policy.md §7。
 */

import { isAbsolute, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { expandHomePath } from '../../../paths.js';
import type { HitlDecision } from '@octopi-agent/core/types/tools.js';
import type { ToolIsolationMode } from './isolation.js';
import type { EscalationPolicy, EscalationRule } from './privileged-exec.js';
import {
  checkEscalationBinary,
  escalationRuleTargets,
  escalationWritableRoots,
} from './privileged-exec.js';
import {
  deniesReducedSurface,
  resolveToolCapabilities,
} from './tool-capabilities.js';
import {
  assessL4ProcessMinimum,
  type ProcessIsolationProfile,
} from './process-isolation.js';
import { resolveHitlOutcome } from '../../governance/human-in-the-loop/decision-cache.js';
import { getRunSessionId, getRunScope } from '../../run/run-scope.js';

/** 命名运行模式 */
export type EffectRunMode = 'workspace' | 'project' | 'host' | 'untrusted';

/**
 * Engine default when `effectPolicy.mode` is omitted (secure-by-default).
 * Scaffold/`octopi init` / `octopi.example.json` set `mode: "host"` explicitly
 * so evaluation gets full capability; embedders who omit `mode` get `workspace`.
 * See `docs/process-isolation.md`.
 */
export const DEFAULT_EFFECT_RUN_MODE: EffectRunMode = 'workspace';

/** 路径包含级别（L2） */
export type PathContainment = 'strict' | 'soft' | 'none';

/** shell 工具策略（非「越界」；无 L4 时 deny=拒绝整个 shell） */
export type ShellEscapePolicy = 'deny' | 'confirm' | 'allow';

/** commit 策略 */
export type EffectCommitPolicy = 'auto' | 'manual';

/** 效应确认通道 */
/** 效应意图（host-gate confirmEffect 入参） */
export type EffectIntent = EffectIntentPayload & {
  /** 引擎侧确认窗（毫秒）：宿主卡片生命周期须严格晚于它结束（见 core confirmEffect 契约） */
  timeoutMs?: number;
};

type EffectIntentPayload =
  | {
      kind: 'file.write';
      path: string;
      mode: 'create' | 'overwrite' | 'append' | 'edit';
      /** 是否落在事务 root 内（可 undo） */
      transactional: boolean;
    }
  | {
      kind: 'shell';
      command: string;
      cwd?: string;
    }
  | {
      /** project_run / package_install — executes workspace-defined scripts. Not shellEscape-gated. */
      kind: 'runner';
      command: string;
      cwd?: string;
      description?: string;
    }
  | {
      /** Local VCS porcelain (git). Not shellEscape-gated. */
      kind: 'vcs';
      operation: string;
      cwd?: string;
      description?: string;
    }
  | {
      kind: 'memory.write';
      domain: 'memory' | 'cognition' | 'wisdom';
      transactional: true;
    }
  | {
      kind: 'other';
      description: string;
    };

export type ConfirmEffectDecision = HitlDecision;

/**
 * host-gate 确认回调（P4）。engine 不内置审批 UI。
 * 宿主可自动放行 / 弹自己的确认框 / 策略引擎。
 * 返回 {@link HitlDecision}；session/always 由引擎 HitlDecisionCache 记账。
 */
export type ConfirmEffect = NonNullable<
  import('@octopi-agent/core/types/tools.js').ToolExecutionContext['confirmEffect']
>;

export type EffectConfirmChannel = 'engine' | 'host-gate';

/** shell 记账深度（§5.6）：snapshot=采 before 可逆；off=只知情 */
export type ShellJournalMode = 'snapshot' | 'off';

/** How to admit `untrusted` when L4 process jail is missing */
export type UntrustedAdmission = 'refuse' | 'degrade';

/**
 * 进程牢笼意图（ops P0，`arch/ops-privileged-mode.md` §4）：
 * `auto` = 按模式派生（缺笼如实降级）| `require` = 拿不到即拒 | `none` = 显式无笼（需 privilegedAck）。
 * 「主动选择无约束」与「被动失去约束」必须可区分——授权 ≠ 降级。
 */
export type JailIntent = 'auto' | 'require' | 'none';

/** jail 意图落空时的行为：`refuse` 拒绝执行 | `degrade` 记 securityDegraded + 告警（禁止静默） */
export type OnJailUnavailable = 'refuse' | 'degrade';
export type { EscalationPolicy, EscalationRule };

/** run 开始即记录的 jail 状态（意图 × 实测后端）——「授权」与「故障」的事后判据 */
export interface OpsJailState {
  /** 配置意图 */
  intent: JailIntent;
  /** 实测 ProcessIsolationProfile.backend */
  backend: import('./process-isolation.js').IsolationBackend | 'unknown';
  /** L4 最小判据是否成立（intent=none 时仅作事实上报） */
  jailAvailable: boolean;
  /** true = 授权态（显式 none / 笼按意图就位）；false = 故障或缺失（降级路径） */
  authorized: boolean;
  /** 本 run 的 securityDegraded 代码 */
  degraded: string[];
}

/** Effective tool surface after isolation admission */
export type ToolSurface = 'full' | 'reduced';

/** Machine-readable degradations (never silent) */
export type SecurityDegradation =
  | 'no_process_jail'
  | 'network_open'
  | 'env_inherit'
  | 'privilege_same'
  | 'filesystem_not_jailed';

/** 配置形状（可覆盖预设） */
export interface EffectPolicyConfig {
  /**
   * Omitted = `DEFAULT_EFFECT_RUN_MODE` (**workspace**, secure-by-default).
   * Scaffold/config templates set `"mode": "host"` explicitly for local evaluation.
   */
  mode?: EffectRunMode;
  /**
   * `untrusted` 无 L4 时：`refuse`（缺省，第三方）拒绝运行；
   * `degrade` 降 effectiveMode + toolSurface=reduced + securityDegraded。
   */
  untrustedAdmission?: UntrustedAdmission;
  /** 额外事务 root（绝对路径或 ~ 形态，入口 trim → expand）；并入 allowRoots */
  transactionRoots?: string[];
  pathContainment?: PathContainment;
  shellEscape?: ShellEscapePolicy;
  /**
   * Jail network posture (D4-c). Omitted = mode default:
   * host/project → `open`, workspace/untrusted → `deny`.
   */
  network?: 'open' | 'deny' | 'allowlist';
  processLimits?: boolean;
  commit?: EffectCommitPolicy;
  /** commit=manual 时会话关闭/超时如何收残留 undo */
  onClose?: 'commit' | 'discard';
  effects?: EffectConfirmChannel;
  /** 覆盖模式推导的 toolIsolation */
  toolIsolation?: ToolIsolationMode;
  /** undo 配额；缺省不限。撞顶停记 before，业务写继续 */
  undoLimit?: { maxEntries?: number; maxBlobBytes?: number };
  /** shell 记账深度；缺省 snapshot */
  shellJournal?: ShellJournalMode;
  /** shell 清点/快照预算；缺省不限 */
  shellJournalLimit?: { maxFiles?: number; maxBytes?: number; maxFileSize?: number };
  /** 进程牢笼意图；缺省 `auto`（按模式派生，缺笼如实降级 + 告警） */
  jail?: JailIntent;
  /** jail≠none 且笼不可用时：`refuse` 拒绝执行 | `degrade`（缺省）记 securityDegraded + 告警 */
  onJailUnavailable?: OnJailUnavailable;
  /** `jail: "none"` 时必填的显式表态（缺省拒绝启动；§8.1 二级确认）。root/elevated
   *  部署同样要求此声明（§5 P4 root 部署语义，启动期断言）。 */
  privilegedAck?: string;
  /** 提权策略（§4/§5 P3/P4）：`allowlist` 按 cmd+args 全等放行；`full` 全量档
   *  （需 `jail: "none"` + `privilegedAck` + `mode: "host"`）；缺省 `none` */
  escalation?: {
    policy?: 'none' | 'allowlist' | 'full';
    via?: 'sudo' | 'direct';
    allow?: EscalationRule[];
  };
  /**
   * 危险命令确认（§6：减速带而非安全边界）：命中保守分类表的 argv 要求确认。
   * `policy`：`confirm`（缺省，走 HitlDecision）| `deny`（直接拒绝）| `off`（关闭分类）。
   * `timeoutMs`：确认超时（超时一律 deny，不可配 outcome）；缺省 120000。
   */
  dangerousCommands?: {
    policy?: 'confirm' | 'deny' | 'off';
    timeoutMs?: number;
  };
  /** ops 审计账本开关（安全字段：重启生效 + 宿主署名，§4.3）；缺省 `on` */
  opsAudit?: 'on' | 'off';
  /** ops 审计账本路径（缺省 `<OCTOPI_HOME>/audit/ops.<agentId>.jsonl`） */
  opsAuditPath?: string;
  /**
   * 审计外送收口路径（P5 唯一不可抵赖档，原则 8）；缺省不外送。
   * **必须放在 agent 可写面之外**（`~/.octopi` 在 host 模式可写面内——放那里等于没外送）。
   * 每条账目以信封（count=seq + tailHash 锚点 + entry 原样）append-only 外送，宿主可重验链。
   */
  opsAuditExportPath?: string;
}

/** 展开后的有效策略 */
export interface EffectiveEffectPolicy {
  /** Configured/requested mode (audit trail) */
  requestedMode: EffectRunMode;
  /**
   * Effective mode after untrusted admission.
   * Equals `requestedMode` when isolation is sufficient (or mode ≠ untrusted).
   */
  mode: EffectRunMode;
  untrustedAdmission: UntrustedAdmission;
  /** `reduced` strips shell/http/MCP-style power when untrusted degrades */
  toolSurface: ToolSurface;
  /** Non-empty when isolation is weaker than requested */
  securityDegraded: SecurityDegradation[];
  toolIsolation: ToolIsolationMode;
  pathContainment: PathContainment;
  shellEscape: ShellEscapePolicy;
  /** Resolved jail network posture */
  network: 'open' | 'deny' | 'allowlist';
  processLimits: boolean;
  commit: EffectCommitPolicy;
  onClose: 'commit' | 'discard';
  effects: EffectConfirmChannel;
  /** L2 允许根（含 workspace + transactionRoots） */
  allowRoots: string[];
  /** 事务 root 语义标签 */
  transactionRoots: Array<'workspace' | 'memory' | 'host'>;
  undoLimit?: { maxEntries?: number; maxBlobBytes?: number };
  shellJournal: ShellJournalMode;
  shellJournalLimit?: { maxFiles?: number; maxBytes?: number; maxFileSize?: number };
  /** 进程牢笼意图（auto/require/none） */
  jail: JailIntent;
  /** jail 意图落空时的行为（refuse/degrade） */
  onJailUnavailable: OnJailUnavailable;
  /** 提权策略（ops P3/P4，resolved） */
  escalation: EscalationPolicy;
  /**
   * 特权部署标记（§5 P4 / §8.1）：`jail: "none"`（授权无笼）或 `escalation.policy: "full"`
   * （全量提权）即为特权上下文。root/elevated 进程维度由启动期探测叠加（UI 常驻
   * `PRIVILEGED` 标记的数据源）。**授权态 ≠ 降级**：此标记不进 securityDegraded。
   */
  privileged: boolean;
  /** 危险命令减速带（§6）resolved：分类策略 + 确认超时（超时一律 deny） */
  dangerousCommands: { policy: 'confirm' | 'deny' | 'off'; timeoutMs: number };
  /** ops 审计账本开关（ops P2） */
  opsAudit: 'on' | 'off';
  /** ops 审计账本路径覆盖 */
  opsAuditPath?: string;
  /** 审计外送收口路径（P5；缺省不外送） */
  opsAuditExportPath?: string;
}

type ModePreset = Omit<
  EffectiveEffectPolicy,
  | 'allowRoots'
  | 'transactionRoots'
  | 'requestedMode'
  | 'untrustedAdmission'
  | 'toolSurface'
  | 'securityDegraded'
  | 'jail'
  | 'onJailUnavailable'
  | 'opsAudit'
  | 'opsAuditPath'
  | 'opsAuditExportPath'
  | 'escalation'
  | 'privileged'
  | 'dangerousCommands'
>;

const MODE_DEFAULTS: Record<EffectRunMode, ModePreset> = {
  workspace: {
    mode: 'workspace',
    toolIsolation: 'session-subdir',
    pathContainment: 'strict',
    // 无 L4 时无法「只禁越界」：deny = 拒绝 shell 工具（fail-closed）
    shellEscape: 'deny',
    network: 'deny',
    processLimits: true,
    commit: 'auto',
    onClose: 'commit',
    effects: 'engine',
    shellJournal: 'snapshot',
  },
  project: {
    mode: 'project',
    toolIsolation: 'session-subdir',
    pathContainment: 'strict',
    // 编码 agent 必须有 shell；文件侧靠 L2，shell FS 越界待 L4
    shellEscape: 'allow',
    network: 'open',
    processLimits: true,
    commit: 'auto',
    onClose: 'commit',
    effects: 'engine',
    shellJournal: 'snapshot',
  },
  host: {
    mode: 'host',
    toolIsolation: 'none',
    pathContainment: 'none',
    shellEscape: 'allow',
    network: 'open',
    processLimits: true,
    commit: 'auto',
    onClose: 'commit',
    effects: 'engine',
    shellJournal: 'snapshot',
  },
  untrusted: {
    mode: 'untrusted',
    toolIsolation: 'session-subdir',
    pathContainment: 'strict',
    shellEscape: 'deny',
    network: 'deny',
    processLimits: true,
    commit: 'auto',
    onClose: 'discard',
    effects: 'engine',
    shellJournal: 'snapshot',
  },
};

/**
 * Whether the resolved policy demands a process jail — fail-closed when the
 * jail cannot be applied (ops P0: `jail: require`, `onJailUnavailable: refuse`,
 * or untrusted that survived untrusted admission). Single predicate shared by
 * the run path (runner) and host-side read surfaces (WebUI git status endpoint)
 * so the isolation level never drifts between them.
 *
 * @param eff - resolved effective policy
 * @returns true when a missing/broken jail must refuse execution
 */
export function requiresJail(eff: EffectiveEffectPolicy): boolean {
  // jail=none 是授权无笼：onJailUnavailable 对它无意义，不得误报「要求笼」
  if (eff.jail === 'none') return false;
  if (eff.jail === 'require' || eff.onJailUnavailable === 'refuse') return true;
  return eff.requestedMode === 'untrusted' && eff.mode === 'untrusted';
}

/**
 * 白名单提权全等匹配（§5 P3）：`cmd` 绝对路径比对 + `args` 逐项全等。
 * 不做前缀/正则/插值——任何「宽松匹配」都会把 allowlist 变成任意命令通道。
 *
 * @param escalation - resolved 提权策略
 * @param cmd - 请求的可执行文件（必须与规则逐字相同）
 * @param args - 请求的 argv 尾部
 * @returns 命中的规则与稳定 ruleId；未命中 null
 */
export function matchEscalationRule(
  escalation: EscalationPolicy,
  cmd: string,
  args: readonly string[],
): { rule: EscalationRule; ruleId: string } | null {
  if (escalation.policy !== 'allowlist') return null;
  for (let i = 0; i < escalation.allow.length; i += 1) {
    const rule = escalation.allow[i]!;
    const ruleArgs = rule.args ?? [];
    if (
      rule.cmd === cmd &&
      ruleArgs.length === args.length &&
      ruleArgs.every((a, idx) => a === args[idx])
    ) {
      // 显式 id 优先（下标 id 在规则重排后会断裂审计关联）
      return { rule, ruleId: rule.id ?? `allow[${i}]` };
    }
  }
  return null;
}

/**
 * 构造 run 开始即记录的 `ops.jail.state`（意图 × 实测后端）。
 * 「主动选择无约束」（authorized, intent=none）与「被动失去约束」
 * （authorized=false, 缺笼降级）事后可分辨即靠这条记录。
 *
 * @param eff - 解析后的有效策略
 * @param isolation - probe 到的隔离画像（缺省按「无笼」）
 * @returns jail 状态记录
 */
export function buildOpsJailState(
  eff: EffectiveEffectPolicy,
  isolation?: ProcessIsolationProfile,
): OpsJailState {
  const l4 = isolation ? assessL4ProcessMinimum(isolation) : { ok: false };
  const jailAvailable = l4.ok;
  return {
    intent: eff.jail,
    backend: isolation?.backend ?? 'unknown',
    jailAvailable,
    // none = 授权无笼；其余意图下只有笼按意图就位才是授权态
    authorized: eff.jail === 'none' || jailAvailable,
    degraded: [...eff.securityDegraded],
  };
}

/**
 * 展开 effectPolicy 为有效策略
 *
 * @param config - 用户配置（mode 可省略，缺省 `DEFAULT_EFFECT_RUN_MODE`）
 * @param baseWorkspace - 工具基路径（agent.workspace / RunConfig.cwd）
 * @returns 有效策略
 */
/**
 * Expand effectPolicy into an effective policy.
 *
 * `untrusted` requires an L4 process profile. When the host cannot offer it:
 * - `untrustedAdmission: 'refuse'` (default) throws
 * - `untrustedAdmission: 'degrade'` renames effectiveMode to workspace,
 *   sets toolSurface=reduced, and records securityDegraded[] (never silent)
 *
 * @param config - user config (mode optional)
 * @param baseWorkspace - tool base path
 * @param isolation - probed process isolation (optional; treated as supervised if absent)
 * @returns effective policy with requested vs effective mode
 * @throws Error when untrusted is refused
 */
export function resolveEffectiveEffectPolicy(
  config: EffectPolicyConfig,
  baseWorkspace?: string,
  isolation?: ProcessIsolationProfile,
): EffectiveEffectPolicy {
  // `~` 前缀收口展开（Windows/Linux/macOS 通用）：下游 allowRoots / tool cwd 只见
  // 绝对路径；配置层（ConfigPathSchema）已先拒相对路径。顺序固定「trim → expand」，
  // 库调用面传入带空白的 ` ~/x` 同样归一。
  config = {
    ...config,
    ...(config.transactionRoots
      ? { transactionRoots: config.transactionRoots.map((r) => expandHomePath(r.trim())) }
      : {}),
  };
  baseWorkspace =
    baseWorkspace !== undefined ? expandHomePath(baseWorkspace.trim()) : baseWorkspace;
  const requestedMode = config.mode ?? DEFAULT_EFFECT_RUN_MODE;
  const untrustedAdmission = config.untrustedAdmission ?? 'refuse';
  // ops P0：jail 意图先解析；**纯配置矛盾 fail-closed 先于任何探测分支**——
  // 矛盾是配置事实，不该被「先撞上缺笼」抢先抛成另一种错误
  const jail: JailIntent = config.jail ?? 'auto';
  const onJailUnavailable: OnJailUnavailable = config.onJailUnavailable ?? 'degrade';
  // ops P4 §4.1：full 档纯配置矛盾——同上原则，先于任何探测分支（矛盾是配置事实，
  // 不该被「先撞上缺笼/缺 ack」抢先抛成另一种错误）
  if (config.escalation?.policy === 'full') {
    if (requestedMode !== 'host') {
      throw new Error(
        'effect_policy_invalid: escalation.policy=full requires mode=host (explicitly designated machine)',
      );
    }
    if (jail !== 'none') {
      throw new Error(
        'effect_policy_invalid: escalation.policy=full requires jail=none (whole-shell freedom contradicts a jailed shell)',
      );
    }
    if (!config.privilegedAck?.trim()) {
      throw new Error(
        'effect_policy_invalid: escalation.policy=full requires effectPolicy.privilegedAck (explicit privileged declaration)',
      );
    }
    if ((config.escalation.allow ?? []).length > 0) {
      // 死键 fail-loud：full 档没有 allowlist 面，静默忽略会误导配置读者
      throw new Error(
        'effect_policy_invalid: escalation.policy=full takes no escalation.allow rules (remove them, or use policy=allowlist)',
      );
    }
  }
  if (jail === 'none') {
    if (requestedMode === 'untrusted') {
      throw new Error(
        'effect_policy_invalid: jail=none cannot combine with mode=untrusted (untrusted promises a jail)',
      );
    }
    if (!config.privilegedAck?.trim()) {
      throw new Error(
        'effect_policy_invalid: jail=none requires effectPolicy.privilegedAck (explicit unjailed choice)',
      );
    }
    if (onJailUnavailable === 'refuse') {
      // 死键 fail-loud：none 下该旋钮无指代，静默忽略会误导配置读者
      throw new Error(
        'effect_policy_invalid: onJailUnavailable=refuse has no meaning under jail=none (remove it, or use jail=auto/require)',
      );
    }
    if (config.network === 'deny' || config.network === 'allowlist') {
      // 网络限制只由 jail 实施：无笼时 deny/allowlist 是无法兑现的承诺，拒绝作假
      throw new Error(
        'effect_policy_invalid: network=deny/allowlist cannot be enforced under jail=none (network is jail-implemented only)',
      );
    }
    // 授权无笼：不为 jail 记 securityDegraded（这是授权，不是降级）
  } else if ((jail === 'require' || onJailUnavailable === 'refuse') && untrustedAdmission === 'degrade') {
    throw new Error(
      'effect_policy_invalid: jail=require/onJailUnavailable=refuse contradicts untrustedAdmission=degrade (same condition, opposite outcomes)',
    );
  }
  let mode = requestedMode;
  let toolSurface: ToolSurface = 'full';
  const securityDegraded: SecurityDegradation[] = [];

  if (requestedMode === 'untrusted') {
    const profile = isolation;
    const l4 = profile ? assessL4ProcessMinimum(profile) : { ok: false, missing: ['processTree'] as const };
    if (!l4.ok) {
      if (config.jail === 'require' || config.onJailUnavailable === 'refuse') {
        // jail 意图 fail-closed 优先且错误码/建议指向 jail 旋钮（untrustedAdmission=degrade
        // 与该组合矛盾，配置校验已拒，不能在这里推荐它）
        throw new Error(
          `jail_required_unavailable: effectPolicy.jail=${config.jail ?? 'auto'} ` +
            `(onJailUnavailable=${config.onJailUnavailable ?? 'degrade'}) but no process jail ` +
            `(missing: ${l4.missing.join(', ')}). Install bwrap/sandbox-exec, or set jail=none with privilegedAck.`,
        );
      }
      if (untrustedAdmission === 'refuse') {
        throw new Error(
          `untrusted_refused: L4 process jail unavailable (missing: ${l4.missing.join(', ')}). ` +
            `Install bwrap/sandbox-exec or set effectPolicy.untrustedAdmission=degrade.`,
        );
      }
      // degrade: rename + strip power, do not keep the untrusted label
      mode = 'workspace';
      toolSurface = 'reduced';
      securityDegraded.push('no_process_jail');
      if (profile?.filesystem === 'none' || profile?.filesystem === 'cwd-pin') {
        securityDegraded.push('filesystem_not_jailed');
      }
      if (profile?.privilege === 'same') securityDegraded.push('privilege_same');
      if (profile?.envHygiene === 'inherit') securityDegraded.push('env_inherit');
    }
    // Declare open egress whenever the host cannot close it — not only when
    // effective mode is still named untrusted (degrade renames mode first).
    if (isolation?.network === 'open') {
      securityDegraded.push('network_open');
    }
  }

  // ops P0：jail 可用性申报（纯配置矛盾已在上方先拒）。授权（none）≠ 降级（缺笼）。
  if (jail !== 'none') {
    const l4 = isolation
      ? assessL4ProcessMinimum(isolation)
      : { ok: false as const, missing: ['processTree'] as const };
    if (!l4.ok) {
      if (jail === 'require' || onJailUnavailable === 'refuse') {
        throw new Error(
          `jail_required_unavailable: effectPolicy.jail=${jail} (onJailUnavailable=${onJailUnavailable}) ` +
            `but no process jail (missing: ${l4.missing.join(', ')}). ` +
            `Install bwrap/sandbox-exec, or set jail=none with privilegedAck.`,
        );
      }
      // degrade：run 级如实申报（untrusted 降级路径可能已记，去重）
      if (!securityDegraded.includes('no_process_jail')) securityDegraded.push('no_process_jail');
    }
  }

  // ops P3：提权策略（§4.1）。纯配置矛盾 fail-closed；allowlist 二进制 TOCTOU 护栏
  // 同步兜底（库路径无 daemon 启动探测时也不能放行可换二进制）。
  const escalation: EscalationPolicy = {
    policy: config.escalation?.policy ?? 'none',
    via: config.escalation?.via ?? 'sudo',
    allow: config.escalation?.allow ?? [],
  };
  if (escalation.policy !== 'none') {
    if (requestedMode === 'untrusted') {
      // untrusted 的产品承诺就是笼；「越笼」提权通道与之矛盾（§4.1 同类拒绝）
      throw new Error('effect_policy_invalid: escalation cannot combine with mode=untrusted (untrusted promises a jail)');
    }
  }
  // （full 档纯配置矛盾已在最前 fail-closed，此处只剩 allowlist 的 TOCTOU 护栏）
  if (escalation.policy === 'allowlist') {
    if (escalation.allow.length === 0) {
      throw new Error('effect_policy_invalid: escalation.policy=allowlist requires escalation.allow rules');
    }
    // 可写根统一口径（与 daemon 启动探测共用 escalationWritableRoots，防两处漂移）
    const writableRoots = escalationWritableRoots({
      workspaces: baseWorkspace !== undefined ? [baseWorkspace] : [],
      transactionRoots: (config.transactionRoots ?? []).map((r) => expandHomePath(r)),
    });
    for (const rule of escalation.allow) {
      if (!isAbsolute(rule.cmd)) {
        throw new Error(`effect_policy_invalid: escalation rule cmd must be absolute, got ${JSON.stringify(rule.cmd)}`);
      }
      // 有效目标逐个过 TOCTOU 护栏（via: sudo 形态含 sudo 之后的真实二进制）
      const targets = escalationRuleTargets(rule, escalation.via);
      if ('invalid' in targets) {
        throw new Error(`effect_policy_invalid: escalation rule rejected (${targets.invalid})`);
      }
      for (const target of targets.targets) {
        const bad = checkEscalationBinary(target, writableRoots);
        if (bad) {
          throw new Error(`effect_policy_invalid: escalation rule rejected (${bad})`);
        }
      }
    }
  }

  // Path jail is part of the untrusted promise; never loosen it from config.
  const d = MODE_DEFAULTS[mode];
  const pathContainment: PathContainment =
    requestedMode === 'untrusted'
      ? 'strict'
      : (config.pathContainment ?? d.pathContainment);

  // untrusted intent residue: keep discard-on-close even when effectiveMode renames
  const onClose =
    config.onClose ??
    (requestedMode === 'untrusted' ? MODE_DEFAULTS.untrusted.onClose : d.onClose);
  const extra = (config.transactionRoots ?? []).map((p) => p.trim()).filter(Boolean);
  const allowRoots = [...(baseWorkspace?.trim() ? [baseWorkspace.trim()] : []), ...extra];
  return {
    requestedMode,
    mode,
    untrustedAdmission,
    toolSurface,
    securityDegraded,
    toolIsolation: config.toolIsolation ?? d.toolIsolation,
    pathContainment,
    // degraded untrusted must not leave shell allow as a hole
    shellEscape: toolSurface === 'reduced' ? 'deny' : (config.shellEscape ?? d.shellEscape),
    // untrusted product promise: egress deny is not a config knob (like pathContainment)
    // jail=none：网络限制只由 jail 实施，无笼时 deny 是假承诺——显式配置已在上方拒绝，
    // 未指定则如实取 open（§4.2 注记带 network=open）
    network:
      requestedMode === 'untrusted' || toolSurface === 'reduced'
        ? 'deny'
        : jail === 'none'
          ? 'open'
          : (config.network ?? d.network),
    processLimits: config.processLimits ?? d.processLimits,
    commit: config.commit ?? d.commit,
    onClose,
    effects: config.effects ?? d.effects,
    allowRoots,
    transactionRoots: [
      'workspace',
      'memory',
      ...extra.map(() => 'host' as const),
    ],
    undoLimit: config.undoLimit,
    shellJournal: config.shellJournal ?? 'snapshot',
    shellJournalLimit: config.shellJournalLimit,
    jail,
    onJailUnavailable,
    escalation,
    // 特权上下文（§5 P4/§8.1）：授权态标记，不是降级；root/elevated 维度由启动期探测叠加
    privileged: jail === 'none' || escalation.policy === 'full',
    dangerousCommands: {
      policy: config.dangerousCommands?.policy ?? 'confirm',
      timeoutMs: config.dangerousCommands?.timeoutMs ?? 120_000,
    },
    opsAudit: config.opsAudit ?? 'on',
    opsAuditPath: config.opsAuditPath,
    opsAuditExportPath: config.opsAuditExportPath,
  };
}

/**
 * Whether a tool is on the reduced surface (untrusted degrade).
 * Reduced keeps content tools inside L2; strips egress and code-exec power.
 *
 * @param toolName - registered tool name
 * @param surface - full or reduced
 * @returns whether the tool may run
 */
export function isToolAllowedOnSurface(
  toolName: string,
  surface: ToolSurface,
  capabilities?: readonly string[] | null,
): boolean {
  if (surface === 'full') return true;
  // D5-a: capability tags, not names. Unknown on reduced = reject (unknown-reject).
  const caps = resolveToolCapabilities(toolName, capabilities);
  if (caps === null) return false;
  return !deniesReducedSurface(caps);
}



/**
 * L2：路径是否落在 allowRoots 内
 *
 * @param resolved - 已 resolve 的绝对路径
 * @param allowRoots - 允许根
 * @param containment - 级别；none 一律放行；soft 仅用于审计（由调用方记日志）
 * @returns 是否允许
 */
export function isPathAllowed(
  resolved: string,
  allowRoots: string[],
  containment: PathContainment,
): boolean {
  if (containment === 'none') return true;
  if (allowRoots.length === 0) return containment !== 'strict';
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const win = process.platform === 'win32';
  const target = win ? norm(resolved).toLowerCase() : norm(resolved);
  return allowRoots.some((root) => {
    const r = win ? norm(root).toLowerCase() : norm(root);
    return target === r || target.startsWith(r + '/');
  });
}

/** 闸门放行结论（ops P2：审计要「是否经确认」的事实，不是通道配置） */
export interface GateEffectResult {
  /** 是否经宿主确认（自动放行 = false；未过闸 = 不返回本值而是 throw） */
  confirmed: boolean;
  /** 放行来源：确认过 / 事务自动 / engine 内置策略 */
  confirmSource: 'host-gate' | 'auto-transaction' | 'auto-engine';
  /** ops P5 确认人署名（仅 host-gate 经人工批准时；缓存命中/自动放行如实缺省） */
  confirmedBy?: string;
  /** ops P5 确认通道（gateway | webhook | …） */
  confirmChannel?: string;
}

/** 效应确认缓存 key（含目标）：一次点头只覆盖同一目标，不按 kind 一类放行 */
function effectCacheKey(intent: EffectIntent): string {
  switch (intent.kind) {
    case 'file.write':
      return `file.write:${intent.path}`;
    case 'shell':
      return `shell:${intent.command}`;
    case 'runner':
      return `runner:${intent.command}`;
    case 'vcs':
      return `vcs:${intent.operation}:${intent.cwd ?? ''}`;
    case 'memory.write':
      return `memory.write:${intent.domain}`;
    case 'other':
      return `other:${intent.description}`;
  }
}

/**
 * 效应闸（P4）：事务内自动放行；host-gate 交给宿主；engine 通道按内置策略。
 *
 * @param intent - 效应意图
 * @param options - 通道与回调
 * @returns 放行结论（confirmed/confirmSource + 确认人归因，审计用）
 * @throws Error 当拒绝执行时（`effect_confirm_timeout` 超时 / `effect_denied` 拒绝，语义分家）
 */
export async function gateEffect(
  intent: EffectIntent,
  options: {
    effects: EffectConfirmChannel;
    confirmEffect?: ConfirmEffect;
    shellEscape?: ShellEscapePolicy;
    /** SEC-7：session-scope 缓存键；缺省尝试 RunScope */
    sessionId?: string;
    /** SEC-7：always-scope 缓存键（agent 分桶）；缺省尝试 RunScope */
    agentId?: string;
    hitlCache?: import('../../governance/human-in-the-loop/decision-cache.js').HitlDecisionCache;
  },
): Promise<GateEffectResult> {
  // 可事务化（可 undo）→ 自动
  if (intent.kind === 'memory.write' && intent.transactional) {
    return { confirmed: false, confirmSource: 'auto-transaction' };
  }
  if (intent.kind === 'file.write' && intent.transactional) {
    return { confirmed: false, confirmSource: 'auto-transaction' };
  }

  if (intent.kind === 'shell') {
    const esc = options.shellEscape ?? 'allow';
    // deny：无 L4 无法只禁越界，必须拒绝 shell（fail-closed，保策略语义）
    if (esc === 'deny') {
      throw new Error(
        'shell_denied: shellEscape=deny (cannot contain shell escapes until L4; use mode=project|host or shellEscape=allow|confirm)',
      );
    }
    // confirm：必须走 host-gate
    if (esc === 'confirm' && options.effects !== 'host-gate') {
      throw new Error(
        'shell_confirm_required: shellEscape=confirm requires effectPolicy.effects=host-gate + confirmEffect',
      );
    }
  }
  // `runner` / `vcs` are dedicated allowlisted tools, not arbitrary shell.
  // shellEscape gates the shell tool only — workspace stays capable of git/project scripts.

  if (options.effects !== 'host-gate') {
    // engine 通道：路径牢笼由 L2 承担；shell 已在上方按 shellEscape 处理
    return { confirmed: false, confirmSource: 'auto-engine' };
  }

  // host-gate：非事务效应交给宿主（自动放行 / 宿主 UI / 策略引擎）
  const decide = options.confirmEffect;
  if (!decide) {
    throw new Error(
      'confirm_effect_missing: effectPolicy.effects=host-gate requires confirmEffect callback',
    );
  }
  // SEC-7：HitlDecision + 引擎缓存；失败路径 fail-closed。
  // 缓存 key 含目标（B(c) 拍板 2026-10-26）：一次 approve_session 只覆盖同一目标，
  // 不再按 kind 一类放行（旧「有意粗粒度」已翻案，见 KNOWN-ISSUES）
  const outcome = await resolveHitlOutcome({
    cache: options.hitlCache,
    channel: 'effect',
    key: effectCacheKey(intent),
    sessionId: options.sessionId ?? getRunSessionId(),
    agentId: options.agentId ?? getRunScope()?.agentId,
    // 宿主可返回裸 HitlDecision 或 ConfirmOutcome（带归因/来源）；归因随结果回传审计
    ask: async () => {
      const raw = await decide(intent);
      const normalized: {
        decision: HitlDecision;
        approver?: string;
        channel?: string;
        reason?: string;
      } = typeof raw === 'string' ? { decision: raw } : raw;
      return {
        decision: normalized.decision,
        ...(normalized.approver !== undefined ? { approver: normalized.approver } : {}),
        ...(normalized.channel !== undefined ? { channel: normalized.channel } : {}),
        // 宿主标注的拒绝来源：timeout 归超时语义；其余归通道故障——不得冒充人工拒绝
        ...(normalized.decision === 'deny' && normalized.reason === 'timeout'
          ? { timedOut: true }
          : {}),
        ...(normalized.decision === 'deny' &&
        normalized.reason !== undefined &&
        normalized.reason !== 'timeout'
          ? { denyReason: 'channel_error' as const, denyDetail: normalized.reason }
          : {}),
      };
    },
  });
  if (!outcome.allowed) {
    // 错误面分家（与审计 why 同一口径）：超时 ≠ 人工拒绝 ≠ 通道故障，不得混为一谈
    if (outcome.timedOut) {
      throw new Error(
        `effect_confirm_timeout: no decision for ${effectCacheKey(intent)} — timeout is deny; do NOT retry this call until a human decides`,
      );
    }
    const provenance = outcome.denyReason
      ? ` (${outcome.denyReason}${outcome.denyDetail ? `: ${outcome.denyDetail}` : ''})`
      : '';
    throw new Error(
      `effect_denied: ${intent.kind}${provenance} — ${
        outcome.denyReason ? 'no human decision was reached' : 'a human rejected this effect'
      }`,
    );
  }
  return {
    confirmed: true,
    confirmSource: 'host-gate',
    ...(outcome.approver !== undefined ? { confirmedBy: outcome.approver } : {}),
    ...(outcome.channel !== undefined ? { confirmChannel: outcome.channel } : {}),
  };
}

// ── Session-scoped effect overrides (temporary transactionRoots) ──

/**
 * Session-only effect overrides. Append-only: may add allow roots for this
 * session; must never loosen pathContainment / shellEscape.
 */
export interface SessionEffectOverrides {
  /** Extra allow/transaction roots (absolute paths), merged into allowRoots */
  transactionRoots?: string[];
}

const EFFECT_OVERRIDES_META_KEY = 'effectOverrides';

/**
 * Parse `session.metadata.effectOverrides` safely (read path).
 *
 * Invalid entries are **skipped**, not thrown: a poisoned/corrupt metadata bag
 * must not abort run start. Strict validation belongs on the write API
 * (`normalizeTransactionRoots`).
 *
 * @param metadata - session metadata bag
 * @returns valid absolute roots only (empty when absent/invalid)
 */
export function readSessionEffectOverrides(
  metadata: Record<string, unknown> | undefined,
): SessionEffectOverrides {
  const raw = metadata?.[EFFECT_OVERRIDES_META_KEY];
  if (!raw || typeof raw !== 'object') return {};
  const bag = raw as Record<string, unknown>;
  const list = bag.transactionRoots;
  if (!Array.isArray(list)) return {};
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t || !isAbsolute(t)) continue;
    const abs = resolve(t);
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return { transactionRoots: out };
}

/**
 * Normalize and validate transaction root paths (absolute, non-empty).
 *
 * @param paths - raw paths
 * @returns absolute normalized unique paths
 * @throws Error when a path is empty or not absolute
 */
export function normalizeTransactionRoots(paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const t = typeof raw === 'string' ? raw.trim() : '';
    if (!t) throw new Error('effect_root_empty: path must be a non-empty string');
    // Require caller-supplied absolute paths (do not silently join cwd)
    if (!isAbsolute(t)) {
      throw new Error(`effect_root_not_absolute: ${t}`);
    }
    const abs = resolve(t);
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

/**
 * Append session roots to base allowRoots (dedupe; base wins on conflicts).
 *
 * @param baseRoots - roots from effectPolicy / workspace
 * @param extraRoots - session temporary roots
 * @returns combined unique list
 */
export function mergeTransactionRoots(
  baseRoots: string[],
  extraRoots: string[] | undefined,
): string[] {
  const out = [...baseRoots];
  const seen = new Set(
    out.map((p) => (process.platform === 'win32' ? p.toLowerCase() : p)),
  );
  for (const p of extraRoots ?? []) {
    const key = process.platform === 'win32' ? p.toLowerCase() : p;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * Metadata key used on SessionData.metadata / SessionStore.updateMetadata.
 */
export const SESSION_EFFECT_OVERRIDES_KEY = EFFECT_OVERRIDES_META_KEY;
