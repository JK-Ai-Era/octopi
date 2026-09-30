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
});

export const SessionConfigSchema = z.object({
  dmScope: z.enum(['main', 'per-peer', 'per-channel-peer']).optional(),
}).passthrough();

/**
 * `toolIsolation` — 工具效应面策略
 *
 * - `none`（默认）：多 Session 共享 agent.workspace
 * - `session-subdir`：cwd = join(agent.workspace | RunConfig.cwd, sessionId)
 * - `session-lock`：共享路径；并发安全依赖 Runner 的 sessionId 锁（不路径隔离）
 */
export const ToolIsolationConfigSchema = z.enum(['none', 'session-subdir', 'session-lock']);

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
