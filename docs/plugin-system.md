# Plugin System

Octopi plugins are **trusted, in-process extensions**. A plugin can contribute Tools, Commands, background Services, and declared Hooks through one versioned contract. The host validates the package before executing its code.

> **Trust boundary:** manifest declarations, `allowList`, and `blockList` support installation decisions and diagnostics; they are not a sandbox. In-process plugin code can use Node.js APIs directly. ToolPolicy and EffectPolicy govern effects made through the Tool interface, not arbitrary code in the plugin process. Do not install untrusted code.

## Current implementation status

This document describes the v1 contract: manifest-first loading (P1), the per-Agent Plugin Tool chain (P2), Plugin Commands (P3), and the typed Hook execution surface (P4).

| Surface | Status |
|---|---|
| Manifest validation before import | Implemented |
| Explicit enable / allow / block before import | Implemented |
| JSON Schema config validation | Implemented |
| Dependency, identity, and contribution validation | Implemented |
| Staged registration and atomic effective-registry publication | Implemented |
| Tool / Command / Service / Provider / Channel contribution registration | Implemented; declared and registered sets must match |
| Tool mounting, per-Agent allow/deny, execution, and source attribution | Implemented; empty `tools.allow` does not expose a plugin Tool |
| Command metadata, caller admission, and Host `sessionOps` authorization | Implemented; Plugin SessionOps require matching manifest declarations |
| Hook execution semantics | Implemented for the 22 hook names: typed Observe / Collect / Transform / Vote / Override composition, dual-phase Tool and Iteration hooks, cooperative timeout, per-call audit |
| Run / Tool / Iteration / Message / Compact / Session-archive / Gateway triggers | Implemented on real production paths |
| Tool approval votes (`before_tool_call` `require_approval`) | Implemented through the Host HITL channel; `approve` / `approve_session` / `approve_always` are honored by the engine decision cache; no channel fails closed |
| Background services | Implemented: manifest-declared `registerService` with Host start/stop, required rollback, optional failure issues, reverse-order stop, cooperative timeout |
| Provider contributions (P5) | Implemented: `contributes.providers` + `registerProvider` factories referenced by `models.providers[].plugin`; real example plugin `examples/plugins/openai-compat-dialect` |
| Channel contributions (P5b) | Implemented: `contributes.channels` + `registerChannel` factories referenced by `channels[].plugin`; real example plugin `examples/plugins/feishu-channel` |
| `before_install` hook | Declared but dormant — the repository has no real Skill/Plugin install flow yet, so no trigger is wired and none is faked |
| `session_end` hook | Fires only after a real archive export and hot-store deletion (when an archive manager is configured); plain deletion or compaction never emulates it |
| `before_prompt_build` / `before_iteration` snapshots | Implemented; budgeted, pluginId-attributed snapshots ride the turn envelope's `runtime_snapshot` slot (`before_prompt_build`) or the per-request LLM view (`before_iteration`); never the system prompt |
| ContextEngine registration | Not part of the stable v1 author surface yet |
| Untrusted-code isolation / hot unload | Not supported |

## Package layout

```text
my-plugin/
  octopi.plugin.json
  index.js             # compiled ESM entry; the path is explicit in the manifest
  package.json
```

The loader scans each configured path. A path can be one plugin directory or a parent containing plugin directories. Only directories with `octopi.plugin.json` are candidates.

## Manifest v1

```json
{
  "id": "acme.search",
  "apiVersion": "1",
  "version": "1.0.0",
  "name": "Acme Search",
  "description": "Search Acme",
  "entry": "./index.js",
  "enabledByDefault": true,
  "engine": { "octopi": ">=0.98.18 <1" },
  "configSchema": {
    "type": "object",
    "properties": { "region": { "type": "string", "enum": ["cn", "global"] } },
    "required": ["region"],
    "additionalProperties": false
  },
  "contributes": {
    "tools": ["acme_search"],
    "commands": [{ "name": "acme-status", "sessionOps": [] }],
    "services": ["acme-watcher"],
    "providers": ["acme-llm-gateway"],
    "channels": ["acme-im"],
    "hooks": ["message_received"]
  },
  "requiresPlugins": [],
  "legacyPluginIds": ["acme.legacy-search"]
}
```

- `apiVersion` is the plugin contract version. `engine.octopi` is a semver range checked against the installed engine.
- `entry` is mandatory. Its resolved realpath must stay inside the plugin root, including after symbolic-link resolution. This is package validation, not a security sandbox.
- The manifest is the installation-time declaration authority. `definePlugin` only repeats the entry `id` for identity checking.
- `contributes` declares what the entry must actually register. Undeclared or missing Tools, Commands, Hooks, and Services fail that plugin's registration.
- `legacyPluginIds` maps old configuration IDs to this canonical identity. Configuring both old and new IDs is an error.
- Unknown manifest fields are rejected. Unsupported declaration-only fields from older drafts are not silent feature switches.

The config schema accepts the documented JSON Schema subset, including object/array/scalar types, required properties, enum, range, length, pattern, `additionalProperties`, and composition. Unsupported or invalid schemas fail before import. Configuration errors identify the config path without echoing secret values.

## Entry and author API

```ts
import { definePlugin } from '@octopi-agent/engine/plugin-sdk/plugin-entry';

export default definePlugin({
  id: 'acme.search',
  register(api) {
    api.registerTool(
      {
        name: 'acme_search',
        description: 'Search Acme',
        parameters: {
          query: { type: 'string', description: 'Search query', required: true },
        },
        capabilities: ['egress'],
      },
      async (args, ctx) => {
        const region = api.pluginConfig.region;
        return search(args.query, { region, signal: ctx.abortSignal });
      },
    );

    api.registerCommand({
      name: 'acme-status',
      description: 'Show Acme service status',
      kind: 'control',
      risk: 'low',
      invocableBy: ['principal'],
      sessionOps: [],
      async handler() {
        return { status: 'ok', display: { type: 'text', text: 'Acme is ready' } };
      },
    });

    api.on('message_received', async (event) => {
      api.logger.info(`Message in ${event.sessionId}`);
    });
  },
});
```

`register` should only declare contributions. It is not a transaction for arbitrary external side effects: a failed registration discards its staged Tool/Command/Hook contributions, but cannot undo network or filesystem effects the plugin already performed. Start external resources only at an explicit host lifecycle extension point.

- `api.pluginConfig` contains the validated business config.
- `api.resolvePath(relativePath)` resolves against the plugin root in ESM.
- Tool `capabilities` are mandatory. A Tool with `fs-write` defaults to sequential execution unless explicitly configured otherwise.
- `api.on` is typed against the 22 existing Hook names. `before_tool_call` and `before_iteration` are dual-phase and must pass `{ phase: 'transform' | 'vote' }` (or use the `api.onBeforeToolCall` / `api.onBeforeIteration` helpers); every other event must omit `phase`. A declaration does not imply that every event already has a production trigger; see the status table above (`before_install` is dormant).
- `api.registerService` stages a background service that must also be declared in `contributes.services`; the Host owns its start/stop lifecycle (see Background services).
- `api.registerProvider` stages a Provider factory that must also be declared in `contributes.providers`; the Host instantiates it per `models.providers[].plugin` reference (see Provider contributions (P5)).
- `api.registerChannel` stages a Channel factory that must also be declared in `contributes.channels`; the Host instantiates it per `channels[].plugin` reference (see Channel contributions (P5b)).
- `api.getContributionInstance(kind, id)` returns this plugin's live provider/channel instance as served by the Host, with exactly-one semantics (see Contribution instances (P6-3)).
- `api.stateDir` / `api.ensureStateDir()` — per-plugin private state directory, created 0700 (a chmod failure is reported via the plugin logger and the directory keeps the filesystem default — see Host storage primitives (P6-4)).
- `api.secrets.get/set/delete` — per-plugin secret namespace over the Host credentials vault (AES-GCM, consumer-bound); never log or persist returned plaintext.
- ContextEngine and media-provider registration methods are intentionally absent until each has a complete production consumer and lifecycle contract.

## Plugin Commands and Session effects

The manifest declares the complete set of SessionOps a Command may request. Repeat the same set in `registerCommand`; a mismatch fails registration before publication. An omitted or empty `sessionOps` declaration grants **no** Session effects. The supported operation names are `abort_run`, `new_session`, `set_model`, `compact`, and `set_preferred_agent`; the latter remains reserved and has no v1 effect implementation.

```json
{ "commands": [{ "name": "acme-status", "sessionOps": ["compact"] }] }
```

The Host obtains plugin identity from the mounted effective contribution, not from handler-returned fields. Before applying **any** SessionOp, it checks the effective manifest for that plugin and Command. An unknown or undeclared operation rejects the entire batch: no earlier operation is applied, the result becomes `denied`, and a `command_denied` record is appended to `~/.octopi/audit/commands/YYYY-MM-DD.jsonl`. The record includes Session, Agent, plugin, Principal, requested operations, and denied operations. An audit-write failure leaves the effects denied and raises a `command.audit_failed` System Issue. This daily JSONL journal is not a tamper-evident ledger.

The manifest Command declaration contains `name` and `sessionOps`; the trusted `registerCommand` call supplies the other metadata. Supported `kind` values are `control` (the default) and `prompt`. `client` is rejected at registration because v1 has no client-effect contract. `kind`, `risk`, `args`, `preempt`, and `invocableBy` are preserved through mounting. `risk` is catalog metadata only; it does **not** imply HITL approval. `invocableBy` defaults to `['principal']` and is an invoker-category check, not a per-user or Session-role ACL. The only v1 categories are `principal`, `agent`, and `service`. Host/user/timer Principals map to `principal`; service/subsystem map to `service`. They do not implicitly inherit each other's access. A plugin contribution's source is not a caller category. `preempt` bypasses only the active-Run busy check and grants no SessionOp authorization.

`newSessionId` is Host-generated only after an authorized `new_session`; a handler-supplied value is discarded. Router candidate identity includes the Command name, so multiple Commands from one plugin retain independent conflict and unregister behavior while authorization still uses their real pluginId.

A `prompt` Command may return `enterLoop: true` with non-empty `messages`; it cannot combine those with SessionOps. `control` Commands do not enter the Loop. A declared effect still undergoes its normal Host operation validation and can fail for business reasons. Disabled plugins contribute no visible or executable Command.

## Hook execution semantics

Each hook name has one composition class with explicit failure, cancellation, and audit semantics. Handlers run in priority order (registration order breaks ties); `priority` orders execution only and never overrides a denial.

| Class | Hooks | Failure semantics |
|---|---|---|
| Observe | `agent_end`, `after_tool_call`, `message_received`, `message_sent`, `session_start`, `session_end`, `after_compaction`, `gateway_start`, `gateway_stop`, `after_iteration`, `loop_end` | Fail-open: a throwing handler is recorded and the operation continues |
| Collect | `before_prompt_build` | Fail-open per contribution: a failing collector is skipped and recorded; valid contributions still apply |
| Transform | `before_model_resolve`, `agent_turn_prepare`, `before_agent_finalize` | Fail-closed: a throwing handler aborts the Run (the tool-scoped `before_tool_call` transform rejects that one call instead — nothing executes); no partial transform is published |
| Vote | `before_agent_run`, `message_sending`, `before_compaction`, `before_install`, and the `vote` phase of `before_tool_call` / `before_iteration` | Fail-closed: any `deny` wins; a throwing handler counts as `deny`; `require_approval` outside `before_tool_call` is a denial |
| Override | `before_agent_reply` | Exactly one owner allowed; multiple owners or a failure reject the Run |

- Dual-phase events run `transform` first, then `vote` on the transformed values. For `before_tool_call` the tool's own validation and the Host security checks re-run on transformed parameters before the Vote, and the audit keeps both raw and final parameters with the plugin that changed them. A denied tool call never executes and never fabricates `after_tool_call`.
- Every handler execution is bounded by a cooperative timeout (default 30 s; override per hook with `timeoutMs` or plugin config `hooks.timeouts`). The handler receives an `AbortSignal`; in-process code cannot be forcibly terminated.
- Every execution appends a per-day audit record (`~/.octopi/audit/hooks/YYYY-MM-DD.jsonl`) with pluginId, hook, phase, outcome, run/session/agent identity, and the Principal. The journal is diagnostic, not a tamper-evident ledger; a failed audit write never changes an operation's outcome.
- Run-level observations report exact terminal facts: `reason` is `completed | should_stop | aborted | error | denied` and `success` is true only for clean terminal ends (`completed` or `should_stop`). A policy denial surfaces to hook observations as `reason: 'denied'` while the Core `agent_end` event keeps the compatible `error` reason.
- `before_agent_reply` (Override) replaces the model reply for that Run; `before_agent_finalize` transforms only the final reply of a step without tool calls. Neither may add `toolCalls` (no tool results would follow). Events and persistence carry the finalized reply; text already streamed to the client cannot be recalled — a plugin that must fully control the reply uses `before_agent_reply`.
- Iteration model/thinking transforms may only select values the Host configured — an unknown model fails the Run instead of silently falling back. The selected thinking level enters the LLMRequest and the built-in adapters map it to their native parameters (`reasoning_effort` / `thinking.budget_tokens`); plugin providers decide their own mapping (see Provider contributions (P5)).
- `before_prompt_build` contributions ride the turn envelope's `runtime_snapshot` slot alongside the other volatile blocks: the user message is write-once (raw user text is never altered, later turns are never rewritten, and what was sent to the model is what is stored). `before_iteration` snapshots project into the per-request LLM request view only. The system prompt is never affected.

## Tool call approval

A `before_tool_call` Vote may return `require_approval` together with an `approval` request. The Host presents its existing high-risk approval card, and the outcome resolves that Vote:

- `approve` allows this call only. `approve_session` and `approve_always` are remembered by the engine decision cache (per Session, or per Agent for the process lifetime) for the same tool, so the same approval is not requested again within that scope.
- Timeout, cancellation, and human rejection are distinct denial sources. Each is preserved in the audit record and in the block reason; a timeout is never recorded as a human rejection.
- A remembered grant is keyed by (channel, pluginId, tool name, session/agent) — not by arguments. `approve_session` and `approve_always` therefore cover later parameter variants of the same tool under the same plugin's policy (the builtin `high_risk` channel keeps the established tool-name key); use one-shot approvals for argument-sensitive tools.
- With no Host approval channel configured, `require_approval` fails closed.

## Background services

```jsonc
{ "contributes": { "services": ["acme-watcher"] } }
```

```ts
api.registerService({
  serviceId: 'acme-watcher',
  required: false,
  timeoutMs: 5000,
  start: async (signal) => { /* bind resources */ },
  stop: async (signal) => { /* release resources */ },
});
```

- Every service must be declared in `contributes.services` and registered exactly once. Cross-plugin id conflicts fail before import; undeclared or missing contributions are detected at registration and fail publication before the plugin reaches the effective registry.
- `registerService` only stages the service; it starts no side effects. The Host starts services before opening Channels and stops them in reverse registration order on shutdown.
- `required: true` failure rolls back startup and blocks the Gateway; `optional: true` failure opens a System Issue and the Gateway continues.
- `start`/`stop` receive an `AbortSignal` and are bounded by `timeoutMs` (cooperative; in-process code cannot be forcibly killed). Lifecycle outcomes are recorded in the hook audit journal.

## Provider contributions (P5)

A plugin can contribute a **Provider factory** — a named builder the Host calls to
construct a Core `ModelProvider` for one `models.providers` entry.

```jsonc
// octopi.plugin.json
{ "contributes": { "providers": ["acme-llm-gateway"] } }
```

```ts
api.registerProvider('acme-llm-gateway', (context) => {
  // context: { providerName, baseUrl, apiKey, models, defaultModel?, timeoutMs?, options }
  return myModelProvider;
});
```

```jsonc
// octopi.json — reference the contribution via `plugin` (mutually exclusive with `api`)
{
  "models": {
    "providers": {
      "my-gateway": {
        "baseUrl": "https://llm-gateway.internal/v1",
        "apiKey": "${MY_GATEWAY_KEY}",
        "plugin": "acme-llm-gateway",
        "models": [{ "id": "kimi-k2", "reasoning": true, "contextWindow": 131072 }],
        "options": { "thinking": { "field": "enable_thinking", "mode": "boolean" } }
      }
    }
  }
}
```

- `plugin` and `api` are mutually exclusive — exactly one must be set. An unknown
  or disabled contribution id fails provider creation loudly (fail closed).
- The factory is called per config instance at startup and on config hot-replace
  (never at registration time). Contribution ids are globally unique across
  plugins, like services; declared and registered sets must match.
- The API key always arrives through the credential channel (`apiKey`,
  `${ENV_VAR}` recommended; `""` = keyless). `options` carries **non-secret**
  tuning knobs only and is passed through verbatim for the plugin to validate.
- `options` is echoed verbatim to the Web console (`/config/models`) and written
  to disk as-is. **Never put credentials in `options`** (custom auth headers that
  carry secrets belong in `apiKey`); secret-aware option schemas are a future
  extension.
- The Host owns provider lifecycle: a retired instance (config hot-replace or
  removal) keeps serving during a fixed **grace window** (30 min, logged
  force-disposal after it) — the window is not a per-request drain (the
  `ModelProvider` contract has no in-flight counting). The process shutdown path
  disposes everything. `dispose()` should release transports and abort in-flight
  requests, including streaming bodies.
- Built-in `api: "openai-completions"` / `"anthropic-messages"` adapters already
  cover strict OpenAI-compatible / Anthropic endpoints (custom `baseUrl`,
  keyless). Use a Provider contribution only for dialects the built-ins do not
  cover — see the maintained example `examples/plugins/openai-compat-dialect`
  (custom auth headers, extra body fields, thinking-parameter dialects).
- `thinkingLevel` from `LLMRequest` maps to `reasoning_effort` (openai) and
  `thinking.budget_tokens` (anthropic) in the built-in adapters; plugin providers
  decide their own mapping. The built-in openai adapter does not probe whether
  the endpoint understands `reasoning_effort` — it is only sent when
  `thinkingLevel` is set; endpoints that reject it should use a Provider
  contribution.
- Plugin providers do not participate in wire dumps
  (`observability.llmRequestDump`) unless they implement
  `wireBodyFor(request, mode)`; the decoration chain forwards `dispose` so
  lifecycle guarantees hold with dumps enabled.

## Channel contributions (P5b)

A plugin can contribute a **Channel factory** — a named builder the Host calls
to construct a Gateway `ChannelAdapter` (message transport) for one `channels`
entry.

```jsonc
// octopi.plugin.json
{ "contributes": { "channels": ["feishu"] } }
```

```ts
api.registerChannel('feishu', async (context) => {
  // context: { channelName, apiKey, options }
  return myChannelAdapter; // { name, start(handler), send(reply), stop() }
});
```

```jsonc
// octopi.json — reference the contribution via `plugin` (mutually exclusive with `type`)
{
  "channels": [
    {
      "plugin": "feishu",
      "apiKey": "${FEISHU_APP_SECRET}",
      "options": { "appId": "cli_xxx", "policy": { "dmMode": "allowlist", "dmAllowlist": ["ou_…"] } }
    }
  ],
  "session": { "dmScope": "per-conversation" }
}
```

- `plugin` and `type` are mutually exclusive — exactly one must be set.
  `type: "http"` selects the built-in HTTP/WebSocket channel; `plugin` names a
  channel contribution. An unknown or disabled contribution id, or an unknown
  built-in `type`, fails daemon startup loudly (fail closed).
- The factory is called per `channels` entry at startup (never at registration
  time). Contribution ids are globally unique across plugins and double as the
  channel label: the Host rejects `adapter.name` ≠ contribution id, duplicate
  names are refused at `registerChannel`, and built-in channel ids (`http`) are
  reserved. One instance per channel contribution id in v1.
- The adapter contract is the Channel SPI (`start(handler)` receives normalized
  `ChannelMessage`s, `send(reply)` delivers a `ChannelReply`, `stop()` releases
  the transport). The Host drives `start`/`stop` with the Gateway lifecycle:
  services start before channels, channels stop in reverse registration order.
  A channel whose `start()` fails is logged, reported as an issue, best-effort
  `stop()`-ed (so `stop()` **must tolerate being called after a failed
  `start()`**) and dropped from routing — startup proceeds without it. Startup
  aborts with a real-reason `AggregateError` only when **all** channels fail or
  when the built-in `http` channel fails (a gateway without its HTTP/WS
  listener must not report Ready).
- Adapters may implement an optional `status()`
  (`{ state: 'running' | 'dormant' | 'degraded' | 'retiring', detail? }`) for
  health aggregation: the gateway `/health` endpoint reports each channel's
  state. Adapters without `status()` are reported as `running` after a
  successful `start()` (the start/stop contract makes "started" the truthful
  default); a `status()` that throws degrades only that channel's health entry.
- Messages carry `channel === adapter.name`; replies and command short-replies
  route back through the same adapter. `channelBindings` key on the channel
  label, and `session.dmScope: "per-conversation"` keys sessions per chat (one
  session shared by all members of a group chat).
- A channel lets whoever can reach it drive an agent with real tools. Configure
  the transport's own admission gates (e.g. the `policy` allowlists in the
  Feishu example) for anything beyond a personal setup.
- `options` is written to disk as-is; **never put credentials in `options`**
  (secrets belong in `apiKey`). The JSON Schema in `octopi.schema.json` cannot
  express the `type | plugin` exclusivity (like `models.providers[].api|plugin`);
  the runtime enforces it strictly.
- Real example: `examples/plugins/feishu-channel` — a Feishu (Lark) bot over the
  official SDK's long connection (WebSocket), with policy-gated DM/group
  admission and mention detection.

## Contribution instances (P6-3)

Factory-backed contributions (providers, channels) are staged as factories; the
Host creates the runtime instances when configuration references them. Every
accepted instance is recorded in a per-plugin instance registry, and the plugin
reaches its own live instance through the narrow lookup
`api.getContributionInstance(kind, id)` — the supported replacement for
module-closure bridges (a `let adapter` shared between a factory and a tool
breaks under multiple instantiations and after retirement).

```js
api.registerChannel('weixin', async (context) => createWeixinChannelAdapter(context, {}));
api.registerTool({ name: 'weixin_pair', /* ... */ }, async () => {
  const adapter = api.getContributionInstance('channel', 'weixin');
  // TS authors: cast to their own adapter interface for SPI-external methods
  return adapter.pair();
});
```

Contract:

- **Kinds**: `'provider'` and `'channel'` — only factory-backed contributions
  have instances separable from their registrations. Tools, commands, hooks and
  services *are* their registrations. Any other kind string is rejected with a
  real error (the API is reachable from plain JS).
- **Birth**: an instance is registered when the Host *accepts* the factory
  product — after contract validation — so the registry's notion of "live"
  matches what the Host routes to. A rejected factory product never becomes a
  tracked instance, and neither does a pre-built instance whose config apply
  aborted before install (the Host rolls the acceptance back). The registered
  object is the factory product itself: plugin-specific methods live only
  there. With `observability.llmRequestDump` the Host routes through a
  decorator copy that carries only SPI members and forwards calls to the
  product (its `dispose` forwarding closes the retirement chain — acceptance
  runs before decoration).
- **Retirement** — two triggers, both idempotent:
  - physical: the instance's lifecycle method runs — `stop()` for channels,
    `dispose()` for providers (defined as a retirement marker when the provider
    has none). Recorded when the call is *requested*, regardless of outcome.
  - logical: the Host stops routing to the instance — a newer instance is
    accepted for the same contribution key and config identity (hot-reload
    replace), or the instance is removed from routing (provider removal /
    config reset marks it immediately). The instance may still serve draining
    in-flight work until disposed — provider disposal is deferred by the
    gateway's grace window on hot-reload, but lookup stops returning the
    instance at retirement, not at disposal.
  - Re-accepting the same product (singleton factories) revives its entry as
    live; in normal operation the Host calls the lifecycle methods (shutdown,
    rollback, hot-reload), and the plugin can call them too — the method sits
    on its own instance.
- **Exactly-one semantics**: the lookup succeeds only while exactly one live
  instance exists, and throws a real error otherwise:
  - never instantiated: `has no live instance (the Host has not instantiated it)`;
  - retired: `has no live instance (its instance was retired)`;
  - several live at once: the error names the instance labels — capture
    per-instance handles in the factory closure instead (each factory call may
    close over its own). For providers the label is the `models.providers`
    config key; for channels it is the contribution id (the gateway allows at
    most one instance per channel id).
  - not a contribution of this plugin: cross-plugin lookup is not part of the
    v1 contract.
- An instance whose retirement cannot be tracked (a frozen/sealed object) is
  **not registered** and the Host logs an explicit warning; the Host's own
  contract validation reports broken adapters and the registry never patches
  the objects it is given.
- The declared return types are the SPI structural views (`ModelProvider`,
  `PluginChannelAdapterLike`). Plugin-specific methods beyond the SPI (like
  `pair()` on the weixin adapter) exist at runtime; TypeScript authors cast to
  their own adapter interface.

## Host storage primitives (P6-4)

Plugins get two storage primitives from the Host — the only supported
persistence surface; never write into the plugin install directory.

- **`api.stateDir`** — per-plugin private state directory
  (`OCTOPI_HOME/plugin-state/<id>`, created with mode 0700 on first use via
  `api.ensureStateDir()`). Runtime state (cursors, session files) goes here.
- **`api.secrets`** — `get/set/delete` over the Host credentials vault
  (`OCTOPI_HOME/credentials/credentials.db`, AES-GCM at rest). Values live in
  the plugin's own namespace (`plugin:<id>:<key>`) and are bound to the plugin
  as the only resolvable consumer (any leftover foreign binding is revoked on
  write). Plaintext returned by `get` is short-lived: never log or persist it.
  **Secrets never go into state files, options or logs.**
  Prerequisite: the vault encryption key must be configured
  (`OCTOPI_CREDENTIALS_KEY` or `OCTOPI_CREDENTIALS_KEY_FILE`) — `set` throws a
  real error otherwise. Plugins that degrade on such a failure must do so
  explicitly (e.g. the weixin example keeps the token inline in its state file
  and logs the vault error instead of losing it).

```js
register(api) {
  const stateDir = await api.ensureStateDir(); // 0700
  await api.secrets.set('bot_token', token);   // encrypted at rest
  const token = await api.secrets.get('bot_token');
}
```

- Secret keys are `[A-Za-z0-9._-]+`; empty values are rejected with a real
  error. Metadata (name, mode, timestamps) never contains plaintext.
- Manifest **`secretOptions`** (optional `string[]`) declares which
  `options` keys hold secrets (e.g. pairing codes). The Host redacts those
  values in config echo surfaces (Web console `GET /config/models`): the value
  is replaced with the same `RedactedSecret` view as `apiKey`
  (`{configured, ref}`) and never echoed. Echo placeholders are write-safe:
  on upsert a `RedactedSecret`-shaped value for a declared key means "client
  did not change it" — the stored value is kept (same rule as a blank `apiKey`).
  When the plugin contribution is not in the live registry the Host fails
  closed and masks the whole `options` object. Scope note: the redaction
  surface today is `models.providers` echo only — there is no channel config
  echo endpoint yet, so `secretOptions` on a channel manifest is declarative
  ahead of its consumer.

Real example: `examples/plugins/weixin-clawbot` — runtime state
(`baseurl`, cursor) in `api.stateDir`, `bot_token` in the vault
(`api.secrets`), and a one-shot `migrateLegacyState()` that adopts
deployments from the pre-P6-4 single-file state (inline token is moved into
the vault on first save).

## Plugin tooling (P6-5)

The `octopi plugin` command group covers the plugin lifecycle outside the
runtime (v1 deliberately has no dev-mode watch / hot reload — sync says so
instead of pretending):

- **`octopi plugin init <name> [--dir <path>]`** — scaffold a plugin project
  (manifest + TS entry + package/tsconfig). After `npm run build` (the entry
  points at `dist/`), the scaffolded plugin passes `plugin doctor` clean;
  before the first build, doctor reports the missing entry (PLG004) exactly
  as the loader would refuse it.
- **`octopi plugin doctor [dir] [--json]`** — local health check of one plugin
  directory (no LLM, exit 1 on errors): manifest JSON/schema (`PLG001/2`),
  engine range vs the installed engine (`PLG003`, the loader's own rule),
  entry file presence (`PLG004`), `plugin-state/<id>` permissions (`PLG005`,
  no group/other access), deployed-copy drift against `OCTOPI_HOME/plugins/<id>`
  (`PLG006`), `secretOptions` keys vs `configSchema.properties` (`PLG007`),
  runtime dependency presence/versions (`PLG009`, Node-resolution aware —
  hoisted workspace deps resolve; non-semver specs verified by presence only)
  and stale sync scratch dirs (`PLG010`, informational). Warnings do not block
  loading; errors mean the loader will refuse the plugin.

## Plugin distribution & deployment (P6-6)

A deployable plugin copy is **files + the runtime dependency closure** —
Node's module resolution needs `node_modules` next to the entry at load time,
so dependency installation is part of deployment, not a user chore. Three
shapes, two pipelines, one semantics ("files in place, dependencies in
place"):

| Shape | What it is | How it deploys |
|-------|-----------|----------------|
| Development | source dir (git repo) | `plugins.loadPaths` can point at it; `npm install` once |
| Distribution | **npm package** carrying `octopi.plugin.json` + entry | `octopi plugin install <spec>` |
| Deployment | `plugins/<id>/` = files + `node_modules` (runtime deps only) | `octopi plugin sync` / `plugin install` |

The npm package is the distribution unit (`octopi plugin init` scaffolds one);
a dedicated plugin marketplace can come later on the same channel. Lifecycle
scripts (`preinstall`/`postinstall`) are an automatic code-execution surface
and **the operator, never the package, consents to them**: installs run with
`--ignore-scripts` unless the CLI carries `--allow-scripts`. A manifest
`installScripts: true` is a requirement declaration, not a permission —
without operator consent deployment is refused (a skipped postinstall would be
a silently broken plugin). The fetch stage (`npm pack`) always skips
publisher scripts; npm's git-dependency preparation runs inside npm itself and
follows your npm version's own script policy. The channel carries no built-in
integrity pinning: install by pinned spec (`name@version`) and treat
`plugin install` as trusting the registry.

- **`octopi plugin install <npm-spec> [--into <plugins-root>]`** — deploy a
  plugin from the npm channel (registry, git URL, tarball): fetch, verify the
  manifest, install runtime dependencies, atomically swap into the plugins
  root, print the restart notice. A package without `octopi.plugin.json` is
  rejected as "not an Octopi plugin", and a plugin whose entry would not
  resolve (or whose engine range this host cannot satisfy) is refused —
  deployment completeness includes loadability.
- **`octopi plugin sync [dir] [--into <plugins-root>] [--skip-install] [--allow-scripts]`** — atomically deploy a
  plugin into `OCTOPI_HOME/plugins`: files are staged beside the target and
  swapped in with renames (a failed swap restores the previous copy; a failed
  rollback preserves the backup on disk and reports its path — the deployed
  plugin is never left a partial mix; rename-atomicity only, no fsync, so a
  power loss can still lose the newest write); dev-only files (`node_modules`,
  `.git`, `*.test.*`) are excluded; **runtime dependencies are installed
  (`npm install --omit=dev`, staged before the swap) or reused from the
  current deployment when the dependency set is unchanged (offline-fast);
  `--skip-install` PRESERVES the deployed node_modules instead of installing
  (never silently dropped)**; stale deployed files are removed; stale
  `.sync-*` scratch dirs from interrupted runs are swept first (the loader
  never treats dot-dirs as plugin candidates). Prints the restart notice —
  in-process plugins have no hot reload in v1.

## Configuration

```jsonc
{
  "plugins": {
    "loadPaths": ["~/.octopi/plugins"],
    "allowList": ["acme.search"],
    "blockList": [],
    "entries": {
      "acme.search": {
        "enabled": true,
        "config": { "region": "cn" }
      }
    }
  }
}
```

Enablement is resolved before any plugin import:

```text
blockList → allowList → entries[id].enabled → manifest.enabledByDefault → true
```

- `blockList` wins. If `allowList` is present, an unlisted plugin is disabled.
- `entries[id].enabled` is the only per-plugin enable/disable setting.
- A `config` entry by itself does **not** enable a plugin. An omitted `enabled` falls back to the manifest default, then `true`.
- A dependency must itself be eligible. Dependencies do not auto-enable a plugin or bypass allow/block. A failed or disabled dependency rejects its dependents.
- Duplicate IDs, conflicting legacy aliases, and duplicate declared capabilities are rejected rather than resolved by scan order.
- `loadPaths`, allow/block, and per-plugin enablement are security-sensitive configuration. Changes require a host restart and trigger configuration-drift protection; business config is not copied in plaintext into the fingerprint's diagnostic fields.

### Allow an Agent to use a Plugin Tool

Loading a plugin and exposing its Tools are separate decisions. A plugin Tool is **denied by default for every Agent**, including when `tools.allow` is empty or omitted. Opt in by exact Tool name or by `*`:

```jsonc
{
  "agents": [
    {
      "id": "researcher",
      "model": { "provider": "openai", "model": "gpt-5.5" },
      "tools": { "allow": ["acme_search"] }
    },
    {
      "id": "writer",
      "model": { "provider": "openai", "model": "gpt-5.5" },
      "tools": { "allow": [] }
    }
  ]
}
```

`researcher` can see and execute `acme_search`; `writer` cannot. `tools.deny` wins over both an exact allow and `allow: ["*"]`. The existing builtin Tool behavior is unchanged: an empty allow list still permits builtin Tools unless denied.

The host mounts contributions into each Agent's ToolBus and filters the LLM tool definitions using the Agent's policy. Direct ToolBus execution and Plugin Tool handlers also check the active policy, so hiding a Tool is not the only authorization check. A Plugin Tool cannot silently shadow a builtin or another registered Tool; a name conflict is an error.

Handlers receive the normal `ToolExecutionContext`, including `runId`, `sessionId`, `agentId`, and `abortSignal`. Cancellation is **cooperative**: handlers should stop at effect boundaries when `abortSignal` fires. `definition.timeoutMs` uses the existing tool watchdog, but cannot forcibly terminate arbitrary in-process code. Tool source is retained in `tool.exec.end` events and persisted ToolResults as `{ kind: "plugin", origin: pluginId, trustLevel: "third-party" }`.

ToolPolicy / EffectPolicy still applies to calls made through the Tool interface. `trustLevel` is diagnostic metadata, not a permission grant or a sandbox. The separate Agent `tools` configuration is restart/rebuild-scoped, not a per-message authorization override.

### Migrating `plugins.configs`

Legacy configuration:

```json
{ "plugins": { "configs": { "acme.search": { "region": "cn" } } } }
```

is reported as `CFG013` and migrated in memory by `loadConfig`, or written by `octopi doctor --fix`, to:

```json
{ "plugins": { "entries": { "acme.search": { "config": { "region": "cn" } } } } }
```

The old field was not connected to the default Gateway, so migration does not invent `enabled: true`. Set `enabled` explicitly when desired. A conflicting old and new entry fails loudly instead of silently choosing one.

## Loading and failure semantics

```text
Read manifests
→ Resolve canonical and legacy identities
→ Decide enable / allow / block
→ Validate dependency eligibility and declared conflicts
→ Resolve entry and validate business config and engine range
→ Import only eligible entries
→ Register into staging and compare with declarations
→ Publish the host-level effective contribution registry
→ Mount to consumers in their respective implementation phases
```

A failed plugin leaves no effective Tool, Command, Service, or Hook behind. Its dependents are also rejected. An unrelated valid plugin can still load. A host-level registry is not the same as a per-Agent ToolBus: registry publication does not claim that every Agent has already mounted the Tool. Likewise, a mounted Tool is not automatically exposed to the model; the Agent's `tools.allow` policy controls the final LLM tool definitions and execution.

Use `PluginManager.getDiagnostics()` to distinguish `disabled`, `failed`, and `registered`, with a failure stage and reason. The default Gateway logs non-registered diagnostics at startup.

## Creating a plugin

```sh
octopi plugin init acme.search --dir ~/.octopi/plugins/acme.search
# Compile index.ts to index.js, install its dependencies, then configure and restart Octopi.
```

The scaffold uses the same v1 manifest, `definePlugin`, and Tool declaration contract shown above. Registration is not Tool exposure: after enabling the plugin, also add its Tool name to the intended Agent's `tools.allow` (or explicitly choose `*`), then restart/rebuild the Agent.
