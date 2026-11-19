/**
 * integration/browser/install — 浏览器引擎安装单一实现（arch/browser-capability.md §3.9）
 *
 * CLI（`octopi browser install`）与 gateway（WebUI 设置页）共用本模块——安装
 * 逻辑只此一份（One source of truth）。子进程输出按行回调 `onProgress`：CLI 透传
 * 终端，gateway 缓冲进安装任务供前端轮询。
 *
 * 覆盖面：
 * - `playwright` / `rebrowser`：管理版 Chromium（各自驱动的 CLI，版本恒配）。
 *   只补库不补浏览器时二进制来自 playwright 系 registry；安装幂等。
 * - `camoufox`：隔离 provider 目录（自带 camoufox-js + 自洽 playwright-core）+
 *   Camoufox 定制 Firefox 下载（不依赖系统 Firefox）。
 * - `stealth` = rebrowser + camoufox（engine="stealth" 链所需全部）。
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  camoufoxProviderDir,
  resolveCamoufoxJsCliPath,
  resolvePlaywrightCliPath,
  resolveRebrowserCliPath,
} from './index.js';

/** 可安装引擎（与 browser.engine 同名；cdp-attach 用真实浏览器无需安装） */
export type InstallableEngine = 'playwright' | 'rebrowser' | 'camoufox' | 'stealth';

const INSTALLABLE: ReadonlySet<string> = new Set(['playwright', 'rebrowser', 'camoufox', 'stealth']);

/** 引擎就绪状态（WebUI 状态卡消费） */
export interface EngineStatus {
  /** 引擎名（含 cdp-attach：恒 ready——浏览器就是用户的 Chrome） */
  engine: 'playwright' | 'rebrowser' | 'camoufox' | 'stealth' | 'cdp-attach';
  /** 就绪判定：驱动包在 + 二进制在（启发式探测，detail 说明依据） */
  ready: boolean;
  /** 人类可读的状态依据（缺什么、下一步跑什么） */
  detail: string;
}

/** 安装结果 */
export interface InstallResult {
  ok: boolean;
  /** 汇总说明（ok=false 时是失败依据） */
  detail: string;
}

function cacheCandidates(envOverride: string | undefined, name: string): string[] {
  const out: string[] = [];
  if (envOverride) out.push(envOverride);
  // playwright 系 registry 缓存平台约定：mac=~/Library/Caches、win=%LOCALAPPDATA%、其余 ~/.cache
  if (process.platform === 'darwin') out.push(join(homedir(), 'Library', 'Caches', name));
  else if (process.platform === 'win32') {
    out.push(join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), name));
  }
  out.push(join(homedir(), '.cache', name));
  return out;
}

/** 二进制在位探测（启发式：registry 目录约定、平台多候选；detail 里如实标注探测口径） */
function chromiumBinaryPresent(): boolean {
  // playwright 系 registry 解压为 chromium-<rev> 目录（rebrowser 同布局、独立 rev）
  return cacheCandidates(process.env.PLAYWRIGHT_BROWSERS_PATH, 'ms-playwright').some((root) => {
    if (!existsSync(root)) return false;
    return (readdirSafe(root) ?? []).some((d) => d.startsWith('chromium-'));
  });
}

function readdirSafe(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

/**
 * 探测全部引擎的就绪状态（WebUI 状态卡 / CLI 预检共用）。
 *
 * @returns 各引擎状态（顺序固定：playwright / rebrowser / camoufox / stealth / cdp-attach）
 */
export function probeEngines(): EngineStatus[] {
  const pwDriver = resolvePlaywrightCliPath() !== null;
  const rbDriver = resolveRebrowserCliPath() !== null;
  const bin = chromiumBinaryPresent();
  const providerDir = camoufoxProviderDir();
  const camoufoxJs = resolveCamoufoxJsCliPath() !== null;
  const camoufoxBin = cacheCandidates(process.env.CAMOUFOX_EXTRACT_PATH, 'camoufox').some((d) =>
    existsSync(d),
  );

  const describe = (driver: boolean, hint: string): { ready: boolean; detail: string } => {
    if (!driver) return { ready: false, detail: `驱动包缺失（可选依赖未装）——先 "npm install ${hint}" 或重装 octopi（勿 --omit=optional）` };
    if (!bin) return { ready: false, detail: '驱动在位，浏览器二进制缺失——运行 "octopi browser install" 安装管理版 Chromium' };
    return { ready: true, detail: '就绪（驱动 + 管理版 Chromium，二进制按 registry 目录探测）' };
  };

  const pw = describe(pwDriver, 'playwright-core');
  const rb = describe(rbDriver, 'rebrowser-playwright-core');
  const camoufox = (() => {
    if (!camoufoxJs) {
      return { ready: false, detail: `隔离 provider 未安装（${providerDir}）——运行 "octopi browser install camoufox"` };
    }
    if (!camoufoxBin) {
      return { ready: false, detail: 'provider 在位，Camoufox 浏览器未下载——运行 "octopi browser install camoufox"' };
    }
    return { ready: true, detail: '就绪（隔离 provider + Camoufox 定制 Firefox）' };
  })();

  return [
    { engine: 'playwright', ...pw },
    { engine: 'rebrowser', ...rb },
    { engine: 'camoufox', ...camoufox },
    {
      engine: 'stealth',
      ready: rb.ready && camoufox.ready,
      detail:
        rb.ready && camoufox.ready
          ? '就绪（rebrowser + camoufox 链齐备）'
          : `链缺成员：rebrowser ${rb.ready ? '✓' : '✗'} / camoufox ${camoufox.ready ? '✓' : '✗'}——运行 "octopi browser install stealth"`,
    },
    { engine: 'cdp-attach', ready: true, detail: 'attach 用户真实 Chrome，无需安装（运行时连接 CDP 端点）' },
  ];
}

/**
 * 安装引擎二进制 / 提供方（幂等；重跑安全）。
 *
 * @param engine - 引擎名（stealth = rebrowser + camoufox）
 * @param options.onProgress - 子进程输出按行回调（CLI 透传终端；gateway 缓冲）
 * @returns 安装结果（ok=false 时 detail 是失败依据；不静默吞错）
 */
export async function installEngine(
  engine: string,
  options: { onProgress?: (line: string) => void } = {},
): Promise<InstallResult> {
  const emit = (line: string): void => options.onProgress?.(line);
  if (!INSTALLABLE.has(engine)) {
    return {
      ok: false,
      detail: `unknown browser engine "${engine}" — supported: playwright | rebrowser | camoufox | stealth`,
    };
  }
  if (engine === 'playwright' || engine === 'stealth') {
    const r = await installManagedChromium('playwright', emit);
    if (!r.ok) return r;
  }
  if (engine === 'rebrowser' || engine === 'stealth') {
    const r = await installManagedChromium('rebrowser', emit);
    if (!r.ok) return r;
  }
  if (engine === 'camoufox') {
    return installCamoufoxProvider(emit);
  }
  return { ok: true, detail: `${engine} ready` };
}

async function installManagedChromium(
  kind: 'playwright' | 'rebrowser',
  emit: (line: string) => void,
): Promise<InstallResult> {
  const cliPath = kind === 'playwright' ? resolvePlaywrightCliPath() : resolveRebrowserCliPath();
  const pkg = kind === 'playwright' ? 'playwright-core' : 'rebrowser-playwright-core';
  if (!cliPath) {
    return {
      ok: false,
      detail:
        `${pkg} is not installed (optional dependency). ` +
        `Reinstall octopi without --omit=optional, or run: npm install ${pkg}`,
    };
  }
  emit(`[${kind}] installing managed Chromium via ${pkg} (version-matched)…`);
  const code = await run(process.execPath, [cliPath, 'install', 'chromium'], undefined, emit);
  if (code === 0) {
    emit(`[${kind}] chromium ready.`);
    return { ok: true, detail: `${kind} chromium installed` };
  }
  return {
    ok: false,
    detail: `[${kind}] install failed (exit ${code}); on Linux you may also need system libs: node ${cliPath} install --with-deps chromium`,
  };
}

/**
 * 装 camoufox 隔离 provider（自带依赖树）+ 下载 Camoufox 定制 Firefox。
 *
 * 依赖隔离：camoufox-js 的 peer（playwright-core <1.63）与原生依赖只装在 provider
 * 目录内，不触碰主安装树。provider 目录约定见 `camoufoxProviderDir()`。
 */
async function installCamoufoxProvider(emit: (line: string) => void): Promise<InstallResult> {
  const dir = camoufoxProviderDir();
  emit(`[camoufox] preparing isolated provider at ${dir}…`);
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
  const installCode = await run('npm', ['install', '--no-audit', '--no-fund'], dir, emit);
  if (installCode !== 0) {
    return { ok: false, detail: 'camoufox provider npm install failed (see progress output)' };
  }
  const fetchCli = resolveCamoufoxJsCliPath();
  if (!fetchCli) {
    return { ok: false, detail: 'camoufox-js CLI not found after install — provider dir is incomplete' };
  }
  emit('[camoufox] fetching Camoufox browser build (pinned)…');
  const fetchCode = await run(process.execPath, [fetchCli, 'fetch'], undefined, emit);
  if (fetchCode !== 0) {
    return { ok: false, detail: 'camoufox fetch failed (see progress output)' };
  }
  emit('[camoufox] ready. Set browser.engine="camoufox" (or "stealth") in octopi.json.');
  return { ok: true, detail: 'camoufox provider + browser installed' };
}

/** 透传子进程输出（按行回调），返回退出码（被信号杀死按 1 记） */
function run(
  cmd: string,
  cmdArgs: string[],
  cwd: string | undefined,
  emit: (line: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      stdio: ['inherit', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    });
    const pump = (stream: NodeJS.ReadableStream, prefix: string): void => {
      let buf = '';
      stream.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) emit(prefix + line);
      });
      stream.on('end', () => {
        if (buf.trim()) emit(prefix + buf);
      });
    };
    pump(child.stdout, '');
    pump(child.stderr, '[!] ');
    child.on('error', (err) => {
      emit(`failed to launch installer: ${err.message}`);
      resolve(1);
    });
    child.on('close', (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
