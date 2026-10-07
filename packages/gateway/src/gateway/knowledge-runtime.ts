/**
 * Gateway 侧 Knowledge Service 运行时 — manageLocal 子进程 + Client
 *
 * 契约：arch/knowledge-service-http.md；Gateway **不**打开 knowledge.db，
 * 也**不**与 Service 共进程。manageLocal = fork `knowledge-serve-child`。
 */

import type { KnowledgeClient } from '@octopi-agent/engine/harness/knowledge/client.js';
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

export class GatewayKnowledgeRuntime {
  private client: KnowledgeClient | null = null;
  private local: KnowledgeServiceProcessHandle | null = null;
  private _state: KnowledgeRuntimeState = 'disabled';
  private gatewayId = 'gw-local';
  private tenantId = 'default';

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
   * @param opts.embed - embed 批/限速/密钥策略
   */
  async start(
    cfg: KnowledgeServiceConfig | undefined,
    opts: {
      dataDir: string;
      gatewayId?: string;
      tenantId?: string;
      documentConfig?: import('@octopi-agent/engine/harness/capabilities/document/factory.js').DocumentCapabilityConfig | null;
      /** models.providers + models.embedding（子进程 resolveEmbeddingRuntime） */
      embeddingModels?: {
        providers?: Record<string, unknown>;
        embedding?: unknown;
      } | null;
      embed?: {
        enabled?: boolean;
        embedBatch?: number;
        embedMinIntervalMs?: number;
        embedConcurrency?: number;
        embedSecretPolicy?: 'allow' | 'redact' | 'skip';
      };
      sqliteVecExtensionPath?: string;
    },
  ): Promise<void> {
    this.gatewayId = opts.gatewayId ?? this.gatewayId;
    this.tenantId = opts.tenantId ?? this.tenantId;

    const manageLocal = cfg?.manageLocal !== false;
    const baseUrl = cfg?.baseUrl?.trim();
    // 可推导的默认 token 等同无鉴权；未配置时每进程随机，不可猜测
    const token =
      cfg?.token?.trim() ||
      `local:${this.gatewayId}:${(await import('node:crypto')).randomBytes(16).toString('hex')}`;

    if (!baseUrl && !manageLocal) {
      this._state = 'disabled';
      this.client = null;
      return;
    }

    try {
      if (manageLocal && !baseUrl) {
        const { startKnowledgeServiceProcess } = await import(
          '@octopi-agent/engine/harness/knowledge/start-service-process.js'
        );
        const { join } = await import('node:path');
        const { mkdirSync } = await import('node:fs');
        const dbPath = join(opts.dataDir, 'knowledge.db');
        mkdirSync(opts.dataDir, { recursive: true });

        this.local = await startKnowledgeServiceProcess({
          dbPath,
          port: cfg?.port,
          tokens: [{ token, tenantId: this.tenantId, gatewayId: this.gatewayId }],
          documentConfig: opts.documentConfig ?? null,
          embed: opts.embed ?? undefined,
          embeddingModels: opts.embeddingModels ?? null,
          ...(opts.sqliteVecExtensionPath
            ? { sqliteVecExtensionPath: opts.sqliteVecExtensionPath }
            : {}),
        });

        // 子进程崩溃 → degraded（不得拖死 Gateway）
        this.local.child.once('exit', () => {
          if (this._state !== 'disabled') {
            this._state = 'degraded';
            console.warn('[Knowledge] service process exited; state=degraded');
          }
        });

        const { KnowledgeClient } = await import(
          '@octopi-agent/engine/harness/knowledge/client.js'
        );
        this.client = new KnowledgeClient({
          baseUrl: `http://127.0.0.1:${this.local.port}`,
          token,
          timeoutMs: cfg?.timeoutMs ?? 30_000,
        });
        console.log(
          `[Knowledge] manageLocal child started (port=${this.local.port}, pid=${this.local.child.pid}, db=${dbPath}, gatewayId=${this.gatewayId})`,
        );
      } else if (baseUrl) {
        const { KnowledgeClient } = await import(
          '@octopi-agent/engine/harness/knowledge/client.js'
        );
        this.client = new KnowledgeClient({
          baseUrl,
          token,
          timeoutMs: cfg?.timeoutMs ?? 30_000,
        });
        console.log(`[Knowledge] remote client → ${baseUrl} (gatewayId=${this.gatewayId})`);
      } else {
        console.log('[Knowledge] disabled (manageLocal=false and no baseUrl)');
      }
      if (this.client) {
        await this.client.health();
      }
      this._state = this.client ? 'ready' : 'disabled';
      if (this.client) {
        console.log(`[Knowledge] state=ready`);
      }
    } catch (err) {
      this._state = 'degraded';
      console.warn(
        `[Knowledge] start failed/degraded: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.local) {
      await this.local.stop();
      this.local = null;
    }
    this.client = null;
    this._state = 'disabled';
  }

  markDegraded(): void {
    if (this.client) this._state = 'degraded';
  }

  /**
   * 订阅 Knowledge Service SSE 进度；回调失败不影响 ingest。
   */
  async subscribeProgress(
    onEvent: (evt: { type: string; data: unknown }) => void,
  ): Promise<() => void> {
    if (!this.client) return () => undefined;
    const baseUrl = this.client.baseUrl;
    const token = this.client.token;
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/events`, {
          headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
          signal: ac.signal,
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
      } catch {
        // 断线：调用方可退 stats 轮询
      }
    })();
    return () => ac.abort();
  }
}
