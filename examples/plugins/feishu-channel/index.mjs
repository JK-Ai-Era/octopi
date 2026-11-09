/**
 * feishu — Channel contribution `feishu` (Feishu / Lark bot).
 *
 * Thin adapter over `@larksuiteoapi/node-sdk`'s `LarkChannel` (official SDK,
 * long connection / WebSocket transport — no public callback URL required).
 * The SDK owns transport, reconnect, event dedup, mention detection and the
 * policy gates (DM/group allowlists, mention requirement); this adapter only
 * maps its normalized message to the Host `ChannelMessage` SPI and maps
 * `ChannelReply` back to `send()`.
 *
 * Per-instance config lives in `channels[].options` (non-secret); the App
 * Secret always arrives via the credential channel (`apiKey`).
 */

const POLICY_MODES = new Set(['open', 'allowlist', 'pair', 'disabled']);
const POLICY_KEYS = ['dmMode', 'dmAllowlist', 'groupAllowlist', 'requireMention', 'respondToMentionAll'];
// Only real user-authored text is forwarded. The SDK normalizes media/cards
// into placeholder text (`![image](img_key)`, `[file]`, `[sticker]`, …);
// forwarding those would fabricate user input.
const FORWARDABLE_TYPES = new Set(['text', 'post']);

/** Parse and validate `options` from one channels entry. Fails loud. */
export function parseOptions(raw) {
  const opts = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const unknown = Object.keys(opts).filter((k) => k !== 'appId' && k !== 'policy');
  if (unknown.length > 0) {
    throw new Error(`feishu-channel: unknown option(s): ${unknown.join(', ')}`);
  }
  if (typeof opts.appId !== 'string' || opts.appId.length === 0) {
    throw new Error('feishu-channel: options.appId is required (Feishu app id, "cli_…")');
  }
  const policy = opts.policy ?? {};
  if (typeof policy !== 'object' || Array.isArray(policy) || policy === null) {
    throw new Error('feishu-channel: options.policy must be an object');
  }
  if (policy.dmMode === 'pair') {
    throw new Error(
      "feishu-channel: options.policy.dmMode 'pair' is not implemented by the SDK yet (it would be treated as open); use 'allowlist' with dmAllowlist instead",
    );
  }
  const unknownPolicy = Object.keys(policy).filter((k) => !POLICY_KEYS.includes(k));
  if (unknownPolicy.length > 0) {
    throw new Error(`feishu-channel: unknown policy key(s): ${unknownPolicy.join(', ')}`);
  }
  if (policy.dmMode !== undefined && !POLICY_MODES.has(policy.dmMode)) {
    throw new Error(`feishu-channel: options.policy.dmMode must be one of open|allowlist|pair|disabled (got "${policy.dmMode}")`);
  }
  for (const key of ['dmAllowlist', 'groupAllowlist']) {
    const list = policy[key];
    if (list !== undefined && (!Array.isArray(list) || list.some((id) => typeof id !== 'string' || id.length === 0))) {
      throw new Error(`feishu-channel: options.policy.${key} must be an array of non-empty strings`);
    }
  }
  for (const key of ['requireMention', 'respondToMentionAll']) {
    if (policy[key] !== undefined && typeof policy[key] !== 'boolean') {
      throw new Error(`feishu-channel: options.policy.${key} must be a boolean`);
    }
  }
  return {
    appId: opts.appId,
    policy: {
      // Group hygiene defaults: only respond in groups when @-mentioned.
      requireMention: true,
      respondToMentionAll: false,
      ...policy,
    },
  };
}

/**
 * Map one SDK NormalizedMessage to the Host ChannelMessage SPI.
 *
 * @param channelName - Host channel id (must equal adapter.name)
 * @param msg - SDK normalized message
 * @returns Host ChannelMessage, or null when the message carries no text
 *   (e.g. media-only) — such messages are skipped, never given fabricated text
 */
export function toChannelMessage(channelName, msg) {
  const rawType = typeof msg.rawContentType === 'string' ? msg.rawContentType : 'unknown';
  if (!FORWARDABLE_TYPES.has(rawType)) return null;
  const content = typeof msg.content === 'string' ? msg.content.trim() : '';
  if (!content) return null;
  return {
    id: msg.messageId,
    channel: channelName,
    senderId: msg.senderId,
    ...(msg.senderName ? { senderName: msg.senderName } : {}),
    content,
    conversationId: msg.chatId,
    timestamp: msg.createTime,
    metadata: {
      chatType: msg.chatType,
      ...(msg.threadId ? { threadId: msg.threadId } : {}),
      ...(msg.rootId ? { rootId: msg.rootId } : {}),
      ...(msg.replyToMessageId ? { replyToMessageId: msg.replyToMessageId } : {}),
    },
  };
}

/**
 * Build a ChannelAdapter over an SDK-like module (`createLarkChannel`).
 * The SDK module is injectable so tests can drive normalization without the
 * real dependency; the plugin entry lazily imports the real SDK.
 *
 * @param ctx - PluginChannelFactoryContext from the Host ({channelName, apiKey, options})
 * @param lark - Module exposing `createLarkChannel(opts)` (the real SDK or a test fake)
 * @returns Host ChannelAdapter bound to ctx.channelName
 */
export function createFeishuChannelAdapter(ctx, lark) {
  const options = parseOptions(ctx.options);
  const appSecret = typeof ctx.apiKey === 'string' ? ctx.apiKey : '';
  if (!appSecret) {
    throw new Error('feishu-channel: apiKey is required (Feishu App Secret; set channels[].apiKey, e.g. "${FEISHU_APP_SECRET}")');
  }
  if (typeof lark?.createLarkChannel !== 'function') {
    throw new Error('feishu-channel: SDK module does not expose createLarkChannel');
  }

  let channel = null;
  let handler = null;

  return {
    name: ctx.channelName,

    async start(handle) {
      if (channel) throw new Error(`feishu-channel: channel "${ctx.channelName}" already started`);
      handler = handle;
      const chan = lark.createLarkChannel({
        appId: options.appId,
        appSecret,
        transport: 'websocket',
        policy: options.policy,
        source: 'octopi-plugin:feishu',
      });
      channel = chan;
      chan.on('message', (msg) => {
        // Stale SDK callbacks after stop()/restart are ignored explicitly.
        if (channel !== chan) return;
        const mapped = toChannelMessage(ctx.channelName, msg);
        if (!mapped) {
          chan.logger?.debug?.(`skip non-text message ${msg.messageId} (type=${msg.rawContentType})`);
          return;
        }
        // Handler errors must never kill the SDK event chain / WS connection.
        Promise.resolve()
          .then(() => handler(mapped))
          .catch((error) => {
            chan.logger?.error?.(
              `inbound message ${msg.messageId} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      });
      chan.on('reject', (evt) => {
        if (channel !== chan) return;
        chan.logger?.info?.(`message ${evt.messageId} rejected by policy: ${evt.reason}`);
      });
      chan.on('error', (err) => {
        if (channel !== chan) return;
        chan.logger?.error?.(`lark channel error: ${err?.message ?? String(err)}`);
      });
      // Resolves only after the first WebSocket handshake succeeds (fail-loud).
      // On failure the Host never reaches `stop()` for this adapter (Gateway
      // only rolls back adapters that started), so clean up the SDK side here.
      try {
        await chan.connect();
      } catch (error) {
        channel = null;
        handler = null;
        await chan.disconnect().catch(() => { /* best-effort during failed start */ });
        throw error;
      }
    },

    async send(reply) {
      if (!channel) throw new Error('feishu-channel: channel not started');
      // markdown → post 消息（tag:'md' 原生渲染）；SDK 的 sendOneWithFallback
      // 在格式被拒时自动降级纯文本。
      await channel.send(
        reply.conversationId,
        { markdown: reply.content },
        reply.replyToId ? { replyTo: reply.replyToId } : undefined,
      );
    },

    async stop() {
      if (!channel) return;
      const current = channel;
      // Clear state only after disconnect succeeds; on failure the state is
      // retained so `stop()` can be retried and no second connection is ever
      // created over a live one.
      await current.disconnect();
      if (channel === current) {
        channel = null;
        handler = null;
      }
    },
  };
}

export default {
  id: 'feishu',
  register(api) {
    api.registerChannel('feishu', async (context) => {
      let lark;
      try {
        lark = await import('@larksuiteoapi/node-sdk');
      } catch (error) {
        throw new Error(
          `feishu-channel: "@larksuiteoapi/node-sdk" is not installed — run \`npm install\` in the plugin directory (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      return createFeishuChannelAdapter(context, lark);
    });
  },
};
