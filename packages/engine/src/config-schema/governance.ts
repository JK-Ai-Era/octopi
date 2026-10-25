/**
 * security / session / sessionAcl / toolIsolation — Governance & Session 域段
 *
 * @module
 */
import { z } from 'zod';
import { ConfigPathSchema, SessionRightsSchema } from './shared.js';

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
  /** 额外事务 root（绝对路径或 ~ 形态）；并入 allowRoots */
  transactionRoots: z.array(ConfigPathSchema).optional(),
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
  /**
   * 进程牢笼意图（ops P0）：auto（缺省，按模式派生，缺笼如实降级 + 告警）|
   * require（拿不到即拒）| none（显式无笼，需 privilegedAck）。
   */
  jail: z.enum(['auto', 'require', 'none']).optional(),
  /** jail 意图落空时：refuse 拒绝执行 | degrade（缺省）记 securityDegraded + 告警 */
  onJailUnavailable: z.enum(['refuse', 'degrade']).optional(),
  /** `jail: "none"` 时必填的显式表态（授权 ≠ 降级；§8.1） */
  privilegedAck: z.string().min(1).optional(),
  /** 提权策略（ops P3）：`allowlist` 按 cmd+args 全等放行（full 档属 P4） */
  escalation: z
    .object({
      policy: z.enum(['none', 'allowlist']).optional(),
      via: z.enum(['sudo', 'direct']).optional(),
      allow: z
        .array(
          // strict：未知子键拒绝启动（`confrim` 拼错 = 确认闸静默消失，§6.1 教训）
          z
            .object({
              id: z.string().min(1).optional(),
              cmd: z.string().min(1),
              args: z.array(z.string()).optional(),
              confirm: z.boolean().optional(),
              cwd: z.string().min(1).optional(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict()
    .optional(),
  /** ops 审计账本开关（安全字段：重启生效 + 宿主署名）；缺省 `on` */
  opsAudit: z.enum(['on', 'off']).optional(),
  /** ops 审计账本路径（缺省 `<OCTOPI_HOME>/audit/ops.<agentId>.jsonl`） */
  opsAuditPath: z.string().min(1).optional(),
}).superRefine((v, ctx) => {
  // 配置矛盾 fail-closed（§4.1）：拒绝启动，不做静默取舍
  if (v.jail === 'none') {
    if (!v.privilegedAck?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['privilegedAck'],
        message: 'jail=none requires privilegedAck (explicit unjailed choice)',
      });
    }
    if (v.mode === 'untrusted') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['jail'],
        message: 'jail=none cannot combine with mode=untrusted (untrusted promises a jail)',
      });
    }
  }
  if (v.jail === 'none' && v.onJailUnavailable === 'refuse') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['onJailUnavailable'],
      message: 'onJailUnavailable=refuse has no meaning under jail=none (remove it, or use jail=auto/require)',
    });
  }
  // 注：effectPolicy.network 目前不在配置 schema（library-only）；jail=none 下
  // network=deny/allowlist 的拒绝在 resolveEffectiveEffectPolicy 守卫
  if (
    (v.jail === 'require' || v.onJailUnavailable === 'refuse') &&
    v.untrustedAdmission === 'degrade'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['jail'],
      message:
        'jail=require/onJailUnavailable=refuse contradicts untrustedAdmission=degrade (same condition, opposite outcomes)',
    });
  }
  // ops P3：提权规则纯形状矛盾（TOCTOU/启动探测在 resolve 与 daemon 层）
  if (v.escalation && v.escalation.policy !== undefined && v.escalation.policy !== 'none' && v.mode === 'untrusted') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['escalation', 'policy'],
      message: 'escalation cannot combine with mode=untrusted (untrusted promises a jail)',
    });
  }
  if (v.escalation?.policy === 'allowlist') {
    const rules = v.escalation.allow ?? [];
    if (rules.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['escalation', 'allow'],
        message: 'escalation.policy=allowlist requires non-empty escalation.allow rules',
      });
    }
    const seen = new Set<string>();
    for (const [i, rule] of rules.entries()) {
      const absolute = rule.cmd.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rule.cmd);
      if (!absolute) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['escalation', 'allow', i, 'cmd'],
          message: 'escalation rule cmd must be an absolute path (PATH resolution = replaceable binary)',
        });
      }
      // 重复 (cmd,args)：后写的 confirm:true 会被先命中者静默忽略 → 查重拒绝
      const dupKey = JSON.stringify([rule.cmd, rule.args ?? []]);
      if (seen.has(dupKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['escalation', 'allow', i],
          message: 'duplicate escalation rule (cmd,args) — the first match wins silently',
        });
      }
      seen.add(dupKey);
    }
  }
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

const ToolRightsShape = z.object({
  /** allowlist；缺省 = 名字不限（仍受 deny 约束）。`'*'` = 全放行 */
  allow: z.array(z.string().min(1)).optional(),
  /** 工具名黑名单；`'*'` = 全拒绝 */
  deny: z.array(z.string().min(1)).optional(),
  /** 能力标签黑名单（D5-a） */
  denyCapabilities: z.array(z.string().min(1)).optional(),
});

/**
 * Role defaults/max rights. `toolRights` is always present after parse
 * (omitted config → unrestricted empty bag) so TS `EffectiveSessionRights`
 * matches without casts.
 */
const SessionEffectiveRightsSchema = z.object({
  canRun: z.boolean(),
  readScope: z.enum(['full', 'from_grant', 'summary_tail', 'none']),
  writeMemory: z.boolean(),
  canManageTasks: z.boolean(),
  canHandoff: z.boolean(),
  toolRights: ToolRightsShape.default({ deny: [], denyCapabilities: [] }),
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
