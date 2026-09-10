/**
 * CLI Web UI 命令
 */

import type { CliArgs } from './args.js';
import { ensureDaemonConfig } from './daemon.js';
import {
  findWebDir,
  startWebUi,
  stopWebUi,
  readWebUiPidFile,
  writeWebUiPidFile,
  removeWebUiPidFile,
} from './helpers.js';
import { isProcessAlive } from './daemon.js';

export async function webuiStartCommand(configPath?: string): Promise<void> {
  const existingPid = readWebUiPidFile();
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(`⚠️  Web UI is already running (PID: ${existingPid})`);
    console.log(`\nUse 'octopi webui restart' to restart.`);
    return;
  }

  removeWebUiPidFile();

  const webDir = findWebDir(configPath);
  if (!webDir) {
    console.error('❌ Web UI directory not found. Searched:');
    console.error('   - $OCTOPI_WEB_DIR (if set)');
    console.error('   - Config file directory + /web');
    console.error('   - ./web/package.json (current directory)');
    process.exit(1);
  }

  const pid = startWebUi(webDir);
  if (!pid) {
    console.error('❌ Failed to start Web UI');
    process.exit(1);
  }

  writeWebUiPidFile(pid);
  console.log(`✅ Web UI started (PID: ${pid})`);
  console.log(`   Directory: ${webDir}`);
  console.log(`\nUse 'octopi webui stop' to stop, 'octopi webui status' to check.`);
}

export async function webuiStopCommand(): Promise<void> {
  const pid = readWebUiPidFile();
  if (!pid) {
    console.log('ℹ️  No Web UI instance found.');
    return;
  }

  if (!isProcessAlive(pid)) {
    console.log('ℹ️  Web UI process is not running. Cleaning up PID file.');
    removeWebUiPidFile();
    return;
  }

  console.log(`🛑 Stopping Web UI (PID: ${pid})...`);
  await stopWebUi(pid);
  removeWebUiPidFile();
  console.log('✅ Web UI stopped.');
}

export async function webuiRestartCommand(configPath?: string): Promise<void> {
  await webuiStopCommand();
  await new Promise((r) => setTimeout(r, 500));
  await webuiStartCommand(configPath);
}

export async function webuiStatusCommand(): Promise<void> {
  const pid = readWebUiPidFile();
  if (!pid) {
    console.log('ℹ️  No Web UI instance found.');
    return;
  }

  const alive = isProcessAlive(pid);
  console.log(`\n🌐 Web UI Status\n`);
  console.log(`  PID:       ${pid}`);
  console.log(`  Status:    ${alive ? '🟢 Running' : '🔴 Stopped'}`);
  console.log();

  if (!alive) {
    console.log('  ⚠️  Process is not running. PID file is stale.');
    console.log(`     Run 'octopi webui start' to start a new instance.\n`);
  }
}

export async function webuiCommand(args: CliArgs): Promise<void> {
  const configPath = await ensureDaemonConfig(args);
  switch (args.subcommand) {
    case 'start':
      return webuiStartCommand(configPath);
    case 'stop':
      return webuiStopCommand();
    case 'restart':
      return webuiRestartCommand(configPath);
    case 'status':
      return webuiStatusCommand();
    case undefined:
      console.log('💡 Tip: Use "octopi webui start" to start Web UI.\n');
      return webuiStartCommand(configPath);
    default:
      console.error(`Unknown webui subcommand: ${args.subcommand}`);
      console.error('Valid subcommands: start, stop, restart, status');
      process.exit(1);
  }
}
