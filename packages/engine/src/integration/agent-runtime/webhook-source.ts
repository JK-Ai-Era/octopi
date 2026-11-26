/**
 * WebhookSource — HTTP 入站 → Trigger（Integration）
 *
 * 薄适配：POST JSON → dispatch。不在此层做鉴权策略以外的业务。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AgentRuntime } from '@octopi-agent/engine/harness/activation/runtime.js';
import type { Trigger, TriggerSource } from '@octopi-agent/engine/harness/activation/types.js';

export interface WebhookSourceConfig {
  id?: string;
  /** 监听端口；0 = 系统分配 */
  port: number;
  host?: string;
  path?: string;
  runtime: AgentRuntime;
  /** body.agentId 缺失时的默认 agent */
  defaultAgentId?: string;
  /** 可选 API Key（Authorization: Bearer <key>） */
  apiKey?: string;
  /**
   * 解析目标 agent 的**生效** effectPolicy.mode（A2 host 认证面拍板 2026-11-27：
   * webhook 与发消息同构——`content` 就是 user_message，触达 host agent 必须
   * 认证）。未认证请求只能驱动非 host agent；目标为 host 且未过 Bearer 鉴权
   * 一律 403。由装配层注入（勿在本层猜配置）。
   */
  resolveAgentEffectiveMode: (agentId: string) => string | undefined;
  /** 请求体上限字节（默认 64KB） */
  maxBodyBytes?: number;
}

/**
 * 触发契约：POST <path> JSON body
 * { agentId?, sessionId?, content, coalesceKey? }
 */
export class WebhookSource implements TriggerSource {
  readonly id: string;
  readonly type = 'event' as const;
  private server?: Server;
  private running = false;

  constructor(private readonly config: WebhookSourceConfig) {
    this.id = config.id ?? `webhook-${randomUUID().slice(0, 8)}`;
  }

  async start(_emit: (t: Trigger) => void): Promise<void> {
    // Webhook 不走 emit 回调，直接 dispatch（仍遵守非阻塞）
    if (this.running) return;
    const path = this.config.path ?? '/runtime/webhook';
    const server = createServer((req, res) => {
      void this.handle(req, res, path);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // port=0 → 系统分配，避免测试/并发撞端口
      server.listen(this.config.port, this.config.host ?? '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.running = true;
  }

  /** 实际监听端口（port=0 时有意义） */
  get port(): number | undefined {
    const addr = this.server?.address();
    return typeof addr === 'object' && addr ? addr.port : this.config.port;
  }

  async stop(): Promise<void> {
    this.running = false;
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<void> {
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== path) {
      res.writeHead(404).end();
      return;
    }
    // 认证态（A2 host 认证面）：配了 apiKey 才可能认证；未配 = 全部请求视为
    // 未认证（仅可驱动非 host agent）。
    const providedAuth = req.headers.authorization ?? '';
    const authenticated =
      this.config.apiKey !== undefined &&
      providedAuth === `Bearer ${this.config.apiKey}`;
    if (this.config.apiKey && !authenticated) {
      res.writeHead(401).end();
      return;
    }

    const maxBytes = this.config.maxBodyBytes ?? 64 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(buf);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        agentId?: string;
        sessionId?: string;
        content?: string;
        coalesceKey?: string;
      };
      const agentId = body.agentId ?? this.config.defaultAgentId;
      if (!agentId || !body.content) {
        res.writeHead(400).end(JSON.stringify({ error: 'agentId and content required' }));
        return;
      }
      // A2 host 认证面（2026-11-27 拍板）：webhook 与发消息同构（content 即
      // user_message）——触达 host 生效模式 agent 必须认证；未认证（含未配
      // apiKey）一律 403，fail loud 不静默降级目标。
      const targetMode = this.config.resolveAgentEffectiveMode(agentId);
      if (targetMode === 'host' && !authenticated) {
        res.writeHead(403).end(
          JSON.stringify({
            error:
              'host_agent_unauthenticated: triggering a host-mode agent requires webhook apiKey authentication (Authorization: Bearer)',
          }),
        );
        return;
      }
      const trigger: Trigger = {
        id: `trg-${randomUUID().slice(0, 12)}`,
        type: 'event',
        agentId,
        sessionId: body.sessionId,
        payload: { kind: 'user_message', content: body.content },
        coalesceKey: body.coalesceKey,
        metadata: { source: this.id, reason: 'webhook' },
      };
      // 非阻塞契约：不 await 整次 Run
      void this.config.runtime
        .dispatch(trigger)
        .catch((err) => {
          console.error('[WebhookSource] dispatch failed:', err);
        });
      res.writeHead(202).end(JSON.stringify({ status: 'accepted', triggerId: trigger.id }));
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: 'invalid json' }));
    }
  }
}
