/**
 * `gateway` — 进程面覆盖段（→ 未来 @octopi-agent/gateway）
 *
 * **只放 HTTP/WS 进程面覆盖**，不重复 engine 业务键（agents/models/session…）。
 * 现状：无顶层 `gateway` 键时由 `toGatewayConfig()` 从 engine 配置派生；
 * 本段预留可选覆盖，避免双源。
 *
 * @module
 */
import { z } from 'zod';
import { NetworkHostSchema } from '@octopi-agent/engine/config-schema/shared.js';

export const GatewayOverrideConfigSchema = z
  .object({
    port: z.number().int().positive().optional(),
    host: NetworkHostSchema.optional(),
    /** 调试 REST 前缀等进程面开关；不含业务策略 */
    debugRest: z.boolean().optional(),
  })
  .strict();
