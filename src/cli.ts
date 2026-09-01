#!/usr/bin/env node

/**
 * Octopi — 多协议 LLM Agent 框架
 *
 * 框架的命令行入口。支持以下命令：
 *
 * - serve: 启动 Gateway 服务
 * - chat: 交互式聊天
 * - health: 健康检查
 *
 * 使用方式：
 * ```bash
 * npx octopi serve --config ./octopi.json
 * npx octopi chat --config ./octopi.json
 * npx octopi health --config ./octopi.json
 * ```
 */

import { loadConfig, toGatewayConfig } from './config.js';
import { resolve, dirname, join } from 'node:path';
import { Gateway } from './integration/gateway/gateway.js';
import { OpenAIProvider } from './integration/providers/openai.js';
import { AnthropicProvider } from './integration/providers/anthropic.js';
import { getBuiltinTools } from './harness/plugin-ecosystem/tools/builtin.js';
import { fork, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import type { ModelProvider } from './core/interfaces/model-provider.js';
import type { ProviderConfig } from './config.js';
import { initOctopi, getOctopiHome, isInitialized, formatInitReport, ensureAgentDirs } from './init.js';

// ================================================================
// 守护进程管理
// ================================================================

interface DaemonPidFile {
  pid: number;
  config: string;
  port?: number;
  startedAt: string;
}

function getPidPath(): string {
  return join(getOctopiHome(), 'gateway.pid');
}

function readPidFile(): DaemonPidFile | null {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    return JSON.parse(readFileSync(pidPath, 'utf-8')) as DaemonPidFile;
  } catch {
    return null;
  }
}

function writePidFile(data: DaemonPidFile): void {
  const pidPath = getPidPath();
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, JSON.stringify(data, null, 2));
}

function removePidFile(): void {
  const pidPath = getPidPath();
  if (existsSync(pidPath)) {
    try { unlinkSync(pidPath); } catch { /* ignore */ }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 查找占用指定端口的进程 PID
 * 返回 null 表示端口未被占用
 */
function findPidOnPort(port: number): number | null {
  try {
    const result = execSync(`lsof -ti :${port}`, { encoding: 'utf-8', timeout: 5000 }).trim();
    if (!result) return null;
    // lsof 可能返回多个 PID（多行），取第一个 node 进程
    const pids = result.split('\n').map(Number).filter(n => n > 0);
    return pids[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * 杀掉占用指定端口的进程（排除自身）
 */
function killProcessOnPort(port: number): boolean {
  const pid = findPidOnPort(port);
  if (!pid || pid === process.pid) return false;

  try {
    process.kill(pid, 'SIGTERM');
    // 等待进程退出
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) return true;
      execSync('sleep 0.2');
    }
    // 强制 kill
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

// ================================================================
// Provider 工厂
// ================================================================

function createProvider(cfg: ProviderConfig): ModelProvider | null {
  if (!cfg.apiKey) return null;

  if (cfg.type === 'anthropic') {
    return new AnthropicProvider({
      name: cfg.name,
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      models: cfg.models,
      defaultModel: cfg.defaultModel,
    });
  }

  return new OpenAIProvider({
    name: cfg.name,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    models: cfg.models,
    defaultModel: cfg.defaultModel,
    timeoutMs: cfg.timeoutMs,
  });
}

// ================================================================
// 参数解析
// ================================================================

interface CliArgs {
  command: string;
  subcommand?: string;
  config?: string;
  port?: number;
  help?: boolean;
  verbose?: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  // 先提取 flags
  let help = false;
  let verbose = false;
  let config: string | undefined;
  let port: number | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--config':
      case '-c':
        config = args[++i];
        break;
      case '--port':
      case '-p':
        port = parseInt(args[++i], 10);
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      case '--verbose':
      case '-v':
        verbose = true;
        break;
      default:
        positional.push(args[i]);
        break;
    }
  }

  return {
    command: positional[0] ?? 'help',
    subcommand: positional[1],
    config,
    port,
    verbose,
    help,
  };
}

// ================================================================
// 命令实现
// ================================================================

function showHelp(): void {
  console.log(`
Octopi — AI Agent Framework

Usage:
  octopi <command> [options]

Commands:
  init              Initialize Octopi directory structure and config
  serve start       Start the Gateway server (background daemon)
  serve stop        Stop the Gateway server
  serve restart     Restart the Gateway server
  serve status      Show Gateway server status
  serve fg          Start the Gateway server in foreground (for debugging)
  chat  (or tui)        Interactive TUI chat with an agent
  health            Check the health of configured providers
  plugin init       Scaffold a new plugin project
  help              Show this help message

Options:
  --config, -c <path>   Config file path (default: ./octopi.json)
  --port, -p <port>     Port override
  --verbose, -v         Enable verbose mode (trace all engine events to file)
  --help, -h            Show this help message

Examples:
  octopi init
  octopi serve start -c ./my-config.json
  octopi serve stop
  octopi serve restart
  octopi serve status
  octopi serve fg -c ./my-config.json   # foreground mode
  octopi chat -c ./my-config.json
  octopi health -c ./my-config.json
`);
}

async function initCommand(args: CliArgs): Promise<void> {
  const homeDir = args.config ? resolve(dirname(args.config)) : undefined;
  const result = await initOctopi(homeDir);
  console.log(formatInitReport(result));
}

/**
 * 确保系统已初始化（serve/chat 启动时自动检测）
 *
 * 如果未初始化且没有指定配置文件，自动执行初始化。
 * 返回最终使用的配置路径。
 */
async function ensureInitialized(args: CliArgs): Promise<string | undefined> {
  // 如果明确指定了配置文件，跳过自动初始化
  if (args.config) return args.config;

  // 检查当前目录是否有配置
  if (isInitialized(process.cwd())) return undefined; // 使用默认 ./octopi.json

  // 检查 OCTOPI_HOME
  const home = getOctopiHome();
  if (isInitialized(home)) {
    // 返回 home 下的配置路径，让 loadConfig 使用
    return resolve(home, 'octopi.json');
  }

  // 未初始化 → 自动初始化
  console.log('🐙 First run detected. Initializing Octopi...\n');
  const result = await initOctopi();
  console.log(formatInitReport(result));
  console.log('');

  return result.configPath;
}

/**
 * 为守护进程解析配置路径
 *
 * 守护进程（serve）始终优先使用 OCTOPI_HOME 下的配置，
 * 因为它是系统级服务，不应依赖运行目录。
 */
async function ensureDaemonConfig(args: CliArgs): Promise<string | undefined> {
  if (args.config) return args.config;

  const home = getOctopiHome();
  if (isInitialized(home)) return resolve(home, 'octopi.json');

  // 回退到当前目录
  if (isInitialized(process.cwd())) return undefined;

  // 都没有 → 自动初始化到 OCTOPI_HOME
  console.log('🐙 First run detected. Initializing Octopi...\n');
  const result = await initOctopi();
  console.log(formatInitReport(result));
  console.log('');
  return result.configPath;
}

/**
 * 在前台运行 Gateway（阻塞模式，用于调试）
 */
async function serveFgCommand(args: CliArgs): Promise<void> {
  const configPath = await ensureDaemonConfig(args);
  await startGatewayBlocking(configPath, args);
}

/**
 * 启动 Gateway 守护进程（后台模式）
 */
async function serveStartCommand(args: CliArgs): Promise<void> {
  // 检查是否已有运行中的实例
  const existing = readPidFile();
  if (existing && isProcessAlive(existing.pid)) {
    console.log(`⚠️  Gateway is already running (PID: ${existing.pid})`);
    console.log(`   Started at: ${existing.startedAt}`);
    console.log(`   Config: ${existing.config}`);
    console.log(`\nUse 'octopi serve restart' to restart.`);
    return;
  }

  // 清理残留 PID 文件
  removePidFile();

  // 检查端口是否被占用
  const port = args.port ?? 3000;
  const portPid = findPidOnPort(port);
  if (portPid && portPid !== process.pid) {
    console.log(`⚠️  Port ${port} is occupied by PID ${portPid}. Killing...`);
    killProcessOnPort(port);
    await new Promise((r) => setTimeout(r, 500));
  }

  // 确保已初始化，获取配置路径
  const configPath = await ensureDaemonConfig(args);

  // 构建子进程参数
  const childArgs = ['serve', 'fg'];
  if (configPath) childArgs.push('--config', configPath);
  if (args.port) childArgs.push('--port', String(args.port));

  // fork 子进程
  // execArgv: [] 防止子进程继承父进程的 --inspect 等参数
  // detached + stdio: ignore 让父进程可以独立退出
  const child = fork(process.argv[1], childArgs, {
    detached: true,
    stdio: 'ignore',
    execArgv: [],
    env: { ...process.env, OCTOPI_DAEMON: '1' },
  });

  if (!child.pid) {
    console.error('❌ Failed to fork daemon process');
    process.exit(1);
  }

  // 写 PID 文件
  writePidFile({
    pid: child.pid,
    config: configPath ?? join(process.cwd(), 'octopi.json'),
    port: args.port,
    startedAt: new Date().toISOString(),
  });

  // 断开父子进程连接，父进程可以安全退出
  child.unref();
  child.disconnect?.();

  console.log(`✅ Gateway started in background (PID: ${child.pid})`);
  console.log(`   Config: ${configPath ?? './octopi.json'}`);
  console.log(`\nUse 'octopi serve stop' to stop, 'octopi serve status' to check.`);

  // 强制父进程退出，防止 fork IPC 或其他异步句柄阻塞
  process.exit(0);
}

/**
 * 停止 Gateway 守护进程
 */
async function serveStopCommand(): Promise<void> {
  const pidFile = readPidFile();
  let stopped = false;

  // 1. 尝试通过 PID 文件停止
  if (pidFile) {
    if (isProcessAlive(pidFile.pid)) {
      console.log(`🛑 Stopping Gateway (PID: ${pidFile.pid})...`);
      try {
        process.kill(pidFile.pid, 'SIGTERM');
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          if (!isProcessAlive(pidFile.pid)) {
            stopped = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        if (!stopped) {
          console.log('⚠️  Graceful shutdown timed out. Sending SIGKILL...');
          process.kill(pidFile.pid, 'SIGKILL');
          await new Promise((r) => setTimeout(r, 500));
          stopped = true;
        }
      } catch (error: any) {
        if (error.code === 'ESRCH') {
          stopped = true;
        } else {
          console.error(`❌ Failed to stop PID ${pidFile.pid}: ${error.message}`);
        }
      }
    }
    removePidFile();
  }

  // 2. 检查端口是否仍被占用（可能是旧进程或 PID 文件丢失的情况）
  const port = pidFile?.port ?? 3000;
  const portPid = findPidOnPort(port);
  if (portPid && portPid !== process.pid) {
    if (!stopped) console.log(`ℹ️  Found stale process on port ${port} (PID: ${portPid})`);
    else console.log(`⚠️  Port ${port} still occupied by PID ${portPid}`);
    console.log(`🛑 Killing process ${portPid}...`);
    try {
      process.kill(portPid, 'SIGTERM');
      await new Promise((r) => setTimeout(r, 1000));
      if (isProcessAlive(portPid)) {
        process.kill(portPid, 'SIGKILL');
        await new Promise((r) => setTimeout(r, 500));
      }
      stopped = true;
      console.log(`✅ Process ${portPid} killed.`);
    } catch (error: any) {
      if (error.code === 'ESRCH') {
        console.log(`✅ Process ${portPid} already exited.`);
      } else {
        console.error(`❌ Failed to kill PID ${portPid}: ${error.message}`);
      }
    }
  }

  if (stopped) {
    console.log('✅ Gateway stopped.');
  } else if (!pidFile && !portPid) {
    console.log('ℹ️  No Gateway instance found.');
  }
}

/**
 * 重启 Gateway 守护进程
 */
async function serveRestartCommand(args: CliArgs): Promise<void> {
  await serveStopCommand();
  // 等待端口完全释放
  const port = args.port ?? 3000;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!findPidOnPort(port)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await serveStartCommand(args);
}

/**
 * 查看 Gateway 状态
 */
async function serveStatusCommand(): Promise<void> {
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

/**
 * serve 命令路由
 */
async function serveCommand(args: CliArgs): Promise<void> {
  switch (args.subcommand) {
    case 'start':    return serveStartCommand(args);
    case 'stop':     return serveStopCommand();
    case 'restart':  return serveRestartCommand(args);
    case 'status':   return serveStatusCommand();
    case 'fg':       return serveFgCommand(args);
    case undefined:  // `octopi serve` 无子命令 → 兼容旧用法，前台运行
      console.log('💡 Tip: Use "octopi serve start" for background mode.\n');
      return serveFgCommand(args);
    default:
      console.error(`Unknown serve subcommand: ${args.subcommand}`);
      console.error('Valid subcommands: start, stop, restart, status, fg');
      process.exit(1);
  }
}

/**
 * 在前台阻塞运行 Gateway（核心逻辑，serve fg 和旧 serve 共用）
 */
async function startGatewayBlocking(configPath: string | undefined, args: CliArgs): Promise<void> {
  const config = loadConfig(configPath);
  const gatewayConfig = toGatewayConfig(config);

  if (args.port) gatewayConfig.port = args.port;

  // --verbose 或配置文件中的 observability 启用 tracing
  if (args.verbose && !gatewayConfig.trace) {
    const os = await import('node:os');
    const path = await import('node:path');
    gatewayConfig.trace = {
      outputDir: path.join(os.homedir(), '.octopi', 'traces'),
      level: 'DEBUG',
    };
    console.log('[CLI] Verbose mode: tracing enabled');
  }

  const gateway = new Gateway(gatewayConfig);

  for (const providerCfg of config.providers ?? []) {
    const provider = createProvider(providerCfg);
    if (provider) {
      gateway.registerProvider(provider);
      console.log(`[CLI] Registered provider: ${providerCfg.name} (${providerCfg.type})`);
    }
  }

  for (const tool of getBuiltinTools()) gateway.registerTool(tool);

  const httpConfig = config.channels?.find((c) => c.type === 'http');
  if (httpConfig) {
    const { HttpChannelAdapter } = await import('./integration/protocols/http.js');
    const { WebApiRouter } = await import('./integration/web/api/router.js');
    const webApiRouter = new WebApiRouter({ gateway, basePath: '/api/v1' });
    gateway.registerChannel(new HttpChannelAdapter({
      port: httpConfig.port ?? args.port ?? 3000,
      path: httpConfig.path ?? '/messages',
      apiKey: httpConfig.apiKey,
      corsOrigins: httpConfig.corsOrigins,
      onRequest: (req, res) => webApiRouter.handle(req, res),
    }));
  }

  // 优雅关闭
  const shutdown = async () => {
    console.log('\n[CLI] Shutting down...');
    await gateway.stop();
    removePidFile();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 写 PID 文件（方便 serve stop/restart 发现）
  writePidFile({
    pid: process.pid,
    config: configPath ?? join(process.cwd(), 'octopi.json'),
    port: args.port,
    startedAt: new Date().toISOString(),
  });

  await gateway.start();
}

/**
 * 解析 Gateway URL
 *
 * 优先级：
 * 1. 守护进程 PID 文件中的端口
 * 2. 配置文件中的 channels[0].port
 * 3. 默认 http://localhost:3000
 */
function resolveGatewayUrl(config: any): string {
  // 1. PID 文件
  const pidFile = readPidFile();
  if (pidFile && isProcessAlive(pidFile.pid) && pidFile.port) {
    return `http://localhost:${pidFile.port}`;
  }
  // 2. 配置文件
  const httpChannel = config.channels?.find((c: any) => c.type === 'http');
  if (httpChannel?.port) {
    return `http://localhost:${httpChannel.port}`;
  }
  // 3. 默认
  return 'http://localhost:3000';
}

async function chatCommand(args: CliArgs): Promise<void> {
  // 1. 确保配置已初始化
  const configPath = await ensureInitialized(args);
  const config = loadConfig(configPath);
  const agent = config.agents[0];
  if (!agent) {
    console.error('[Error] No agents defined in config');
    process.exit(1);
  }

  // 2. 确保 Gateway 在运行（没运行则自动启动）
  let pidFile = readPidFile();
  let gatewayRunning = pidFile && isProcessAlive(pidFile.pid);

  if (!gatewayRunning) {
    console.log('[TUI] Gateway not running, starting...');
    // 清理残留 PID 文件
    removePidFile();
    // 启动 Gateway（与 serveStartCommand 相同逻辑）
    const childArgs = ['serve', 'fg'];
    if (configPath) childArgs.push('--config', configPath);
    const child = fork(process.argv[1], childArgs, {
      detached: true,
      stdio: 'ignore',
      execArgv: [],
      env: { ...process.env, OCTOPI_DAEMON: '1' },
    });
    child.unref();
    if (!child.pid) {
      console.error('❌ Failed to start Gateway');
      process.exit(1);
    }
    // 写 PID 文件
    const httpChannel = config.channels?.find((c: any) => c.type === 'http');
    const port = httpChannel?.port ?? 3000;
    writePidFile({
      pid: child.pid,
      config: configPath ?? join(process.cwd(), 'octopi.json'),
      port,
      startedAt: new Date().toISOString(),
    });
    // 等待 Gateway 启动
    console.log('[TUI] Waiting for Gateway to start...');
    const gatewayUrl = `http://localhost:${port}`;
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const res = await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) { ready = true; break; }
      } catch { /* not ready yet */ }
    }
    if (!ready) {
      console.error('❌ Gateway failed to start within 15 seconds');
      process.exit(1);
    }
    console.log(`[TUI] Gateway started (PID: ${child.pid})`);
    pidFile = readPidFile();
  } else {
    console.log(`[TUI] Gateway detected (PID: ${pidFile!.pid})`);
  }

  // 3. 解析 Gateway URL
  const gatewayUrl = resolveGatewayUrl(config);

  // 4. 启动 TUI
  const { TuiApp } = await import('./integration/tui/app.js');
  const app = new TuiApp({
    agentId: agent.id,
    gatewayUrl,
  });
  await app.start();
}

async function healthCommand(args: CliArgs): Promise<void> {
  const configPath = await ensureInitialized(args);
  const config = loadConfig(configPath);

  console.log('\n🏥 Health Check\n');
  for (const providerCfg of config.providers ?? []) {
    const provider = createProvider(providerCfg);
    if (provider) {
      try {
        // 通过 isAvailable 检查
        const available = await provider.isAvailable();
        console.log(`  ${providerCfg.name}: ${available ? '✅ OK' : '❌ FAIL'}`);
      } catch {
        console.log(`  ${providerCfg.name}: ❌ FAIL`);
      }
    }
  }
  console.log();
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    if (args.command && args.command !== 'help') {
      // `octopi serve -h` → 显示 help
    }
    showHelp();
    return;
  }

  if (args.command === 'help') {
    showHelp();
    return;
  }

  switch (args.command) {
    case 'init': await initCommand(args); break;
    case 'serve': await serveCommand(args); break;
    case 'stop':  await serveStopCommand(); break;  // 快捷方式
    case 'chat':
    case 'tui': await chatCommand(args); break;
    case 'health': await healthCommand(args); break;
    case 'plugin': await pluginCommand(args); break;
    default:
      console.error(`Unknown command: ${args.command}`);
      showHelp();
      process.exit(1);
  }
}

/**
 * Plugin 脚手架命令
 *
 * octopi plugin init <name> [--dir <path>]
 */
async function pluginCommand(args: CliArgs): Promise<void> {
  const subcommand = args.subcommand;

  if (subcommand === 'init') {
    // 从 process.argv 提取插件名和 --dir 参数
    const rawArgs = process.argv.slice(2);
    const positional = rawArgs.filter(a => !a.startsWith('-'));
    const pluginName = positional[2]; // positional[0] = 'plugin', positional[1] = 'init', positional[2] = <name>
    const dirIdx = rawArgs.indexOf('--dir');
    const dirFlag = dirIdx >= 0 ? rawArgs[dirIdx + 1] : undefined;

    if (!pluginName) {
      console.error('Usage: octopi plugin init <plugin-name> [--dir <path>]');
      process.exit(1);
    }

    const targetDir = dirFlag ?? `./plugins/${pluginName}`;
    const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');

    if (existsSync(targetDir)) {
      console.error(`Directory already exists: ${targetDir}`);
      process.exit(1);
    }

    mkdirSync(targetDir, { recursive: true });

    // 生成 manifest
    const manifest = {
      id: pluginName,
      name: `${pluginName} plugin`,
      version: '0.1.0',
      description: `A plugin for Octopi`,
      main: 'index.js',
      enabledByDefault: true,
    };
    writeFileSync(join(targetDir, 'octopi.plugin.json'), JSON.stringify(manifest, null, 2) + '\n');

    // 生成入口文件
    const entryCode = `/**
 * ${pluginName} plugin
 */

import { definePluginEntry } from 'octopi/plugin-sdk/plugin-entry';

export default definePluginEntry({
  id: '${pluginName}',
  name: '${pluginName}',
  description: 'A plugin for Octopi',

  register(api) {
    // 注册 tools
    // api.registerTool({ ... }, async (args, ctx) => { ... });

    // 注册 providers
    // api.registerProvider({ name: '${pluginName}', ... });

    // 注册 commands
    // api.registerCommand('${pluginName}', async (args) => { ... });

    console.log('[${pluginName}] Registered');
  },
});
`;
    writeFileSync(join(targetDir, 'index.ts'), entryCode);

    // 生成 package.json
    const pkg = {
      name: `@octopi/plugin-${pluginName}`,
      version: '0.1.0',
      type: 'module',
      main: 'index.js',
      types: 'index.d.ts',
      peerDependencies: {
        octopi: '>=0.4.0',
      },
    };
    writeFileSync(join(targetDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

    // 生成 tsconfig.json
    const tsconfig = {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        declaration: true,
        outDir: '.',
        rootDir: '.',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
      include: ['*.ts'],
    };
    writeFileSync(join(targetDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n');

    console.log(`\n🐙 Plugin "${pluginName}" created at ${targetDir}\n`);
    console.log('Files:');
    console.log(`  ${targetDir}/octopi.plugin.json  ← Plugin manifest`);
    console.log(`  ${targetDir}/index.ts             ← Entry point`);
    console.log(`  ${targetDir}/package.json         ← Package config`);
    console.log(`  ${targetDir}/tsconfig.json         ← TypeScript config`);
    console.log('\nNext steps:');
    console.log(`  cd ${targetDir}`);
    console.log('  # Edit index.ts to add your plugin logic');
    console.log('  # Add plugins.loadPaths to your octopi.json config');
    return;
  }

  console.error('Usage: octopi plugin init <plugin-name> [--dir <path>]');
  process.exit(1);
}

main().catch((error) => {
  console.error(`[Fatal] ${error.message}`);
  process.exit(1);
});
