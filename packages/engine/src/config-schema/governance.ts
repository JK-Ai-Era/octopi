/**
 * security / session / sessionAcl / toolIsolation — Governance & Session 域段
 *
 * @module
 */
import { z } from 'zod';
import { SessionRightsSchema } from './shared.js';

export const SecurityConfigSchema = z.object({
  enforce: z.enum(['block', 'audit']).optional(),
  injectionSensitivity: z.enum(['low', 'medium', 'high']).optional(),
  allowedPaths: z.array(z.string()).optional(),
  /**
   * Tool/engine egress network guard (http_request, Knowledge default).
   * Default rejects private/loopback/link-local/metadata (SSRF).
   */
  network: z
    .object({
      /** Explicitly allow private/loopback targets (lab / intranet). */
      allowPrivateNetwork: z.boolean().optional(),
    })
    .optional(),
});

/**
 * `credentials` — named credential vault policy (SEC-3c).
 *
 * Default: non-empty `credential_bindings` are enforced; empty bindings resolve freely.
 * `requireBindings: true` (or untrusted effect mode) rejects unbound credentials.
 */
export const CredentialsConfigSchema = z.object({
  requireBindings: z.boolean().optional(),
});

export const SessionConfigSchema = z.object({
  dmScope: z.enum(['main', 'per-peer', 'per-channel-peer']).optional(),
  /** 上下文租约（毫秒）。显式配置才生效；缺省不截断 LLM 窗口 */
  idleExpiryMs: z.number().int().positive().optional(),
}).passthrough();

/**
 * `toolIsolation` — 工具效应面策略
 *
 * - `none`（默认）：多 Session 共享 agent.workspace
 * - `session-subdir`：cwd = join(agent.workspace | RunConfig.cwd, sessionId)
 * - `session-lock`：共享路径；并发安全依赖 Runner 的 sessionId 锁（不路径隔离）
 */
/**
 * `effectPolicy` — ToolEffectPolicy 运行模式（P3）
 *
 * 命名预设展开正交旋钮；agents[].effectPolicy 优先于顶层。
 * 注意：与 `agents[].tools`（工具 allow/deny）无关。
 * **省略 `mode` = engine 缺省 workspace（secure-by-default）**；
 * 评估/本机全能力请在配置里显式 `"mode": "host"`（init / example 即如此）。
 */
export const EffectPolicyConfigSchema = z.object({
  mode: z.enum(['workspace', 'project', 'host', 'untrusted']).optional(),
  /**
   * untrusted 无 L4 process jail 时：refuse（缺省）拒绝运行；
   * degrade 降 effectiveMode + toolSurface=reduced + securityDegraded。
   */
  untrustedAdmission: z.enum(['refuse', 'degrade']).optional(),
  transactionRoots: z.array(z.string()).optional(),
  pathContainment: z.enum(['strict', 'soft', 'none']).optional(),
  shellEscape: z.enum(['deny', 'confirm', 'allow']).optional(),
  processLimits: z.boolean().optional(),
  commit: z.enum(['auto', 'manual']).optional(),
  /** commit=manual 时，会话关闭/删除：commit=保留效应，discard=逆放 */
  onClose: z.enum(['commit', 'discard']).optional(),
  effects: z.enum(['engine', 'host-gate']).optional(),
  toolIsolation: z.enum(['none', 'session-subdir', 'session-lock']).optional(),
  /** undo 配额；缺省不限 */
  undoLimit: z
    .object({
      /** 0 = 不限 */
      maxEntries: z.number().int().nonnegative().optional(),
      /** 0 = 不限 */
      maxBlobBytes: z.number().int().nonnegative().optional(),
    })
    .optional(),
  /** shell 记账深度 */
  shellJournal: z.enum(['snapshot', 'off']).optional(),
  shellJournalLimit: z
    .object({
      /** 0 = 不限 */
      maxFiles: z.number().int().nonnegative().optional(),
      /** 0 = 不限 */
      maxBytes: z.number().int().nonnegative().optional(),
      /** 0 = 不限 */
      maxFileSize: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export const ToolIsolationConfigSchema = z.enum(['none', 'session-subdir', 'session-lock']);

/**
 * `fileSend` — send_file 外发限额
 *
 * - `maxBytes`：单文件上限（字节）；缺省 **2GB**
 * - `maxReleasesPerSession`：每会话 release 次数上限；缺省 / `0` = **不限**
 */
export const FileSendConfigSchema = z.object({
  maxBytes: z.number().int().positive().optional(),
  maxReleasesPerSession: z.number().int().nonnegative().optional(),
});

const SessionEffectiveRightsSchema = z.object({
  canRun: z.boolean(),
  readScope: z.enum(['full', 'from_grant', 'summary_tail', 'none']),
  writeMemory: z.boolean(),
  canManageTasks: z.boolean(),
  canHandoff: z.boolean(),
});

/**
 * `sessionAcl` — 角色目录与切换缺省
 *
 * 出厂五角色内置；配置可覆盖同 id 或新增业务角色。
 * `allowAgentInitiatedHandoff` 缺省 false（I3）。
 */
export const SessionAclConfigSchema = z.object({
  roles: z
    .array(
      z.object({
        id: z.string().min(1),
        description: z.string().optional(),
        defaults: SessionEffectiveRightsSchema,
        max: SessionEffectiveRightsSchema.optional(),
      }),
    )
    .optional(),
  switchDefaults: z
    .object({
      preferredOnly: z.boolean().optional(),
      consultGrantRole: z.string().min(1).optional(),
      requireExplicitHandoff: z.boolean().optional(),
    })
    .optional(),
  allowAgentInitiatedHandoff: z.boolean().optional(),
});

export { SessionRightsSchema };
