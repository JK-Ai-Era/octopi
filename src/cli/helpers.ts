/**
 * CLI 共用工具
 */

import { resolve, dirname, join } from 'node:path';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getOctopiHome } from '../init.js';
import { readPidFile } from './daemon.js';
import {
  isProcessAlive,
  killProcess,
  resolveViteLaunch,
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

/**
 * 解析 Web UI 源码目录
 *
 * 查找顺序（显式优先）：
 * 1. $OCTOPI_WEB_DIR
 * 2. 配置 web.dir
 * 3. 配置文件同级 /web
 * 4. OCTOPI_HOME/web
 * 5. CLI 包根 /web（全局 npm 安装自带 web/ 时生效）
 * 6. cwd/web
 * 7. 自 cwd 向上寻找 web/package.json
 */
export function findWebDir(
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
  }

  candidates.push(resolve(getOctopiHome(), 'web'));
  candidates.push(resolve(getCliPackageRoot(), 'web'));
  candidates.push(resolve(process.cwd(), 'web'));

  let dir = process.cwd();
  let prev = '';
  while (dir !== prev) {
    const candidate = join(dir, 'web');
    if (existsSync(join(candidate, 'package.json'))) {
      candidates.push(candidate);
      break;
    }
    prev = dir;
    dir = dirname(dir);
  }

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

export interface StartWebUiOptions {
  /** Vite `--host` 参数（如 `localhost` / `0.0.0.0`）；省略则用 vite.config 默认 */
  hostArg?: string;
}

export function startWebUi(webDir: string, options?: StartWebUiOptions): number | null {
  const launch = resolveViteLaunch(webDir, { hostArg: options?.hostArg });
  if (!launch) return null;
  return spawnDetached(launch.command, launch.args, { cwd: webDir });
}

export async function stopWebUi(pid: number): Promise<void> {
  await killProcess(pid, { timeoutMs: 3000 });
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
  return 'http://localhost:3000';
}
