/**
 * HTTP + WebSocket Channel Adapter
 *
 * - POST /messages — 发送消息（REST）
 * - GET  /health   — 健康检查
 * - WS   /ws       — WebSocket 双向流式通信
 *
 * WebSocket 协议：
 *   客户端 → 服务端:
 *     { type: "chat", content: "...", sessionId: "...", agentId: "..." }
 *     { type: "abort", sessionId: "..." }
 *
 *   服务端 → 客户端:
 *     { type: "event", event: AgentEvent }
 *     { type: "accepted", messageId: "..." }
 *     { type: "error", message: "..." }
 */

import type { ChannelAdapter, ChannelMessage, ChannelReply } from '../types/channels.js';
import type { AgentEvent } from '../../core/primitives/event-bus.js';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket, type WebSocket as WS } from 'ws';

export interface HttpAdapterOptions {
  port: number;
  path?: string;
  /** 启用 WebSocket 支持（默认 true） */
  enableWebSocket?: boolean;
  /**
   * API Key 认证
   *
   * 设置后，所有请求必须携带 Authorization: Bearer <apiKey> 头。
   * WebSocket 连接需要在 URL 查询参数中传递 token：ws://host/ws?token=<apiKey>
   * health 端点不需要认证。
   */
  apiKey?: string;
  /**
   * 允许的 CORS 源（默认 '*'）
   *
   * 生产环境应设置为具体的域名列表。
   */
  corsOrigins?: string[];
  onRequest?: HttpCustomRequestHandler;
}

export type HttpCustomRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;

interface WsSession {
  ws: WS;
  sessionId?: string;
  agentId?: string;
  /** 精确订阅的 session 列表 */
  subscribedSessions?: Set<string>;
  /** 发送队列（背压处理） */
  sendQueue: string[];
  /** 队列是否正在消费 */
  draining: boolean;
}

/**
 * Gateway 向 adapter 推送事件的接口
 */
export interface StreamingChannelAdapter extends ChannelAdapter {
  /**
   * 向指定 session 的所有 WebSocket 客户端广播事件
   */
  broadcastEvent(sessionId: string, event: AgentEvent): void;
}

export class HttpChannelAdapter implements StreamingChannelAdapter {
  name = 'http';
  private port: number;
  private path: string;
  private enableWebSocket: boolean;
  private apiKey?: string;
  private corsOrigins: string;
  private onRequest?: HttpCustomRequestHandler;
  private handler?: (msg: ChannelMessage) => Promise<void>;
  private server?: Server;
  private wss?: WebSocketServer;
  private wsSessions = new Set<WsSession>();
  /** 中止回调（由 Gateway 注册） */
  onAbort?: (sessionId: string) => void;
  /** 欢迎消息扩展（由 Gateway 注册，返回额外数据合并到欢迎消息） */
  onWelcome?: () => Record<string, unknown>;

  constructor(options: HttpAdapterOptions) {
    this.port = options.port;
    this.path = options.path ?? '/messages';
    this.enableWebSocket = options.enableWebSocket ?? true;
    this.apiKey = options.apiKey;
    this.corsOrigins = options.corsOrigins?.join(', ') ?? '*';
    this.onRequest = options.onRequest;
  }

  async start(handler: (msg: ChannelMessage) => Promise<void>): Promise<void> {
    this.handler = handler;

    this.server = createServer(async (req, res) => {
      // CORS
      res.setHeader('Access-Control-Allow-Origin', this.corsOrigins);
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          adapter: 'http',
          websocket: this.enableWebSocket,
          connections: this.wsSessions.size,
          auth: !!this.apiKey,
        }));
        return;
      }

      if (this.onRequest) {
        const handled = await this.onRequest(req, res);
        if (handled) return;
      }

      if (req.method === 'GET' && req.url === '/metrics') {
        if (!this.checkAuth(req, res)) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          connections: this.wsSessions.size,
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          timestamp: Date.now(),
        }));
        return;
      }

      if (req.method === 'POST' && req.url === this.path) {
        // 认证检查
        if (!this.checkAuth(req, res)) return;

        try {
          const body = await this.readBody(req);
          const message: ChannelMessage = {
            id: `http-${Date.now()}`,
            channel: 'http',
            senderId: body.senderId ?? 'cli',
            senderName: body.senderName,
            content: body.content ?? body.message ?? '',
            conversationId: body.conversationId ?? 'default',
            timestamp: Date.now(),
            metadata: body.metadata,
          };

          this.handler!(message).catch(console.error);

          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted: true, messageId: message.id }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(error) }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    // WebSocket
    if (this.enableWebSocket) {
      this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
      this.wss.on('connection', (ws, req) => {
        // WebSocket 认证：从 URL 查询参数提取 token
        if (this.apiKey) {
          const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
          const token = url.searchParams.get('token');
          if (token !== this.apiKey) {
            ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: invalid or missing token' }));
            ws.close(4001, 'Unauthorized');
            return;
          }
        }
        this.handleWsConnection(ws);
      });
    }

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, () => {
        const wsInfo = this.enableWebSocket ? ' + WebSocket /ws' : '';
        console.log(`[HTTP Adapter] Listening on port ${this.port}${wsInfo}`);
        resolve();
      });
    });
  }

  async send(reply: ChannelReply): Promise<void> {
    // HTTP REST 模式的回复（非 WebSocket 客户端）
    // 广播给所有连接到该 conversationId 的 WebSocket 客户端
    const content = reply.content;
    this.broadcastToConversation(reply.conversationId, {
      type: 'reply',
      content,
      conversationId: reply.conversationId,
      replyToId: reply.replyToId,
    });
  }

  broadcastEvent(sessionKey: string, event: AgentEvent): void {
    // sessionKey 格式：agentId:rest（由 Gateway 构建）
    const agentId = sessionKey.split(':')[0];
    const payload = { type: 'event', sessionId: sessionKey, event };
    const data = JSON.stringify(payload);
    const statePayload = this.deriveSessionState(sessionKey, event);
    const stateData = statePayload ? JSON.stringify(statePayload) : undefined;

    for (const session of this.wsSessions) {
      if (session.ws.readyState !== WebSocket.OPEN) continue;

      const matchesExact = session.subscribedSessions?.has(sessionKey) ?? false;
      const sessionAgentId = (session.agentId ?? session.sessionId ?? '').split(':')[0];
      const matchesAgent = sessionAgentId === agentId;

      if (matchesExact || matchesAgent) {
        this.enqueueSend(session, data);
        if (stateData) {
          this.enqueueSend(session, stateData);
        }
      }
    }
  }

  private deriveSessionState(sessionKey: string, event: AgentEvent): { type: 'state'; sessionId: string; state: string } | null {
    switch (event.type) {
      case 'llm_stream_delta':
      case 'tool.exec.start':
      case 'tool.exec.end':
      case 'model.call.start':
        return { type: 'state', sessionId: sessionKey, state: 'running' };
      case 'turn.end':
        return { type: 'state', sessionId: sessionKey, state: 'idle' };
      case 'aborted':
        return { type: 'state', sessionId: sessionKey, state: 'aborted' };
      case 'engine.error':
      case 'model.call.error':
        return { type: 'state', sessionId: sessionKey, state: 'error' };
      case 'engine.end':
        return { type: 'state', sessionId: sessionKey, state: 'idle' };
      default:
        return null;
    }
  }

  /**
   * 带背压的消息入队
   *
   * 队列上限 100 条。超过时丢弃最旧的非关键消息。
   * 如果 WebSocket 缓冲区已满（bufferedAmount > 1MB），暂停入队。
   */
  private enqueueSend(session: WsSession, data: string): void {
    const MAX_QUEUE = 100;
    const MAX_BUFFER = 1024 * 1024; // 1MB

    // 高水位丢弃：丢弃队列中最旧的消息
    if (session.sendQueue.length >= MAX_QUEUE) {
      session.sendQueue.shift();
    }

    session.sendQueue.push(data);
    this.drainQueue(session);
  }

  /** 消费发送队列 */
  private drainQueue(session: WsSession): void {
    if (session.draining) return;
    session.draining = true;

    const MAX_BUFFER = 1024 * 1024; // 1MB

    const drain = () => {
      while (session.sendQueue.length > 0) {
        if (session.ws.readyState !== WebSocket.OPEN) {
          session.sendQueue.length = 0;
          break;
        }
        if (session.ws.bufferedAmount > MAX_BUFFER) {
          // 缓冲区满，延迟重试剩余消息
          setTimeout(drain, 50);
          return;
        }
        const msg = session.sendQueue.shift()!;
        session.ws.send(msg);
      }
      session.draining = false;
    };

    drain();
  }

  async stop(): Promise<void> {
    // Close all WebSocket connections
    for (const session of this.wsSessions) {
      session.ws.close();
    }
    this.wsSessions.clear();

    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  // ── WebSocket handling ──

  private handleWsConnection(ws: WS): void {
    const session: WsSession = { ws, sendQueue: [], draining: false };
    this.wsSessions.add(session);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleWsMessage(session, msg);
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.on('close', () => {
      this.wsSessions.delete(session);
    });

    ws.on('error', () => {
      this.wsSessions.delete(session);
    });

    // Send welcome
    const welcome: Record<string, unknown> = {
      type: 'connected',
      message: 'Octopi Gateway WebSocket connected',
      timestamp: Date.now(),
    };
    // 合并 Gateway 提供的额外信息
    if (this.onWelcome) {
      try { Object.assign(welcome, this.onWelcome()); } catch { /* ignore */ }
    }
    ws.send(JSON.stringify(welcome));
  }

  private async handleWsMessage(session: WsSession, msg: any): Promise<void> {
    if (msg.type === 'chat') {
      // 绑定 agentId（sessionId 在 Gateway 处理后更新）
      session.agentId = msg.agentId;

      const channelMsg: ChannelMessage = {
        id: `ws-${Date.now()}`,
        channel: 'ws',
        senderId: msg.senderId ?? 'tui',
        content: msg.content ?? '',
        conversationId: msg.sessionId ?? 'default',
        timestamp: Date.now(),
        metadata: { wsSession: true, agentId: msg.agentId, sessionId: msg.sessionId, ...msg.metadata },
      };

      try {
        // Gateway 处理消息后会广播事件，广播用的是 Gateway 自己的 sessionKey
        // 但 WS session 的 sessionId 是 TUI 传来的，两者可能不一致
        // 所以先用 TUI 的 sessionId 作为 fallback
        session.sessionId = msg.sessionId;
        session.agentId = msg.agentId;
        if (msg.sessionId) {
          session.subscribedSessions ??= new Set<string>();
          session.subscribedSessions.add(String(msg.sessionId));
        }
        await this.handler!(channelMsg);
        session.ws.send(JSON.stringify({ type: 'accepted', sessionId: String(msg.sessionId ?? channelMsg.conversationId), messageId: channelMsg.id }));
        if (msg.sessionId) {
          session.ws.send(JSON.stringify({ type: 'state', sessionId: String(msg.sessionId), state: 'running' }));
        }
      } catch (error) {
        session.ws.send(JSON.stringify({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    } else if (msg.type === 'abort') {
      console.log(`[WS] Abort requested for session ${msg.sessionId}`);
      this.onAbort?.(msg.sessionId);
    } else if (msg.type === 'subscribe' && msg.sessionId) {
      session.subscribedSessions ??= new Set<string>();
      session.subscribedSessions.add(String(msg.sessionId));
      session.sessionId = String(msg.sessionId);
      if (msg.agentId) session.agentId = String(msg.agentId);
      session.ws.send(JSON.stringify({ type: 'state', sessionId: String(msg.sessionId), state: 'idle' }));
    } else if (msg.type === 'unsubscribe' && msg.sessionId) {
      session.subscribedSessions?.delete(String(msg.sessionId));
    }
  }

  private broadcastToConversation(conversationId: string, data: any): void {
    const json = JSON.stringify(data);
    for (const session of this.wsSessions) {
      if (session.sessionId === conversationId && session.ws.readyState === WebSocket.OPEN) {
        this.enqueueSend(session, json);
      }
    }
  }

  /**
   * 检查 Authorization: Bearer <apiKey> 头
   * @returns true 如果认证通过，false 如果已发送 401 响应
   */
  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.apiKey) return true;

    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (token !== this.apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing API key' }));
      return false;
    }
    return true;
  }

  private readBody(req: any): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: string) => { data += chunk; });
      req.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }
}
