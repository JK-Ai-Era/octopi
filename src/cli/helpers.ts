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
  /** Git 页签轮询间隔（秒）：透传给 serve-webui 下发（缺省不下发，前端回落默认） */
  gitStatusPollSeconds?: number;
}

/**
 * 组装 serve-webui 的 argv（纯函数，供测试锁定 0 哨兵语义）。
 *
 * @param distDir - WebUI dist 目录（argv[2]）
 * @param options - host/port/gatewayPort/gitStatusPollSeconds 透传项
 * @returns distDir 之后的 argv 段
 */
export function webUiServeArgs(distDir: string, options?: StartWebUiOptions): string[] {
  const args = [distDir];
  if (options?.hostArg) args.push('--host', options.hostArg);
  if (options?.port) args.push('--port', String(options.port));
  if (options?.gatewayPort) args.push('--gateway-port', String(options.gatewayPort));
  // `!== undefined` 是 0 哨兵的保命线：0 = 不自动轮询，truthy 判断会把它静默吞掉
  if (options?.gitStatusPollSeconds !== undefined) {
    args.push('--git-status-poll-seconds', String(options.gitStatusPollSeconds));
  }
  return args;
}

export function startWebUi(distDir: string, options?: StartWebUiOptions): number | null {
  const serveJs = join(getCliPackageRoot(), 'dist', 'cli', 'serve-webui.js');
  const entry = existsSync(serveJs)
    ? serveJs
    : join(dirname(fileURLToPath(import.meta.url)), 'serve-webui.js');
  if (!existsSync(entry)) return null;
  return spawnDetached(process.execPath, [entry, ...webUiServeArgs(distDir, options)], {
    cwd: distDir,
  });
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

/**
 * `/octopi-config.js` 响应体（UI 行为旋钮段）：与网关地址一起下发。
 *
 * 唯一真相源是 `octopi.json`（`web.gitStatusPollSeconds` 等）；缺省下发 null，
 * 前端走内置默认。与 `gatewayConfigScript` 分开发射——网关地址与 UI 行为是
 * 两类语义，各归各的全局（`window.__OCTOPI_GATEWAY__` / `window.__OCTOPI_WEB__`）。
 *
 * @param web - UI 旋钮对象；undefined 时下发 null
 * @returns JavaScript 赋值语句
 */
export function webConfigScript(web?: { gitStatusPollSeconds?: number }): string {
  return web !== undefined
    ? `window.__OCTOPI_WEB__=${JSON.stringify(web)};\n`
    : 'window.__OCTOPI_WEB__=null;\n';
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

/**
 * 解析 Gateway 控制台钥匙（channels[type=http].apiKey）
 *
 * WS 认证契约：apiKey 配置后，客户端连接须首条消息送 auth（GatewayChatClient 已支持）。
 * TUI 与 Gateway 同机读同一份配置，无需像 WebUI 那样手工录入。
 *
 * @param config - 已加载的配置对象
 * @returns apiKey 字符串；未配置或为空串时返回 undefined（无鉴权模式）
 */
export function resolveGatewayApiKey(config: Record<string, unknown>): string | undefined {
  const channels = (config.channels ?? []) as Array<Record<string, unknown>>;
  const httpChannel = channels.find((c) => c.type === 'http') as Record<string, unknown> | undefined;
  const apiKey = httpChannel?.apiKey;
  return typeof apiKey === 'string' && apiKey ? apiKey : undefined;
}

/**
 * 按 `--agent` 选择 chat 目标 agent。
 *
 * @param agents - config.agents 列表
 * @param requestedId - `--agent` 取值；缺省取第一个
 * @returns 命中的 agent；列表为空或 id 不存在返回 undefined
 */
export function selectChatAgent<T extends { id: string }>(
  agents: T[],
  requestedId?: string,
): T | undefined {
  if (agents.length === 0) return undefined;
  if (!requestedId) return agents[0];
  return agents.find((a) => a.id === requestedId);
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
