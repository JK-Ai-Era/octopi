/**
 * weixin — Channel contribution `weixin` (WeChat ClawBot / iLink Bot API).
 *
 * Talks to Tencent's official iLink Bot API directly over plain HTTPS
 * (`ilinkai.weixin.qq.com`), same pattern as the feishu plugin: a thin,
 * dependency-free adapter over the Host ChannelAdapter SPI. No OpenClaw
 * involvement — the iLink protocol is WeChat's official Bot API surface;
 * the official OpenClaw plugin is only a reference implementation.
 *
 * Contract highlights (see README for sources):
 * - Login: POST /ilink/bot/get_bot_qrcode → scan → GET /ilink/bot/get_qrcode_status
 *   (8 states) → { bot_token, baseurl, ilink_bot_id, ilink_user_id }.
 * - Receive: POST {baseurl}/ilink/bot/getupdates (long polling) with a
 *   persisted cursor `get_updates_buf`; `errcode=-14` means the token died.
 * - Send: POST {baseurl}/ilink/bot/sendmessage carrying the inbound message's
 *   `context_token` (sensitive + time-boxed).
 *
 * Security: `context_token` never leaves this adapter — the SPI only sees
 * message ids. `bot_token` and the cursor are persisted to a chmod 600 state
 * file. Nothing sensitive is logged.
 */

import { mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

const CHANNEL_VERSION = '2.4.6';
const BOT_AGENT = 'octopi-plugin-weixin/0.1.0';
const LOGIN_HOST = 'https://ilinkai.weixin.qq.com';
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Encode "2.4.6" → 132102 (iLink client version encoding). */
export function encodeClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map((v) => Number.parseInt(v, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

/** Random X-WECHAT-UIN header value (per-POST freshness requirement). */
export function makeWechatUin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
}

/** Trusted-host rule for server-provided baseurl / redirect_host (HTTPS + weixin.qq.com). */
export function isTrustedHost(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && (url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com'));
}

const OPTION_KEYS = ['statePath', 'verifyCode', 'loginTimeoutMs', 'allowHosts'];

/** Parse and validate `options` from one channels entry. Fails loud. */
export function parseOptions(raw, defaultStatePath = join(process.env.OCTOPI_HOME ?? join(homedir(), '.octopi'), 'credentials', 'weixin-clawbot-state.json')) {
  const opts = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const unknown = Object.keys(opts).filter((k) => !OPTION_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new Error(`weixin-channel: unknown option(s): ${unknown.join(', ')}`);
  }
  if (opts.statePath !== undefined && (typeof opts.statePath !== 'string' || opts.statePath.length === 0)) {
    throw new Error('weixin-channel: options.statePath must be a non-empty string');
  }
  if (opts.verifyCode !== undefined && (typeof opts.verifyCode !== 'string' || !/^\d+$/.test(opts.verifyCode))) {
    throw new Error('weixin-channel: options.verifyCode must be a numeric string (the pairing code shown on the phone)');
  }
  if (opts.loginTimeoutMs !== undefined && (typeof opts.loginTimeoutMs !== 'number' || opts.loginTimeoutMs <= 0)) {
    throw new Error('weixin-channel: options.loginTimeoutMs must be a positive number');
  }
  if (opts.allowHosts !== undefined) {
    // May widen trust beyond *.weixin.qq.com; https is still enforced at use
    // time by isAcceptableHost (review #14).
    if (!Array.isArray(opts.allowHosts) || opts.allowHosts.some((h) => typeof h !== 'string' || h.length === 0)) {
      throw new Error('weixin-channel: options.allowHosts must be an array of non-empty host names');
    }
  }
  return {
    statePath: opts.statePath ?? defaultStatePath,
    verifyCode: opts.verifyCode,
    loginTimeoutMs: opts.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    allowHosts: opts.allowHosts ?? [],
  };
}

/**
 * Map one iLink inbound message to the Host ChannelMessage SPI.
 *
 * @param channelName - Host channel id (must equal adapter.name)
 * @param msg - WeixinMessage from getupdates
 * @param contextTokens - internal message_id → context_token sink ({set}; never exposed)
 * @returns Host ChannelMessage, or null when the message is not forwardable
 *   (bot's own message, non-text-only content) — never fabricated
 */
export function toChannelMessage(channelName, msg, contextTokens) {
  if (msg.message_type !== 1) return null; // 2 = the bot's own message (loop guard)
  // Group messaging is unverified against live traffic — the reply target for
  // group messages is ambiguous (sender vs chat), so v1 skips them explicitly
  // instead of silently mis-delivering a DM to the sender (review #23).
  if (msg.group_id) return null;
  const items = Array.isArray(msg.item_list) ? msg.item_list : [];
  const texts = items.filter((it) => it.type === 1 && typeof it.text_item?.text === 'string').map((it) => it.text_item.text);
  const content = texts.join('\n').trim();
  if (!content) return null; // media-only / empty — skipped, never given placeholder text
  if (typeof msg.context_token === 'string' && msg.context_token.length > 0 && msg.message_id !== undefined) {
    contextTokens.set(String(msg.message_id), msg.context_token);
  }
  return {
    id: String(msg.message_id ?? msg.client_id ?? ''),
    channel: channelName,
    senderId: String(msg.from_user_id ?? ''),
    content,
    // from_user_id doubles as the reply target (sendmessage.to_user_id), which
    // keeps ChannelReply.conversationId directly actionable; the iLink
    // session id is preserved in metadata for conversation-scoped tooling.
    conversationId: String(msg.from_user_id ?? ''),
    timestamp: typeof msg.create_time_ms === 'number' ? msg.create_time_ms : Date.now(),
    metadata: {
      ...(msg.session_id ? { sessionId: msg.session_id } : {}),
      ...(msg.group_id ? { groupId: msg.group_id } : {}),
    },
  };
}

/**
 * Build a ChannelAdapter over an injectable transport.
 *
 * @param ctx - PluginChannelFactoryContext from the Host ({channelName, apiKey, options})
 * @param deps - { fetch, logger?, now?, randomId? } — injectable for tests
 * @returns Host ChannelAdapter bound to ctx.channelName
 */
export function createWeixinChannelAdapter(ctx, deps) {
  const options = parseOptions(ctx.options, deps?.defaultStatePath);
  const secrets = deps?.secrets ?? null;
  const doFetch = deps?.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('weixin-channel: no fetch implementation available (Node.js 18+ required)');
  }
  const log = deps?.logger ?? console;
  const now = deps?.now ?? (() => Date.now());
  const randomId = deps?.randomId ?? (() => randomUUID());
  /**
   * Abort-aware sleep: the default implementation sleeps in slices so
   * stop()/shutdown is never parked in a long backoff (review #2). Tests may
   * inject an instant timer instead.
   */
  const sleep = deps?.sleep ?? (async (ms, signal) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (signal?.aborted) return;
      await new Promise((r) => setTimeout(r, Math.min(250, deadline - Date.now())));
    }
  });

  /** @type {Map<string, string>} message_id → context_token (in-memory only) */
  const contextTokens = new Map();
  const CONTEXT_TOKEN_CAP = 1000;

  let handler = null;
  let running = false;
  let pairingActive = false;
  let pollAbort = null;
  let pollLoopPromise = null;
  /** Consecutive poll failures and last error — surfaced by status() (P6-2). */
  let pollFailures = 0;
  let lastPollError = null;
  /** Server-adaptive long-poll timeout hint (review #16). */
  let pollHintMs = undefined;
  /** @type {{bot_token: string, baseurl: string, ilink_bot_id?: string, ilink_user_id?: string, get_updates_buf?: string} | null} */
  let session = null;

  // ── state persistence ──
  // Runtime state (baseurl, ids, cursor) lives in the state file (chmod 600).
  // bot_token lives in the Host credentials vault via `deps.secrets`
  // (api.secrets); without secrets injection the token stays in the file
  // (legacy single-file mode, e.g. standalone testing).
  /** Token currently persisted in the vault — skipped on cursor-only saves. */
  let persistedToken = null;
  /**
   * Vault degradation reported once per process (review T3a follow-up): a
   * missing OCTOPI_CREDENTIALS_KEY makes every vault write fail, which used
   * to log on every state save and bury the log. One loud report per
   * process, then stay quiet — the degraded mode itself is unchanged.
   */
  let vaultDegradationReported = false;
  function reportVaultDegraded(direction, error) {
    if (vaultDegradationReported) return;
    vaultDegradationReported = true;
    log.error(
      `weixin: vault ${direction} failed (${String(error)}); ` +
        'bot_token stays in the state file (0600). ' +
        'Set OCTOPI_CREDENTIALS_KEY or OCTOPI_CREDENTIALS_KEY_FILE to enable vault storage. ' +
        'This message is reported once per process.',
    );
  }
  /** Trusted-host gate used everywhere a server-provided URL is adopted. */
  function isAcceptableHost(urlString) {
    let url;
    try {
      url = new URL(String(urlString));
    } catch {
      return false;
    }
    if (url.protocol !== 'https:') return false;
    return isTrustedHost(url.toString()) || options.allowHosts.includes(url.hostname);
  }
  /** Adopt server-provided credentials; validates BOTH token and host (review #6). */
  async function adoptCredentials(data, fallbackBuf) {
    if (!data || typeof data.bot_token !== 'string' || data.bot_token.length === 0) {
      throw new Error('weixin-channel: pairing response missing bot_token');
    }
    if (!isAcceptableHost(data.baseurl)) {
      throw new Error('weixin-channel: refusing untrusted baseurl from pairing/state');
    }
    session = {
      bot_token: data.bot_token,
      baseurl: String(data.baseurl).replace(/\/+$/, ''),
      ilink_bot_id: data.ilink_bot_id,
      ilink_user_id: data.ilink_user_id,
      get_updates_buf:
        typeof fallbackBuf === 'string' ? fallbackBuf
          : typeof data.get_updates_buf === 'string' ? data.get_updates_buf
            : '',
    };
    await saveState();
  }
  async function loadState() {
    try {
      const parsed = JSON.parse(readFileSync(options.statePath, 'utf8'));
      // Legacy single-file state carries bot_token inline; vault state keeps
      // it in the secrets namespace (the migrate path below adopts and rewrites).
      const fileToken = typeof parsed?.bot_token === 'string' ? parsed.bot_token : null;
      let vaultToken = null;
      if (secrets) {
        try {
          vaultToken = await secrets.get('bot_token');
        } catch (error) {
          // Vault unreadable (e.g. master key not configured): surface the real
          // cause instead of pretending "not paired", and fall back to an
          // inline token so the channel keeps working.
          reportVaultDegraded('read', error);
        }
      }
      const token = vaultToken ?? fileToken;
      if (parsed && typeof token === 'string' && typeof parsed.baseurl === 'string') {
        // A tampered state file must never point the bot token at an
        // arbitrary host — validate before trusting (review #6/#24).
        await adoptCredentials({ ...parsed, bot_token: token });
        return session;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('weixin-channel:')) throw error;
      /* missing/corrupt state → fresh login */
    }
    return null;
  }
  async function saveState() {
    if (!session) return;
    const { bot_token: token, ...runtime } = session;
    // Vault first: only after the vault has accepted the token may the file
    // drop it. If the vault write fails, the token stays inline (legacy form)
    // and the failure is logged loudly — never a silent token loss.
    if (secrets && token !== persistedToken) {
      try {
        await secrets.set('bot_token', token);
        persistedToken = token;
      } catch (error) {
        reportVaultDegraded('write', error);
      }
    }
    const vaulted = Boolean(secrets) && persistedToken === token;
    mkdirSync(dirname(options.statePath), { recursive: true, mode: 0o700 });
    writeFileSync(
      options.statePath,
      `${JSON.stringify(vaulted ? runtime : session, null, 2)}\n`,
      { mode: 0o600 },
    );
    try {
      chmodSync(options.statePath, 0o600);
    } catch {
      /* best effort on platforms without POSIX modes */
    }
  }

  // ── HTTP plumbing ──
  function businessHeaders(token, method) {
    // GET uses only the two app headers (protocol §3); POST adds auth metadata.
    return {
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': String(encodeClientVersion(CHANNEL_VERSION)),
      ...(method === 'GET'
        ? {}
        : {
            'Content-Type': 'application/json',
            AuthorizationType: 'ilink_bot_token',
            'X-WECHAT-UIN': makeWechatUin(),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          }),
    };
  }
  function baseInfo() {
    return { base_info: { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT } };
  }
  /** Normalize a server-provided base URL and join a path (no `//path` drift). */
  function apiUrl(base, path) {
    return new URL(path, `${String(base).replace(/\/+$/, '')}/`).toString();
  }
  async function requestJson(method, url, body, { token, signal, timeoutMs = 15_000 } = {}) {
    // Every call gets a timeout; the external signal (shutdown) composes with it
    // so stop() is never parked behind a hung request (review #3).
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const res = await doFetch(url, {
      method,
      headers: businessHeaders(token, method),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: combined,
    });
    if (!res.ok) throw new Error(`weixin-channel: HTTP ${res.status} from ${new URL(url).pathname}`);
    return res.json();
  }
  function checkBusiness(url, data) {
    // Real iLink responses often omit `ret` entirely on success — the
    // reference client (lmwacn/weixin-clawbot-api SDK) treats ret===undefined
    // as success and only fails on a present, non-zero ret. Absent fields must
    // never be read as failure (that false-negative stalled the poll loop).
    if (data.ret !== undefined && data.ret !== 0) {
      throw new Error(`weixin-channel: ${new URL(url).pathname} failed: ret=${data.ret} errcode=${data.errcode ?? '?'} errmsg="${String(data.errmsg ?? '').slice(0, 200)}"`);
    }
    // errcode-only failure envelopes are also real (that is why -14 is special
    // -cased in the poll loop) — a present non-zero errcode is a failure (review #9).
    if (data.errcode !== undefined && data.errcode !== 0) {
      throw new Error(`weixin-channel: ${new URL(url).pathname} failed: errcode=${data.errcode} errmsg="${String(data.errmsg ?? '').slice(0, 200)}"`);
    }
    return data;
  }

  // ── login (scan-to-pair; the QR payload is printed, never logged as secret) ──
  /** Fetch a fresh pairing QR code without waiting for confirmation. */
  async function getQrCode(signal) {
    const qrcodeRes = await requestJson(
      'POST',
      apiUrl(LOGIN_HOST, 'ilink/bot/get_bot_qrcode?bot_type=3'),
      { local_token_list: session?.bot_token ? [session.bot_token] : [] },
      { token: null, signal },
    );
    checkBusiness(apiUrl(LOGIN_HOST, 'ilink/bot/get_bot_qrcode'), qrcodeRes);
    return { qr: qrcodeRes.qrcode, qrContent: qrcodeRes.qrcode_img_content ?? qrcodeRes.qrcode };
  }

  async function login(signal) {
    const deadline = now() + options.loginTimeoutMs;
    let pendingVerify = options.verifyCode;
    let qrAttempts = 0;
    for (;;) {
      qrAttempts += 1;
      if (qrAttempts > 5) {
        const err = new Error('weixin-channel: pairing QR expired 5 times without confirmation — giving up (call the weixin_pair tool to try again)');
        err.code = 'PAIRING_EXHAUSTED';
        throw err;
      }
      const { qr, qrContent } = await getQrCode(signal);
      // qrcode_img_content is a scan target (QR text/URL), not a credential.
      log.log?.(`[weixin] scan to pair (QR content): ${qrContent}`);
      log.log?.('[weixin] waiting for confirmation in WeChat…');
      const outcome = await pollQrStatusOn(LOGIN_HOST, qr, pendingVerify, deadline, signal);
      if (outcome === 'paired') return;
      // 'expired' → back off before re-fetching a QR (request-storm guard).
      await sleep(3000);
    }
  }
  async function pollQrStatusOn(host, qr, verifyCode, deadline, signal) {
    if (!isAcceptableHost(host)) throw new Error('weixin-channel: refusing untrusted redirect_host');
    const url = String(host).replace(/\/+$/, '');
    let pendingVerify = verifyCode;
    while (now() < deadline) {
      const statusUrl = `${apiUrl(url, 'ilink/bot/get_qrcode_status')}?qrcode=${encodeURIComponent(qr)}` +
        (pendingVerify ? `&verify_code=${encodeURIComponent(pendingVerify)}` : '');
      const st = await requestJson('GET', statusUrl, undefined, { signal, timeoutMs: 40_000 });
      switch (st.status) {
        case 'wait':
        case 'scaned':
          break;
        case 'need_verifycode': {
          if (!pendingVerify) {
            throw new Error('weixin-channel: pairing requires a numeric verify code (shown on the phone) — set options.verifyCode and retry');
          }
          break;
        }
        case 'verify_code_blocked':
          throw new Error('weixin-channel: pairing code rejected too many times; start over (remove options.verifyCode)');
        case 'expired':
          // Signal the caller to fetch a fresh QR (bounded by the shared deadline).
          return 'expired';
        case 'scaned_but_redirect': {
          if (!isAcceptableHost(st.redirect_host)) {
            throw new Error('weixin-channel: refusing untrusted redirect_host from login flow');
          }
          return pollQrStatusOn(st.redirect_host, qr, pendingVerify, deadline, signal);
        }
        case 'binded_redirect': {
          // Already bound on this client: reuse existing credentials.
          if (st.bot_token && st.baseurl) {
            await adoptCredentials(st, session?.get_updates_buf);
            log.log?.('[weixin] paired (existing binding)');
            return 'paired';
          }
          throw new Error('weixin-channel: binded_redirect without credentials; clear the state file and log in again');
        }
        case 'confirmed': {
          await adoptCredentials(st, session?.get_updates_buf);
          log.log?.('[weixin] paired');
          return 'paired';
        }
        default:
          throw new Error(`weixin-channel: unexpected qr status "${st.status}"`);
      }
      await sleep(1500);
    }
    const timeoutErr = new Error('weixin-channel: login timed out waiting for scan/confirmation');
    timeoutErr.code = 'PAIRING_EXHAUSTED';
    throw timeoutErr;
  }

  async function notifyConnection(path, signal) {
    if (!session) return; // dormant (unpaired) — nothing to notify
    try {
      const data = await requestJson(
        'POST',
        apiUrl(session.baseurl, `ilink/bot/msg/${path}`),
        baseInfo(),
        // notifystop needs its own short timeout (protocol §6); never block shutdown.
        { token: session.bot_token, signal, timeoutMs: path === 'notifystop' ? 5_000 : 15_000 },
      );
      checkBusiness(apiUrl(session.baseurl, `ilink/bot/msg/${path}`), data);
    } catch (error) {
      // stop notification must never block shutdown (contract); start failures are loud.
      if (path === 'notifystop') {
        log.error?.(`weixin-channel: notifystop failed (ignored): ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      throw error;
    }
  }

  // ── receive loop ──
  function rememberContextToken(messageId, token) {
    contextTokens.set(String(messageId), token);
    if (contextTokens.size > CONTEXT_TOKEN_CAP) {
      contextTokens.delete(contextTokens.keys().next().value);
    }
  }
  async function pollOnce(signal) {
    // Watchdog timeout adapts to the server hint (review #16); requestJson
    // composes it with the external (shutdown) signal.
    const pollTimeoutMs = Math.min(typeof pollHintMs === 'number' ? pollHintMs : 40_000, 90_000);
    const data = await requestJson(
      'POST',
      apiUrl(session.baseurl, 'ilink/bot/getupdates'),
      { get_updates_buf: session.get_updates_buf ?? '', ...baseInfo() },
      { token: session.bot_token, signal, timeoutMs: pollTimeoutMs },
    );
    if (data.errcode === -14) {
      const err = new Error('weixin-channel: token expired (errcode=-14)');
      err.code = 'TOKEN_EXPIRED';
      throw err;
    }
    checkBusiness(apiUrl(session.baseurl, 'ilink/bot/getupdates'), data);
    const msgs = Array.isArray(data.msgs) ? data.msgs : [];
    for (const msg of msgs) {
      const mapped = toChannelMessage(ctx.channelName, msg, { set: (id, token) => rememberContextToken(id, token) });
      if (!mapped) continue;
      // Dispatch detached (fire-and-forget), like the feishu/http adapters:
      // a long agent run must not block receiving, and the cursor advances on
      // acceptance (at-most-once on crash — documented trade-off, review #10).
      void Promise.resolve()
        .then(() => handler(mapped))
        .catch((error) => {
          // Handler errors must never kill the poll loop.
          log.error?.(`weixin-channel: inbound ${mapped.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
    if (typeof data.get_updates_buf === 'string') {
      session.get_updates_buf = data.get_updates_buf;
      await saveState();
    } else if (msgs.length > 0) {
      // The same "absent field" envelope class as the ret bug: without a new
      // cursor this batch would re-deliver forever (review #7). Fail loud and
      // let the backoff keep it from churning.
      throw new Error('weixin-channel: getupdates returned messages without a new cursor (get_updates_buf missing)');
    }
    pollHintMs = typeof data.longpolling_timeout_ms === 'number' ? data.longpolling_timeout_ms : undefined;
    return;
  }
  async function pollLoop() {
    let backoffMs = 1000;
    while (running) {
      const startedAt = now();
      try {
        await pollOnce(pollAbort.signal);
        backoffMs = 1000;
        pollFailures = 0;
        lastPollError = null;
        // Server normally holds the call (long polling). An instant return is
        // abnormal — pad to a 500ms floor so a misbehaving server cannot busy-loop us.
        const elapsed = now() - startedAt;
        if (running && elapsed < 500) await sleep(500 - elapsed, pollAbort.signal);
      } catch (error) {
        if (!running || pollAbort.signal.aborted) break;
        pollFailures += 1;
        lastPollError = error instanceof Error ? error.message : String(error);
        if (error.code === 'TOKEN_EXPIRED') {
          log.error?.('weixin-channel: token expired — re-pairing (scan the QR that appears in the log)');
          try {
            await login(pollAbort.signal);
            await notifyConnection('notifystart', pollAbort.signal);
            backoffMs = 1000;
          } catch (reloginError) {
            log.error?.(`weixin-channel: re-pairing failed: ${reloginError instanceof Error ? reloginError.message : String(reloginError)}`);
            if (reloginError.code === 'PAIRING_EXHAUSTED') {
              // Nobody scanned — drop the dead pairing and go dormant so the
              // weixin_pair tool is the single recovery entry (review #8).
              // No infinite re-login churn on an unattended dead token.
              log.error?.('[weixin] pairing not completed — channel dormant; call the weixin_pair tool to pair again');
              session = null;
              // Vault mode: the dead token lives in the secrets namespace —
              // clear it so the next loadState() cannot re-adopt it. Steps are
              // independent: one failure must not keep the dead token alive.
              if (secrets) {
                try {
                  await secrets.delete('bot_token');
                } catch (error) {
                  log.error(`weixin: vault delete failed during parking (${String(error)}); dead token may re-adopt on restart`);
                }
                persistedToken = null;
              }
              try {
                unlinkSync(options.statePath);
              } catch { /* already gone */ }
              break;
            }
            // Transient re-login failure (network): back off and retry.
            await sleep(backoffMs, pollAbort.signal);
            backoffMs = Math.min(backoffMs * 2, 300_000);
          }
          continue;
        }
        log.error?.(`weixin-channel: poll error (retrying in ${backoffMs}ms): ${error instanceof Error ? error.message : String(error)}`);
        await sleep(backoffMs, pollAbort.signal);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  }

  return {
    name: ctx.channelName,
    /** Resolves when background pairing completes (or null if not started). For testing. */
    pairingPromise: null,

    /**
     * Health probe (P6-2): truthful state from the adapter's own lifecycle.
     * dormant = unpaired or dead-token parking; degraded = backing off after
     * poll failures; running = paired with a healthy poll loop.
     */
    status() {
      if (!running) return { state: 'dormant', detail: 'not started' };
      if (pairingActive) return { state: 'dormant', detail: 'pairing in progress — scan the QR code' };
      if (!session) return { state: 'dormant', detail: 'not paired — call the weixin_pair tool to pair' };
      if (pollFailures > 0) {
        return { state: 'degraded', detail: `poll failing (${pollFailures} in a row): ${lastPollError ?? 'unknown error'}` };
      }
      return { state: 'running' };
    },

    /**
     * On-demand pairing: fetch a QR code and return it immediately.
     * Confirmation continues in the background; once paired, the poll loop starts.
     */
    async pair() {
      if (session) {
        return { status: 'already_paired', message: 'WeChat is already paired and active.' };
      }
      if (!running) {
        return { status: 'channel_not_started', message: 'weixin channel is not started — restart the gateway.' };
      }
      if (pairingActive) {
        return { status: 'pairing_in_progress', message: 'A pairing QR is already awaiting a scan — check the previous qrContent (or the gateway log) and scan it.' };
      }
      // Claim the guard synchronously, before the first await — tools run with
      // parallel execution, so a guard set after await() races (review #1).
      pairingActive = true;
      let qr;
      let qrContent;
      try {
        ({ qr, qrContent } = await getQrCode(pollAbort.signal));
      } catch (error) {
        pairingActive = false;
        throw error;
      }
      log.log?.(`[weixin] scan to pair (QR content): ${qrContent}`);
      // Background: wait for this QR to be confirmed, then activate polling.
      this.pairingPromise = (async () => {
        try {
          const deadline = now() + options.loginTimeoutMs;
          const outcome = await pollQrStatusOn(LOGIN_HOST, qr, options.verifyCode, deadline, pollAbort.signal);
          if (outcome === 'paired') {
            await notifyConnection('notifystart', pollAbort.signal);
            pollLoopPromise = pollLoop();
          } else {
            log.error?.('[weixin] pairing QR expired before confirmation — call the weixin_pair tool again for a fresh code');
          }
        } catch (error) {
          if (pollAbort.signal.aborted) return;
          log.error?.(`weixin-channel: pairing failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          pairingActive = false;
        }
      })();
      return {
        status: 'awaiting_scan',
        qrContent,
        message: 'Scan this QR code with WeChat to pair. If it expires, call weixin_pair again for a fresh code.',
      };
    },

    async start(handle) {
      if (running) throw new Error(`weixin-channel: channel "${ctx.channelName}" already started`);
      handler = handle;
      session = await loadState();
      pollAbort = new AbortController();
      running = true;
      if (session) {
        // Already paired — connect and start polling immediately.
        try {
          await notifyConnection('notifystart', pollAbort.signal);
        } catch (error) {
          running = false;
          throw error;
        }
        pollLoopPromise = pollLoop();
      }
      // Not paired: stay dormant. User calls weixin_pair tool to generate a QR code.
    },

    async send(reply) {
      if (!running) throw new Error('weixin-channel: channel not started');
      if (!session) throw new Error('weixin-channel: WeChat not paired — call the weixin_pair tool to generate a pairing QR code');
      const contextToken = reply.replyToId ? contextTokens.get(String(reply.replyToId)) : undefined;
      const toUserId = reply.conversationId;
      if (typeof toUserId !== 'string' || toUserId.length === 0) {
        throw new Error('weixin-channel: cannot resolve to_user_id for reply (empty conversationId)');
      }
      const msg = {
        to_user_id: toUserId,
        from_user_id: '',
        client_id: randomId(),
        message_type: 2,
        message_state: 2,
        ...(contextToken ? { context_token: contextToken } : {}),
        item_list: [{ type: 1, text_item: { text: reply.content } }],
      };
      const sendUrl = apiUrl(session.baseurl, 'ilink/bot/sendmessage');
      checkBusiness(sendUrl, await requestJson('POST', sendUrl, { msg, ...baseInfo() }, { token: session.bot_token }));
    },

    async stop() {
      if (!running) return;
      running = false;
      pollAbort?.abort();
      await this.pairingPromise?.catch(() => {});
      await pollLoopPromise?.catch(() => {});
      await notifyConnection('notifystop');
      handler = null;
    },
  };
}

/**
 * One-shot deployment migration (P6-4): earlier versions kept the single-file
 * state (bot_token inline) under `${OCTOPI_HOME}/credentials/`. When the new
 * state location is still empty and the legacy file exists, adopt it — the
 * first loadState() then moves bot_token into the credentials vault and
 * rewrites the file with runtime state only.
 *
 * @param targetStatePath - New state file location
 * @returns Whether a legacy state file was migrated
 */
export function migrateLegacyState(targetStatePath) {
  if (existsSync(targetStatePath)) return false;
  const legacyPath = join(
    process.env.OCTOPI_HOME ?? join(homedir(), '.octopi'),
    'credentials',
    'weixin-clawbot-state.json',
  );
  if (legacyPath === targetStatePath) return false;
  let raw;
  try {
    raw = readFileSync(legacyPath, 'utf8');
  } catch {
    return false; // no legacy state to migrate
  }
  mkdirSync(dirname(targetStatePath), { recursive: true, mode: 0o700 });
  writeFileSync(targetStatePath, raw, { mode: 0o600 });
  try {
    chmodSync(targetStatePath, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
  unlinkSync(legacyPath);
  return true;
}

export default {
  id: 'weixin',
  register(api) {
    api.registerChannel('weixin', async (context) => {
      // Host storage primitives (P6-4): runtime state lives under the
      // plugin's own 0700 stateDir; bot_token lives in the credentials vault
      // (api.secrets). Legacy single-file deployments migrate on first use.
      const stateDir = await api.ensureStateDir();
      const defaultStatePath = join(stateDir, 'weixin-clawbot-state.json');
      // Adopt the pre-P6-4 default location only when the operator did not
      // explicitly configure statePath — a configured path is their choice
      // and must never be moved away from under them.
      if (typeof context.options?.statePath !== 'string') {
        migrateLegacyState(defaultStatePath);
      }
      return createWeixinChannelAdapter(context, {
        secrets: api.secrets,
        defaultStatePath,
      });
    });

    api.registerTool(
      {
        name: 'weixin_pair',
        description:
          'Generate a WeChat pairing QR code for the weixin channel. Call this when you need to pair WeChat. ' +
          'Returns a QR code URL (qrContent) — show it to the user so they can scan it with WeChat. ' +
          'After scanning, the weixin channel activates automatically. If the QR expires, call again.',
        parameters: {},
        capabilities: ['egress'],
      },
      async () => {
        // Host instance registry (not a module closure): survives multiple
        // factory calls and reports real lifecycle state after retirement.
        const adapter = api.getContributionInstance('channel', 'weixin');
        return adapter.pair();
      },
    );
  },
};
