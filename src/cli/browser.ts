/**
 * octopi browser — 浏览器引擎管理（arch/browser-capability.md §3.9）
 *
 * `octopi browser install`：安装管理版 Chromium（playwright-core 自带 CLI，
 * 版本恒与运行时库一致；浏览器二进制不随 npm 包下载，经本命令显式安装）。
 * 备选零下载路径：`browser.channel: "chrome"` 用系统 Chrome，无需本命令。
 */

import type { CliArgs } from './args.js';
import { spawn } from 'node:child_process';

/**
 * browser 命令入口（`octopi browser install`）。
 *
 * @param args - CLI 参数（subcommand 分派）
 */
export async function browserCommand(args: CliArgs): Promise<void> {
  if (args.subcommand !== 'install') {
    console.error(
      `Unknown browser subcommand: ${args.subcommand ?? '(none)'} — supported: install`,
    );
    process.exit(1);
  }

  // 引擎侧解析 CLI（engine 自己的可选依赖；npm/pnpm/嵌套布局一致，版本恒配）
  const { resolvePlaywrightCliPath } = await import(
    '@octopi-agent/engine/integration/browser/index.js'
  );
  const cliPath = resolvePlaywrightCliPath();
  if (!cliPath) {
    console.error(
      'playwright-core is not installed (optional dependency). ' +
        'Reinstall octopi without --omit=optional, or run: npm install playwright-core',
    );
    process.exit(1);
    return;
  }

  console.log('[browser] installing managed Chromium via playwright-core (version-matched)…');
  const code = await run(process.execPath, [cliPath, 'install', 'chromium']);
  if (code === 0) {
    console.log('[browser] done. Set browser.channel="chrome" in octopi.json to use system Chrome instead.');
  } else {
    console.error(`[browser] install failed (exit ${code}); on Linux you may also need system libs: node <playwright-core>/cli.js install --with-deps chromium`);
  }
  process.exit(code);
}

/** 透传子进程 stdio，返回退出码（被信号杀死按 1 记） */
function run(cmd: string, cmdArgs: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`[browser] failed to launch installer: ${err.message}`);
      resolve(1);
    });
    child.on('close', (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
