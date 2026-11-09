# weixin (WeChat ClawBot)

Channel contribution (`weixin`) for WeChat personal accounts, built on
Tencent's official **iLink Bot API** (the "ClawBot" plugin surface,
`ilinkai.weixin.qq.com`) — the sanctioned bot channel, not a client hook or
web-protocol hack. Zero runtime dependencies (Node.js 20.3+ — `AbortSignal.any` is used).

This plugin speaks the iLink protocol directly, like the feishu plugin speaks
the Feishu SDK: the official OpenClaw plugin is only a reference
implementation of the same protocol. No public callback URL is needed —
messages arrive over HTTP **long polling**.

## Prerequisites

1. WeChat **8.0.70+** (iOS) / 8.0.69+ (Android).
2. The **ClawBot plugin entry** must be visible in WeChat → Me → Settings →
   Plugins (it is rolled out in batches; no entry means your account is not
   in the rollout yet).
3. `plugins.loadPaths` includes this plugin's directory.

## Configure

```json
{
  "channels": [
    {
      "plugin": "weixin",
      "options": { }
    }
  ],
  "session": { "dmScope": "per-peer" }
}
```

| Option | Meaning |
|---|---|
| `options.statePath` | Where `{baseurl, get_updates_buf}` is persisted (chmod 600). Default `<api.stateDir>/weixin-clawbot-state.json` (P6-4). `bot_token` lives in the Host credentials vault via `api.secrets`; without vault injection (standalone use) the token stays inline in this file (legacy mode). |
| `options.verifyCode` | Numeric pairing code shown on the phone, when the flow asks for one. |
| `options.loginTimeoutMs` | Pairing wait budget (default 5 minutes). |
| `options.allowHosts` | Extra trusted host names beyond `*.weixin.qq.com` (server-provided `baseurl` / redirect hosts are validated). |

## First run (pairing)

The channel starts **dormant** when unpaired — it never blocks gateway
startup and never hammers the pairing endpoint. To pair, ask the agent to
call the **`weixin_pair`** tool (or call it from any client): it returns a QR
payload to scan with WeChat. After you confirm on the phone, the channel
activates automatically. If the QR expires, call `weixin_pair` again.

When a persisted pairing dies later (`errcode=-14`), the adapter re-prints a
QR in the gateway log and waits — with capped retries and exponential backoff,
so an unattended dead token degrades to idle instead of churning.

## Behavior notes

- **Text messages** only in v1: the text items of an inbound message are
  forwarded; media-only messages are skipped (logged), never given fabricated
  text. The bot's own messages are ignored (loop guard). **Group messages are
  skipped explicitly** — the in-group reply target is unverified and answering
  via DM to the sender would silently mis-deliver.
- Replies are sent as text messages carrying the inbound `context_token`
  (WeChat's reply-context requirement). That token is **time-boxed and
  sensitive** — it never leaves the adapter and is never persisted or logged;
  replies without a `replyToId` degrade to a plain send.
- Sessions: `conversationId` is the sender's iLink user id, so
  `dmScope: "per-peer"` behaves naturally. Group support (`group_id`) is
  preserved in `metadata.groupId` but not verified live yet.
- The polling loop has a client watchdog (90 s) and exponential backoff on
  network errors; instant empty responses are rate-padded so a misbehaving
  server cannot busy-loop the process.

## Security

- Since P6-4 `bot_token` lives in the Host credentials vault (AES-GCM, bound
  to this plugin via `api.secrets`); the state file only holds runtime state
  (`baseurl`, cursor) and is written with mode 600 inside the plugin's 0700
  stateDir. Deployments from earlier versions (single state file with the
  token inline under `credentials/`) migrate automatically on first start
  (`migrateLegacyState`); in standalone/legacy mode without vault injection
  the token stays inline in the state file — keep such files out of backups
  you do not control.
- `context_token`, `bot_token`, and full media URLs must never be logged; the
  adapter's log lines are pre-redacted accordingly.
- Server-provided hosts are validated against `https://*.weixin.qq.com` unless
  explicitly allow-listed.

## Known limits (v1)

- No media send/receive (images/files/video) yet — iLink media uses
  AES-128-ECB + CDN upload; planned behind the same SPI.
- Group messaging is unverified against live traffic.
- The ~24 h connection lifetime of the pairing is not yet auto-renewed; when
  the token dies the channel **goes dormant** (state cleared) and `weixin_pair`
  is the single re-pairing entry — no unattended re-login churn.

## Protocol sources

Contract derived from community documentation of the official iLink Bot API
(`lmwacn/weixin-clawbot-api` DOCS) cross-checked against the official plugin's
observed behavior (`@tencent-weixin/openclaw-weixin`). The protocol is
Tencent's official Bot API surface but has no official public field-level docs
— pin behavior with the tests in `tests/plugin-weixin-channel.test.ts` when
upgrading.
