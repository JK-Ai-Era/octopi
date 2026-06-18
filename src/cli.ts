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
import { createInterface } from 'node:readline';
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
  chat              Interactive chat with an agent
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
  const child = fork(process.argv[1], childArgs, {
    detached: true,
    stdio: 'ignore',
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

  // 父进程不等待子进程
  child.unref();

  console.log(`✅ Gateway started in background (PID: ${child.pid})`);
  console.log(`   Config: ${configPath ?? './octopi.json'}`);
  console.log(`\nUse 'octopi serve stop' to stop, 'octopi serve status' to check.`);
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

async function chatCommand(args: CliArgs): Promise<void> {
  const configPath = await ensureInitialized(args);
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

  // 使用新架构
  const { AgentBuilder } = await import('./harness/builder.js');
  const { JsonlSessionStore } = await import('./integration/storage/jsonl.js');

  // 使用配置中的 dataDir，否则默认 .octopi/sessions
  const storeDir = config.store?.dataDir
    ? (config.store.dataDir.startsWith('/') ? config.store.dataDir : resolve(configDir, config.store.dataDir))
    : resolve(configDir, '.octopi/sessions');
  const builder = new AgentBuilder()
    .model(provider)
    .store(new JsonlSessionStore(storeDir));

  // 传递 systemPrompt 到 builder
  if (typeof agent.persona === 'object' && agent.persona?.systemPrompt) {
    builder.systemPrompt(agent.persona.systemPrompt);
  } else if (typeof agent.persona === 'string') {
    // persona 路径
    const personaPath = agent.persona.startsWith('/') ? agent.persona : resolve(configDir, agent.persona);
    builder.persona(personaPath);
  }

  for (const tool of getBuiltinTools()) {
    builder.tool(tool);
  }

  // 配置预算（如果用户指定了）
  if (config.budget) {
    builder.budget(config.budget);
  }

  // 配置 TaskSupervisor
  if (config.supervisor?.enabled !== false) {
    const supervisorCfg = { ...config.supervisor };
    // llmModel 格式: "provider/model" → 提取 model 部分
    if (supervisorCfg.llmModel?.includes('/')) {
      supervisorCfg.llmModel = supervisorCfg.llmModel.split('/')[1];
    }
    builder.taskSupervisor(supervisorCfg);
  }

  const { engine, runner } = await builder.build();

  // --verbose: 接入 TraceCollector + MetricsAggregator
  let traceCollector: import('./integration/observability/trace-collector.js').TraceCollector | undefined;
  if (args.verbose) {
    const { TraceCollector } = await import('./integration/observability/trace-collector.js');
    const { getOctopiHome } = await import('./init.js');
    const traceDir = resolve(getOctopiHome(), 'traces');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(traceDir, { recursive: true });
    traceCollector = new TraceCollector({
      outputDir: traceDir,
      captureStreamDeltas: true,
      captureToolArgs: true,
      captureToolResults: true,
      enableMetrics: true,
    });
    console.log(`   🔍 Verbose mode: trace → ${traceDir}`);
  }

  // 每次 CLI 启动生成唯一 session，避免跨重启的上下文错乱
  const cliSessionId = `${agent.id}:cli:${Date.now()}`;

  // 进度显示状态
  let hasShownThinking = false;
  let streamedContent = '';

  console.log(`\n🐙 Octopi Chat`);
  const agentName = typeof agent.persona === 'string'
    ? agent.persona
    : agent.persona?.name ?? agent.id;
  console.log(`   Agent: ${agentName}`);
  console.log(`   Model: ${providerCfg.type} / ${agent.model.model}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // 可变状态
  const sessionIdRef = { current: cliSessionId };
  const currentModelRef = { current: agent.model.model };

  // 命令系统
  const { CommandPlugin } = await import('./harness/commands/index.js');
  const commands = new CommandPlugin({
    sessionIdRef,
    currentModelRef,
    onNewSession: () => `${agent.id}:cli:${Date.now()}`,
  });

  console.log(`   Commands: ${Array.from(commands.getCommands().keys()).join(', ')}, exit`);

  const ask = () => {
    rl.question('You: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed) { ask(); return; }

      // exit 命令
      if (trimmed === 'exit' || trimmed === 'quit') {
        console.log('Goodbye! 👋');
        rl.close();
        return;
      }

      // 斜杠命令拦截
      const cmdResult = await commands.tryExecute(trimmed, sessionIdRef.current, agent.id);
      if (cmdResult) {
        console.log(cmdResult.message + '\n');
        ask();
        return;
      }

      try {
        hasShownThinking = false;
        streamedContent = '';

        const userMessage = {
          role: 'user' as const,
          content: trimmed,
          timestamp: Date.now(),
        };

        const runConfig = {
          agentId: agent.id,
          sessionId: sessionIdRef.current,
          model: agent.model.model,
          systemPrompt: typeof agent.persona === 'object' ? agent.persona?.systemPrompt : '',
          cwd: agent.workspace,
        };

        let finalContent = '';
        let engineTerminated = false;
        const eventStream = runner.handle(sessionIdRef.current, userMessage, runConfig);
        const wrappedStream = traceCollector
          ? traceCollector.wrap(eventStream, { sessionId: sessionIdRef.current, agentId: agent.id })
          : eventStream;
        for await (const event of wrappedStream) {
          if (event.type === 'model.call.start') {
            if (!hasShownThinking) {
              process.stdout.write('  🤔 Thinking...');
              hasShownThinking = true;
            }
          } else if (event.type === 'llm_stream_delta' && event.data?.delta) {
            if (hasShownThinking) {
              process.stdout.write('\r' + ' '.repeat(20) + '\r');
              hasShownThinking = false;
            }
            process.stdout.write(event.data.delta as string);
            streamedContent += event.data.delta as string;
          } else if (event.type === 'tool.exec.start') {
            process.stdout.write(`\n  🔧 Running: ${event.data?.toolName}...\n`);
          } else if (event.type === 'tool.exec.end') {
            process.stdout.write(`  ✅ Done (${event.data?.durationMs ?? '?'}ms)\n`);
          } else if (event.type === 'turn.end') {
            finalContent = (event.data?.content as string) ?? '';
          } else if (event.type === 'budget.exceeded') {
            engineTerminated = true;
            const report = event.data as any;
            const status = report?.status ?? 'unknown';
            const detail = report?.report;
            if (streamedContent) process.stdout.write('\n');
            console.log(`\n  ⛔ 预算耗尽: ${status}`);
            if (detail) {
              console.log(`     迭代: ${detail.iterations}/${detail.iterations + (detail.remaining?.iterations ?? 0)}`);
              console.log(`     工具调用: ${detail.toolCalls}/${detail.toolCalls + (detail.remaining?.toolCalls ?? 0)}`);
              console.log(`     耗时: ${Math.round(detail.elapsedMs / 1000)}s`);
            }
            console.log('     使用 /new 开始新会话，或继续对话（上下文已保留）\n');
          } else if (event.type === 'engine.error') {
            engineTerminated = true;
            const errorData = event.data as any;
            const errorMsg = errorData?.error ?? 'unknown error';
            if (streamedContent) process.stdout.write('\n');
            console.log(`\n  ❌ 引擎错误: ${errorMsg}`);
            console.log('     使用 /new 开始新会话，或重新输入重试\n');
          } else if (event.type === 'context.truncated') {
            const data = event.data as any;
            console.log(`\n  ✂️  上下文过长，已自动截断 (${data?.from} → ${data?.to} 条消息)，重试中...`);
          } else if (event.type === 'planning_only_retry') {
            const data = event.data as any;
            console.log(`\n  🔄 检测到计划性响应，正在重试 (${data?.attempt}/${data?.maxAttempts})...`);
          } else if (event.type === 'checkpoint') {
            const data = event.data as any;
            const verdict = data?.verdict;
            if (verdict?.action === 'recover') {
              console.log(`\n  🔄 检查点审查: ${verdict.reason}`);
            }
          } else if (event.type === 'checkpoint.stop') {
            engineTerminated = true;
            const data = event.data as any;
            if (streamedContent) process.stdout.write('\n');
            console.log(`\n  🛑 任务监督器终止: ${data?.reason ?? '未知原因'}`);
            if (data?.userMessage) {
              console.log(`     ${data.userMessage}`);
            }
            console.log('');
          }
        }

        // 流式内容已实时输出，补换行；否则用 finalContent 回显
        if (!engineTerminated) {
          const displayContent = streamedContent || finalContent;
          if (streamedContent) {
            process.stdout.write('\n');
          } else if (displayContent) {
            console.log(`\n  ${displayContent}`);
          } else {
            console.log('\n  ⚠️  Empty response from model. This may be a streaming issue or model quirk.\n     Try rephrasing your message or use /new to start a fresh session.\n');
          }
        }
      } catch (error) {
        console.error(`\n[Error] ${error instanceof Error ? error.message : String(error)}\n`);
      }

      ask();
    });
  };

  ask();

  // 退出时打印指标摘要
  rl.on('close', async () => {
    if (traceCollector) {
      const metrics = traceCollector.getMetricsAggregator();
      if (metrics) {
        const { formatMetricsSnapshot } = await import('./integration/observability/metrics.js');
        console.error('\n' + formatMetricsSnapshot(metrics.snapshot()));
      }
      traceCollector.finalize();
    }
  });
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
    case 'chat': await chatCommand(args); break;
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
