/**
 * browser — 浏览器操作工具段（→ engine；arch/browser-capability.md §3.8）
 *
 * 缺省 = 默认开（拍板）；`enabled: false` 显式关闭。
 * `cloud` 为后续分期槽位，运行时 fail-loud（装配拒绝）；`rebrowser` / `camoufox`
 * 双 stealth 后端与 `cdp-attach` 已实现（P2/P3）。
 *
 * @module
 */
import { z } from 'zod';

export const BrowserConfigSchema = z.object({
  /** 工具面注册开关（缺省 true） */
  enabled: z.boolean().optional(),
  /**
   * 后端引擎：auto = playwright；stealth = 按 stealth.fallback 链的隐身模式
   * （缺省 rebrowser->camoufox）；rebrowser / camoufox = 单后端直钉；cdp-attach = 真实 Chrome。
   */
  engine: z
    .enum(['auto', 'playwright', 'stealth', 'rebrowser', 'camoufox', 'cdp-attach', 'cloud'])
    .optional(),
  /** attach 端点（engine=cdp-attach 用；缺省 http://127.0.0.1:9222） */
  attach: z
    .object({
      endpoint: z.string().min(1).optional(),
    })
    .optional(),
  /** 持久 profile（P2；storageState 归档于 OCTOPI_HOME/browser-profiles） */
  profiles: z
    .object({
      persist: z.boolean().optional(),
      defaultProfile: z.string().min(1).optional(),
    })
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
  /**
   * stealth（P3）：`fallback` = engine=stealth 的后端链（`->` 分隔，缺省
   * `rebrowser->camoufox`）；挑战判定命中切下一后端重试一次（有界），仍败走 HITL。
   * `humanize` = 行为拟人化节流（stealth 引擎缺省启用；区间 [min,max] 毫秒随机）。
   */
  stealth: z
    .object({
      fallback: z.string().min(1).optional(),
      humanize: z
        .object({
          /** 逐键打字延迟区间（默认 [20, 80]） */
          typingDelayMs: z.tuple([z.number().min(0), z.number().min(0)]).optional(),
          /** 动作间抖动区间（默认 [100, 600]） */
          actionJitterMs: z.tuple([z.number().min(0), z.number().min(0)]).optional(),
          /** 动作重试上限（默认 2；有界重试，禁止重试风暴） */
          maxRetries: z.number().int().min(0).optional(),
        })
        .optional(),
    })
    .optional(),
  /**
   * 敏感动作确认闸门三档（2026-11-20 拍板）：
   * `strict` = 所有非 GET 过闸（含页内 fetch/XHR）；`standard`（缺省）= 仅文档级
   * （表单提交/密码/上传）；`off` = 全放开。
   */
  confirm: z.enum(['strict', 'standard', 'off']).optional(),
});
