/**
 * ToolEffectPolicy P3 — 运行模式预设与有效策略
 *
 * 命名模式（workspace / project / host / untrusted）展开为正交旋钮。
 * 见 arch/tool-effect-policy.md §7。
 */

import type { ToolIsolationMode } from './isolation.js';

/** 命名运行模式 */
export type EffectRunMode = 'workspace' | 'project' | 'host' | 'untrusted';

/**
 * 产品缺省运行模式（未配置 `effectPolicy` / 未写 `mode` 时）。
 * `host`：本机自动化——shell allow、路径不设牢笼；严格场景显式 `workspace`。
 */
export const DEFAULT_EFFECT_RUN_MODE: EffectRunMode = 'host';

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
      kind: 'memory.write';
      domain: 'memory' | 'cognition' | 'wisdom';
      transactional: true;
    }
  | {
      kind: 'other';
      description: string;
    };

export type ConfirmEffectDecision = 'allow' | 'deny';

/**
 * host-gate 确认回调（P4）。engine 不内置审批 UI。
 * 宿主可自动放行 / 弹自己的确认框 / 策略引擎。
 */
export type ConfirmEffectIntent =
  | EffectIntent
  | {
      kind: 'file.write' | 'shell' | 'memory.write' | 'other';
      path?: string;
      mode?: string;
      transactional?: boolean;
      command?: string;
      cwd?: string;
      domain?: string;
      description?: string;
    };

export type ConfirmEffect = (intent: {
  kind: 'file.write' | 'shell' | 'memory.write' | 'other';
  path?: string;
  mode?: string;
  transactional?: boolean;
  command?: string;
  cwd?: string;
  domain?: string;
  description?: string;
}) => Promise<ConfirmEffectDecision>;

export type EffectConfirmChannel = 'engine' | 'host-gate';

/** shell 记账深度（§5.6）：snapshot=采 before 可逆；off=只知情 */
export type ShellJournalMode = 'snapshot' | 'off';

/** 配置形状（可覆盖预设） */
export interface EffectPolicyConfig {
  /** 省略 = `DEFAULT_EFFECT_RUN_MODE`（host） */
  mode?: EffectRunMode;
  /** 额外事务 root（绝对路径）；并入 allowRoots */
  transactionRoots?: string[];
  pathContainment?: PathContainment;
  shellEscape?: ShellEscapePolicy;
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
  mode: EffectRunMode;
  toolIsolation: ToolIsolationMode;
  pathContainment: PathContainment;
  shellEscape: ShellEscapePolicy;
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

const MODE_DEFAULTS: Record<
  EffectRunMode,
  Omit<EffectiveEffectPolicy, 'allowRoots' | 'transactionRoots'>
> = {
  workspace: {
    mode: 'workspace',
    toolIsolation: 'session-subdir',
    pathContainment: 'strict',
    // 无 L4 时无法「只禁越界」：deny = 拒绝 shell 工具（fail-closed）
    shellEscape: 'deny',
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
    processLimits: true,
    commit: 'auto',
    onClose: 'discard',
    effects: 'engine',
    shellJournal: 'snapshot',
  },
};

/**
 * 展开 effectPolicy 为有效策略
 *
 * @param config - 用户配置（mode 可省略，缺省 `DEFAULT_EFFECT_RUN_MODE`）
 * @param baseWorkspace - 工具基路径（agent.workspace / RunConfig.cwd）
 * @returns 有效策略
 */
export function resolveEffectiveEffectPolicy(
  config: EffectPolicyConfig,
  baseWorkspace?: string,
): EffectiveEffectPolicy {
  const mode = config.mode ?? DEFAULT_EFFECT_RUN_MODE;
  const d = MODE_DEFAULTS[mode];
  const extra = (config.transactionRoots ?? []).map((p) => p.trim()).filter(Boolean);
  const allowRoots = [...(baseWorkspace?.trim() ? [baseWorkspace.trim()] : []), ...extra];
  return {
    mode,
    toolIsolation: config.toolIsolation ?? d.toolIsolation,
    pathContainment: config.pathContainment ?? d.pathContainment,
    shellEscape: config.shellEscape ?? d.shellEscape,
    processLimits: config.processLimits ?? d.processLimits,
    commit: config.commit ?? d.commit,
    onClose: config.onClose ?? d.onClose,
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
  const d = await decide(intent);
  if (d !== 'allow') {
    throw new Error(`effect_denied: ${intent.kind}`);
  }
}
