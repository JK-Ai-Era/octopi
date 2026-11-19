/**
 * browser — 浏览器操作工具段（→ engine；arch/browser-capability.md §3.8）
 *
 * 缺省 = 默认开（拍板）；`enabled: false` 显式关闭。
 * `rebrowser` / `camoufox` / `cdp-attach` / `cloud` 为后续分期槽位，
 * 运行时 fail-loud（装配拒绝），schema 先行把键形状定死。
 *
 * @module
 */
import { z } from 'zod';

export const BrowserConfigSchema = z.object({
  /** 工具面注册开关（缺省 true） */
  enabled: z.boolean().optional(),
  /** 后端引擎（auto = playwright） */
  engine: z
    .enum(['auto', 'playwright', 'rebrowser', 'camoufox', 'cdp-attach', 'cloud'])
    .optional(),
  /** 浏览器来源：chromium（管理版，octopi browser install）| chrome（系统 Chrome） */
  channel: z.enum(['chromium', 'chrome']).optional(),
  headless: z.boolean().optional(),
  /** 工具/动作超时（毫秒，默认 30000） */
  timeoutMs: z.number().positive().optional(),
  /** 快照序列化预算（字符，默认 8000） */
  snapshotMaxChars: z.number().int().positive().optional(),
  /** 会话空闲回收（毫秒；<=0 不回收；默认 1800000 = 30 分钟） */
  sessionIdleTimeoutMs: z.number().int().optional(),
  viewport: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
  locale: z.string().min(1).optional(),
  network: z
    .object({
      /** 域名 allow/deny（deny 优先；`*.example.com` 后缀通配；缺省无限制） */
      domains: z
        .object({
          allow: z.array(z.string().min(1)).optional(),
          deny: z.array(z.string().min(1)).optional(),
        })
        .optional(),
      /** 私网/环回放行（缺省 false；与 http_request 语义对齐） */
      allowPrivateNetwork: z.boolean().optional(),
    })
    .optional(),
  /** 敏感动作确认闸门（缺省全开 = 拍板） */
  confirm: z
    .object({
      formSubmit: z.boolean().optional(),
      passwordField: z.boolean().optional(),
    })
    .optional(),
});
