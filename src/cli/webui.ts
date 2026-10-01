/**
 * CLI Web UI 命令
 */

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import type { CliArgs } from './args.js';
import {
  isLanHost,
  resolveListenHost,
  type NetworkHostConfig,
} from '@octopi-agent/engine/config.js';
import { ensureDaemonConfig } from './daemon.js';
import { getOctopiHome } from '@octopi-agent/engine/paths.js';
import {
  findWebDist,
  startWebUi,
  stopWebUi,
  readWebUiPidRecord,
  writeWebUiPidFile,
  removeWebUiPidFile,
} from './helpers.js';
import { findPidOnPort, isProcessAlive } from './process-utils.js';

export interface WebUiStartOptions {
  /** soft: 失败只警告，不 process.exit（供 serve start 使用） */
  soft?: boolean;
  /** CLI `--port` 覆盖（仅 webui 子命令传入；优先于配置 web.port） */
  port?: number;
}

/** Web UI 默认监听端口 */
const DEFAULT_WEBUI_PORT = 8180;

/** 旧版默认与常见 vite dev 端口（认领未写入 pid 文件的实例） */
const LEGACY_VITE_PORTS = [5173, 5174, 4173] as const;

/** 轻量读取配置中的 web 段（dir / host / port），避免 loadConfig 重复打日志/强校验 */
function readConfigWebSettings(configPath?: string): {
  dir?: string;
  host?: NetworkHostConfig;
  port?: number;
} {
  try {
    let filePath: string;
    if (configPath) {
      filePath = resolve(configPath);
    } else if (existsSync(resolve('./octopi.json'))) {
      filePath = resolve('./octopi.json');
    } else {
      filePath = resolve(getOctopiHome(), 'octopi.json');
    }
    if (!existsSync(filePath)) return {};
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      web?: { dir?: unknown; host?: unknown; port?: unknown };
    };
    const dir = typeof raw.web?.dir === 'string' && raw.web.dir.trim() ? raw.web.dir.trim() : undefined;
    const host = typeof raw.web?.host === 'string' && raw.web.host.trim()
      ? (raw.web.host.trim() as NetworkHostConfig)
      : undefined;
    const port = typeof raw.web?.port === 'number' ? raw.web.port : undefined;
    return { dir, host, port: isValidPort(port) ? port : undefined };
  } catch {
    return {};
  }
}

function isValidPort(port: number | undefined): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * 解析 Web UI 监听端口：CLI `--port` > 配置 `web.port` > 默认 8180
 *
 * @param configPath 配置文件路径（缺省按 cwd / OCTOPI_HOME 查找）
 * @param override CLI 传入的端口（非法值忽略，回落配置/默认）
 * @returns 监听端口
 */
export function resolveWebUiPort(configPath?: string, override?: number): number {
  if (isValidPort(override)) return override;
  return readConfigWebSettings(configPath).port ?? DEFAULT_WEBUI_PORT;
}

/** 读取配置中的 web.dir */
function readConfigWebDir(configPath?: string): string | undefined {
  return readConfigWebSettings(configPath).dir;
}

/** 探测本机局域网 IPv4（用于启动提示） */
function firstLanIPv4(): string | null {
  try {
    const ifaces = networkInterfaces();
    for (const entries of Object.values(ifaces)) {
      for (const entry of entries ?? []) {
        if (entry.family === 'IPv4' && !entry.internal) return entry.address;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** 探测疑似 Web UI 实例：先查期望端口（配置/默认），再查旧版与常见 vite 端口 */
export function findPidOnVitePorts(expectedPort?: number): { pid: number; port: number } | null {
  const ports = [expectedPort ?? DEFAULT_WEBUI_PORT, ...LEGACY_VITE_PORTS];
  const seen = new Set<number>();
  for (const port of ports) {
    if (seen.has(port)) continue;
    seen.add(port);
    const pid = findPidOnPort(port);
    if (pid && isProcessAlive(pid)) return { pid, port };
  }
  return null;
}

export async function webuiStartCommand(
  configPath?: string,
  options?: WebUiStartOptions,
): Promise<void> {
  const soft = options?.soft === true;
  const existing = readWebUiPidRecord();
  if (existing && isProcessAlive(existing.pid)) {
    console.log(`⚠️  Web UI is already running (PID: ${existing.pid})`);
    if (existing.dir) console.log(`   Directory: ${existing.dir}`);
    console.log(`\nUse 'octopi webui restart' to restart.`);
    return;
  }

  // pid 文件缺失/失效，但端口上已有实例：提示而非叠跑第二个 vite
  const port = resolveWebUiPort(configPath, options?.port);
  const portHit = findPidOnVitePorts(port);
  if (portHit) {
    console.log(`⚠️  Web UI appears already running on port ${portHit.port} (PID: ${portHit.pid})`);
    console.log('   Not tracked in ~/.octopi/webui.pid (started outside CLI?)');
    if (soft) return;
    console.log(`\nUse 'octopi webui stop' to stop it, then start again.`);
    process.exit(1);
  }

  removeWebUiPidFile();

  const webSettings = readConfigWebSettings(configPath);
  const configWebDir = webSettings.dir;
  const webHost = webSettings.host;
  const webDist = findWebDist(configPath, configWebDir);
  if (!webDist) {
    if (soft) {
      console.warn('⚠️  Web UI dist not found, skipping Web UI');
      console.warn('   Set "web.dir" in config, $OCTOPI_WEB_DIR, or install @octopi-agent/webui');
      return;
    }
    console.error('❌ Web UI dist not found. Searched:');
    console.error('   - $OCTOPI_WEB_DIR (if set)');
    console.error('   - Config "web.dir" (if set)');
    console.error('   - node_modules/@octopi-agent/webui/dist');
    console.error('   - packages/webui/dist (monorepo)');
    console.error('   - ~/.octopi/web/dist');
    process.exit(1);
  }

  // Static server must bind IPv4 127.0.0.1 for local (Windows `localhost` may be IPv6-only)
  const listenHost = resolveListenHost(webHost);
  const lanOpen = isLanHost(webHost);

  const pid = startWebUi(webDist, { hostArg: listenHost, port });
  if (!pid) {
    if (soft) {
      console.warn('⚠️  Failed to start Web UI static server. Gateway continues without it.');
      console.warn(`   Dist: ${webDist}`);
      return;
    }
    console.error('❌ Failed to start Web UI');
    console.error(`   Dist: ${webDist}`);
    process.exit(1);
  }

  writeWebUiPidFile(pid, { dir: webDist, host: webHost });
  console.log(`✅ Web UI started (PID: ${pid})`);
  console.log(`   Dist:   ${webDist}`);
  if (lanOpen) {
    const lanIp = firstLanIPv4();
    console.log(`   Access: LAN (host=${listenHost})`);
    if (lanIp) console.log(`   URL:    http://${lanIp}:${port}`);
    console.log('   Note:   Gateway 也需 channels[].host/web.host 为 "lan"，局域网客户端才能连上 API');
  } else {
    console.log(`   Access: local only (host=${listenHost})`);
    console.log(`   URL:    http://${listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost}:${port}`);
  }
  console.log(`\nUse 'octopi webui stop' to stop, 'octopi webui status' to check.`);

  // spawn 后父进程必须退出：Windows 上残留事件柄/Job 会让 CLI 挂住，
  // 外层工具超时后 taskkill 整棵 shell（表现为执行“被杀掉”）。
  if (!soft) {
    process.exit(0);
  }
}

export async function webuiStopCommand(configPath?: string): Promise<void> {
  const record = readWebUiPidRecord();
  let pid = record?.pid;
  let source: 'pidfile' | 'port' | 'none' = pid ? 'pidfile' : 'none';

  if (!pid || !isProcessAlive(pid)) {
    if (pid) {
      console.log('ℹ️  Web UI process is not running. Cleaning up PID file.');
      removeWebUiPidFile();
      pid = undefined;
    }
    const portHit = findPidOnVitePorts(resolveWebUiPort(configPath));
    if (portHit) {
      pid = portHit.pid;
      source = 'port';
      console.log(`ℹ️  Adopting untracked Web UI on port ${portHit.port} (PID: ${portHit.pid})`);
    }
  }

  if (!pid) {
    console.log('ℹ️  No Web UI instance found.');
    console.log('   CLI tracks ~/.octopi/webui.pid; it also probes the configured port (default 8180) and legacy 5173/5174/4173.');
    console.log('   Manually started vite outside those ports must be stopped in its own terminal.');
    return;
  }

  console.log(`🛑 Stopping Web UI (PID: ${pid})...`);
  if (record?.dir) console.log(`   Directory: ${record.dir}`);
  if (source === 'port') console.log('   Source:    dev port probe');
  await stopWebUi(pid);
  removeWebUiPidFile();
  if (!isProcessAlive(pid)) {
    console.log('✅ Web UI stopped.');
  } else {
    console.warn(`⚠️  Web UI PID ${pid} may still be running`);
  }
}

export async function webuiRestartCommand(configPath?: string, options?: WebUiStartOptions): Promise<void> {
  await webuiStopCommand(configPath);
  await new Promise((r) => setTimeout(r, 500));
  await webuiStartCommand(configPath, options);
}

export async function webuiStatusCommand(configPath?: string): Promise<void> {
  const record = readWebUiPidRecord();
  const pid = record?.pid;
  const portHit = findPidOnVitePorts(resolveWebUiPort(configPath));

  if (!pid) {
    console.log('ℹ️  No Web UI instance found in ~/.octopi/webui.pid.');
    if (portHit && isProcessAlive(portHit.pid)) {
      console.log(`   But port ${portHit.port} is LISTENING (PID: ${portHit.pid}) — started outside CLI?`);
    }
    const configWebDir = readConfigWebDir(configPath);
    const webDist = findWebDist(configPath, configWebDir);
    if (webDist) console.log(`   Detected Web UI dist (not started via CLI): ${webDist}`);
    return;
  }

  const alive = isProcessAlive(pid);
  console.log(`\n🌐 Web UI Status\n`);
  console.log(`  PID:       ${pid}`);
  console.log(`  Status:    ${alive ? '🟢 Running' : '🔴 Stopped'}`);
  if (record.dir) console.log(`  Directory: ${record.dir}`);
  if (record.host) {
    const lanOpen = record.host === 'lan' || (record.host !== 'local' && record.host !== 'localhost' && record.host !== '127.0.0.1');
    console.log(`  Host:      ${record.host} (${lanOpen ? 'LAN' : 'local only'})`);
  }
  if (record.startedAt) console.log(`  Started:   ${record.startedAt}`);
  if (portHit) console.log(`  Port:      ${portHit.port} (PID ${portHit.pid})`);
  console.log();

  if (!alive) {
    console.log('  ⚠️  Process is not running. PID file is stale.');
    if (portHit && portHit.pid !== pid && isProcessAlive(portHit.pid)) {
      console.log(`     Another process holds port ${portHit.port} (PID ${portHit.pid}).`);
    }
    console.log(`     Run 'octopi webui start' to start a new instance.\n`);
  }
}

export async function webuiCommand(args: CliArgs): Promise<void> {
  const configPath = await ensureDaemonConfig(args);
  switch (args.subcommand) {
    case 'start':
      await webuiStartCommand(configPath, { port: args.port });
      break;
    case 'stop':
      await webuiStopCommand(configPath);
      break;
    case 'restart':
      await webuiRestartCommand(configPath, { port: args.port });
      break;
    case 'status':
      await webuiStatusCommand(configPath);
      break;
    case undefined:
      console.log('💡 Tip: Use "octopi webui start" to start Web UI.\n');
      await webuiStartCommand(configPath, { port: args.port });
      break;
    default:
      console.error(`Unknown webui subcommand: ${args.subcommand}`);
      console.error('Valid subcommands: start, stop, restart, status');
      process.exit(1);
  }
  // 所有 webui 子命令收尾强制退出，避免 import/spawn 句柄拖住进程
  process.exit(0);
}
