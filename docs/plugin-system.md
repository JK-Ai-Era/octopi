# Plugin System

Octopi plugins are **trusted, in-process extensions**. A plugin can contribute Tools, Commands, and declared Hooks through one versioned contract. The host validates the package before executing its code.

> **Trust boundary:** manifest declarations, `allowList`, and `blockList` support installation decisions and diagnostics; they are not a sandbox. In-process plugin code can use Node.js APIs directly. ToolPolicy and EffectPolicy govern effects made through the Tool interface, not arbitrary code in the plugin process. Do not install untrusted code.

## Current implementation status

This document describes the manifest-first loading foundation (P1) and the per-Agent Plugin Tool execution chain (P2).

| Surface | Status |
|---|---|
| Manifest validation before import | Implemented |
| Explicit enable / allow / block before import | Implemented |
| JSON Schema config validation | Implemented |
| Dependency, identity, and contribution validation | Implemented |
| Staged registration and atomic effective-registry publication | Implemented |
| Tool / Command contribution registration | Implemented |
| Tool mounting, per-Agent allow/deny, execution, and source attribution | Implemented; empty `tools.allow` does not expose a plugin Tool |
| Command metadata and Host `sessionOps` authorization | Next phase; existing bridge behavior is not a complete authorization model |
| Hook execution semantics | Existing message/gateway-stop triggers remain; typed composition and remaining triggers are later work |
| Provider / Channel / ContextEngine registration | Not part of the stable v1 author surface yet |
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
    "hooks": ["message_received"]
  },
  "requiresPlugins": [],
  "legacyPluginIds": ["acme.legacy-search"]
}
```

- `apiVersion` is the plugin contract version. `engine.octopi` is a semver range checked against the installed engine.
- `entry` is mandatory. Its resolved realpath must stay inside the plugin root, including after symbolic-link resolution. This is package validation, not a security sandbox.
- The manifest is the installation-time declaration authority. `definePlugin` only repeats the entry `id` for identity checking.
- `contributes` declares what the entry must actually register. Undeclared or missing Tools, Commands, and Hooks fail that plugin's registration.
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
- `api.on` is typed against the 22 existing Hook names. A declaration does not imply that every event already has a production trigger; see the status table above.
- Provider, Channel, ContextEngine, media-provider, and background-service registration methods are intentionally absent until each has a complete production consumer and lifecycle contract.

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

A failed plugin leaves no effective Tool, Command, or Hook behind. Its dependents are also rejected. An unrelated valid plugin can still load. A host-level registry is not the same as a per-Agent ToolBus: registry publication does not claim that every Agent has already mounted the Tool. Likewise, a mounted Tool is not automatically exposed to the model; the Agent's `tools.allow` policy controls the final LLM tool definitions and execution.

Use `PluginManager.getDiagnostics()` to distinguish `disabled`, `failed`, and `registered`, with a failure stage and reason. The default Gateway logs non-registered diagnostics at startup.

## Creating a plugin

```sh
octopi plugin init acme.search --dir ~/.octopi/plugins/acme.search
# Compile index.ts to index.js, install its dependencies, then configure and restart Octopi.
```

The scaffold uses the same v1 manifest, `definePlugin`, and Tool declaration contract shown above. Registration is not Tool exposure: after enabling the plugin, also add its Tool name to the intended Agent's `tools.allow` (or explicitly choose `*`), then restart/rebuild the Agent.
