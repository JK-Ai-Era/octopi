/**
 * octopi browser — 浏览器引擎管理（arch/browser-capability.md §3.9）
 *
 * `octopi browser install [engine]`：显式安装浏览器二进制/提供方（二进制不随 npm
 * 包下载）。安装逻辑单一实现在 engine 的 `integration/browser/install.ts`（与
 * gateway / WebUI 设置页共用）——本 CLI 只做参数分派 + 终端透传。
 *
 * engine 与 `browser.engine` 同名：
 * - `playwright`（缺省）：管理版 Chromium
 * - `rebrowser`：rebrowser 的 Chromium 构建
 * - `camoufox`：隔离 provider + Camoufox 定制 Firefox（不依赖系统 Firefox）
 * - `stealth` = rebrowser + camoufox（engine="stealth" 链所需全部）
 *
 * 备选零下载路径：`browser.channel: "chrome"` 用系统 Chrome，无需本命令。
 */

import type { CliArgs } from './args.js';

/**
 * browser 命令入口（`octopi browser install [engine]`）。
 *
 * @param args - CLI 参数（`target` = 引擎名，缺省 playwright）
 */
export async function browserCommand(args: CliArgs): Promise<void> {
  if (args.subcommand !== 'install') {
    console.error(
      `Unknown browser subcommand: ${args.subcommand ?? '(none)'} — supported: install [playwright|rebrowser|camoufox|stealth]`,
    );
    process.exit(1);
  }
  const { installEngine } = await import(
    '@octopi-agent/engine/integration/browser/install.js'
  );
  const engine = args.target ?? 'playwright';
  const result = await installEngine(engine, {
    onProgress: (line) => console.log(line),
  });
  if (result.ok) {
    console.log(`[browser] done. ${result.detail}`);
    if (engine === 'playwright') {
      console.log(
        '[browser] tip: set browser.channel="chrome" in octopi.json to use system Chrome instead.',
      );
    }
  } else {
    console.error(`[browser] ${result.detail}`);
  }
  process.exit(result.ok ? 0 : 1);
}
