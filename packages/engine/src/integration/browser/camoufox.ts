/**
 * integration/browser/camoufox.ts — Camoufox 后端接入（P3 备选 stealth）
 *
 * **依赖隔离设计**：camoufox-js 的 peer 钉 `playwright-core <1.63`（与主树
 * 1.65+ 冲突）且带原生依赖（better-sqlite3 等）——不进主依赖树。`octopi browser
 * install --engine camoufox` 在独立 provider 目录（`OCTOPI_HOME/browser-providers/
 * camoufox/`，自带 package.json）安装 camoufox-js + 自洽的 playwright-core，运行期
 * **按绝对路径动态 import**，依赖冲突与原生构建不外溢到嵌入方安装树。
 *
 * Camoufox 自带定制 Firefox 二进制（`camoufox-js fetch` 下载，pin 版本），不依赖
 * 系统安装 Firefox；其返回的是标准 Playwright Browser/Page，走既有会话实现。
 *
 * @module
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PwBrowser } from './playwright.js';

/** camoufox-js 的最小结构（运行时动态 import；编译期零耦合） */
interface CamoufoxModule {
  /** 启动定制 Firefox，返回 Playwright Browser（firefox/Juggler） */
  Camoufox(options?: unknown): Promise<unknown>;
}

/** 启动器形状（与 PlaywrightBrowserPort 的 launcher 参数结构兼容） */
export type CamoufoxLauncher = (opts: {
  headless: boolean;
  channel?: 'chromium' | 'chrome';
  timeoutMs?: number;
}) => Promise<PwBrowser>;

/**
 * camoufox provider 安装目录（与 `octopi browser install --engine camoufox` 同一约定）。
 *
 * @returns `<OCTOPI_HOME>/browser-providers/camoufox`（OCTOPI_HOME 缺省 ~/.octopi）
 */
export function camoufoxProviderDir(): string {
  const home = process.env.OCTOPI_HOME || join(homedir(), '.octopi');
  return join(home, 'browser-providers', 'camoufox');
}

/**
 * 解析 camoufox-js 自带 CLI 路径（`octopi browser install` 下载浏览器用）。
 *
 * @returns dist/__main__.js 绝对路径；provider 未安装时返回 null
 */
export function resolveCamoufoxJsCliPath(): string | null {
  try {
    const entry = join(
      camoufoxProviderDir(),
      'node_modules',
      'camoufox-js',
      'dist',
      '__main__.js',
    );
    return entry;
  } catch {
    return null;
  }
}

let providerPromise: Promise<CamoufoxModule> | undefined;

/**
 * 加载隔离安装的 camoufox-js provider（绝对路径 import；单飞缓存）。
 *
 * @throws provider 未安装时 `not_implemented: … — run "octopi browser install --engine camoufox"`（fail-loud，不静默降级）
 */
export async function loadCamoufoxProvider(): Promise<CamoufoxModule> {
  if (!providerPromise) {
    providerPromise = (async () => {
      const entry = join(camoufoxProviderDir(), 'node_modules', 'camoufox-js', 'dist', 'index.js');
      try {
        return (await import(pathToFileURL(entry).href)) as CamoufoxModule;
      } catch (err) {
        providerPromise = undefined; // 允许安装后重试
        throw new Error(
          'not_implemented: camoufox provider not installed — run "octopi browser install --engine camoufox"',
          { cause: err },
        );
      }
    })();
  }
  return providerPromise;
}

/**
 * 创建 camoufox 启动器（注入 PlaywrightBrowserPort 的 `launcher`）。
 *
 * 浏览器二进制由 camoufox-js 自行解析（`CAMOUFOX_INSTALL_DIR`/`~/.cache/camoufox`，
 * 缺失时首启自动下载——显式安装仍推荐 `octopi browser install --engine camoufox`）。
 *
 * @returns 结构兼容 PwBrowser 的启动器（firefox/Juggler 驱动）
 */
export function createCamoufoxLauncher(): CamoufoxLauncher {
  return async ({ headless, timeoutMs }) => {
    const mod = await loadCamoufoxProvider();
    return mod.Camoufox({
      headless,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    }) as Promise<PwBrowser>;
  };
}
