/**
 * ToolEffectPolicy P3 — 运行模式预设与有效策略
 *
 * 命名模式（workspace / project / host / untrusted）展开为正交旋钮。
 * 见 arch/tool-effect-policy.md §7。
 */

import { isAbsolute, resolve } from 'node:path';
import { expandHomePath } from '../../../paths.js';
import type { HitlDecision } from '@octopi-agent/core/types/tools.js';
import type { ToolIsolationMode } from './isolation.js';
import {
  deniesReducedSurface,
  resolveToolCapabilities,
} from './tool-capabilities.js';
import {
  assessL4ProcessMinimum,
  type ProcessIsolationProfile,
} from './process-isolation.js';
import { resolveHitlDecision } from '../../governance/human-in-the-loop/decision-cache.js';
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
export type EffectIntent =
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
}

type ModePreset = Omit<
  EffectiveEffectPolicy,
  | 'allowRoots'
  | 'transactionRoots'
  | 'requestedMode'
  | 'untrustedAdmission'
  | 'toolSurface'
  | 'securityDegraded'
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
 * Whether the resolved policy demands a process jail (untrusted that survived
 * untrusted admission). Single predicate shared by the run path (runner) and
 * host-side read surfaces (WebUI git status endpoint) so the isolation level
 * never drifts between them.
 *
 * @param eff - resolved effective policy
 * @returns true when untrusted was requested and remains effective
 */
export function requiresJail(eff: EffectiveEffectPolicy): boolean {
  return eff.requestedMode === 'untrusted' && eff.mode === 'untrusted';
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
  let mode = requestedMode;
  let toolSurface: ToolSurface = 'full';
  const securityDegraded: SecurityDegradation[] = [];

  if (requestedMode === 'untrusted') {
    const profile = isolation;
    const l4 = profile ? assessL4ProcessMinimum(profile) : { ok: false, missing: ['processTree'] as const };
    if (!l4.ok) {
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
    network:
      requestedMode === 'untrusted' || toolSurface === 'reduced'
        ? 'deny'
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

/**
 * 效应闸（P4）：事务内自动放行；host-gate 交给宿主；engine 通道按内置策略。
 *
 * @param intent - 效应意图
 * @param options - 通道与回调
 * @throws Error 当拒绝执行时
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
): Promise<void> {
  // 可事务化（可 undo）→ 自动
  if (intent.kind === 'memory.write' && intent.transactional) return;
  if (intent.kind === 'file.write' && intent.transactional) return;

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
    return;
  }

  // host-gate：非事务效应交给宿主（自动放行 / 宿主 UI / 策略引擎）
  const decide = options.confirmEffect;
  if (!decide) {
    throw new Error(
      'confirm_effect_missing: effectPolicy.effects=host-gate requires confirmEffect callback',
    );
  }
  // SEC-7：HitlDecision + 引擎缓存；失败路径 fail-closed
  const allowed = await resolveHitlDecision({
    cache: options.hitlCache,
    channel: 'effect',
    key: intent.kind,
    sessionId: options.sessionId ?? getRunSessionId(),
    agentId: options.agentId ?? getRunScope()?.agentId,
    ask: () => decide(intent),
  });
  if (!allowed) {
    throw new Error(`effect_denied: ${intent.kind}`);
  }
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
