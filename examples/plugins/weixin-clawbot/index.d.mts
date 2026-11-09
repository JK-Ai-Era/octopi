import type { ChannelMessage, ChannelReply } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/channel-types.js';

export interface WeixinOptions {
  /** Where to persist { baseurl, cursor } (chmod 600). bot_token lives in the Host credentials vault (api.secrets) unless no vault is injected (legacy standalone mode). Default: <api.stateDir>/weixin-clawbot-state.json */
  statePath?: string;
  /** Numeric pairing code shown on the phone, when the flow requires one. */
  verifyCode?: string;
  /** Pairing wait budget in ms (default 5 minutes). */
  loginTimeoutMs?: number;
  /** Extra trusted host names (beyond *.weixin.qq.com) for baseurl/redirect. */
  allowHosts?: string[];
}

export interface WeixinAdapterContext {
  channelName: string;
  apiKey: string;
  options: Record<string, unknown>;
}

export interface WeixinFetchDeps {
  /** Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  logger?: { log?(...args: unknown[]): void; error?(...args: unknown[]): void };
  now?: () => number;
  randomId?: () => string;
  /** Injectable timer (tests use setImmediate to keep loops turnable). */
  sleep?: (ms: number) => Promise<void>;
  /** P6-4: vault-backed secret namespace. With it, bot_token is stored in the vault; without it, inline in the state file (legacy mode). */
  secrets?: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<boolean> };
  /** P6-4: host-provided default state file path (api.stateDir). */
  defaultStatePath?: string;
}

export interface WeixinPairResult {
  status: 'already_paired' | 'channel_not_started' | 'pairing_in_progress' | 'awaiting_scan';
  qrContent?: string;
  message: string;
}

export interface WeixinChannelAdapter {
  name: string;
  /** Resolves when background pairing completes (null before pair()). */
  pairingPromise: Promise<void> | null;
  /** Health probe (P6-2): dormant (unpaired/not started) | degraded (poll failing) | running. */
  status(): { state: 'running' | 'dormant' | 'degraded' | 'retiring'; detail?: string };
  /** On-demand pairing: fetch a QR code and return immediately. */
  pair(): Promise<WeixinPairResult>;
  start(handler: (msg: ChannelMessage) => Promise<void>): Promise<void>;
  send(reply: ChannelReply): Promise<void>;
  stop(): Promise<void>;
}

/** Encode "2.4.6" → 132102 (iLink client version encoding). */
export function encodeClientVersion(version: string): number;

/** Random X-WECHAT-UIN header value (per-POST freshness requirement). */
export function makeWechatUin(): string;

/** Trusted-host rule for server-provided baseurl / redirect_host. */
export function isTrustedHost(urlString: string): boolean;

/** Parse and validate `options` from one channels entry. Fails loud. */
export function parseOptions(raw: unknown): Required<Pick<WeixinOptions, 'statePath' | 'loginTimeoutMs' | 'allowHosts'>> & Pick<WeixinOptions, 'verifyCode'>;

/**
 * Map one iLink inbound message to the Host ChannelMessage SPI.
 *
 * @param channelName - Host channel id (must equal adapter.name)
 * @param msg - WeixinMessage from getupdates
 * @param contextTokens - internal message_id → context_token store (never exposed)
 * @returns Host ChannelMessage, or null when not forwardable
 */
export function toChannelMessage(
  channelName: string,
  msg: Record<string, unknown>,
  contextTokens: { set(id: string, token: string): void },
): ChannelMessage | null;

/**
 * Build a ChannelAdapter over an injectable transport.
 *
 * @param ctx - PluginChannelFactoryContext from the Host
 * @param deps - fetch/logger/now/randomId — injectable for tests
 * @returns Host ChannelAdapter bound to ctx.channelName
 */
export function createWeixinChannelAdapter(ctx: WeixinAdapterContext, deps?: WeixinFetchDeps): WeixinChannelAdapter;

/**
 * One-shot deployment migration (P6-4): adopt a pre-P6-4 single-file state
 * (inline bot_token under ${OCTOPI_HOME}/credentials/) into the target state
 * path. Idempotent — a present target is never overwritten. The vault move of
 * the inline token happens on the next loadState()/saveState() cycle.
 *
 * @param targetStatePath - The new default state file path
 * @returns Whether a legacy state file was adopted
 */
export function migrateLegacyState(targetStatePath: string): boolean;

declare const plugin: {
  id: string;
  register(api: {
    registerChannel(
      id: string,
      factory: (context: WeixinAdapterContext) => Promise<WeixinChannelAdapter>,
    ): void;
    registerTool(
      definition: { name: string; description: string; parameters?: Record<string, unknown>; capabilities?: string[] },
      handler: () => Promise<unknown>,
    ): void;
    getContributionInstance(kind: 'channel', id: string): WeixinChannelAdapter;
    /** P6-4: per-plugin 0700 state directory (created on first use). */
    ensureStateDir(): Promise<string>;
    /** P6-4: per-plugin secret namespace over the Host credentials vault. */
    secrets: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string): Promise<void>;
      delete(key: string): Promise<boolean>;
    };
  }): void;
};
export default plugin;
