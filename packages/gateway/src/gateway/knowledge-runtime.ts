/**
 * Gateway 侧 Knowledge Service 运行时 — manageLocal + Client
 *
 * 契约：arch/knowledge-service-http.md；Gateway **不**打开 knowledge.db。
 */

import type { KnowledgeClient } from '@octopi-agent/engine/harness/knowledge/client.js';
import type { KnowledgeServeHandle } from '@octopi-agent/engine/harness/knowledge/serve.js';

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

async function isPidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class GatewayKnowledgeRuntime {
  private client: KnowledgeClient | null = null;
  private local: KnowledgeServeHandle | null = null;
  private lockPath: string | null = null;
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
   */
  async start(
    cfg: KnowledgeServiceConfig | undefined,
    opts: {
      dataDir: string;
      gatewayId?: string;
      tenantId?: string;
      documentConfig?: import('@octopi-agent/engine/harness/capabilities/document/factory.js').DocumentCapabilityConfig | null;
    },
  ): Promise<void> {
    this.gatewayId = opts.gatewayId ?? this.gatewayId;
    this.tenantId = opts.tenantId ?? this.tenantId;

    const manageLocal = cfg?.manageLocal !== false;
    const baseUrl = cfg?.baseUrl?.trim();
    const token = cfg?.token?.trim() ?? `local:${this.gatewayId}`;

    if (!baseUrl && !manageLocal) {
      // 未配置且不拉起 → disabled（产品关闭知识面）
      this._state = 'disabled';
      this.client = null;
      return;
    }

    try {
      if (manageLocal && !baseUrl) {
        const { startKnowledgeService } = await import(
          '@octopi-agent/engine/harness/knowledge/serve.js'
        );
        const { join, dirname } = await import('node:path');
        const { mkdirSync, writeFileSync, readFileSync, unlinkSync } = await import('node:fs');
        const dbPath = join(opts.dataDir, 'knowledge.db');
        mkdirSync(dirname(dbPath), { recursive: true });
        // 单写者：同机双 Gateway manageLocal 不得同时写同一 knowledge.db
        const lockPath = `${dbPath}.writer.lock`;
        const tryWriteLock = (): void => {
          writeFileSync(
            lockPath,
            JSON.stringify({ pid: process.pid, at: Date.now() }),
            { encoding: 'utf8', flag: 'wx' },
          );
        };
        try {
          tryWriteLock();
        } catch {
          // EEXIST：读持有者；死锁回收后再独占创建
          let holderPid: number | undefined;
          try {
            const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number };
            holderPid = lock.pid;
          } catch {
            holderPid = undefined;
          }
          const holderAlive =
            holderPid != null &&
            holderPid !== process.pid &&
            (await isPidAlive(holderPid));
          if (holderAlive) {
            throw new Error(
              `knowledge.db already locked by PID ${holderPid} (${lockPath}); use remote baseUrl or stop the other instance`,
            );
          }
          try {
            unlinkSync(lockPath);
          } catch {
            /* ignore */
          }
          console.warn(
            `[Knowledge] reclaimed stale writer.lock (pid=${holderPid ?? 'unknown'})`,
          );
          // 仍用 wx：并发回收方只有一人成功
          tryWriteLock();
        }
        this.lockPath = lockPath;
        this.local = await startKnowledgeService({
          dbPath,
          port: cfg?.port,
          tokens: [{ token, tenantId: this.tenantId, gatewayId: this.gatewayId }],
          autoRegisterPrincipals: true,
          documentConfig: opts.documentConfig ?? null,
        });
        const { KnowledgeClient } = await import(
          '@octopi-agent/engine/harness/knowledge/client.js'
        );
        this.client = new KnowledgeClient({
          baseUrl: `http://127.0.0.1:${this.local.port}`,
          token,
          timeoutMs: cfg?.timeoutMs ?? 5000,
        });
        console.log(
          `[Knowledge] manageLocal started (port=${this.local.port}, db=${dbPath}, gatewayId=${this.gatewayId})`,
        );
      } else if (baseUrl) {
        const { KnowledgeClient } = await import(
          '@octopi-agent/engine/harness/knowledge/client.js'
        );
        this.client = new KnowledgeClient({
          baseUrl,
          token,
          timeoutMs: cfg?.timeoutMs ?? 5000,
        });
        console.log(`[Knowledge] remote client → ${baseUrl} (gatewayId=${this.gatewayId})`);
      } else {
        console.log('[Knowledge] disabled (manageLocal=false and no baseUrl)');
      }
      // 探活
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
      await this.local.close();
      this.local = null;
    }
    if (this.lockPath) {
      try {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(this.lockPath);
      } catch {
        // ignore
      }
      this.lockPath = null;
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
