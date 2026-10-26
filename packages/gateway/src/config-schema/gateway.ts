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
    /**
     * HITL 异步确认的 webhook 通道（ops P5 双通道之一；进程面传输，非业务策略）。
     * 待确认推送到 owner 侧端点（HMAC-SHA256 签名 `x-octopi-signature`）；
     * 确认可回同一 REST 决策端点（channel=webhook）。超时 deny 不可配。
     */
    hitlWebhook: z
      .object({
        url: z.string().url(),
        /** 签名密钥；缺省不签名（内网/自担风险） */
        secret: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
