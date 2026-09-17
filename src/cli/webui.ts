/**
 * CLI Web UI 命令
 */

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { CliArgs } from './args.js';
import { ensureDaemonConfig } from './daemon.js';
import { getOctopiHome } from '../init.js';
import {
  findWebDir,
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
}

/** Vite 开发服务器常见端口（用于认领未写入 pid 文件的实例） */
const VITE_DEV_PORTS = [5173, 5174, 4173] as const;

/** 轻量读取配置中的 web.dir，避免 loadConfig 重复打日志/强校验 */
function readConfigWebDir(configPath?: string): string | undefined {
  try {
    let filePath: string;
    if (configPath) {
      filePath = resolve(configPath);
    } else if (existsSync(resolve('./octopi.json'))) {
      filePath = resolve('./octopi.json');
    } else {
      filePath = resolve(getOctopiHome(), 'octopi.json');
    }
    if (!existsSync(filePath)) return undefined;
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as { web?: { dir?: unknown } };
    const dir = raw.web?.dir;
    return typeof dir === 'string' && dir.trim() ? dir.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** 在常见 dev 端口上探测疑似 Vite 进程 */
function findPidOnVitePorts(): { pid: number; port: number } | null {
  for (const port of VITE_DEV_PORTS) {
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
  const portHit = findPidOnVitePorts();
  if (portHit) {
    console.log(`⚠️  Web UI appears already running on port ${portHit.port} (PID: ${portHit.pid})`);
    console.log('   Not tracked in ~/.octopi/webui.pid (started outside CLI?)');
    if (soft) return;
    console.log(`\nUse 'octopi webui stop' to stop it, then start again.`);
    process.exit(1);
  }

  removeWebUiPidFile();

  const configWebDir = readConfigWebDir(configPath);
  const webDir = findWebDir(configPath, configWebDir);
  if (!webDir) {
    if (soft) {
      console.warn('⚠️  Web UI directory not found, skipping Web UI');
      console.warn('   Set "web.dir" in config, $OCTOPI_WEB_DIR, or run from a directory that contains web/package.json');
      return;
    }
    console.error('❌ Web UI directory not found. Searched:');
    console.error('   - $OCTOPI_WEB_DIR (if set)');
    console.error('   - Config "web.dir" (if set)');
    console.error('   - Config file directory + /web');
    console.error('   - ~/.octopi/web');
    console.error('   - CLI package root + /web');
    console.error('   - ./web/package.json (current directory)');
    process.exit(1);
  }

  const pid = startWebUi(webDir);
  if (!pid) {
    if (soft) {
      console.warn('⚠️  Failed to start Web UI (is web/ installed?). Gateway continues without it.');
      console.warn(`   Directory: ${webDir}`);
      console.warn(`   Run: npm --prefix "${webDir}" install`);
      return;
    }
    console.error('❌ Failed to start Web UI');
    console.error(`   Directory: ${webDir}`);
    console.error(`   Ensure dependencies are installed: npm --prefix "${webDir}" install`);
    process.exit(1);
  }

  writeWebUiPidFile(pid, { dir: webDir });
  console.log(`✅ Web UI started (PID: ${pid})`);
  console.log(`   Directory: ${webDir}`);
  console.log(`\nUse 'octopi webui stop' to stop, 'octopi webui status' to check.`);

  // spawn 后父进程必须退出：Windows 上残留事件柄/Job 会让 CLI 挂住，
  // 外层工具超时后 taskkill 整棵 shell（表现为执行“被杀掉”）。
  if (!soft) {
    process.exit(0);
  }
}

export async function webuiStopCommand(): Promise<void> {
  const record = readWebUiPidRecord();
  let pid = record?.pid;
  let source: 'pidfile' | 'port' | 'none' = pid ? 'pidfile' : 'none';

  if (!pid || !isProcessAlive(pid)) {
    if (pid) {
      console.log('ℹ️  Web UI process is not running. Cleaning up PID file.');
      removeWebUiPidFile();
      pid = undefined;
    }
    const portHit = findPidOnVitePorts();
    if (portHit) {
      pid = portHit.pid;
      source = 'port';
      console.log(`ℹ️  Adopting untracked Web UI on port ${portHit.port} (PID: ${portHit.pid})`);
    }
  }

  if (!pid) {
    console.log('ℹ️  No Web UI instance found.');
    console.log('   CLI tracks ~/.octopi/webui.pid; it also probes ports 5173/5174/4173.');
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

export async function webuiRestartCommand(configPath?: string): Promise<void> {
  await webuiStopCommand();
  await new Promise((r) => setTimeout(r, 500));
  await webuiStartCommand(configPath);
}

export async function webuiStatusCommand(): Promise<void> {
  const record = readWebUiPidRecord();
  const pid = record?.pid;
  const portHit = findPidOnVitePorts();

  if (!pid) {
    console.log('ℹ️  No Web UI instance found in ~/.octopi/webui.pid.');
    if (portHit && isProcessAlive(portHit.pid)) {
      console.log(`   But port ${portHit.port} is LISTENING (PID: ${portHit.pid}) — started outside CLI?`);
    }
    const configWebDir = readConfigWebDir();
    const webDir = findWebDir(undefined, configWebDir);
    if (webDir) console.log(`   Detected Web UI directory (not started via CLI): ${webDir}`);
    return;
  }

  const alive = isProcessAlive(pid);
  console.log(`\n🌐 Web UI Status\n`);
  console.log(`  PID:       ${pid}`);
  console.log(`  Status:    ${alive ? '🟢 Running' : '🔴 Stopped'}`);
  if (record.dir) console.log(`  Directory: ${record.dir}`);
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
      await webuiStartCommand(configPath);
      break;
    case 'stop':
      await webuiStopCommand();
      break;
    case 'restart':
      await webuiRestartCommand(configPath);
      break;
    case 'status':
      await webuiStatusCommand();
      break;
    case undefined:
      console.log('💡 Tip: Use "octopi webui start" to start Web UI.\n');
      await webuiStartCommand(configPath);
      break;
    default:
      console.error(`Unknown webui subcommand: ${args.subcommand}`);
      console.error('Valid subcommands: start, stop, restart, status');
      process.exit(1);
  }
  // 所有 webui 子命令收尾强制退出，避免 import/spawn 句柄拖住进程
  process.exit(0);
}
