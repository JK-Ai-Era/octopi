# feishu

Channel contribution (`feishu`) for Feishu (Lark) bots, built on the official
`@larksuiteoapi/node-sdk` **long connection** (WebSocket) transport — no public
callback URL, domain, or TLS certificate is required; the gateway only needs
outbound access to Feishu.

The SDK owns transport, reconnect, event dedup, mention detection and the
policy gates (DM/group allowlists, mention requirement). This plugin is a thin
adapter that maps the SDK's normalized message to the Host `ChannelMessage` SPI
and maps `ChannelReply` back to `send()`.

## Install

```sh
cd examples/plugins/feishu-channel
npm install
```

Point `plugins.loadPaths` at the `examples/plugins` directory (or copy this
folder into your plugin load path).

## Feishu open platform setup

1. Create an **enterprise self-built app** at <https://open.feishu.cn> and note
   the **App ID** (`cli_…`) and **App Secret**.
2. Enable **bot capability** for the app.
3. Grant message permissions, at least `im:message` (read) and
   `im:message:send_as_bot` (send), plus `im:message.group_at_msg:readonly` /
   `im:message.p2p_msg:readonly` as needed.
4. Under **Event Subscription**, add `im.message.receive_v1` and set the
   subscription mode to **长连接 / long connection** (no callback URL needed).
5. **Create a version and publish it** — permissions and event subscriptions do
   not take effect until the version is published.

## Configure

```json
{
  "plugins": { "loadPaths": ["~/.octopi/plugins"] },
  "channels": [
    {
      "plugin": "feishu",
      "apiKey": "${FEISHU_APP_SECRET}",
      "options": {
        "appId": "cli_xxxxxxxxxxxxxxxx",
        "policy": {
          "dmMode": "open",
          "requireMention": true
        }
      }
    }
  ],
  "session": { "dmScope": "per-conversation" }
}
```

| Field | Where | Meaning |
|---|---|---|
| `apiKey` | `channels[].apiKey` | Feishu **App Secret**. Use a `${ENV_VAR}` reference — secrets never belong in `options`. |
| `options.appId` | required | Feishu App ID (`cli_…`). |
| `options.policy.dmMode` | `open` \| `allowlist` \| `disabled` | Who may DM the bot. Default `open`. (`pair` is rejected: the SDK does not implement it yet and would treat it as open.) |
| `options.policy.dmAllowlist` | `string[]` | Sender open ids, used when `dmMode` is `allowlist`/`pair`. |
| `options.policy.groupAllowlist` | `string[]` | Chat ids (`oc_…`) the bot responds in. Unset = all groups it is added to. |
| `options.policy.requireMention` | boolean | Groups: respond only when @-mentioned. Default `true`. |
| `options.policy.respondToMentionAll` | boolean | Respond to @all. Default `false` (spams). |

**Security note.** A Feishu channel lets whoever can message the bot drive an
agent with real tools. A self-built app is visible to its creator only by
default, but once the bot is added to a group (or the app's visibility is
widened), every member can drive it. Set `dmMode: "allowlist"` with explicit
`dmAllowlist` and/or `groupAllowlist` in anything beyond a personal setup.

`session.dmScope: "per-conversation"` keeps one session per Feishu chat (a
group chat shares a session across members; each p2p chat gets its own). The
default `dmScope` splits sessions per sender instead. **Note the scope is
global**: with `per-conversation`, HTTP REST callers that send no
`conversationId` all map to the same `default` conversation — set it only when
IM-style scoping fits every channel.

The `octopi chat` / TUI loop expects an HTTP channel (it polls the gateway's
REST port); a plugin-only `channels` setup has no listener to poll — keep a
`type: "http"` entry when you need local chat too.

## Behavior notes

- **Text and post messages** are forwarded. Media and card messages are
  skipped (logged) — the SDK normalizes them into placeholder text
  (`![image](key)`, `[file]`, …) which would fabricate user input; they are
  never forwarded as text.
- Replies are sent as text messages (model markdown arrives as literal `**`);
  rendered markdown messages are a possible future option.
- One channel instance per contribution id (`feishu`) in v1. A second Feishu
  app needs a separate plugin copy with its own contribution id (or a separate
  gateway deployment).
- The connection is established at gateway start and fails the start loudly
  when the handshake cannot complete (bad credentials show up here).

## Permissions checklist (typical personal assistant)

| Permission | Why |
|---|---|
| `im:message` | receive message content |
| `im:message:send_as_bot` | reply |
| `im:message.group_at_msg:readonly` | receive group @-mentions |
| `im:message.p2p_msg:readonly` | receive p2p messages |
