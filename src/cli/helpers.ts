/**
 * CLI 共用工具
 */

import { resolve, dirname, join } from 'node:path';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { getOctopiHome } from '../init.js';
import { readPidFile } from './daemon.js';
import {
  isProcessAlive,
  killProcess,
  resolveViteLaunch,
  spawnDetached,
} from './process-utils.js';

export function findWebDir(configPath?: string): string | null {
  const candidates: string[] = [];

  if (process.env.OCTOPI_WEB_DIR) {
    candidates.push(resolve(process.env.OCTOPI_WEB_DIR));
  }

  if (configPath) {
    candidates.push(resolve(dirname(resolve(configPath)), 'web'));
  }

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

export function startWebUi(webDir: string): number | null {
  const launch = resolveViteLaunch(webDir);
  if (!launch) return null;
  return spawnDetached(launch.command, launch.args, { cwd: webDir });
}

export async function stopWebUi(pid: number): Promise<void> {
  await killProcess(pid, { timeoutMs: 3000 });
}

export function getWebUiPidPath(): string {
  return join(getOctopiHome(), 'webui.pid');
}

export function readWebUiPidFile(): number | null {
  const pidPath = getWebUiPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    return parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
  } catch {
    return null;
  }
}

export function writeWebUiPidFile(pid: number): void {
  writeFileSync(getWebUiPidPath(), String(pid));
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
