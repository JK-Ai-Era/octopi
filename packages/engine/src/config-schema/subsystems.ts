/**
 * subsystems — 协作/子系统段（→ engine）
 *
 * @module
 */
import { z } from 'zod';

export const SubsystemsConfigSchema = z.object({
  /** 审计目录；缺省 `<OCTOPI_HOME>/audit`，`false` 显式关闭 */
  auditDir: z.union([z.string().min(1), z.literal(false)]).optional(),
  /** 允许注册：子系统 id / packageId / `memory.steward.*` 前缀 */
  allowlist: z.array(z.string().min(1)).optional(),
  /** 禁止注册（deny 优先） */
  denylist: z.array(z.string().min(1)).optional(),
});
