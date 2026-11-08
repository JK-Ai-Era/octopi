import type { ChannelMessage, ChannelReply } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/channel-types.js';
import type { PluginApi } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/api.js';

export interface FeishuPolicyOptions {
  dmMode?: 'open' | 'allowlist' | 'disabled';
  dmAllowlist?: string[];
  groupAllowlist?: string[];
  requireMention?: boolean;
  respondToMentionAll?: boolean;
}

export interface FeishuOptions {
  appId: string;
  policy?: FeishuPolicyOptions;
}

export interface FeishuAdapterContext {
  channelName: string;
  apiKey: string;
  options: Record<string, unknown>;
}

/** Structural view of the `@larksuiteoapi/node-sdk` surface the adapter uses. */
export interface FeishuSdkLike {
  createLarkChannel(opts: Record<string, unknown>): unknown;
}

export interface FeishuChannelAdapter {
  name: string;
  start(handler: (msg: ChannelMessage) => Promise<void>): Promise<void>;
  send(reply: ChannelReply): Promise<void>;
  stop(): Promise<void>;
}

/** Parse and validate `options` from one channels entry. Fails loud. */
export function parseOptions(raw: unknown): { appId: string; policy: Required<Pick<FeishuPolicyOptions, 'requireMention' | 'respondToMentionAll'>> & FeishuPolicyOptions };

/**
 * Map one SDK normalized message to the Host ChannelMessage SPI.
 *
 * @param channelName - Host channel id (must equal adapter.name)
 * @param msg - SDK normalized message
 * @returns Host ChannelMessage, or null when the message carries no text
 */
export function toChannelMessage(channelName: string, msg: Record<string, unknown>): ChannelMessage | null;

/**
 * Build a ChannelAdapter over an SDK-like module.
 *
 * @param ctx - PluginChannelFactoryContext from the Host
 * @param lark - Module exposing `createLarkChannel(opts)` (real SDK or test fake)
 * @returns Host ChannelAdapter bound to ctx.channelName
 */
export function createFeishuChannelAdapter(ctx: FeishuAdapterContext, lark: FeishuSdkLike): FeishuChannelAdapter;

declare const plugin: { id: string; register(api: PluginApi): void };
export default plugin;
