/**
 * Gateway Chat Client
 *
 * TUI 用来连接 Gateway 的客户端。
 * 通过 WebSocket 接收流式事件，通过 HTTP POST 发送消息。
 */

import type { AgentEvent } from '../../core/event-bus.js';
import WebSocket from 'ws';

export interface GatewayClientOptions {
  /** Gateway URL，如 http://localhost:3000 */
  url: string;
}

export interface GatewayClientCallbacks {
  /** 收到 agent 事件 */
  onEvent?: (event: AgentEvent) => void;
  /** 连接成功 */
  onConnected?: () => void;
  /** 收到 Gateway 欢迎消息（包含 Gateway 配置信息） */
  onGatewayInfo?: (info: GatewayInfo) => void;
  /** 连接断开 */
  onDisconnected?: (reason?: string) => void;
  /** 错误 */
  onError?: (error: Error) => void;
}

/** Gateway 连接信息（从欢迎消息解析） */
export interface GatewayInfo {
  agents?: Array<{ id: string; model: { provider: string; model: string } }>;
}

/**
 * Gateway Chat Client
 *
 * 连接 Gateway WebSocket，收发消息。
 */
export class GatewayChatClient {
  private url: string;
  private ws: WebSocket | null = null;
  private callbacks: GatewayClientCallbacks = {};
  private _connected = false;
  private sessionId: string = '';
  private agentId: string = '';
  /** Gateway 连接信息（从欢迎消息解析） */
  private _gatewayInfo: GatewayInfo | null = null;

  constructor(options: GatewayClientOptions) {
    // 去掉末尾斜杠
    this.url = options.url.replace(/\/$/, '');
  }

  get connected(): boolean {
    return this._connected;
  }

  /** Gateway 连接信息 */
  get gatewayInfo(): GatewayInfo | null {
    return this._gatewayInfo;
  }

  /** 设置回调 */
  on(callbacks: GatewayClientCallbacks): void {
    this.callbacks = callbacks;
  }

  /** 连接到 Gateway */
  async connect(): Promise<void> {
    const wsUrl = this.url.replace(/^http/, 'ws') + '/ws';

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
          this._connected = true;
          this.callbacks.onConnected?.();
          resolve();
        });

        this.ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            this.handleMessage(msg);
          } catch {
            // ignore malformed messages
          }
        });

        this.ws.on('close', (code, reason) => {
          this._connected = false;
          this.callbacks.onDisconnected?.(reason?.toString());
        });

        this.ws.on('error', (err) => {
          if (!this._connected) {
            reject(err);
          } else {
            this.callbacks.onError?.(err as Error);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /** 断开连接 */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  /** 发送聊天消息 */
  async sendMessage(content: string, sessionId: string, agentId: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to Gateway');
    }

    this.sessionId = sessionId;
    this.agentId = agentId;

    this.ws.send(JSON.stringify({
      type: 'chat',
      content,
      sessionId,
      agentId,
      senderId: 'tui',
    }));
  }

  /** 发送中止信号 */
  async sendAbort(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      type: 'abort',
      sessionId: this.sessionId,
    }));
  }

  /** 检测 Gateway 是否可用 */
  static async detect(url: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);

      const res = await fetch(`${url}/health`, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json() as any;
        return data?.status === 'ok';
      }
      return false;
    } catch {
      return false;
    }
  }

  // ── Internal ──

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'connected':
        // Welcome message from server — 提取 Gateway 信息
        if (msg.agents) {
          this._gatewayInfo = { agents: msg.agents };
          this.callbacks.onGatewayInfo?.(this._gatewayInfo);
        }
        break;

      case 'event':
        if (msg.event) {
          this.callbacks.onEvent?.(msg.event as AgentEvent);
        }
        break;

      case 'accepted':
        // Message accepted by Gateway
        break;

      case 'reply':
        // Direct reply (non-streaming fallback)
        break;

      case 'error':
        this.callbacks.onError?.(new Error(msg.message ?? 'Unknown error'));
        break;
    }
  }
}
