/**
 * integration/browser — 浏览器后端集成（arch/browser-capability.md §3）
 *
 * 后端矩阵（§3.3）：playwright / rebrowser / camoufox / cdp-attach 已实现；
 * cloud 为 P4 槽位——显式配置未实现引擎时 fail-loud 拒绝装配（不静默降级）。
 */

import type {
  BrowserService,
  BrowserStealthConfig,
} from '../../harness/extension/plugin-ecosystem/tools/browser-types.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { DefaultBrowserService } from './service.js';
import { PlaywrightBrowserPort } from './playwright.js';
import { createCamoufoxLauncher } from './camoufox.js';
import { parseFallbackChain, StealthFallbackService } from './stealth.js';

export { DefaultBrowserService } from './service.js';
export { PlaywrightBrowserPort, PlaywrightBrowserSession } from './playwright.js';
export {
  camoufoxProviderDir,
  createCamoufoxLauncher,
  loadCamoufoxProvider,
  resolveCamoufoxJsCliPath,
} from './camoufox.js';
export { parseFallbackChain, StealthFallbackService } from './stealth.js';
export {
  installEngine,
  probeEngines,
  type EngineStatus,
  type InstallableEngine,
  type InstallResult,
} from './install.js';

/**
 * `browser.*` 配置块形状（createBrowserService 的入参）。
 *
 * **消费方分工**（勿假设全部由引擎消费）：`engine/channel/headless/timeoutMs/
 * viewport/locale/sessionIdleTimeoutMs` 由本工厂消费（启动/回收）；
 * `enabled/network/confirm/snapshotMaxChars` 由**工具面**消费（assemble →
 * `createBrowserTools`），工厂不读——放这里只为让配置块形状单一。
 */
export interface BrowserServiceOptions {
  /** 工具面注册开关（缺省 true = 拍板默认开）——工具面消费 */
  enabled?: boolean;
  /** 后端引擎（auto = playwright）——工厂消费 */
  engine?: string;
  /** attach 端点（engine=cdp-attach；缺省 http://127.0.0.1:9222）——工厂消费 */
  attach?: { endpoint?: string };
  /** 持久 profile（P2）：defaultProfile/persist——工具面消费（注入 launch 选项） */
  profiles?: { persist?: boolean; defaultProfile?: string };
  /** profile 存储目录——工具面消费 */
  profileDir?: string;
  /** 浏览器来源：chromium（管理版）| chrome（系统 Chrome）——工厂消费 */
  channel?: 'chromium' | 'chrome';
  /** 无头开关——工厂消费 */
  headless?: boolean;
  /** 工具/动作超时（毫秒）——工厂消费 */
  timeoutMs?: number;
  /** 快照序列化预算（字符）——工具面消费 */
  snapshotMaxChars?: number;
  /** 会话空闲回收（毫秒；<=0 不回收；缺省 30 分钟）——工厂消费 */
  sessionIdleTimeoutMs?: number;
  /** 视口——工厂消费 */
  viewport?: { width: number; height: number };
  /** 语言环境——工厂消费 */
  locale?: string;
  /** URL 策略：域名 allow/deny（deny 优先）+ 私网门禁——工具面消费（注入会话策略） */
  network?: {
    domains?: { allow?: string[]; deny?: string[] };
    allowPrivateNetwork?: boolean;
  };
  /**
   * 敏感动作确认闸门三档（2026-11-20 拍板）——工具面消费：
   * `strict` = 所有非 GET 过闸（含页内 fetch/XHR）；`standard`（缺省）= 仅文档级
   * （表单提交/密码/上传）；`off` = 全放开。
   */
  confirm?: 'strict' | 'standard' | 'off';
  /** stealth（P3）：fallback 链由服务层消费；humanize 透传工具层 */
  stealth?: BrowserStealthConfig;
}

/**
 * 按配置创建浏览器会话服务。
 *
 * @param options - 引擎与启动默认值
 * @throws 配置了未实现的引擎时 `not_implemented: …`（fail-loud，不静默降级）
 */
export function createBrowserService(options: BrowserServiceOptions = {}): BrowserService {
  const engine = options.engine ?? 'auto';
  switch (engine) {
    case 'auto':
    case 'playwright':
      return new DefaultBrowserService(
        new PlaywrightBrowserPort({
          headless: options.headless,
          channel: options.channel,
          timeoutMs: options.timeoutMs,
          viewport: options.viewport,
          locale: options.locale,
        }),
        { sessionIdleTimeoutMs: options.sessionIdleTimeoutMs },
      );
    case 'cdp-attach':
      // P2：attach 用户真实 Chrome（launch 派发到 connectOverCDP；close=断开不杀）
      return new DefaultBrowserService(
        new PlaywrightBrowserPort({
          timeoutMs: options.timeoutMs,
          attachMode: true,
          attachEndpoint: options.attach?.endpoint,
        }),
        { sessionIdleTimeoutMs: options.sessionIdleTimeoutMs },
      );
    case 'rebrowser':
      // P3 默认 stealth 后端：drop-in 补丁版 playwright-core（同 API、同 Chromium 二进制；
      // 补 Runtime.enable 泄漏/webdriver 标记；请求策略仍走 CDP Fetch）
      return new DefaultBrowserService(
        new PlaywrightBrowserPort({
          headless: options.headless,
          channel: options.channel,
          timeoutMs: options.timeoutMs,
          viewport: options.viewport,
          locale: options.locale,
          driver: 'rebrowser-playwright-core',
          engine: 'rebrowser',
        }),
        { sessionIdleTimeoutMs: options.sessionIdleTimeoutMs },
      );
    case 'camoufox':
      // P3 备选 stealth 后端：隔离 provider 的定制 Firefox（指纹差异化；无 CDP Fetch
      // 域 → 请求策略走 route 逐跳走查）
      return new DefaultBrowserService(
        new PlaywrightBrowserPort({
          headless: options.headless,
          timeoutMs: options.timeoutMs,
          viewport: options.viewport,
          locale: options.locale,
          engine: 'camoufox',
          policyMode: 'route-walk',
          launcher: createCamoufoxLauncher(),
        }),
        { sessionIdleTimeoutMs: options.sessionIdleTimeoutMs },
      );
    case 'stealth': {
      // P3 隐身链：按 stealth.fallback（缺省 rebrowser->camoufox）建链；挑战命中有界轮换
      const chainNames = parseFallbackChain(options.stealth?.fallback);
      const chain = chainNames.map(
        (name) => createBrowserService({ ...options, engine: name }) as DefaultBrowserService,
      );
      return new StealthFallbackService(chain);
    }
    case 'cloud':
      throw new Error(
        `not_implemented: browser engine "${engine}" lands in P4 (arch/browser-capability.md §4)`,
      );
    default:
      throw new Error(`not_implemented: unknown browser engine "${engine}"`);
  }
}

/**
 * 解析 playwright-core 自带 CLI 路径（`octopi browser install` 用）。
 * 从引擎侧解析（engine 自己的可选依赖），npm/pnpm/嵌套布局都一致。
 *
 * @returns cli.js 绝对路径；playwright-core 未安装时返回 null（调用方 fail-loud）
 */
export function resolvePlaywrightCliPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('playwright-core/package.json');
    return join(dirname(pkgPath), 'cli.js');
  } catch {
    return null;
  }
}

/**
 * 解析 rebrowser-playwright-core 自带 CLI 路径（P3：rebrowser Chromium 安装用）。
 * 同 `resolvePlaywrightCliPath` 解析方式（fork 同布局）。
 *
 * @returns cli.js 绝对路径；未安装时返回 null（调用方 fail-loud）
 */
export function resolveRebrowserCliPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('rebrowser-playwright-core/package.json');
    return join(dirname(pkgPath), 'cli.js');
  } catch {
    return null;
  }
}
