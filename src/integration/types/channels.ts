/**
 * Channel Adapter — 消息渠道适配器类型
 *
 * Integration 层类型。定义外部消息渠道的接入协议。
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
