/**
 * Gateway 侧 Knowledge Service 运行时 — manageLocal 子进程 + Client
 *
 * 契约：arch/knowledge-service-http.md；Gateway **不**打开 knowledge.db，
 * 也**不**与 Service 共进程。manageLocal = fork `knowledge-serve-child`。
 *
 * 自愈（拍板 2026-11-02）：manageLocal 子进程意外退出/首启失败 → 指数退避自动重启
 * （1s→2s→…封顶 60s，无限次——「自愈」语义 = 宿主活着就一直试）；恢复 ready 即放行
 * run（required 闸门的拒 run 窗口从「到网关重启」缩为「到子进程回来」）。生命周期
 * 经 opts.onLifecycle 上抛（gateway 转 WS/事件总线）；子进程属宿主级生命周期，
 * 不进 agent 级 ops 账本（「拒 run 的每一次」由准入闸门记 ops.knowledge.run_refused）。
 */

import { createStreamDispatcher, providerFetch } from '@octopi-agent/engine/integration/providers/fetch-timeout.js';
import type { KnowledgeClient } from '@octopi-agent/engine/harness/knowledge/client.js';
import type {
  KnowledgeBootEmbed,
  KnowledgeBootIngest,
  KnowledgeBootRetriever,
} from '@octopi-agent/engine/harness/knowledge/boot-config.js';
import type { KnowledgeServiceProcessHandle } from '@octopi-agent/engine/harness/knowledge/start-service-process.js';

export interface KnowledgeServiceConfig {
  baseUrl?: string;
  token?: string;
  manageLocal?: boolean;
  /** manageLocal 本地监听端口（缺省 18280） */
  port?: number;
  timeoutMs?: number;
  connectTimeoutMs?: number;
}

export type KnowledgeRuntimeState = 'disabled' | 'ready' | 'degraded';

/** 自愈退避：attempt 从 0 起，指数增长封顶（缺省 1s→…→60s） */
export function knowledgeRestartBackoffMs(
  attempt: number,
  initialMs = 1_000,
  maxMs = 60_000,
): number {
  return Math.min(initialMs * 2 ** attempt, maxMs);
}

/** 退避清零的稳定期（P2-7）：子进程存活满此时长才视为「已恢复」，清 crash-loop 计数 */
const RESTART_STABILITY_MS = 60_000;

interface KnowledgeLocalBoot {
  cfg: KnowledgeServiceConfig | undefined;
  opts: KnowledgeStartOpts;
  token: string;
}

export interface KnowledgeStartOpts {
  dataDir: string;
  gatewayId?: string;
  tenantId?: string;
  documentConfig?: import('@octopi-agent/engine/harness/capabilities/document/factory.js').DocumentCapabilityConfig | null;
  /** models.providers + models.embedding（子进程 resolveEmbeddingRuntime） */
  embeddingModels?: {
    providers?: Record<string, unknown>;
    embedding?: unknown;
  } | null;
  embed?: KnowledgeBootEmbed;
  /** Ingest 调参（knowledge.load / index.queue / index.files） */
  ingest?: KnowledgeBootIngest;
  /** 检索调参（knowledge.keywordWeight / autoInject / hint / index.hybridKeyword） */
  retriever?: KnowledgeBootRetriever;
  /** false = 索引稳定后不自动生成 generatedDescription（knowledge.catalog.autoDescribe；仅 manageLocal） */
  autoDescribe?: boolean;
  /** 子进程生命周期观测（宿主级；不进 agent 级 ops 账本） */
  onLifecycle?: (evt: { type: string; data: Record<string, unknown> }) => void;
  /** 自愈退避参数覆盖（测试用；缺省 1s→60s 封顶、无限次） */
  restartBackoff?: { initialMs?: number; maxMs?: number };
  sqliteVec?: boolean | { extensionPath?: string; require?: boolean };
  /** 跨租户共享闸（B-5）：允许创建 visibility='public' 项目 */
  allowPublic?: boolean;
}

/**
 * Knowledge SSE 订阅的「首字节」预算（毫秒）：连接 + 响应头。
 *
 * 拿到 2xx 之后的静默是正常业务态（没有 ingest 任务时事件之间无数据），不设上限——
 * 见 {@link GatewayKnowledgeRuntime.subscribeProgress}。
 */
const KNOWLEDGE_SSE_HEADERS_TIMEOUT_MS = 30_000;

export class GatewayKnowledgeRuntime {
  private client: KnowledgeClient | null = null;
  private local: KnowledgeServiceProcessHandle | null = null;
  private _state: KnowledgeRuntimeState = 'disabled';
  private gatewayId = 'gw-local';
  private tenantId = 'default';
  /** 自愈状态 */
  private lastBoot: KnowledgeLocalBoot | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempt = 0;
  private stopped = false;
  /** 子进程代际：失效旧代的 exit 回调（换子进程/清理孤儿时自增） */
  private generation = 0;
  private onLifecycle: ((evt: { type: string; data: Record<string, unknown> }) => void) | null =
    null;
  private restartBackoff: { initialMs?: number; maxMs?: number } | null = null;

  get state(): KnowledgeRuntimeState {
    return this._state;
  }

  get knowledgeClient(): KnowledgeClient | null {
    return this.client;
  }

  /**
   * 按配置拉起/连接 Knowledge Service。
   *
   * @param cfg - knowledge.service
   * @param opts.gatewayId - 本 Gateway 身份（token 一致）
   * @param opts.dataDir - manageLocal 时的 OCTOPI_HOME/knowledge
   * @param opts.documentConfig - documents.*（与 Gateway 抽取同源）
   * @param opts.embeddingModels - models.*（子进程内重建 EmbeddingProvider）
   * @param opts.embed - embed 批/限速/密钥策略（仅 manageLocal；远程 Service 由其自身部署配置）
   * @param opts.ingest - Ingest 调参（knowledge.load / index.queue / index.files；仅 manageLocal）
   * @param opts.retriever - 检索调参（knowledge.keywordWeight / autoInject / hint；仅 manageLocal）
   * @param opts.autoDescribe - false = 索引稳定后不自动生成描述（knowledge.catalog.autoDescribe；仅 manageLocal）
   * @param opts.onLifecycle - 子进程生命周期观测（exited/restarting/recovered/restart_failed；仅 manageLocal）
   * @param opts.restartBackoff - 自愈退避参数覆盖（测试用；缺省 1s→60s）
   * @param opts.connectTimeoutMs 经 cfg 传入：manageLocal 启动握手等待（fork→ready）
   */
  /** 状态迁移观察者（gateway 经此补推 syncKnowledgeState；M2 单一生产点） */
  private stateChange?: (state: KnowledgeRuntimeState) => void;

  /**
   * 注入状态迁移观察者（每次 _state 迁移后回调；回调异常不阻断迁移）。
   *
   * @param fn - 迁移回调
   */
  onStateChange(fn: (state: KnowledgeRuntimeState) => void): void {
    this.stateChange = fn;
  }

  /**
   * 状态迁移单点：赋值 + 上抛（供 run 侧准入态同步）。
   *
   * @param state - 目标状态
   */
  private setState(state: KnowledgeRuntimeState): void {
    if (this._state === state) return;
    this._state = state;
    try {
      this.stateChange?.(state);
    } catch {
      // 观察者失败不阻断迁移（上抛面 fail-open）
    }
  }

  async start(
    cfg: KnowledgeServiceConfig | undefined,
    opts: KnowledgeStartOpts,
  ): Promise<void> {
    this.gatewayId = opts.gatewayId ?? this.gatewayId;
    this.tenantId = opts.tenantId ?? this.tenantId;
    this.onLifecycle = opts.onLifecycle ?? null;
    this.restartBackoff = opts.restartBackoff ?? null;
    this.stopped = false;

    const manageLocal = cfg?.manageLocal !== false;
    const baseUrl = cfg?.baseUrl?.trim();
    // 可推导的默认 token 等同无鉴权；未配置时每进程随机，不可猜测
    const token =
      cfg?.token?.trim() ||
      `local:${this.gatewayId}:${(await import('node:crypto')).randomBytes(16).toString('hex')}`;

    if (!baseUrl && !manageLocal) {
      this.setState('disabled');
      this.client = null;
      return;
    }

    try {
      if (manageLocal && !baseUrl) {
        this.lastBoot = { cfg, opts, token };
        // launchLocal 自带健康握手 + ready 迁移 + 子进程接管（自愈可重入）
        await this.launchLocal();
      } else if (baseUrl) {
        const { KnowledgeClient, runTenantClaimProvider } = await import(
          '@octopi-agent/engine/harness/knowledge/client.js'
        );
        this.client = new KnowledgeClient({
          baseUrl,
          token,
          timeoutMs: cfg?.timeoutMs ?? 30_000,
        });
        this.client.setTenantProvider(runTenantClaimProvider());
        console.log(`[Knowledge] remote client → ${baseUrl} (gatewayId=${this.gatewayId})`);
        await this.client.health();
        this.setState('ready');
        console.log(`[Knowledge] state=ready`);
      } else {
        this.setState('disabled');
        this.client = null;
        console.log('[Knowledge] disabled (manageLocal=false and no baseUrl)');
      }
    } catch (err) {
      if (this.stopped) return; // stop() 在途：保持 disabled，不进入自愈
      this.setState('degraded');
      console.warn(
        `[Knowledge] start failed/degraded: ${err instanceof Error ? err.message : String(err)}`,
      );
      // 自愈（仅 manageLocal）：首启失败也进退避重试，不再锁 degraded 直到网关重启
      this.scheduleRestart('boot_failed');
    }
  }

  /** 拉起子进程 + 接管退出 + 健康握手（可重入；失败/中止统一清理后抛出，调用方退避重试） */
  private async launchLocal(): Promise<void> {
    const boot = this.lastBoot;
    if (!boot) throw new Error('launchLocal: no boot params');
    const { startKnowledgeServiceProcess } = await import(
      '@octopi-agent/engine/harness/knowledge/start-service-process.js'
    );
    const { join } = await import('node:path');
    const { mkdirSync } = await import('node:fs');
    const dbPath = join(boot.opts.dataDir, 'knowledge.db');
    mkdirSync(boot.opts.dataDir, { recursive: true });

    const gen = ++this.generation;
    let handle: KnowledgeServiceProcessHandle | null = null;
    try {
      handle = await startKnowledgeServiceProcess({
        dbPath,
        port: boot.cfg?.port,
        tokens: [{ token: boot.token, tenantId: this.tenantId, gatewayId: this.gatewayId }],
        documentConfig: boot.opts.documentConfig ?? null,
        embed: boot.opts.embed ?? undefined,
        ingest: boot.opts.ingest ?? undefined,
        retriever: boot.opts.retriever ?? undefined,
        autoDescribe: boot.opts.autoDescribe,
        embeddingModels: boot.opts.embeddingModels ?? null,
        // connectTimeoutMs = 连接建立等待（fork→ready 握手）；远程模式无独立连接阶段，请求由 timeoutMs 约束
        ...(boot.cfg?.connectTimeoutMs != null ? { startTimeoutMs: boot.cfg.connectTimeoutMs } : {}),
        sqliteVec: boot.opts.sqliteVec,
        allowPublic: boot.opts.allowPublic,
      });
      this.local = handle;

      // 子进程崩溃 → degraded + 自愈重启（不得拖死 Gateway）
      handle.child.once('exit', (code: number | null, signal: string | null) => {
        if (gen !== this.generation || this.stopped || this._state === 'disabled') return;
        this.setState('degraded');
        this.local = null;
        console.warn('[Knowledge] service process exited; state=degraded (self-heal armed)');
        this.emitLifecycle('knowledge.service.exited', {
          code: code ?? null,
          signal: signal ?? null,
        });
        this.scheduleRestart('exited');
      });

      const { KnowledgeClient, runTenantClaimProvider } = await import(
        '@octopi-agent/engine/harness/knowledge/client.js'
      );
      this.client = new KnowledgeClient({
        baseUrl: `http://127.0.0.1:${handle.port}`,
        token: boot.token,
        timeoutMs: boot.cfg?.timeoutMs ?? 30_000,
      });
      this.client.setTenantProvider(runTenantClaimProvider());
      await this.client.health();
      // 降级显式宣告（父侧回读）：子进程 stdio 被丢弃，其 console.warn 不可见——
      // 非 js 档而服务端未加载 sqlite-vec 时必须在此告警（M3：显式降级不得变成静默）
      const readyState = await this.client.ready();
      if (boot.opts.sqliteVec !== false && !readyState.sqliteVec) {
        console.warn(
          '[Knowledge] sqlite-vec unavailable — running the JS vector path; large corpora degrade (vectorEngine fallback, see docs/KNOWN-ISSUES.md)',
        );
      }
      // stop()/换代可能在 fork+握手窗口内完成：丢弃结果，绝不留下复活的子进程（P0-1 竞态闸）
      if (this.stopped || gen !== this.generation) {
        throw new Error('launch aborted: runtime stopped during launch');
      }
      this.setState('ready');
      console.log(
        `[Knowledge] manageLocal child started (port=${handle.port}, pid=${handle.child.pid}, db=${dbPath}, gatewayId=${this.gatewayId})`,
      );
    } catch (err) {
      // 失败即清理（共享语义，P1-1）：作废旧代 exit 回调 + 兜停可能的孤儿进程——
      // 否则「spawn 成功但健康抖动」会留下占端口的活子进程，下轮重试撞端口超时，放大成 30s+ 拒 run
      this.generation++;
      try {
        await (handle ?? this.local)?.stop();
      } catch {
        /* 孤儿清理尽力而为 */
      }
      if (!handle || this.local === handle) this.local = null;
      this.client = null;
      throw err;
    }
  }

  /** 自愈调度（幂等：同刻只挂一个重试定时器；无限次——宿主活着就一直试） */
  private scheduleRestart(reason: string): void {
    if (this.stopped || !this.lastBoot || this.restartTimer) return;
    const attempt = this.restartAttempt;
    const delay = knowledgeRestartBackoffMs(
      attempt,
      this.restartBackoff?.initialMs,
      this.restartBackoff?.maxMs,
    );
    this.restartAttempt = attempt + 1;
    console.warn(
      `[Knowledge] service restart scheduled (attempt=${attempt + 1}, backoff=${delay}ms, reason=${reason})`,
    );
    this.emitLifecycle('knowledge.service.restarting', {
      attempt: attempt + 1,
      backoffMs: delay,
      reason,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.attemptRestart();
    }, delay);
    (this.restartTimer as { unref?: () => void }).unref?.();
  }

  private async attemptRestart(): Promise<void> {
    if (this.stopped || !this.lastBoot) return;
    try {
      await this.launchLocal();
      // P2-7：稳定期后才清零退避——「起来即死」型崩溃循环不得钉死在 1s 退避上反复拉起
      const gen = this.generation;
      const stability = setTimeout(() => {
        if (!this.stopped && gen === this.generation) this.restartAttempt = 0;
      }, RESTART_STABILITY_MS);
      (stability as { unref?: () => void }).unref?.();
      console.log('[Knowledge] service process recovered (state=ready)');
      this.emitLifecycle('knowledge.service.recovered', {});
    } catch (err) {
      if (this.stopped) return; // launchLocal 已清理；停机中不再调度/发事件
      this.setState('degraded');
      this.emitLifecycle('knowledge.service.restart_failed', {
        attempt: this.restartAttempt,
        error: err instanceof Error ? err.message : String(err),
      });
      this.scheduleRestart('restart_failed');
    }
  }

  private emitLifecycle(type: string, data: Record<string, unknown>): void {
    try {
      this.onLifecycle?.({ type, data });
    } catch {
      /* 生命周期观测 fail-open：不影响自愈 */
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    // 清 boot 参数：停机后 scheduleRestart/attemptRestart 均不可再拉起（防「先 local 后 remote」误拉）
    this.lastBoot = null;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.local) {
      await this.local.stop();
      this.local = null;
    }
    this.client = null;
    this.setState('disabled');
  }

  /**
   * 订阅 Knowledge Service SSE 进度；回调失败不影响 ingest。
   *
   * 传输必须用 `providerFetch` + `createStreamDispatcher`，**不能裸用 `fetch`**：
   * Node 内置 fetch（undici）的 `bodyTimeout` 默认 300_000ms
   * （`undici/lib/dispatcher/client.js`：`bodyTimeout != null ? bodyTimeout : 300e3`），
   * 只认 dispatcher 配置，传 `AbortSignal` 并不能解除它。本订阅是**长连接 SSE**：
   * 没有 ingest 任务时，事件之间有任意长的空档。静默满 300s，undici 抛
   * `TypeError: terminated` —— 被下面的 catch 吞掉后，订阅会无声死掉、静默退化成
   * stats 轮询。那不是真断线，是我们自己设的阈值（run 事件流踩过同一个坑）。
   *
   * @param onEvent - 进度事件回调
   * @returns 取消订阅函数（同时释放连接池）
   */
  async subscribeProgress(
    onEvent: (evt: { type: string; data: unknown }) => void,
  ): Promise<() => void> {
    if (!this.client) return () => undefined;
    const baseUrl = this.client.baseUrl;
    const token = this.client.token;
    const ac = new AbortController();
    // 每次订阅独占一个 dispatcher：它在 dispose 时随连接池一起关闭，不跨订阅复用
    const dispatcher = createStreamDispatcher(KNOWLEDGE_SSE_HEADERS_TIMEOUT_MS);
    void (async () => {
      try {
        const res = await providerFetch(`${baseUrl.replace(/\/+$/, '')}/v1/events`, {
          headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
          signal: ac.signal,
          dispatcher,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop() ?? '';
          for (const part of parts) {
            const evLine = part.split('\n').find((l) => l.startsWith('event: '));
            const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
            if (!evLine || !dataLine) continue;
            const type = evLine.slice(7).trim();
            try {
              const data = JSON.parse(dataLine.slice(6));
              onEvent({ type, data });
            } catch {
              // 忽略坏帧
            }
          }
        }
      } catch (err) {
        // 主动取消（dispose / 停机）不算异常；真断线要留痕，否则「订阅悄悄死掉、
        // 退化成轮询」这条降级路径永远看不见。
        if (!ac.signal.aborted) {
          console.warn(
            `[Knowledge] progress subscription ended: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } finally {
        // 释放本次订阅独占的连接池（与 provider 的 dispose 同口径）
        await dispatcher.close().catch(() => undefined);
      }
    })();
    return () => ac.abort();
  }
}
