/**
 * CLI 守护进程管理
 */

import { resolve, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
} from 'node:fs';
import type { CliArgs } from './args.js';
import { getOctopiHome, isInitialized, initOctopi, formatInitReport } from '../init.js';
import { loadConfig, toGatewayConfig } from '../config.js';
import { createToolSet } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/tool-set.js';
import type { ModelProviderConfig } from '@octopi-agent/engine/config.js';
import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import { OpenAIProvider } from '@octopi-agent/engine/integration/providers/openai.js';
import { AnthropicProvider } from '@octopi-agent/engine/integration/providers/anthropic.js';
import { Gateway } from '@octopi-agent/gateway/gateway/gateway.js';
import { webuiStartCommand, webuiStopCommand } from './webui.js';
import {
  delay,
  findPidOnPort,
  getProcessName,
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
  return 18180;
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

/** 端口占用者三态：空闲 / 自己的 Gateway / 其他进程 / 无法识别 */
export type PortOccupantState = 'free' | 'own-gateway' | 'foreign' | 'unknown';

export interface PortOccupant {
  state: PortOccupantState;
  port: number;
  /** 端口监听进程 PID（探测不到时为 null） */
  pid: number | null;
  /** foreign 时尽力获取的进程名（如 node.exe） */
  processName?: string;
  /** own-gateway：进程存活但 health 尚未响应（启动中 / 卡住） */
  healthy: boolean;
  /** own-gateway：来自 pid 文件 */
  startedAt?: string;
  config?: string;
}

type HealthProbe = 'octopi' | 'other' | 'none';

/**
 * 探测端口上的 HTTP 服务是否为 Octopi Gateway
 *
 * - `octopi`：`/health` 返回 200 且 body 形如 `{status:"ok"}`
 * - `other`：有 HTTP 响应但不是 octopi health 形状（被别的服务占用）
 * - `none`：无响应（端口空闲 / 非 HTTP 服务 / 连接被拒）
 */
async function probeGatewayHealth(port: number): Promise<HealthProbe> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return 'other';
    const body: unknown = await res.json().catch(() => null);
    if (
      typeof body === 'object' &&
      body !== null &&
      (body as { status?: unknown }).status === 'ok'
    ) {
      return 'octopi';
    }
    return 'other';
  } catch {
    return 'none';
  }
}

/**
 * 识别端口占用者，供 `serve start` 决策：
 *
 * 1. health 是 octopi → 自己的 Gateway（幂等，不是错误）
 * 2. 监听者 pid 与 pid 文件一致 → 自己的 Gateway（health 未响应 = 启动中/卡住）
 * 3. 监听者是其他进程 → foreign（错误：给出占用者身份 + 出路）
 * 4. 无监听者但 pid 文件进程存活且端口一致 → 自己的 Gateway（启动窗口期，防双开）
 * 5. 有 HTTP 响应但拿不到 pid → unknown（警告后继续，失败由子进程日志上浮）
 * 6. 其余 → free
 *
 * @param port 待检查的监听端口
 */
export async function identifyPortOccupant(port: number): Promise<PortOccupant> {
  const probe = await probeGatewayHealth(port);
  const pid = findPidOnPort(port);
  const pidFile = readPidFile();
  const base = { port, healthy: probe === 'octopi' };

  if (probe === 'octopi') {
    return {
      ...base,
      state: 'own-gateway',
      pid,
      startedAt: pidFile?.startedAt,
      config: pidFile?.config,
    };
  }

  if (pid !== null) {
    if (pidFile && pidFile.pid === pid && isProcessAlive(pidFile.pid)) {
      return {
        ...base,
        state: 'own-gateway',
        pid,
        startedAt: pidFile.startedAt,
        config: pidFile.config,
      };
    }
    return {
      ...base,
      state: 'foreign',
      pid,
      processName: getProcessName(pid) ?? undefined,
    };
  }

  if (pidFile && isProcessAlive(pidFile.pid) && (pidFile.port ?? port) === port) {
    return {
      ...base,
      state: 'own-gateway',
      pid: pidFile.pid,
      startedAt: pidFile.startedAt,
      config: pidFile.config,
    };
  }

  if (probe === 'other') {
    return { ...base, state: 'unknown', pid: null };
  }

  return { ...base, state: 'free', pid: null };
}

/** serve start 等待子进程就绪的超时 */
const STARTUP_TIMEOUT_MS = 20_000;

/**
 * 等待子进程的 Gateway 就绪
 *
 * 就绪判定（任一满足）：
 * 1. 端口持有者 === child.pid（直连 spawn，pid 可信）
 * 2. `/health` 返回 octopi 形状（端口表探测失效时兜底；pid 取端口探测值或 child.pid）
 *
 * 端口被外来者占据时不视为就绪——等子进程退出（race 由上层捕获）或超时，
 * 由 diagnoseStartupFailure 给出结论，避免把外来实例误判为成功。
 *
 * @param port 监听端口
 * @param childPid spawn 返回的子进程 pid
 * @param timeoutMs 最长等待时间
 * @returns 就绪实例 pid；超时返回 null
 */
async function waitGatewayReady(
  port: number,
  childPid: number,
  timeoutMs = STARTUP_TIMEOUT_MS,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const portPid = findPidOnPort(port);
    if (portPid === childPid) return childPid;
    if ((await probeGatewayHealth(port)) === 'octopi') {
      return portPid ?? childPid;
    }
    await delay(300);
  }
  return null;
}

/** Gateway 守护进程日志路径（`OCTOPI_HOME/logs/gateway.log`） */
export function getGatewayLogPath(): string {
  return join(getOctopiHome(), 'logs', 'gateway.log');
}

/** 读取日志尾部若干非空行 */
export function readLogTail(logPath: string, maxLines = 20): string[] {
  try {
    const lines = readFileSync(logPath, 'utf-8').split(/\r?\n/);
    return lines.filter((l) => l.trim().length > 0).slice(-maxLines);
  } catch {
    // fork 前失败 / 日志未创建 / 无读权限：降级为“空日志”，诊断走通用提示
    return [];
  }
}

/**
 * 读取本次 `serve start` 标记之后的 `[Knowledge]` 行。
 *
 * gateway.log 是追加写入，不能只看 tail——上一次运行的 `[Knowledge]` 会混进来。
 *
 * @param logPath Gateway 日志路径
 * @param startMarker 本次启动写入的 `--- octopi serve start ... ---` 行
 * @returns 标记之后的 `[Knowledge]` 行（按时间顺序）
 */
export function readKnowledgeLinesSince(logPath: string, startMarker: string): string[] {
  try {
    const text = readFileSync(logPath, 'utf-8');
    const idx = text.lastIndexOf(startMarker);
    const slice = idx >= 0 ? text.slice(idx + startMarker.length) : text;
    return slice
      .split(/\r?\n/)
      .filter((l) => l.includes('[Knowledge]') && l.trim().length > 0);
  } catch {
    return [];
  }
}

/** Knowledge 启动终态：ready / disabled / failed / degraded / remote 均会落日志 */
const KNOWLEDGE_TERMINAL_RE = /state=ready|disabled \(|failed|degraded|remote client/;

/**
 * 等待本次启动的 `[Knowledge]` 终态行。
 *
 * Knowledge 在 HTTP 端口绑定后仍可能未写完日志（启动竞态），故短轮询而非只读一次。
 *
 * @param logPath Gateway 日志路径
 * @param startMarker 本次启动标记
 * @param timeoutMs 最长等待毫秒（默认 5s）
 * @returns 已观察到的 `[Knowledge]` 行；超时则返回目前收集到的（可能为空）
 */
export async function waitForKnowledgeLines(
  logPath: string,
  startMarker: string,
  timeoutMs = 5_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = readKnowledgeLinesSince(logPath, startMarker);
    if (lines.some((l) => KNOWLEDGE_TERMINAL_RE.test(l))) {
      return lines;
    }
    if (Date.now() >= deadline) {
      return lines;
    }
    await delay(200);
  }
}

/**
 * 把子进程日志尾部翻译成用户可执行的结论（原因 + 出路 + 证据位置）
 *
 * @param opts.logTail 日志尾部行（readLogTail 结果）
 * @param opts.port Gateway 监听端口
 * @param opts.configPath 本次使用的配置路径
 * @param opts.logPath 完整日志路径
 * @returns 逐行输出的诊断文本
 */
export function diagnoseStartupFailure(opts: {
  logTail: string[];
  port: number;
  configPath?: string;
  logPath: string;
}): string[] {
  const { logTail, port, configPath, logPath } = opts;
  const tail = logTail.join('\n');
  const lines: string[] = [];

  if (/EADDRINUSE/i.test(tail)) {
    lines.push(`Port ${port} was taken by another process after the preflight check (EADDRINUSE).`);
    lines.push(`   Re-run 'octopi serve start', or start on another port with --port <other>.`);
  } else if (/\bEACCES\b|\bEPERM\b/i.test(tail)) {
    lines.push(`Not allowed to bind port ${port} (EACCES) — ports below 1024 may require elevated privileges.`);
  } else if (/Cannot find module|ERR_MODULE_NOT_FOUND/i.test(tail)) {
    lines.push('A required module failed to load — the installation may be incomplete or out of sync.');
    lines.push('   Reinstall: npm install (project) or npm install -g octopi-agent (global).');
  } else if (/Config file not found/i.test(tail)) {
    lines.push(`Config file not found (searched cwd and ${configPath ?? join(getOctopiHome(), 'octopi.json')}).`);
    lines.push("   Run 'octopi init' to create one, or pass -c <path>.");
  } else if (/Config validation failed/i.test(tail)) {
    lines.push(`Configuration is invalid: ${configPath ?? join(getOctopiHome(), 'octopi.json')}`);
    lines.push('   Fix the field reported in the log, then re-run.');
  } else if (logTail.length > 0) {
    lines.push('Last lines from the Gateway log:');
    for (const line of logTail) lines.push(`   ${line}`);
  } else {
    lines.push('The Gateway log is empty — the child process produced no output.');
  }

  lines.push(`Full log: ${logPath}`);
  lines.push(`Foreground debug: octopi serve fg${configPath ? ` -c ${configPath}` : ''}`);
  return lines;
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
  const port = resolveListenPort(args, configPath);
  const logPath = getGatewayLogPath();
  const occupant = await identifyPortOccupant(port);

  // 幂等：自己的 Gateway 已在跑 → 引导 status/restart，不报错
  if (occupant.state === 'own-gateway') {
    console.log(`⚠️  Gateway is already running (PID: ${occupant.pid ?? 'unknown'}, port ${port}).`);
    if (occupant.healthy) {
      console.log('   Health: OK');
    } else {
      console.log('   Health: process alive but not responding yet (starting or stuck).');
      console.log("   If it stays this way, run 'octopi serve restart'.");
    }
    if (occupant.startedAt) console.log(`   Started: ${occupant.startedAt}`);
    if (occupant.config) console.log(`   Config:  ${occupant.config}`);
    console.log(`\nUse 'octopi serve status' to inspect, 'octopi serve restart' to restart, or 'octopi serve stop' to stop.`);
    await webuiStartCommand(configPath, { soft: true });
    process.exit(0);
  }

  // 被无关进程占用 → 明确报错 + 三条出路，绝不静默
  if (occupant.state === 'foreign') {
    const who = [
      occupant.processName ?? 'unknown process',
      occupant.pid ? `PID ${occupant.pid}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    console.error(`❌ Cannot start Gateway: port ${port} is occupied by ${who}.`);
    console.error('   The occupant is not an Octopi Gateway.');
    console.error('\n   How to resolve:');
    console.error("   1. Stop the occupying process, then run 'octopi serve start' again");
    console.error(`   2. Start on another port:       octopi serve start --port ${port + 1}`);
    console.error(
      `   3. Change the port permanently: set channels[type=http].port in ${configPath ?? 'your config'}`,
    );
    process.exit(1);
  }

  if (occupant.state === 'unknown') {
    console.warn(`⚠️  Port ${port} has an HTTP service that could not be identified; attempting to start anyway.`);
    console.warn(`   If startup fails, the reason will be shown here and in ${logPath}.`);
  }

  // pid 文件是单槽设计：换端口启动时若旧实例仍存活，先明示再接管，避免静默变孤儿
  const prevPidFile = readPidFile();
  if (
    prevPidFile &&
    isProcessAlive(prevPidFile.pid) &&
    prevPidFile.port !== undefined &&
    prevPidFile.port !== port
  ) {
    console.warn(`⚠️  A tracked Gateway (PID ${prevPidFile.pid}, port ${prevPidFile.port}) is still alive.`);
    console.warn(`   Its PID file will be replaced. To stop the old instance: octopi serve stop --port ${prevPidFile.port}`);
  }
  removePidFile();

  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, 'a');
  const startMarker = `--- octopi serve start ${new Date().toISOString()} port=${port} ---`;
  writeSync(logFd, `\n${startMarker}\n`);

  const cliPath = resolve(process.argv[1]);
  const childArgs = ['serve', 'fg'];
  if (configPath) childArgs.push('--config', configPath);
  childArgs.push('--port', String(port));
  if (args.verbose) childArgs.push('--verbose');

  // 子进程 stdout/stderr 落日志：失败原因不再随 stdio:ignore 丢弃
  const child = spawn(process.execPath, [cliPath, ...childArgs], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, OCTOPI_DAEMON: '1' },
  });
  closeSync(logFd);
  child.unref();

  if (!child.pid) {
    console.error('❌ Failed to start Gateway daemon');
    process.exit(1);
  }

  let childExitCode: number | null = null;
  let spawnError: string | null = null;
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', (code) => {
      childExitCode = code;
      resolveExit();
    });
    // spawn 本身失败（权限/资源等）只走 error 不走 exit：不挂监听会以裸栈 uncaughtException 收场
    child.once('error', (err) => {
      spawnError = err instanceof Error ? err.message : String(err);
      resolveExit();
    });
  });

  console.log(`⏳ Waiting for Gateway on port ${port}...`);
  const outcome = await Promise.race([
    waitGatewayReady(port, child.pid).then((pid) => ({ kind: 'ready' as const, pid })),
    exited.then(() => ({ kind: 'exited' as const, pid: null as null })),
  ]);

  if (outcome.kind !== 'ready' || !outcome.pid) {
    if (outcome.kind === 'exited') {
      if (spawnError) {
        console.error(`❌ Failed to launch Gateway child process: ${spawnError}`);
      } else {
        console.error(`❌ Gateway exited during startup (exit code ${childExitCode ?? 'unknown'}).`);
      }
    } else {
      console.error(`❌ Gateway did not become ready within ${STARTUP_TIMEOUT_MS / 1000}s.`);
      // 尽量回收 spawn 出的子进程树
      await killProcess(child.pid, { timeoutMs: 2000 }).catch(() => undefined);
    }
    for (const line of diagnoseStartupFailure({
      logTail: readLogTail(logPath),
      port,
      configPath,
      logPath,
    })) {
      console.error(line);
    }
    process.exit(1);
  }

  const realPid = outcome.pid;

  // 以端口探测到的真实 PID 为准（与 spawn 返回的 pid 可能不一致）
  writePidFile({
    pid: realPid,
    config: configPath ?? join(getOctopiHome(), 'octopi.json'),
    port,
    startedAt: new Date().toISOString(),
  });

  console.log(`✅ Gateway started (PID: ${realPid})`);
  console.log(`   Config: ${configPath ?? join(getOctopiHome(), 'octopi.json')}`);
  console.log(`   Port:   ${port}`);
  console.log(`   Log:    ${logPath}`);

  // Knowledge Service 启动状态（manageLocal / 远程 / disabled）。
  // HTTP 端口先于 Knowledge 就绪，需等待本次启动的 [Knowledge] 终态，避免竞态误报。
  const knLines = await waitForKnowledgeLines(logPath, startMarker, 5_000);
  if (knLines.length > 0) {
    for (const line of knLines.slice(-3)) {
      console.log(`   ${line.trim()}`);
    }
  } else {
    console.log('   Knowledge: (no [Knowledge] line yet — see gateway.log)');
  }

  // Web UI 为可选：失败不拖垮 Gateway（跨平台/无 web 依赖时仍可 serve）
  await webuiStartCommand(configPath, { soft: true });

  console.log(`\nUse 'octopi serve stop' to stop, 'octopi serve status' to check.`);
  process.exit(0);
}

export async function serveStopCommand(args: Pick<CliArgs, 'port' | 'config'> = {}): Promise<void> {
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
    await webuiStopCommand(args.config);
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

  await webuiStopCommand(args.config);
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
    // 守护模式下 preflight 已做过占用者识别：静默杀进程与「失败上浮」契约冲突，
    // 直接失败让父进程按日志给出结论（EADDRINUSE / 占用者信息）
    if (process.env.OCTOPI_DAEMON === '1') {
      console.error(`❌ Port ${port} is already occupied by PID ${portPid} (appeared after preflight).`);
      process.exit(1);
    }
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

  // 与 Gateway 共享 SessionStore（history 检索与运行时同一真相源）
  const { getOctopiHome } = await import('@octopi-agent/engine/paths.js');
  const { join: joinPath } = await import('node:path');
  const { JsonlSessionStore } = await import('@octopi-agent/engine/integration/storage/jsonl.js');
  const home = getOctopiHome();
  let sessionIndex: import('@octopi-agent/engine/integration/storage/session-index.js').SessionIndexBackend | undefined;
  // 先建无 index 的 store 供新鲜度校验；再挂投影
  const storeForRebuild = new JsonlSessionStore({
    sessionsDir: joinPath(home, 'sessions'),
  });
  try {
    const { createSqliteSessionIndex, ensureSessionIndexFresh } = await import(
      '@octopi-agent/engine/integration/storage/session-index.js'
    );
    sessionIndex = await createSqliteSessionIndex({
      dbPath: joinPath(home, 'sessions.index.db'),
    });
    await sessionIndex.ensureSchema();
    // 存量/首次启用：投影数与权威 list 对齐，避免空索引误杀 search
    const fresh = await ensureSessionIndexFresh(sessionIndex, storeForRebuild);
    if (fresh.rebuilt) {
      console.log(`[CLI] session index rebuilt from sessions/ (${fresh.sessions} sessions)`);
    }
  } catch (err) {
    sessionIndex = undefined;
    console.warn(
      `[CLI] session index unavailable (scan-only search): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const gatewayStoreForHistory = new JsonlSessionStore({
    sessionsDir: joinPath(home, 'sessions'),
    index: sessionIndex,
  });

  const gateway = new Gateway(gatewayConfig, gatewayStoreForHistory);

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

  let webSearchToolCfg: { provider: import('@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/web-search-types.js').WebSearchProvider; defaultLimit?: number; timeoutMs?: number } | undefined;
  if (config.webSearch?.providers && Object.keys(config.webSearch.providers).length > 0) {
    const { resolveWebSearchProviders, createWebSearchWithFallback } = await import('@octopi-agent/engine/integration/web-search/factory.js');
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

  // 公用能力 SummaryPort（http_request / file_read L2）；无可用 provider 时仅 L1
  let summarySupport: import('@octopi-agent/engine/harness/context/capabilities/summary/index.js').ToolSummarySupport | undefined;
  try {
    const { createSummaryPort, createToolSummarySupport, createMemorySummaryCache } = await import(
      '@octopi-agent/engine/harness/context/capabilities/summary/index.js'
    );
    const providerMap = new Map<string, import('@octopi-agent/core/interfaces/model-provider.js').ModelProvider>();
    let fallback: import('@octopi-agent/core/interfaces/model-provider.js').ModelProvider | undefined;
    for (const [providerName, providerCfg] of Object.entries(config.models?.providers ?? {})) {
      const provider = createProvider(providerName, providerCfg);
      if (provider) {
        providerMap.set(providerName, provider);
        fallback = fallback ?? provider;
      }
    }
    if (fallback) {
      const summaryCfg = config.summary;
      const toolsCfg = summaryCfg?.tools as
        | {
            maxReturnChars?: number;
            http_request?: Record<string, unknown>;
            file_read?: Record<string, unknown>;
          }
        | undefined;

      let cache:
        | import('@octopi-agent/engine/harness/context/capabilities/summary/index.js').SummaryCachePort
        | undefined;
      let cacheEnabled = false;
      if (summaryCfg?.cache?.enabled) {
        cache = createMemorySummaryCache({
          maxEntries: summaryCfg.cache.maxEntries,
          defaultTtlMs: summaryCfg.cache.ttlMs,
        });
        cacheEnabled = true;
      }

      const policyOverrides = summaryCfg?.policies as
        | Record<string, import('@octopi-agent/engine/harness/context/capabilities/summary/index.js').SummaryPolicy>
        | undefined;

      const portOptions = {
        providers: providerMap,
        levelMap: config.models?.level,
        fallbackProvider: fallback,
        legacySummaryModel: config.contextEngine?.summaryModel,
        model: summaryCfg?.model,
        modelLevel: summaryCfg?.modelLevel,
        gate: summaryCfg?.gate,
        defaultInputBudgetTokens: summaryCfg?.defaultInputBudgetTokens,
        safetyMarginTokens: summaryCfg?.safetyMarginTokens,
        oversizedStrategy: summaryCfg?.oversizedStrategy,
        policyOverrides,
        cache,
        cacheEnabled,
        cacheTtlMs: summaryCfg?.cache?.ttlMs,
        maxReturnCharsDefault: toolsCfg?.maxReturnChars,
        toolBindings: {
          http_request: toolsCfg?.http_request as never,
          file_read: toolsCfg?.file_read as never,
        },
      };
      const port = createSummaryPort(portOptions);
      // 根因修复：配置与 tools 共用同一 binding 解析表（toolBindings），不再 binding:undefined
      summarySupport = createToolSummarySupport(port, portOptions);
      console.log('[CLI] Summary capability: SummaryPort wired into builtin tools');
    }
  } catch (err) {
    console.warn(`[CLI] Summary capability wiring failed (L1-only tools): ${err instanceof Error ? err.message : String(err)}`);
  }

  // 全局工具：CLI 级 builtin（shell/file/http/web_search 等）。
  // memory_store/memory_search **不在**全局注册：由 AgentBuilder 在 agent build 时
  // 按各 agent 的 MemoryStore（SqliteMemoryStore(agent.db)）注入，与 MemoryLayer 同实例。
  // session_search / session_read：Information 历史检索，绑 Gateway 同一 SessionStore。
  let sessionHistoryPort: import('@octopi-agent/engine/harness/session/history/index.js').SessionHistoryPort | undefined;
  try {
    const { createSessionHistoryPort } = await import('@octopi-agent/engine/harness/session/history/index.js');
    const { SessionAclService } = await import('@octopi-agent/engine/harness/governance/session-acl/service.js');
    sessionHistoryPort = createSessionHistoryPort({
      store: gatewayStoreForHistory,
      sessionAcl: new SessionAclService(gatewayConfig.sessionAcl),
      archiveDir: joinPath(home, 'archives'),
      historyScope: 'participated',
      index: sessionIndex,
      // E6 agent.max：与 Runner agentMaxSessionRights 同源（宿主可按 agent 收紧）
      resolveAgentMax: () => undefined,
    });
    console.log('[CLI] session_search/session_read: SessionHistoryPort @ OCTOPI_HOME/sessions');
  } catch (err) {
    console.warn(`[CLI] session history tools unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const documentPort = await gateway.getDocumentPort().catch(() => null);
  const { all } = createToolSet({
    webSearch: webSearchToolCfg,
    summary: summarySupport,
    sessionHistory: sessionHistoryPort,
    documentPort,
    askUser: (question, options, context) =>
      gateway.askUser({
        sessionId: context.sessionId,
        agentId: context.agentId,
        question,
        options,
      }),
  });
  for (const tool of all) gateway.registerTool(tool);
  console.log(`[CLI] Registered ${all.length} global tools: ${all.map(t => t.definition.name).join(', ')}`);
  console.log('[CLI] memory_store/memory_search: agent-scoped (AgentBuilder + memoryStore), not global');

  // ── 子系统发现（启动可见；Agent 首次 build 时按 allow/deny 实际注册） ──
  try {
    const { discoverSubsystemSpecs } = await import('@octopi-agent/engine/harness/agent/builder.js');
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
  const listenPort = args.port ?? httpConfig?.port ?? 18180;
  // web.host 可作 Gateway HTTP 的缺省（局域网访问两者都要放开）；channels[].host 优先
  const listenHostConfig = httpConfig?.host ?? config.web?.host;
  if (httpConfig || args.port) {
    const { HttpChannelAdapter } = await import('@octopi-agent/gateway/protocols/http.js');
    const { WebApiRouter } = await import('@octopi-agent/gateway/web/api/router.js');
    const { resolveListenHost } = await import('@octopi-agent/engine/config.js');
    const webApiRouter = new WebApiRouter({ gateway, basePath: '/api/v1' });
    const listenHost = resolveListenHost(listenHostConfig);
    gateway.registerChannel(new HttpChannelAdapter({
      port: listenPort,
      host: listenHost,
      path: httpConfig?.path ?? '/messages',
      apiKey: httpConfig?.apiKey,
      corsOrigins: httpConfig?.corsOrigins,
      onRequest: (req, res) => webApiRouter.handle(req, res),
      healthExtras: () => ({ knowledge: gateway.getKnowledgeState() }),
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
