/**
 * CLI 共用工具
 */

import { resolve, dirname, join } from 'node:path';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getOctopiHome } from '@octopi-agent/engine/paths.js';
import { readPidFile } from './daemon.js';
import {
  isProcessAlive,
  killProcess,
  spawnDetached,
} from './process-utils.js';

/** Web UI PID 文件记录（兼容旧版纯数字 PID） */
export interface WebUiPidRecord {
  pid: number;
  dir?: string;
  /** 启动时的 web.host（local / lan / IP） */
  host?: string;
  startedAt?: string;
}

/** CLI 包根目录（source: src/cli → 仓库根；dist: dist/cli → 包根） */
function getCliPackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..');
}

function hasIndexHtml(dir: string): boolean {
  return existsSync(join(dir, 'index.html'));
}

/** 目录若本身是预构建 dist，或其下有 dist/，返回 dist 路径（排除 Vite 源码根） */
function asDistDir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const nested = join(dir, 'dist');
  if (hasIndexHtml(nested)) return nested;
  // 明确的 dist（无 vite 源码标志）
  const looksLikeSource =
    existsSync(join(dir, 'vite.config.ts')) ||
    existsSync(join(dir, 'vite.config.js')) ||
    existsSync(join(dir, 'package.json'));
  if (hasIndexHtml(dir) && !looksLikeSource) return dir;
  return null;
}

/**
 * 解析预构建 WebUI dist（产品形态：静态托管，不启 Vite）
 *
 * 查找顺序（显式优先）：
 * 1. $OCTOPI_WEB_DIR（可指向 dist 或包根）
 * 2. 配置 web.dir
 * 3. node_modules/@octopi-agent/webui/dist（npm 依赖 — 方案 B）
 * 4. monorepo packages/webui/dist
 * 5. ~/.octopi/web/dist
 */
export function findWebDist(
  configPath?: string,
  configWebDir?: string,
): string | null {
  const candidates: string[] = [];

  if (process.env.OCTOPI_WEB_DIR) {
    candidates.push(resolve(process.env.OCTOPI_WEB_DIR));
  }
  if (configWebDir) {
    candidates.push(resolve(configWebDir));
  }
  if (configPath) {
    candidates.push(resolve(dirname(resolve(configPath)), 'web'));
    candidates.push(resolve(dirname(resolve(configPath)), 'packages', 'webui'));
  }

  const root = getCliPackageRoot();
  // published: octopi-agent/node_modules/@octopi-agent/webui/dist
  candidates.push(resolve(root, 'node_modules', '@octopi-agent', 'webui'));
  candidates.push(resolve(root, 'node_modules', '@octopi-agent', 'webui', 'dist'));
  // monorepo workspace link
  candidates.push(resolve(root, 'packages', 'webui'));
  candidates.push(resolve(root, 'packages', 'webui', 'dist'));
  candidates.push(resolve(getOctopiHome(), 'web'));
  candidates.push(resolve(process.cwd(), 'node_modules', '@octopi-agent', 'webui'));
  candidates.push(resolve(process.cwd(), 'packages', 'webui'));

  for (const candidate of candidates) {
    const dist = asDistDir(candidate);
    if (dist) return dist;
  }
  return null;
}

/** @deprecated use {@link findWebDist} — product serves prebuilt dist */
export function findWebDir(
  configPath?: string,
  configWebDir?: string,
): string | null {
  return findWebDist(configPath, configWebDir);
}

export interface StartWebUiOptions {
  /** listen host（local → 127.0.0.1，lan → 0.0.0.0） */
  hostArg?: string;
  /** listen port（默认 8180） */
  port?: number;
  /** 网关端口：透传给 serve-webui 动态下发 /octopi-config.js（缺省不下发） */
  gatewayPort?: number;
}

export function startWebUi(distDir: string, options?: StartWebUiOptions): number | null {
  const serveJs = join(getCliPackageRoot(), 'dist', 'cli', 'serve-webui.js');
  const entry = existsSync(serveJs)
    ? serveJs
    : join(dirname(fileURLToPath(import.meta.url)), 'serve-webui.js');
  if (!existsSync(entry)) return null;
  const args = [entry, distDir];
  if (options?.hostArg) args.push('--host', options.hostArg);
  if (options?.port) args.push('--port', String(options.port));
  if (options?.gatewayPort) args.push('--gateway-port', String(options.gatewayPort));
  return spawnDetached(process.execPath, args, { cwd: distDir });
}

export async function stopWebUi(pid: number): Promise<void> {
  await killProcess(pid, { timeoutMs: 3000 });
}

/**
 * `/octopi-config.js` 响应体：把网关端口运行时下发给前端。
 *
 * 唯一真相源是 `octopi.json`——serve-webui 启动时读取，前端加载本脚本后
 * 优先使用其中的端口，构建期兜底仅作回退。
 *
 * @param port 网关端口；undefined 时下发 null（前端走默认）
 * @returns JavaScript 赋值语句
 */
export function gatewayConfigScript(port?: number): string {
  return port !== undefined
    ? `window.__OCTOPI_GATEWAY__=${JSON.stringify({ port })};\n`
    : 'window.__OCTOPI_GATEWAY__=null;\n';
}

export function getWebUiPidPath(): string {
  return join(getOctopiHome(), 'webui.pid');
}

export function readWebUiPidRecord(): WebUiPidRecord | null {
  const pidPath = getWebUiPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, 'utf-8').trim();
    if (!raw) return null;
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as Partial<WebUiPidRecord>;
      const pid = Number(parsed.pid);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      return {
        pid,
        dir: typeof parsed.dir === 'string' && parsed.dir ? parsed.dir : undefined,
        host: typeof parsed.host === 'string' && parsed.host ? parsed.host : undefined,
        startedAt: typeof parsed.startedAt === 'string' && parsed.startedAt ? parsed.startedAt : undefined,
      };
    }
    // 旧版：纯数字 PID
    const pid = parseInt(raw, 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid };
  } catch {
    return null;
  }
}

export function readWebUiPidFile(): number | null {
  return readWebUiPidRecord()?.pid ?? null;
}

export function writeWebUiPidFile(pid: number, extra?: Omit<WebUiPidRecord, 'pid'>): void {
  const record: WebUiPidRecord = {
    pid,
    dir: extra?.dir,
    host: extra?.host,
    startedAt: extra?.startedAt ?? new Date().toISOString(),
  };
  writeFileSync(getWebUiPidPath(), JSON.stringify(record, null, 2));
}

export function removeWebUiPidFile(): void {
  const pidPath = getWebUiPidPath();
  if (existsSync(pidPath)) {
    try { unlinkSync(pidPath); } catch { /* ignore */ }
  }
}

export function resolveGatewayUrl(config: Record<string, unknown>): string {
  const pidFile = readPidFile();
  if (pidFile && isProcessAlive(pidFile.pid) && pidFile.port) {
    return `http://localhost:${pidFile.port}`;
  }
  const channels = (config.channels ?? []) as Array<Record<string, unknown>>;
  const httpChannel = channels.find((c) => c.type === 'http') as Record<string, unknown> | undefined;
  if (httpChannel?.port) {
    return `http://localhost:${httpChannel.port as number}`;
  }
  return 'http://localhost:18180';
}
