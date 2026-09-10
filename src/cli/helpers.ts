/**
 * CLI 共用工具
 */

import { resolve, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { getOctopiHome } from '../init.js';
import { readPidFile, isProcessAlive } from './daemon.js';

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
  try {
    const viteBin = join(webDir, 'node_modules', '.bin', 'vite');
    const child = spawn(viteBin, [], {
      cwd: webDir,
      detached: true,
      stdio: 'ignore',
    });
    if (child.pid) {
      child.unref();
      return child.pid;
    }
    return null;
  } catch {
    return null;
  }
}

export async function stopWebUi(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    process.kill(pid, 'SIGKILL');
  } catch { /* already exited */ }
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
