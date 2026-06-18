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

import type { ChannelAdapter, ChannelMessage, ChannelReply } from '../../core/types.js';
import type { AgentEvent } from '../../core/event-bus.js';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, WebSocket, type WebSocket as WS } from 'ws';

export interface HttpAdapterOptions {
  port: number;
  path?: string;
  /** 启用 WebSocket 支持（默认 true） */
  enableWebSocket?: boolean;
}

interface WsSession {
  ws: WS;
  sessionId?: string;
  agentId?: string;
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
  private handler?: (msg: ChannelMessage) => Promise<void>;
  private server?: Server;
  private wss?: WebSocketServer;
  private wsSessions = new Set<WsSession>();

  constructor(options: HttpAdapterOptions) {
    this.port = options.port;
    this.path = options.path ?? '/messages';
    this.enableWebSocket = options.enableWebSocket ?? true;
  }

  async start(handler: (msg: ChannelMessage) => Promise<void>): Promise<void> {
    this.handler = handler;

    this.server = createServer(async (req, res) => {
      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
        }));
        return;
      }

      if (req.method === 'POST' && req.url === this.path) {
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
      this.wss.on('connection', (ws) => this.handleWsConnection(ws));
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

  broadcastEvent(sessionId: string, event: AgentEvent): void {
    // 从 sessionId 提取 agentId（格式：agentId:rest）
    const agentId = sessionId.split(':')[0];
    const data = JSON.stringify({ type: 'event', event });
    for (const session of this.wsSessions) {
      // 匹配 agentId（Gateway sessionKey 的前缀）或精确 sessionId
      const sessionAgentId = (session.sessionId ?? session.agentId ?? '').split(':')[0];
      if ((sessionAgentId === agentId || session.sessionId === sessionId)
        && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(data);
      }
    }
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
    const session: WsSession = { ws };
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
    ws.send(JSON.stringify({
      type: 'connected',
      message: 'Octopi Gateway WebSocket connected',
      timestamp: Date.now(),
    }));
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
        metadata: { wsSession: true, ...msg.metadata },
      };

      try {
        // Gateway 处理消息后会广播事件，广播用的是 Gateway 自己的 sessionKey
        // 需要从 Gateway 获取实际的 sessionKey，或让 Gateway 广播时匹配 agentId
        // 这里先保存 conversationId 作为 fallback
        session.sessionId = msg.sessionId;
        await this.handler!(channelMsg);
        session.ws.send(JSON.stringify({ type: 'accepted', messageId: channelMsg.id }));
      } catch (error) {
        session.ws.send(JSON.stringify({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    } else if (msg.type === 'abort') {
      console.log(`[WS] Abort requested for session ${msg.sessionId}`);
    }
  }

  private broadcastToConversation(conversationId: string, data: any): void {
    const json = JSON.stringify(data);
    for (const session of this.wsSessions) {
      if (session.sessionId === conversationId && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(json);
      }
    }
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
