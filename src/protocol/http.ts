import type { ChannelAdapter, ChannelMessage, ChannelReply } from '../core/types.js';

/**
 * HTTP Channel Adapter
 *
 * 将 HTTP 请求转化为 Channel 消息，支持：
 * - POST /messages — 发送消息给 agent
 * - GET /health — 健康检查
 */
export interface HttpAdapterOptions {
  port: number;
  path?: string;
}

export class HttpChannelAdapter implements ChannelAdapter {
  name = 'http';
  private port: number;
  private path: string;
  private handler?: (msg: ChannelMessage) => Promise<void>;
  private server?: any;

  constructor(options: HttpAdapterOptions) {
    this.port = options.port;
    this.path = options.path ?? '/messages';
  }

  async start(handler: (msg: ChannelMessage) => Promise<void>): Promise<void> {
    this.handler = handler;

    // 使用 Node.js 原生 http 模块（避免额外依赖）
    const { createServer } = await import('node:http');

    this.server = createServer(async (req, res) => {
      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', adapter: 'http' }));
        return;
      }

      if (req.method === 'POST' && req.url === this.path) {
        try {
          const body = await this.readBody(req);
          const message: ChannelMessage = {
            id: `http-${Date.now()}`,
            channel: 'http',
            senderId: body.senderId ?? 'anonymous',
            senderName: body.senderName,
            content: body.content ?? body.message ?? '',
            conversationId: body.conversationId ?? 'default',
            timestamp: Date.now(),
            metadata: body.metadata,
          };

          // 异步处理，不阻塞响应
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

    await new Promise<void>((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`[HTTP Adapter] Listening on port ${this.port}`);
        resolve();
      });
    });
  }

  async send(reply: ChannelReply): Promise<void> {
    // HTTP 模式下，回复通过 WebSocket 或轮询返回
    // 这里仅记录日志，实际应用需要通过 WS 推送
    console.log(`[HTTP Adapter] Reply to ${reply.conversationId}: ${reply.content.substring(0, 100)}...`);
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
      });
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
