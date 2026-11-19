/**
 * octopi browser — 浏览器引擎管理（arch/browser-capability.md §3.9）
 *
 * `octopi browser install [engine]`：显式安装浏览器二进制/提供方（二进制不随 npm
 * 包下载）。`engine` 与 `browser.engine` 同名：
 * - `playwright`（缺省）：管理版 Chromium（playwright-core 自带 CLI，版本恒配）
 * - `rebrowser`：rebrowser 的 Chromium 构建（rebrowser-playwright-core 自带 CLI）
 * - `camoufox`：隔离 provider 目录（自带 camoufox-js + 自洽 playwright-core）+
 *   Camoufox 定制 Firefox 下载（不依赖系统 Firefox）
 * - `stealth` = rebrowser + camoufox（engine="stealth" 链所需全部）
 *
 * 备选零下载路径：`browser.channel: "chrome"` 用系统 Chrome，无需本命令。
 */

import type { CliArgs } from './args.js';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  const engine = args.target ?? 'playwright';

  let failed = false;
  if (engine === 'playwright' || engine === 'stealth') {
    failed = (await installManagedChromium('playwright')) || failed;
  }
  if (engine === 'rebrowser' || engine === 'stealth') {
    failed = (await installManagedChromium('rebrowser')) || failed;
  }
  if (engine === 'camoufox') {
    failed = (await installCamoufoxProvider()) || failed;
  }
  if (engine !== 'playwright' && engine !== 'rebrowser' && engine !== 'camoufox' && engine !== 'stealth') {
    console.error(
      `Unknown browser engine "${engine}" — supported: playwright | rebrowser | camoufox | stealth`,
    );
    process.exit(1);
    return;
  }
  process.exit(failed ? 1 : 0);
}

/** 安装 Chromium 系管理浏览器（playwright / rebrowser 各自的 CLI，版本恒配） */
async function installManagedChromium(kind: 'playwright' | 'rebrowser'): Promise<boolean> {
  const mod = await import('@octopi-agent/engine/integration/browser/index.js');
  const cliPath =
    kind === 'playwright' ? mod.resolvePlaywrightCliPath() : mod.resolveRebrowserCliPath();
  const pkg = kind === 'playwright' ? 'playwright-core' : 'rebrowser-playwright-core';
  if (!cliPath) {
    console.error(
      `${pkg} is not installed (optional dependency). ` +
        `Reinstall octopi without --omit=optional, or run: npm install ${pkg}`,
    );
    return true;
  }
  console.log(`[browser] installing managed Chromium via ${pkg} (version-matched)…`);
  const code = await run(process.execPath, [cliPath, 'install', 'chromium']);
  if (code === 0) {
    console.log(`[browser] ${kind} chromium ready.`);
    return false;
  }
  console.error(
    `[browser] ${kind} install failed (exit ${code}); on Linux you may also need system libs: node ${cliPath} install --with-deps chromium`,
  );
  return true;
}

/**
 * 装 camoufox 隔离 provider（自带依赖树）+ 下载 Camoufox 定制 Firefox。
 *
 * 依赖隔离：camoufox-js 的 peer（playwright-core <1.63）与原生依赖只装在 provider
 * 目录内，不触碰主安装树。provider 目录约定见 engine 的 `camoufoxProviderDir()`。
 */
async function installCamoufoxProvider(): Promise<boolean> {
  const { camoufoxProviderDir, resolveCamoufoxJsCliPath } = await import(
    '@octopi-agent/engine/integration/browser/index.js'
  );
  const dir = camoufoxProviderDir();
  console.log(`[browser] preparing camoufox provider at ${dir}…`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'octopi-camoufox-provider',
        private: true,
        description: 'isolated Camoufox provider (camoufox-js + self-consistent playwright-core)',
        dependencies: {
          'camoufox-js': '^0.13.0',
          // camoufox-js peer 钉 <1.63；这里给自洽版本（仅本目录生效，不外溢）
          'playwright-core': '~1.62.0',
        },
      },
      null,
      2,
    ),
  );
  const installCode = await run('npm', ['install', '--no-audit', '--no-fund'], dir);
  if (installCode !== 0) {
    console.error('[browser] camoufox provider npm install failed (see output above)');
    return true;
  }
  const fetchCli = resolveCamoufoxJsCliPath();
  if (!fetchCli) {
    console.error('[browser] camoufox-js CLI not found after install — provider dir is incomplete');
    return true;
  }
  console.log('[browser] fetching Camoufox browser build (pinned)…');
  const fetchCode = await run(process.execPath, [fetchCli, 'fetch']);
  if (fetchCode !== 0) {
    console.error('[browser] camoufox fetch failed (see output above)');
    return true;
  }
  console.log('[browser] camoufox ready. Set browser.engine="camoufox" (or "stealth") in octopi.json.');
  return false;
}

/** 透传子进程 stdio，返回退出码（被信号杀死按 1 记） */
function run(cmd: string, cmdArgs: string[], cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { stdio: 'inherit', ...(cwd ? { cwd } : {}) });
    child.on('error', (err) => {
      console.error(`[browser] failed to launch installer: ${err.message}`);
      resolve(1);
    });
    child.on('close', (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
