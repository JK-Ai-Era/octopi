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
import { getBuiltinTools } from './harness/tools/builtin.js';
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
 * 在前台运行 Gateway（阻塞模式，用于调试）
 */
async function serveFgCommand(args: CliArgs): Promise<void> {
  const configPath = await ensureInitialized(args);
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

  // 确保已初始化，获取配置路径
  const configPath = await ensureInitialized(args);

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
  if (!pidFile) {
    console.log('ℹ️  No Gateway instance found (no PID file).');
    return;
  }

  if (!isProcessAlive(pidFile.pid)) {
    console.log(`ℹ️  Gateway process (PID: ${pidFile.pid}) is not running.`);
    console.log('   Cleaning up stale PID file.');
    removePidFile();
    return;
  }

  console.log(`🛑 Stopping Gateway (PID: ${pidFile.pid})...`);

  try {
    process.kill(pidFile.pid, 'SIGTERM');

    // 等待进程退出（最多 10 秒）
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pidFile.pid)) {
        console.log('✅ Gateway stopped.');
        removePidFile();
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    // 超时，强制 kill
    console.log('⚠️  Graceful shutdown timed out. Sending SIGKILL...');
    process.kill(pidFile.pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
    console.log('✅ Gateway force-killed.');
    removePidFile();
  } catch (error: any) {
    if (error.code === 'ESRCH') {
      console.log('ℹ️  Gateway process already exited.');
    } else {
      console.error(`❌ Failed to stop Gateway: ${error.message}`);
    }
    removePidFile();
  }
}

/**
 * 重启 Gateway 守护进程
 */
async function serveRestartCommand(args: CliArgs): Promise<void> {
  await serveStopCommand();
  // 短暂等待端口释放
  await new Promise((r) => setTimeout(r, 500));
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
    gateway.registerChannel(new HttpChannelAdapter({
      port: httpConfig.port ?? args.port ?? 3000,
      path: httpConfig.path ?? '/messages',
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

  // 如果是守护进程模式，也写 PID 文件（方便 serve stop 发现）
  if (process.env.OCTOPI_DAEMON === '1') {
    writePidFile({
      pid: process.pid,
      config: configPath ?? join(process.cwd(), 'octopi.json'),
      port: args.port,
      startedAt: new Date().toISOString(),
    });
  }

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
  // 检测 Gateway 是否在运行
  // 如果在运行，使用 Gateway 的配置文件（保持一致）
  const pidFile = readPidFile();
  const gatewayRunning = pidFile && isProcessAlive(pidFile.pid);

  let configPath: string | undefined;
  if (gatewayRunning && !args.config) {
    // Gateway 在运行 → 用 Gateway 的配置
    configPath = pidFile!.config;
    console.log(`[TUI] Gateway detected (PID: ${pidFile!.pid}), using its config: ${configPath}`);
  } else {
    configPath = await ensureInitialized(args);
  }

  const config = loadConfig(configPath);
  const agent = config.agents[0];
  if (!agent) {
    console.error('[Error] No agents defined in config');
    process.exit(1);
  }

  // 从实际使用的配置文件路径推导 configDir
  const configDir = configPath ? resolve(dirname(configPath)) : process.cwd();
  if (agent.workspace && !agent.workspace.startsWith('/')) {
    agent.workspace = resolve(configDir, agent.workspace);
  }
  if (!agent.workspace) {
    agent.workspace = configDir;
  }

  const providerCfg = config.providers?.find((p) => p.name === agent.model.provider);
  if (!providerCfg) {
    console.error(`[Error] Provider "${agent.model.provider}" not found`);
    process.exit(1);
  }

  const provider = createProvider(providerCfg);
  if (!provider) {
    console.error(`[Error] Provider "${providerCfg.name}" requires apiKey`);
    process.exit(1);
  }

  const { JsonlSessionStore } = await import('./integration/storage/jsonl.js');
  const { TuiApp } = await import('./integration/tui/app.js');

  // 使用配置中的 dataDir，否则默认 .octopi/sessions
  const storeDir = config.store?.dataDir
    ? (config.store.dataDir.startsWith('/') ? config.store.dataDir : resolve(configDir, config.store.dataDir))
    : resolve(configDir, '.octopi/sessions');

  // 构建 systemPrompt
  let systemPrompt: string | undefined;
  if (typeof agent.persona === 'object' && agent.persona?.systemPrompt) {
    systemPrompt = agent.persona.systemPrompt;
  }

  // persona 路径
  let personaPath: string | undefined;
  if (typeof agent.persona === 'string') {
    personaPath = agent.persona.startsWith('/') ? agent.persona : resolve(configDir, agent.persona);
  }

  // TaskSupervisor 配置
  let supervisorCfg: any = undefined;
  if (config.supervisor?.enabled !== false) {
    supervisorCfg = { ...config.supervisor };
    if (supervisorCfg.llmModel?.includes('/')) {
      supervisorCfg.llmModel = supervisorCfg.llmModel.split('/')[1];
    }
  }

  const app = new TuiApp({
    agentId: agent.id,
    model: agent.model.model,
    provider,
    store: new JsonlSessionStore(storeDir),
    systemPrompt,
    personaPath,
    tools: [],
    budget: config.budget,
    supervisor: supervisorCfg,
    workspace: agent.workspace,
    gatewayUrl: resolveGatewayUrl(config),
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
    default:
      console.error(`Unknown command: ${args.command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[Fatal] ${error.message}`);
  process.exit(1);
});
