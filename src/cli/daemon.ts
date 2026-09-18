/**
 * CLI 守护进程管理
 */

import { resolve, dirname, join } from 'node:path';
import { fork } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import type { CliArgs } from './args.js';
import { getOctopiHome, isInitialized, initOctopi, formatInitReport } from '../init.js';
import { loadConfig, toGatewayConfig } from '../config.js';
import { createToolSet } from '../harness/plugin-ecosystem/tools/tool-set.js';
import type { ModelProviderConfig } from '../config.js';
import type { ModelProvider } from '../core/interfaces/model-provider.js';
import { OpenAIProvider } from '../integration/providers/openai.js';
import { AnthropicProvider } from '../integration/providers/anthropic.js';
import { Gateway } from '../integration/gateway/gateway.js';
import { webuiStartCommand, webuiStopCommand } from './webui.js';
import {
  delay,
  findPidOnPort,
  isProcessAlive,
  killProcess,
  killProcessOnPort,
} from './process-utils.js';

// Re-export for existing importers (commands.ts / helpers.ts)
export { findPidOnPort, isProcessAlive, killProcessOnPort };

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

/** 从配置解析 Gateway 监听端口 */
export function resolveListenPort(
  args: Pick<CliArgs, 'port' | 'config'>,
  configPath?: string,
): number {
  if (args.port) return args.port;
  const path = configPath ?? args.config;
  try {
    const config = loadConfig(path);
    const httpChannel = config.channels?.find((c: { type: string }) => c.type === 'http');
    if (httpChannel?.port) return httpChannel.port;
  } catch { /* fall through */ }
  return 3000;
}

/**
 * 解析当前 Gateway 的真实 PID
 *
 * 优先端口占用者（最可靠）；其次 pid 文件且进程存活。
 * Windows 上 fork 返回的 pid 与子进程 process.pid 可能不一致，
 * 不能只信 serve start 写下的 pid。
 */
export function resolveGatewayPid(args: Pick<CliArgs, 'port' | 'config'>, configPath?: string): {
  pid: number | null;
  port: number;
  source: 'port' | 'pidfile' | 'none';
} {
  const port = resolveListenPort(args, configPath);
  const portPid = findPidOnPort(port);
  if (portPid && portPid !== process.pid) {
    return { pid: portPid, port, source: 'port' };
  }
  const pidFile = readPidFile();
  if (pidFile && isProcessAlive(pidFile.pid) && pidFile.pid !== process.pid) {
    return { pid: pidFile.pid, port: pidFile.port ?? port, source: 'pidfile' };
  }
  return { pid: null, port, source: 'none' };
}

async function waitGatewayReady(port: number, timeoutMs = 20_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const portPid = findPidOnPort(port);
    if (portPid && portPid !== process.pid) {
      return portPid;
    }
    // health 探测兜底（端口表可能稍慢）
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(800),
      });
      if (res.ok) {
        return findPidOnPort(port);
      }
    } catch { /* not ready */ }
    await delay(300);
  }
  return null;
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
  const configPath = await ensureDaemonConfig(args);
  const existing = resolveGatewayPid(args, configPath);
  if (existing.pid) {
    console.log(`⚠️  Gateway is already running (PID: ${existing.pid}, port ${existing.port})`);
    console.log(`\nUse 'octopi serve restart' to restart, or 'octopi serve stop' to stop.`);
    // Gateway 已在跑时仍尝试拉起 Web UI（restart 半失败 / 仅缺 Web UI 的场景）
    await webuiStartCommand(configPath, { soft: true });
    process.exit(0);
  }

  removePidFile();

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

  const port = resolveListenPort(args, configPath);
  console.log(`⏳ Waiting for Gateway on port ${port}...`);
  const realPid = await waitGatewayReady(port);

  if (!realPid) {
    console.error('❌ Gateway did not become ready within 20s');
    console.error(`   Check logs / try: octopi serve fg -c ${configPath ?? '<config>'}`);
    // 尽量回收 fork 出的子进程树
    await killProcess(child.pid, { timeoutMs: 2000 }).catch(() => undefined);
    process.exit(1);
  }

  // 以端口探测到的真实 PID 覆盖，避免 Windows fork pid 不一致
  writePidFile({
    pid: realPid,
    config: configPath ?? join(getOctopiHome(), 'octopi.json'),
    port,
    startedAt: new Date().toISOString(),
  });

  console.log(`✅ Gateway started (PID: ${realPid})`);
  console.log(`   Config: ${configPath ?? join(getOctopiHome(), 'octopi.json')}`);
  console.log(`   Port:   ${port}`);

  // Web UI 为可选：失败不拖垮 Gateway（跨平台/无 web 依赖时仍可 serve）
  await webuiStartCommand(configPath, { soft: true });

  console.log(`\nUse 'octopi serve stop' to stop, 'octopi serve status' to check.`);
  process.exit(0);
}

export async function serveStopCommand(args: Pick<CliArgs, 'port'> = {}): Promise<void> {
  const resolved = resolveGatewayPid(args);
  const pidFile = readPidFile();

  const targets = new Set<number>();
  if (resolved.pid) targets.add(resolved.pid);
  if (pidFile && isProcessAlive(pidFile.pid)) targets.add(pidFile.pid);

  if (targets.size === 0) {
    if (pidFile || resolved.source === 'none') {
      removePidFile();
      console.log('ℹ️  No running Gateway found (cleaned PID file if any).');
    }
    await webuiStopCommand();
    return;
  }

  let anyStillAlive = false;
  for (const pid of targets) {
    console.log(`🛑 Stopping Gateway (PID: ${pid})...`);
    const stopped = await killProcess(pid, { timeoutMs: 3000 });
    if (!stopped || isProcessAlive(pid)) {
      anyStillAlive = true;
      console.warn(`⚠️  Gateway PID ${pid} may still be running (permission denied or still exiting)`);
    }
  }

  // 端口清理兜底（killProcess 内部会拒绝杀 self/ancestor）
  const portPid = findPidOnPort(resolved.port);
  if (portPid && portPid !== process.pid) {
    console.log(`🛑 Freeing port ${resolved.port} (PID: ${portPid})...`);
    await killProcess(portPid, { timeoutMs: 3000 });
  }

  const portStillHeld = findPidOnPort(resolved.port);
  if (portStillHeld && portStillHeld !== process.pid) {
    anyStillAlive = true;
    console.warn(`⚠️  Port ${resolved.port} still held by PID ${portStillHeld}`);
  }

  if (!anyStillAlive) {
    removePidFile();
  } else if (portStillHeld || resolved.pid || pidFile?.pid) {
    // 保留 pid 文件，避免下次 status/start 误判“没有实例”
    const keepPid = portStillHeld ?? resolved.pid ?? pidFile?.pid;
    if (keepPid && keepPid > 0) {
      writePidFile({
        pid: keepPid,
        config: pidFile?.config ?? join(getOctopiHome(), 'octopi.json'),
        port: resolved.port,
        startedAt: pidFile?.startedAt ?? new Date().toISOString(),
      });
    }
    console.warn('⚠️  Gateway stop incomplete — process still alive.');
    console.warn('   If it was started from an elevated shell, stop it from an elevated terminal:');
    console.warn(`   taskkill /PID ${keepPid} /F`);
  }

  console.log(anyStillAlive ? '⚠️  Gateway not fully stopped.' : '✅ Gateway stopped.');

  await webuiStopCommand();
}

export async function serveRestartCommand(args: CliArgs): Promise<void> {
  await serveStopCommand(args);
  await delay(500);
  await serveStartCommand(args);
}

export async function serveStatusCommand(args: Pick<CliArgs, 'port' | 'config'> = {}): Promise<void> {
  const pidFile = readPidFile();
  const resolved = resolveGatewayPid(args, args.config);

  if (!pidFile && !resolved.pid) {
    console.log('ℹ️  No Gateway instance found.');
    return;
  }

  const alive = resolved.pid !== null;
  console.log(`\n🐙 Gateway Status\n`);
  console.log(`  PID:       ${resolved.pid ?? pidFile?.pid ?? '—'}`);
  console.log(`  Status:    ${alive ? '🟢 Running' : '🔴 Stopped'}`);
  console.log(`  Source:    ${resolved.source}`);
  if (pidFile?.config) console.log(`  Config:    ${pidFile.config}`);
  if (pidFile?.startedAt) console.log(`  Started:   ${pidFile.startedAt}`);
  console.log(`  Port:      ${resolved.port}`);
  console.log();

  if (!alive && pidFile) {
    console.log('  ⚠️  PID file is stale (no listener on port / process dead).');
    console.log(`     Run 'octopi serve start' to start a new instance.\n`);
  }
  if (alive && pidFile && pidFile.pid !== resolved.pid) {
    console.log(`  ℹ️  PID file (${pidFile.pid}) differs from live process (${resolved.pid}).`);
    console.log(`     Status/stop use the live process.\n`);
  }
}

export async function serveFgCommand(args: CliArgs): Promise<void> {
  const configPath = await ensureDaemonConfig(args);
  const port = resolveListenPort(args, configPath);
  const portPid = findPidOnPort(port);
  if (portPid && portPid !== process.pid) {
    console.log(`⚠️  Port ${port} is occupied by PID ${portPid}. Killing...`);
    const killed = await killProcess(portPid, { timeoutMs: 3000 });
    if (!killed && findPidOnPort(port) === portPid) {
      console.error(`❌ Port ${port} still held by PID ${portPid} (likely elevated/foreign process).`);
      console.error('   Stop that process first, or use a different --port.');
      process.exit(1);
    }
    await delay(500);
  }

  await startGatewayBlocking(configPath, args);
}

export async function serveCommand(args: CliArgs): Promise<void> {
  switch (args.subcommand) {
    case 'start':
      return serveStartCommand(args);
    case 'stop':
      return serveStopCommand(args);
    case 'restart':
      return serveRestartCommand(args);
    case 'status':
      return serveStatusCommand(args);
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
  // AgentRuntime 构造参数在 toGatewayConfig 已带上；此处仅防御显式覆盖
  if (config.agentRuntime) {
    gatewayConfig.agentRuntime = {
      ...gatewayConfig.agentRuntime,
      coalesceWindowMs: config.agentRuntime.coalesceWindowMs,
      coalesceBufferLimit: config.agentRuntime.coalesceBufferLimit,
      expectedMaxConcurrentRuns: config.agentRuntime.expectedMaxConcurrentRuns,
    };
  }

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

  const gateway = new Gateway(gatewayConfig);

  for (const [providerName, providerCfg] of Object.entries(config.models?.providers ?? {})) {
    const provider = createProvider(providerName, providerCfg);
    if (provider) {
      gateway.registerProvider(provider);
      console.log(`[CLI] Registered provider: ${providerName} (${providerCfg.api})`);
    }
  }

  // memory 工具不在 Gateway 全局注册：AgentBuilder.build() 按各 agent 的 MemoryStore
  //（SqliteMemoryStore(agent.db)）创建 memory_store/search，与七层 MemoryLayer / memory.steward.* 同实例。
  // SessionTaskService 随 AgentBuilder/Gateway 的 SessionStore 自动接线；不再单独建 TaskTracker。

  let webSearchToolCfg: { provider: import('../harness/plugin-ecosystem/tools/web-search-types.js').WebSearchProvider; defaultLimit?: number; timeoutMs?: number } | undefined;
  if (config.webSearch?.providers && Object.keys(config.webSearch.providers).length > 0) {
    const { resolveWebSearchProviders, createWebSearchWithFallback } = await import('../integration/web-search/factory.js');
    const resolved = resolveWebSearchProviders(config.webSearch);
    if (resolved.primary) {
      webSearchToolCfg = {
        provider: createWebSearchWithFallback(resolved.primary, resolved.fallbacks),
        defaultLimit: resolved.defaultLimit,
        timeoutMs: resolved.timeoutMs,
      };
      console.log(
        `[CLI] Web search enabled: primary=${resolved.primary.id} (api=${resolved.primaryApi}), ` +
        `fallbacks=[${resolved.fallbacks.map((f) => f.id).join(', ')}]`,
      );
    }
  }

  // 全局工具：CLI 级 builtin（shell/file/http/web_search 等）。
  // memory_store/memory_search **不在**全局注册：由 AgentBuilder 在 agent build 时
  // 按各 agent 的 MemoryStore（SqliteMemoryStore(agent.db)）注入，与 MemoryLayer 同实例。
  const { all } = createToolSet({ webSearch: webSearchToolCfg });
  for (const tool of all) gateway.registerTool(tool);
  console.log(`[CLI] Registered ${all.length} global tools: ${all.map(t => t.definition.name).join(', ')}`);
  console.log('[CLI] memory_store/memory_search: agent-scoped (AgentBuilder + memoryStore), not global');

  // ── 子系统发现（启动可见；Agent 首次 build 时按 allow/deny 实际注册） ──
  try {
    const { discoverSubsystemSpecs } = await import('../harness/agent-building/builder.js');
    const { specs, errors } = await discoverSubsystemSpecs();
    if (specs.length > 0) {
      console.log(`[CLI] subsystems discovered: ${specs.map((s) => s.id).join(', ')}`);
    } else {
      console.log('[CLI] subsystems discovered: (none)');
    }
    for (const err of errors) {
      console.warn(`[CLI] subsystem load error at ${err.path}: ${err.error}`);
    }
  } catch (err) {
    console.warn(`[CLI] subsystem discovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Agent Runtime：按配置块挂载 Source（无 enabled 总开关；不写 schedule/escalate 即不挂）──
  const arCfg = config.agentRuntime;
  // agentSignal：显式 true，或 escalate 已配置可用 defaultAgentId 时默认挂
  const mountAgentSignal =
    arCfg?.agentSignal === true || !!arCfg?.escalate?.defaultAgentId;
  await gateway.configureAgentRuntime({
    schedule: arCfg?.schedule,
    escalate: arCfg?.escalate,
    agentSignal: mountAgentSignal,
  });

  const httpConfig = config.channels?.find((c: any) => c.type === 'http');
  const listenPort = args.port ?? httpConfig?.port ?? 3000;
  if (httpConfig || args.port) {
    const { HttpChannelAdapter } = await import('../integration/protocols/http.js');
    const { WebApiRouter } = await import('../integration/web/api/router.js');
    const webApiRouter = new WebApiRouter({ gateway, basePath: '/api/v1' });
    gateway.registerChannel(new HttpChannelAdapter({
      port: listenPort,
      path: httpConfig?.path ?? '/messages',
      apiKey: httpConfig?.apiKey,
      corsOrigins: httpConfig?.corsOrigins,
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
    config: configPath ?? join(getOctopiHome(), 'octopi.json'),
    port: httpConfig || args.port ? listenPort : undefined,
    startedAt: new Date().toISOString(),
  });

  await gateway.start();
}
