/**
 * RemoteRunBackend — RunBackend 的进程间唯一实现（arch/service-topology.md §4 P0b）。
 *
 * 生命周期：fork run-serve-child（resolveWorkerUrl 映射 dist；NODE_CHANNEL_* 剥离）→
 * boot 文件纯数据交接 → ready 握手拿端口 → loopback HTTP 契约通道。
 * 传输可换（loopback → 跨机），协议不变（run-protocol 纯数据）。
 *
 * 错误表面（run-protocol 注记的传输形态）：HTTP 4xx（未装载等同步错）在消费端
 * 首个 next 即抛；闸门拒为流内 error entry。两者以错误消息/状态可辨，不静默吞。
 */

import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@octopi-agent/core/primitives/event-bus.js';
import { resolveWorkerUrl } from '@octopi-agent/engine/worker-path.js';
import type {
  RunBackendHealth,
} from '@octopi-agent/engine/harness/activation/run-backend.js';
import type {
  RunControlOp,
  RunControlResponse,
  RunSmokeReport,
  RunHostNotify,
  RunStreamEntry,
} from '@octopi-agent/engine/harness/activation/run-protocol.js';
import type { RunRequest } from '@octopi-agent/engine/harness/activation/index.js';
import type { RunServeBoot } from './run-serve-child.js';

/**
 * boot 文件写入（0600：内容含 provider apiKey + loopback token，同机多用户不可读）。
 *
 * @param bootPath - 目标路径（随机名，创建态写入）
 * @param payload - boot JSON 文本
 * @returns void
 */
export function writeRunServeBoot(bootPath: string, payload: string): void {
  writeFileSync(bootPath, payload, { encoding: 'utf8', mode: 0o600 });
}

/**
 * NDJSON 流 → AgentEvent 流解码（run-protocol `/runs` 消费端，纯函数可单测）。
 *
 * 终态契约（`RunStreamEntry`）：事件若干后恰好一个 `done`/`error`（逐行、`\n` 结尾）。
 * 流干净结束而无终态 entry 是**截断**——按成功返回会静默吞掉半个 run，故 throw
 * （m1：截断≠成功）；未知 entry type 与坏行同样 fail-loud。错误文案带调用方上下文；
 * `error` entry 的 `name`（分类字段，如 AbortError）保留传递。
 *
 * @param chunks - NDJSON 字节块流（`Response.body` 同形）
 * @param ctxLabel - 错误文案上下文（如 `session x, run y`）
 * @returns 协议事件流
 */
export async function* decodeRunStream(
  chunks: AsyncIterable<Uint8Array>,
  ctxLabel: string,
): AsyncGenerator<AgentEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (!line) continue;
      let entry: { type?: unknown; event?: unknown; error?: { message?: string; name?: string } };
      try {
        entry = JSON.parse(line);
      } catch (parseErr) {
        // 坏行也带上下文（F4）：截断/损坏 ≠ 成功
        throw new Error(
          `run_remote: malformed stream entry (${ctxLabel}): ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        );
      }
      if (entry.type === 'event') {
        yield entry.event as AgentEvent;
      } else if (entry.type === 'error') {
        // F3：wire 的 name 是分类字段（如 AbortError），保留给调用方区分中止与失败
        const e = new Error(`${entry.error?.message ?? 'run stream error'} (${ctxLabel})`);
        if (entry.error?.name) e.name = entry.error.name;
        throw e;
      } else if (entry.type === 'done') {
        return;
      } else {
        throw new Error(`run_remote: unknown stream entry type "${String(entry.type)}" (${ctxLabel})`);
      }
    }
  }
  // done/error 均在上方终结；落到这里 = 流干净结束而无终态 entry（m1 核心不变量）
  throw new Error(`run_remote: stream ended without terminal entry (truncated, ${ctxLabel})`);
}

export interface RemoteRunBackendOptions {
  /** 宿主通知（审批/客户端工具/事件/重投）出口；缺省 fail-loud 留痕 */
  onNotify?: (notify: RunHostNotify) => void;
  /** ready 握手超时（缺省 30s：首启含插件发现） */
  readyTimeoutMs?: number;
  /**
   * 版本化 spawn（P0c-3 §4.4）：该版本构建产物根（其 run-serve-child.js 所在目录）。
   * 缺省=同构建自举（resolveWorkerUrl 映射 dist）。跨版本协议兼容见 §6（op 只增不改）。
   */
  buildRef?: string;
}

export class RemoteRunBackend {
  private constructor(
    private readonly child: ChildProcess,
    private readonly port: number,
    private readonly token: string | undefined,
    private readonly bootPath: string,
    private readonly options: RemoteRunBackendOptions,
  ) {}

  /**
   * fork run 实例子进程并完成 boot 握手。
   *
   * @param boot - boot 文件内容（纯数据交接面）
   * @param options - 通知出口/握手超时
   * @returns 就绪的远程后端
   */
  static async start(
    boot: Omit<RunServeBoot, 'token'>,
    options: RemoteRunBackendOptions = {},
  ): Promise<RemoteRunBackend> {
    const token = randomUUID();
    const bootPath = join(tmpdir(), `run-serve-boot-${randomUUID()}.json`);
    // boot 是纯数据交接面：securityIntegrity 活对象（recheck/reattest 方法）经
    // JSON 会被剥成只剩 fingerprint 的残壳，子进程调用即 TypeError。剥离后由
    // run-serve-child 按 configPath 自建守卫（service-topology §7.3 每实例锚定）。
    // 有守卫却无 configPath = 子进程将静默失去漂移闸——fail-loud 拒启动。
    if (boot.config.securityIntegrity && !boot.config.configPath) {
      throw new Error(
        'run_remote: securityIntegrity requires configPath in boot (live guard cannot cross JSON; child rebuilds from configPath)',
      );
    }
    const { securityIntegrity: _liveGuard, ...bootConfig } = boot.config;
    writeRunServeBoot(
      bootPath,
      JSON.stringify({ ...boot, config: bootConfig, token }),
    );

    // 版本化 spawn（§4.4）：buildRef 直指该版本构建入口；缺省同构建自举
    const entry = options.buildRef
      ? join(options.buildRef, 'run-serve-child.js')
      : resolveWorkerUrl('./run-serve-child.js', import.meta.url);
    const env = { ...process.env };
    // 子进程自有 IPC 通道；剥掉继承的通道标识（knowledge fork 同规）
    delete env.NODE_CHANNEL_FD;
    delete env.NODE_CHANNEL_ID;
    let child: ChildProcess;
    try {
      child = fork(entry, [bootPath], {
        execArgv: [],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env,
      });
    } catch (err) {
      // fork 同步抛（F9）：boot 已写而子进程没机会读删——父进程兜底清 secret
      rmSync(bootPath, { force: true });
      throw err;
    }

    const ready = await new Promise<{ port: number }>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off('message', onMessage);
        fn();
      };
      const fail = (err: Error): void =>
        settle(() => {
          child.kill('SIGKILL');
          rmSync(bootPath, { force: true });
          reject(err);
        });
      const timeout = setTimeout(() => {
        fail(new Error('run_remote: ready handshake timeout'));
      }, options.readyTimeoutMs ?? 30_000);
      timeout.unref();
      const onMessage = (msg: unknown): void => {
        const m = msg as { type?: string; kind?: string; port?: number; error?: string };
        // 宿主通知（provider 注册日志等）先于 ready 到达；不参与握手判定
        if (m?.kind === 'notify') return;
        if (m?.type === 'ready' && typeof m.port === 'number') {
          const port = m.port;
          settle(() => resolve({ port }));
        } else {
          fail(new Error(`run_remote: child boot failed: ${m?.error ?? `unexpected handshake ${JSON.stringify(m)}`}`));
        }
      };
      child.on('message', onMessage);
      child.once('error', (err) => fail(err));
      child.once('exit', (code) => {
        fail(new Error(`run_remote: child exited before ready (code ${String(code)})`));
      });
    });

    const backend = new RemoteRunBackend(child, ready.port, token, bootPath, options);
    child.removeAllListeners('exit');
    child.on('exit', (code) => {
      console.warn(`[RunRemote] run instance exited (code ${String(code)})`);
    });
    child.on('message', (msg: unknown) => {
      const m = msg as { kind?: string; notify?: RunHostNotify };
      if (m?.kind === 'notify' && m.notify) {
        if (options.onNotify) {
          options.onNotify(m.notify);
        } else if (m.notify.type === 'log') {
          console[m.notify.level](m.notify.message);
        } else {
          console.error(`[RunRemote] unhandled run-host notify "${m.notify.type}" (no onNotify wired)`);
        }
      }
    });
    return backend;
  }

  /**
   * 执行 run（契约 startRun）。NDJSON 流逐条还原为 AgentEvent。
   *
   * @param req - run 请求（纯数据）
   * @returns 协议事件流
   */
  startRun(req: RunRequest): AsyncIterable<AgentEvent> {
    const self = this;
    return (async function* () {
      const res = await self.fetchJson('POST', '/runs', req);
      if (!res.ok || !res.body) {
        throw new Error(`run_remote: startRun failed (HTTP ${res.status}): ${await self.errorText(res)}`);
      }
      yield* decodeRunStream(res.body, `session ${req.sessionId}, run ${req.requestId}`);
    })();
  }

  /**
   * 会话级控制 op（契约 control）。
   *
   * @param op - 纯数据控制 op
   * @returns 执行结果（ok:false 不抛——调用方裁决）
   */
  async control(op: RunControlOp): Promise<RunControlResponse> {
    const res = await this.fetchJson('POST', '/control', op);
    return (await res.json()) as RunControlResponse;
  }

  /**
   * 实例信息（supervise 登记用）。
   *
   * @returns loopback 端口与子进程 pid
   */
  get info(): { port: number; pid: number } {
    return { port: this.port, pid: this.child.pid ?? -1 };
  }

  /** 冒烟（健康门 §4.3）：`POST /smoke` 独立通道——装配热路径自检，不是 run */
  async smoke(): Promise<RunSmokeReport> {
    const res = await this.fetchJson('POST', '/smoke');
    return (await res.json()) as RunSmokeReport;
  }

  /**
   * 运行面健康（契约 health）。
   *
   * @returns 健康报告
   */
  async health(): Promise<RunBackendHealth> {
    const res = await this.fetchJson('GET', '/health');
    if (!res.ok) {
      throw new Error(`run_remote: health failed (HTTP ${res.status}): ${await this.errorText(res)}`);
    }
    const body = (await res.json()) as RunBackendHealth & { ok?: boolean };
    return {
      mountedAgents: body.mountedAgents,
      inFlightRuns: body.inFlightRuns,
      retiredRunners: body.retiredRunners,
      // 脉搏自述（P0c A′）：透传给 gateway 脉搏调度器
      ...(body.pulses ? { pulses: body.pulses } : {}),
      ...(body.securityGuard ? { securityGuard: body.securityGuard } : {}),
    };
  }

  /**
   * 停止 run 实例（优雅关闭 → 超时 SIGTERM → SIGKILL），并清理 boot 文件。
   *
   * @returns 关闭完成
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (child.exitCode !== null || child.signalCode !== null) {
      rmSync(this.bootPath, { force: true });
      return;
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.send({ type: 'close' });
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 5_000);
        t.unref();
      }),
    ]);
    if (!graceful) {
      child.kill('SIGTERM');
      const hard = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(false), 3_000);
          t.unref();
        }),
      ]);
      if (!hard) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    rmSync(this.bootPath, { force: true });
  }

  private async fetchJson(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.port}${path}`, {
      method,
      headers: {
        ...(this.token === undefined ? {} : { 'x-run-serve-token': this.token }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  private async errorText(res: Response): Promise<string> {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      return parsed.error?.message ?? text;
    } catch {
      return text;
    }
  }
}
