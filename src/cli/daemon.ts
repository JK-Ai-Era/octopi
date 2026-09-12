/**
 * CLI 守护进程管理
 */

import { resolve, dirname, join } from 'node:path';
import { fork, execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import type { CliArgs } from './args.js';
import { getOctopiHome, isInitialized, initOctopi, formatInitReport } from '../init.js';
import { loadConfig, toGatewayConfig, createStoreFromConfig } from '../config.js';
import { createToolSet } from '../harness/plugin-ecosystem/tools/tool-set.js';
import type { ModelProviderConfig } from '../config.js';
import type { ModelProvider } from '../core/interfaces/model-provider.js';
import { OpenAIProvider } from '../integration/providers/openai.js';
import { AnthropicProvider } from '../integration/providers/anthropic.js';
import { Gateway } from '../integration/gateway/gateway.js';
import { webuiStartCommand, webuiStopCommand } from './webui.js';

interface DaemonPidFile {
  pid: number;
  config: string;
  port?: number;
  startedAt: string;
}

export function getPidPath(): string {
  return join(getOctopiHome(), 'gateway.pid');
}

export function readPidFile(): DaemonPidFile | null {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    return JSON.parse(readFileSync(pidPath, 'utf-8')) as DaemonPidFile;
  } catch {
    return null;
  }
}

export function writePidFile(data: DaemonPidFile): void {
  const pidPath = getPidPath();
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, JSON.stringify(data, null, 2));
}

export function removePidFile(): void {
  const pidPath = getPidPath();
  if (existsSync(pidPath)) {
    try { unlinkSync(pidPath); } catch { /* ignore */ }
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function findPidOnPort(port: number): number | null {
  try {
    const result = execSync(`lsof -nP -sTCP:LISTEN -iTCP:${port}`, { encoding: 'utf-8', timeout: 5000 }).trim();
    if (!result) return null;
    const lines = result.split('\n').slice(1);
    for (const line of lines) {
      const parts = line.split(/\s+/);
      const pid = parseInt(parts[1], 10);
      if (pid > 0 && pid !== process.pid) return pid;
    }
    return null;
  } catch {
    return null;
  }
}

export function killProcessOnPort(port: number): boolean {
  const pid = findPidOnPort(port);
  if (!pid || pid === process.pid) return false;

  try {
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) return true;
      execSync('sleep 0.2');
    }
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

export function createProvider(name: string, cfg: ModelProviderConfig): ModelProvider | null {
  const apiType = cfg.api === 'anthropic-messages' ? 'anthropic' : 'openai';
  const models = cfg.models.map((m) => ({
    name: m.name ?? m.id,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxTokens,
  }));

  if (apiType === 'anthropic') {
    return new AnthropicProvider({
      name,
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      models,
      timeoutMs: cfg.timeoutSeconds ? cfg.timeoutSeconds * 1000 : undefined,
    });
  }

  return new OpenAIProvider({
    name,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    models,
    timeoutMs: cfg.timeoutSeconds ? cfg.timeoutSeconds * 1000 : undefined,
  });
}

export async function ensureDaemonConfig(args: CliArgs): Promise<string | undefined> {
  if (args.config) return args.config;

  const home = getOctopiHome();
  if (isInitialized(home)) return resolve(home, 'octopi.json');

  if (isInitialized(process.cwd())) return undefined;

  console.log('🐙 First run detected. Initializing Octopi...\n');
  const result = await initOctopi();
  console.log(formatInitReport(result));
  console.log('');
  return result.configPath;
}

export async function serveStartCommand(args: CliArgs): Promise<void> {
  const existingPidFile = readPidFile();
  if (existingPidFile && isProcessAlive(existingPidFile.pid)) {
    console.log(`⚠️  Gateway is already running (PID: ${existingPidFile.pid})`);
    console.log(`\nUse 'octopi serve restart' to restart, or 'octopi serve stop' to stop.`);
    return;
  }

  removePidFile();

  const configPath = await ensureDaemonConfig(args);
  const cliPath = resolve(process.argv[1]);

  const childArgs = ['serve', 'fg'];
  if (configPath) childArgs.push('--config', configPath);
  if (args.port) childArgs.push('--port', String(args.port));
  if (args.verbose) childArgs.push('--verbose');

  const child = fork(cliPath, childArgs, {
    detached: true,
    stdio: 'ignore',
    execArgv: [],
    env: { ...process.env, OCTOPI_DAEMON: '1' },
  });

  child.unref();

  if (!child.pid) {
    console.error('❌ Failed to start Gateway daemon');
    process.exit(1);
  }

  const config = loadConfig(configPath);
  const httpChannel = config.channels?.find((c: any) => c.type === 'http');
  const port = args.port ?? httpChannel?.port ?? 3000;

  writePidFile({
    pid: child.pid,
    config: configPath ?? join(process.cwd(), 'octopi.json'),
    port,
    startedAt: new Date().toISOString(),
  });

  console.log(`✅ Gateway started (PID: ${child.pid})`);
  console.log(`   Config: ${configPath ?? './octopi.json'}`);
  console.log(`   Port:   ${port}`);

  // 启动 Web UI
  await webuiStartCommand(configPath);

  console.log(`\nUse 'octopi serve stop' to stop, 'octopi serve status' to check.`);
  process.exit(0);
}

export async function serveStopCommand(): Promise<void> {
  const pidFile = readPidFile();
  if (!pidFile) {
    console.log('ℹ️  No Gateway instance found.');
    return;
  }

  if (!isProcessAlive(pidFile.pid)) {
    console.log('ℹ️  Gateway process is not running. Cleaning up PID file.');
    removePidFile();
    return;
  }

  console.log(`🛑 Stopping Gateway (PID: ${pidFile.pid})...`);
  try {
    process.kill(pidFile.pid, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pidFile.pid)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (isProcessAlive(pidFile.pid)) {
      process.kill(pidFile.pid, 'SIGKILL');
    }
  } catch { /* already exited */ }

  removePidFile();
  console.log('✅ Gateway stopped.');

  // 停止 Web UI
  await webuiStopCommand();
}

export async function serveRestartCommand(args: CliArgs): Promise<void> {
  await serveStopCommand();
  await new Promise((r) => setTimeout(r, 500));
  await serveStartCommand(args);
}

export async function serveStatusCommand(): Promise<void> {
  const pidFile = readPidFile();
  if (!pidFile) {
    console.log('ℹ️  No Gateway instance found.');
    return;
  }

  const alive = isProcessAlive(pidFile.pid);
  console.log(`\n🐙 Gateway Status\n`);
  console.log(`  PID:       ${pidFile.pid}`);
  console.log(`  Status:    ${alive ? '🟢 Running' : '🔴 Stopped'}`);
  console.log(`  Config:    ${pidFile.config}`);
  console.log(`  Started:   ${pidFile.startedAt}`);
  if (pidFile.port) console.log(`  Port:      ${pidFile.port}`);
  console.log();

  if (!alive) {
    console.log('  ⚠️  Process is not running. PID file is stale.');
    console.log(`     Run 'octopi serve start' to start a new instance.\n`);
  }
}

export async function serveFgCommand(args: CliArgs): Promise<void> {
  const port = args.port ?? 3000;
  const portPid = findPidOnPort(port);
  if (portPid && portPid !== process.pid) {
    console.log(`⚠️  Port ${port} is occupied by PID ${portPid}. Killing...`);
    killProcessOnPort(port);
    await new Promise((r) => setTimeout(r, 500));
  }

  const configPath = await ensureDaemonConfig(args);
  await startGatewayBlocking(configPath, args);
}

export async function serveCommand(args: CliArgs): Promise<void> {
  switch (args.subcommand) {
    case 'start':
      return serveStartCommand(args);
    case 'stop':
      return serveStopCommand();
    case 'restart':
      return serveRestartCommand(args);
    case 'status':
      return serveStatusCommand();
    case 'fg':
      return serveFgCommand(args);
    case undefined:
      console.log('💡 Tip: Use "octopi serve start" for background mode.\n');
      return serveFgCommand(args);
    default:
      console.error(`Unknown serve subcommand: ${args.subcommand}`);
      console.error('Valid subcommands: start, stop, restart, status, fg');
      process.exit(1);
  }
}

async function startGatewayBlocking(configPath: string | undefined, args: CliArgs): Promise<void> {
  const config = loadConfig(configPath);
  const gatewayConfig = toGatewayConfig(config);

  if (args.port) gatewayConfig.port = args.port;

  if (args.verbose && !gatewayConfig.trace) {
    const os = await import('node:os');
    const path = await import('node:path');
    gatewayConfig.trace = {
      outputDir: path.join(os.homedir(), '.octopi', 'traces'),
      level: 'DEBUG',
    };
    console.log('[CLI] Verbose mode: tracing enabled');
  }

  const store = config.session?.store ? await createStoreFromConfig(config.session.store) : undefined;
  const gateway = new Gateway(gatewayConfig, store);

  for (const [providerName, providerCfg] of Object.entries(config.models?.providers ?? {})) {
    const provider = createProvider(providerName, providerCfg);
    if (provider) {
      gateway.registerProvider(provider);
      console.log(`[CLI] Registered provider: ${providerName} (${providerCfg.api})`);
    }
  }

  const memoryStore = new (await import('../harness/memory/store.js')).InMemoryMemoryStore();
  const taskTracker = new (await import('../harness/task-system/tasks/tracker.js')).TaskTracker();
  const { all } = createToolSet({ memoryStore, taskTracker });
  for (const tool of all) gateway.registerTool(tool);
  console.log(`[CLI] Registered ${all.length} tools: ${all.map(t => t.definition.name).join(', ')}`);

  const httpConfig = config.channels?.find((c: any) => c.type === 'http');
  if (httpConfig) {
    const { HttpChannelAdapter } = await import('../integration/protocols/http.js');
    const { WebApiRouter } = await import('../integration/web/api/router.js');
    const webApiRouter = new WebApiRouter({ gateway, basePath: '/api/v1' });
    gateway.registerChannel(new HttpChannelAdapter({
      port: httpConfig.port ?? args.port ?? 3000,
      path: httpConfig.path ?? '/messages',
      apiKey: httpConfig.apiKey,
      corsOrigins: httpConfig.corsOrigins,
      onRequest: (req, res) => webApiRouter.handle(req, res),
    }));
  }

  const shutdown = async () => {
    console.log('\n[CLI] Shutting down...');
    await gateway.stop();
    removePidFile();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  writePidFile({
    pid: process.pid,
    config: configPath ?? join(process.cwd(), 'octopi.json'),
    port: args.port,
    startedAt: new Date().toISOString(),
  });

  await gateway.start();
}
