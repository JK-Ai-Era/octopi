/**
 * Channel Adapter — 消息渠道适配器契约
 *
 * @layer harness/extension/plugin-ecosystem — 插件 SPI，非 Core Kernel。
 * 实现方：Integration 协议适配器（HttpChannelAdapter 等）。
 *
 * 设计要点：
 * - 本文件只定义契约，不关心 HTTP / WebSocket 传输
 * - Plugin 通过 registerChannel(adapter) 注册实现
 * - Gateway / Integration 按部署形态挂载具体 adapter
 */

export interface ChannelMessage {
  id: string;
  channel: string;
  senderId: string;
  senderName?: string;
  content: string;
  conversationId: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface ChannelReply {
  channel: string;
  conversationId: string;
  content: string;
  replyToId?: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelAdapter {
  name: string;
  start(handler: (msg: ChannelMessage) => Promise<void>): Promise<void>;
  send(reply: ChannelReply): Promise<void>;
  stop(): Promise<void>;
}
