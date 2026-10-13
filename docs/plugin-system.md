# Plugin System

Octopi’s Plugin system provides declarative capability registration, full-lifecycle hook interception, and a standardized loading pipeline.

---

## Table of contents

- [Architecture overview](#architecture-overview)
- [Quick start](#quick-start)
- [Plugin structure](#plugin-structure)
- [PluginApi in detail](#pluginapi-in-detail)
- [Hook system](#hook-system)
- [Capability Ownership Model](#capability-ownership-model)
- [Plugin loading flow](#plugin-loading-flow)
- [Configuration system](#configuration-system)
- [Complete examples](#complete-examples)
- [Subpath exports](#subpath-exports)
- [API reference](#api-reference)

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────┐
│                    PluginManager                        │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │PluginLoader  │  │ HookRunner   │  │  Capability   │  │
│  │ discovery    │  │ priority     │  │  Registry     │  │
│  │ validation   │  │ timeout      │  │  ownership    │  │
│  │ loading      │  │ intercept    │  │  conflict     │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                │                   │          │
│  ┌──────▼─────────────────▼───────────────────▼──────┐  │
│  │                   LoadedPlugin                    │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐    │  │
│  │  │ Manifest │  │ PluginApi│  │  Entry (TS)  │    │  │
│  │  │ (.json)  │  │ (hooks,  │  │  definePlugin│    │  │
│  │  │          │  │  tools,  │  │  Entry()     │    │  │
│  │  │          │  │  providers│ │              │    │  │
│  │  └──────────┘  └──────────┘  └──────────────┘    │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 4-stage loading pipeline

| Stage | Responsibility |
|------|------|
| **Discovery** | Scan `loadPaths`, find `octopi.plugin.json` |
| **Validation** | Validate manifest format, contracts, dependencies |
| **Loading** | Dynamically `import()` the entry file and obtain the plugin definition |
| **Registration** | Call `register(api)`, collect hooks/tools/providers |

### Core design principles and rationale

1. **Manifest first** — metadata can be read without executing code.  
   Plugins are third-party code; “load equals execute” defers auditing until after something goes wrong. The manifest lets conflict detection, activation planning, and the capability inventory all complete before execution — this is also the precondition for the four uses of Capability Ownership.

2. **Capability Ownership** — every capability has exactly one owner.  
   The Plugin is the capability boundary: if tools / providers / channels allowed multiple owners, the result would be silent overrides and unclear responsibility; exclusive resources (such as a memory provider) could not guarantee a single active instance at a time. The `contracts` declaration makes “who owns what” queryable without loading code, and conflicts fail at registration time rather than causing runtime chaos.

3. **Hook interception semantics** — a non-null return interrupts later handlers.  
   Observation and interception must be distinguishable at a glance: a handler that returns `null` does not change behavior; a return value is an explicit short-circuit; Terminal results such as `block` / `cancel` stop the chain immediately. Timeouts and exceptions of a single handler are **caught and isolated** — one plugin failure does not take down the whole chain.

4. **Priority ordering** — higher numbers run first.  
   When multiple plugins stack, execution order must be deterministic and predictable; security and audit handlers run before business handlers at higher priority, avoiding “act first, be checked later.”

---

## Quick start

### 1. Create a Plugin directory

```
my-plugins/
  tool-preflight/
    octopi.plugin.json    ← manifest (required)
    index.ts              ← entry file (required)
```

### 2. Write the Manifest

```json
{
  "id": "tool-preflight",
  "name": "Tool Preflight",
  "description": "Intercept and validate tool calls",
  "version": "1.0.0",
  "configSchema": {
    "type": "object",
    "properties": {
      "blockedTools": {
        "type": "array",
        "items": { "type": "string" }
      }
    }
  }
}
```

### 3. Write the entry file

```ts
// index.ts
import { definePluginEntry } from '@octopi-agent/engine/plugin-sdk/plugin-entry';

export default definePluginEntry({
  id: 'tool-preflight',
  name: 'Tool Preflight',
  description: 'Intercept and validate tool calls',

  register(api) {
    const blockedTools = (api.pluginConfig.blockedTools as string[]) ?? [];

    api.on('before_tool_call', async (event: any) => {
      if (blockedTools.includes(event.toolName)) {
        return { block: true, blockReason: 'Blocked by policy' };
      }
      return null; // allow
    }, { priority: 50 });
  },
});
```

### 4. Load the Plugin

```ts
import { PluginManager } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/plugins/manager';

const pm = new PluginManager({
  loadPaths: ['/path/to/my-plugins'],
});

const plugins = await pm.discover();
console.log(`Loaded ${plugins.length} plugins`);

// Use within AgentLoop
const result = await pm.runHook('before_tool_call', event, null);
```

---

## Plugin structure

Each Plugin consists of two parts:

### Manifest (`octopi.plugin.json`)

Declarative metadata the framework can read without executing code.

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "What this plugin does",
  "version": "1.0.0",
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string" },
      "enabled": { "type": "boolean", "default": true }
    }
  },
  "contracts": {
    "tools": ["my_custom_tool"],
    "providers": ["my-llm-provider"]
  },
  "activation": {
    "onStartup": true
  }
}
```

**Required fields:**

| Field | Type | Description |
|------|------|------|
| `id` | string | Unique Plugin identifier |
| `configSchema` | JSON Schema | Configuration structure description (pass `{}` even when there is no config) |

**Common optional fields:**

| Field | Type | Description |
|------|------|------|
| `name` | string | Human-readable name |
| `description` | string | Short description |
| `version` | string | Semantic version |
| `contracts` | object | Capability declarations (see [Capability Ownership](#capability-ownership-model)) |
| `activation` | object | Activation conditions (see [Activation config](#activation-config)) |
| `requiresPlugins` | string[] | Depended-on plugin IDs |

### Entry file (`index.ts`)

Create the plugin definition with `definePluginEntry()`, default export.

```ts
import { definePluginEntry } from '@octopi-agent/engine/plugin-sdk/plugin-entry';

export default definePluginEntry({
  id: 'my-plugin',
  name: 'My Plugin',
  description: 'What this plugin does',

  register(api) {
    // Register capabilities through the api
    api.on('gateway_start', async () => {
      api.logger.info('Plugin initialized');
    });
  },
});
```

---

## PluginApi in detail

`PluginApi` is the api object received in the `register()` callback. Plugins register all capabilities through it.

### Properties

| Property | Type | Description |
|------|------|------|
| `id` | string | Plugin ID |
| `name` | string | Plugin name |
| `version` | string? | Plugin version |
| `description` | string? | Plugin description |
| `source` | string | Entry file path |
| `rootDir` | string? | Plugin root directory |
| `pluginConfig` | Record<string, unknown> | User configuration (from config.json) |
| `logger` | PluginLogger | Prefixed logger |

### Registration methods

#### `api.on(hookName, handler, opts?)`

Register a hook handler. Hooks run in descending priority order.

```ts
api.on('before_tool_call', async (event) => {
  // Intercept logic
  return null; // allow
}, { priority: 50, timeoutMs: 5000 });
```

**Parameters:**

| Parameter | Type | Description |
|------|------|------|
| `hookName` | string | Hook name (see [Hook system](#hook-system)) |
| `handler` | (event) => Promise | Handler function |
| `opts.priority` | number | Priority; higher numbers run first (default 0) |
| `opts.timeoutMs` | number | Per-handler timeout in milliseconds (default 30000) |

#### `api.registerTool(definition, handler, opts?)`

Register an Agent Tool.

```ts
api.registerTool(
  {
    name: 'web_search',
    description: 'Search the web',
    parameters: {
      query: { type: 'string', description: 'Search query', required: true },
    },
  },
  async (args, ctx) => {
    return `Results for: ${args.query}`;
  },
  { optional: false },
);
```

#### `api.registerProvider(registration)`

Register an LLM Provider.

```ts
api.registerProvider({
  id: 'my-llm',
  provider: {
    name: 'my-llm',
    models: ['my-model-v1'],
    async complete(request) {
      return { content: 'response', model: 'my-model-v1', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    },
  },
});
```

#### `api.registerChannel(registration)`

Register a Channel Adapter.

```ts
api.registerChannel({
  id: 'my-channel',
  adapter: {
    name: 'my-channel',
    async send(reply) { /* ... */ },
    async receive(handler) { /* ... */ },
  },
});
```

#### `api.registerContextEngine(id, engine)`

Register a Context Engine (exclusive slot — only one active at a time).

#### `api.registerCommand(def)`

Register a Command (bypasses the LLM and executes directly).

```ts
api.registerCommand({
  name: 'clear',
  description: 'Clear session history',
  handler: async (event) => {
    // Clear logic
  },
});
```

#### `api.registerService(service)`

Register a background service (started when Gateway starts, stopped on shutdown).

```ts
api.registerService({
  id: 'health-checker',
  start: async () => { /* Start health check */ },
  stop: async () => { /* Stop health check */ },
});
```

#### `api.resolvePath(relativePath)`

Resolve a path relative to the plugin root.

```ts
const configPath = api.resolvePath('./config/default.json');
```

### Logger

`api.logger` provides prefixed log output:

```ts
api.logger.debug('Debug message');
api.logger.info('Info message');
api.logger.warn('Warning');
api.logger.error('Error');
// Output: [plugin:my-plugin] Info message
```

---

## Hook system

### Hook execution model

```
Handlers run in descending priority order

  priority: 100 ──→ handler_1()
                        │
                   non-null return? ──→ break chain, return result
                        │
                   return null ──→ continue
                        ▼
  priority: 50  ──→ handler_2()
                        │
                   non-null return? ──→ break chain, return result
                        │
                   return null ──→ continue
                        ▼
  priority: 0   ──→ handler_3()
                        │
                   return result
                        ▼
                   use defaultResult
```

**Key rules:**

- **Interception semantics**: a handler returns `null` / `undefined` → continue to the next handler
- **Interception semantics**: a handler returns a non-null value → break the chain; that value is the final result
- **Terminal detection**: returning `{ block: true }` / `{ cancel: true }` / `{ outcome: 'block' }` breaks immediately and skips remaining handlers
- **Timeout**: a single handler timeout is caught and does not affect later handlers
- **Exception**: a single handler exception is caught and does not affect later handlers

### Hook categories

| Hook | Type | Return value | Description |
|------|------|--------|------|
| `gateway_start` | Observe | — | Fired when Gateway starts |
| `gateway_stop` | Observe | — | Fired when Gateway stops |
| `session_start` | Observe | — | Fired when a Session is created |
| `session_end` | Observe | — | Fired when a Session ends |
| `message_received` | Observe | — | Fired when a channel message arrives |
| `message_sending` | Intercept | `{ cancel: true }` | Fired before a reply is sent |
| `message_sent` | Observe | — | Fired after a reply is sent |
| `before_model_resolve` | Intercept | `{ provider?, model? }` | Before the LLM call; may override the model |
| `before_prompt_build` | Inject | `{ prependContext?, systemPrompt? }` | Before prompt build (`runAgentLoop`); may inject context |
| `before_agent_run` | Intercept | `{ outcome: 'block', message? }` | Before Agent execution; may block |
| `before_agent_reply` | Intercept | `Message` | Before the LLM reply; may return a synthesized reply |
| `before_agent_finalize` | Intercept | `{ action: 'revise' }` | Before finalizing the reply; may request revision |
| `before_tool_call` | Intercept | `ToolCallResult` | Before Tool execution; may block/approve |
| `after_tool_call` | Observe | — | Fired after Tool execution |
| `agent_end` | Observe | — | Fired when Agent execution completes |
| `before_compaction` | Observe | — | Fired before Context compaction |
| `after_compaction` | Observe | — | Fired after Context compaction |
| `before_install` | Intercept | `{ block: true }` | Fired before Skill/Plugin install |

### Hook execution-site architecture

Hooks fall into two categories by execution site:

**Gateway-level Hooks** (called in `agent-runner.ts`)

These Hooks handle session lifecycle, message routing, and Agent-level interception:

| Hook | Execution site | Role |
|------|----------|------|
| `session_start` | resolveSession | When a new Session is created |
| `session_end` | Session expire/close | When a Session ends |
| `message_received` | AgentRunner | When a message reaches the Gateway |
| `before_agent_run` | AgentRunner.run | Before Agent execution; may block |
| `before_agent_reply` | AgentRunner.run | Before the LLM reply; may synthesize a reply |
| `before_agent_finalize` | AgentRunner.run | Before finalizing the reply; may revise |
| `agent_end` | AgentRunner.run | When Agent execution completes |
| `message_sending` | AgentRunner.run | Before sending a reply; may cancel |
| `message_sent` | AgentRunner.run | After a reply is sent |

**Loop-level Hooks** (called in `runAgentLoop`)

These Hooks handle iteration, tool execution, prompt build, and other Agent Loop internals:

| Hook | Execution site | Role |
|------|----------|------|
| `before_iteration` | Before each `runAgentLoop` iteration | Inject messages / override params / decide stop |
| `before_tool_call` | Before tool execution in `runAgentLoop` | Block / approve / override params |
| `after_tool_call` | After tool execution in `runAgentLoop` | Observe tool results |
| `before_prompt_build` | Before the LLM call in `runAgentLoop` | Inject context (RAG, memory) |
| `before_compaction` | Before context compaction in `runAgentLoop` | Observe pre-compaction state |
| `after_compaction` | After context compaction in `runAgentLoop` | Observe post-compaction state |

**Design notes**

- Gateway-level Hooks handle cross-session decisions (routing, approval, synthesized replies)
- Loop-level Hooks handle per-iteration decisions (tool execution, context injection)
- `before_iteration` absorbs the former `before_model_resolve` functionality (provider/model override)

### Hook Event and Result types

#### `before_tool_call`

```ts
// Event
interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  call: ToolCall;
  ctx: HookContext;
}

// Result
interface ToolCallResult {
  params?: Record<string, unknown>;     // Override params
  block?: boolean;                       // Block execution
  blockReason?: string;                  // Reason for blocking
  requireApproval?: {                    // Require user approval
    title: string;
    description: string;
    severity?: 'info' | 'warning' | 'critical';
    timeoutMs?: number;
    timeoutBehavior?: 'allow' | 'deny';
  };
}
```

#### `before_prompt_build`

Execution site: `runAgentLoop` — each iteration, before the LLM call.

```ts
// Event
interface BeforePromptBuildEvent {
  agentId: string;            // Agent ID
  sessionId: string;          // Session ID
  messages: Message[];        // Current conversation messages
  ctx: HookContext;           // Hook context
}

// Result
interface PromptBuildResult {
  prependContext?: string;      // Insert before messages
  appendContext?: string;       // Append after messages
  systemPrompt?: string;        // Override system prompt
  prependSystemContext?: string; // Prepend to system prompt
  appendSystemContext?: string;  // Append to system prompt
}
```

#### `before_agent_reply`

```ts
// Return Message → replace LLM reply
// Return null → let the LLM handle it normally
type AgentReplyResult = Message | null;
```

#### `message_sending`

```ts
// Result
interface MessageSendingResult {
  cancel: boolean;        // Cancel sending
  cancelReason?: string;  // Reason for cancellation
}
```

### Practical examples

#### Tool interception + Approval

```ts
api.on('before_tool_call', async (event) => {
  const { toolName } = event;

  if (toolName === 'shell') {
    return {
      requireApproval: {
        title: 'Execute shell command',
        description: `Tool "${toolName}" requires approval`,
        severity: 'warning',
        timeoutMs: 30000,
        timeoutBehavior: 'deny',
      },
    };
  }

  return null; // allow
}, { priority: 50 });
```

#### RAG context injection

```ts
api.on('before_prompt_build', async (event) => {
  const lastUser = event.messages
    .filter(m => m.role === 'user')
    .pop();

  if (!lastUser) return null;

  const results = await ragSearch(lastUser.content);
  if (results.length === 0) return null;

  return {
    prependContext: `<rag>\n${results.join('\n')}\n</rag>`,
  };
}, { priority: 10 });
```

#### Observation semantics (logging)

```ts
// No return value = no interception = all plugins run
api.on('after_tool_call', async (event) => {
  const { call, result } = event;
  api.logger.info(`Tool ${call.toolName}: ${result.isError ? 'FAIL' : 'OK'}`);
});
```

---

## Capability Ownership Model

Core principle: **the Plugin is the capability boundary**. Every provider, channel, and tool has exactly one owner.

### Why Capability Ownership?

1. **Know who owns what without loading code** — via the manifest `contracts` field
2. **Conflict detection** — error when two plugins register a tool with the same name
3. **Activation planning** — decide whether a plugin needs loading from its manifest
4. **Exclusive resource management** — some capabilities (such as a memory provider) may have only one active plugin at a time

### contracts declaration

```json
{
  "contracts": {
    "tools": ["web_search", "web_fetch"],
    "providers": ["openai", "anthropic"],
    "channels": ["telegram", "discord"],
    "embeddingProviders": ["openai-embedding"],
    "speechProviders": ["openai-tts"]
  }
}
```

### Conflict detection

```ts
const registry = new CapabilityRegistry();

registry.register('plugin-a', manifestA);
registry.register('plugin-b', manifestB);

// If both manifestA and manifestB declare ownership of the "web_search" tool
// → throws PluginConflictError
```

### Query capabilities

```ts
const owner = registry.getOwner('tools', 'web_search');
// → 'plugin-a'

const allTools = registry.getCapabilitiesByType('tools');
// → Map<string, string>  (capabilityId → pluginId)
```

### Exclusive slots

Some capability types (`kind: 'memory'`, `kind: 'context-engine'`) allow only one active plugin at a time:

```json
{
  "id": "sqlite-memory",
  "kind": "memory",
  "contracts": { "providers": ["sqlite-memory"] }
}
```

### Relationship between Capability and Hook

Capability and Hook are two independent but complementary mechanisms:

| Dimension | Capability | Hook |
|------|-----------|------|
| **Essence** | “What it is” — declares the capabilities a Plugin owns | “What it does” — registers event-handling logic |
| **Defined in** | `manifest.contracts` | `api.on()` inside the `register(api)` callback |
| **Runtime behavior** | None; pure registry lookup | Yes; intercept/observe logic runs by priority |
| **Conflict detection** | The same capability ID cannot be registered by two plugins | No conflict concept; every plugin’s handlers may register |

**Typical pattern:** after a Plugin declares a Capability, it usually registers related Hooks that implement that capability’s behavior.

```ts
// Declare capability (manifest.json)
// { "contracts": { "tools": ["web_search"] } }

// Implement capability behavior (register callback)
register(api) {
  api.registerTool(webSearchDef, webSearchHandler);

  // Also register a hook to enhance this capability's behavior
  api.on('before_tool_call', async (event) => {
    if (event.toolName === 'web_search') {
      // Perform additional security checks on the web_search tool
    }
    return null;
  });
}
```

**Note:** Capability declaration is optional. A Plugin may register only Hooks (no capability), or declare only Capabilities (no hooks, consumed by other Plugins). The two are orthogonal.

---

## Plugin loading flow

### Discovery

`PluginLoader` scans the configured `loadPaths` for directories containing `octopi.plugin.json`:

```
loadPaths/
  ├── tool-preflight/
  │   ├── octopi.plugin.json  ← discovered
  │   └── index.ts
  ├── tool-logger/
  │   ├── octopi.plugin.json  ← discovered
  │   └── index.ts
  └── not-a-plugin/
      └── random.txt           ← skipped
```

### Validation

Each discovered manifest is validated:

1. JSON is well-formed
2. Required fields exist (`id`, `configSchema`)
3. `requiresPlugins` dependencies are satisfied
4. No contracts conflicts

### Loading

Dynamically `import()` the entry file and take the default export:

```ts
const entry = await import(path.join(pluginDir, 'index.ts'));
const pluginDef = entry.default; // OctopiPluginDefinition
```

### Registration

Create a `PluginApi` instance and call `register(api)`:

```ts
const api = new PluginApi({
  id: manifest.id,
  name: manifest.name,
  source: entryPath,
  rootDir: pluginDir,
  pluginConfig: config,
});

await pluginDef.register(api);

// api._hooks, api._tools, api._providers etc. are now populated
```

### Creating a Plugin directly in code

When not loading from the filesystem, create one with `definePluginEntry()`:

```ts
import { definePluginEntry } from '@octopi-agent/engine/plugin-sdk/plugin-entry';

const myPlugin = definePluginEntry({
  id: 'inline-plugin',
  name: 'Inline Plugin',
  register(api) {
    api.on('gateway_start', async () => {
      api.logger.info('Inline plugin ready');
    });
  },
});
```

---

## Configuration system

### User config files

Each plugin may have its own config file; the directory is set via `PluginLoaderConfig.configDir`:

```
config-dir/
  tool-preflight.json    ← corresponds to plugin id
  tool-logger.json
```

The config file is a JSON object matching the structure defined by `configSchema` in the manifest:

```json
// tool-preflight.json
{
  "blockedTools": ["eval", "exec"],
  "requireApprovalFor": ["shell", "file_write"]
}
```

### Config injection

Configuration is passed into the `register()` callback via `api.pluginConfig`:

```ts
register(api) {
  const config = api.pluginConfig;
  const blocked = (config.blockedTools as string[]) ?? [];

  api.on('before_tool_call', async (event) => {
    if (blocked.includes(event.toolName)) {
      return { block: true };
    }
    return null;
  });
}
```

### Activation config

The `activation` field in the Manifest controls when a plugin is loaded:

```json
{
  "activation": {
    "onStartup": true,
    "onProviders": ["openai"],
    "onCommands": ["clear"],
    "onChannels": ["telegram"],
    "onConfigPaths": ["providers.openai"],
    "onCapabilities": ["provider", "tool"]
  }
}
```

| Field | Description |
|------|------|
| `onStartup` | Load when Gateway starts |
| `onProviders` | Load when the specified provider is configured |
| `onCommands` | Load when the user uses the specified command |
| `onChannels` | Load when the specified channel is configured |
| `onConfigPaths` | Load when the specified config path has a value |
| `onCapabilities` | Load when the specified capability type is needed |

---

## Complete examples

### Example 1: Tool Preflight Plugin

Intercepts tool calls and supports an approval mechanism.

**`octopi.plugin.json`:**

```json
{
  "id": "tool-preflight",
  "name": "Tool Preflight",
  "description": "Intercept and validate tool calls, with approval support",
  "version": "1.0.0",
  "configSchema": {
    "type": "object",
    "properties": {
      "requireApprovalFor": {
        "type": "array",
        "items": { "type": "string" }
      },
      "blockedTools": {
        "type": "array",
        "items": { "type": "string" }
      }
    }
  },
  "activation": {
    "onStartup": true
  }
}
```

**`index.ts`:**

```ts
import { definePluginEntry } from '@octopi-agent/engine/plugin-sdk/plugin-entry';

export default definePluginEntry({
  id: 'tool-preflight',
  name: 'Tool Preflight',
  description: 'Intercept and validate tool calls, with approval support',

  register(api) {
    const config = api.pluginConfig;
    const blockedTools = (config.blockedTools as string[]) ?? [];
    const requireApprovalFor = (config.requireApprovalFor as string[]) ?? [];

    // priority: 50 — runs before the default priority 0
    api.on('before_tool_call', async (event: any) => {
      const toolName = event.toolName;

      if (blockedTools.includes(toolName)) {
        api.logger.warn(`Blocked tool call: ${toolName}`);
        return {
          block: true,
          blockReason: `Tool "${toolName}" is blocked by policy`,
        };
      }

      if (requireApprovalFor.includes(toolName)) {
        api.logger.info(`Requiring approval for tool: ${toolName}`);
        return {
          requireApproval: {
            title: `Approve tool: ${toolName}`,
            description: `Tool "${toolName}" requires user approval`,
            severity: 'warning',
            timeoutMs: 30000,
            timeoutBehavior: 'deny',
          },
        };
      }

      return null; // allow
    }, { priority: 50 });

    api.on('gateway_start', async () => {
      api.logger.info('Tool Preflight initialized');
    });
  },
});
```

### Example 2: Tool Logger Plugin

Observation-semantics hooks — log all tool calls without intercepting.

**`index.ts`:**

```ts
import { definePluginEntry } from '@octopi-agent/engine/plugin-sdk/plugin-entry';

export default definePluginEntry({
  id: 'tool-logger',
  name: 'Tool Logger',
  description: 'Log all tool calls and message events',

  register(api) {
    // Low priority, ensures it runs after other plugins
    api.on('before_tool_call', async (event: any) => {
      api.logger.debug(`→ ${event.toolName}(${JSON.stringify(event.params).slice(0, 100)})`);
    }, { priority: -10 });

    api.on('after_tool_call', async (event: any) => {
      const status = event.result.isError ? 'FAIL' : 'OK';
      api.logger.info(`← ${event.call.toolName} → ${status}`);
    });

    api.on('session_start', async (event: any) => {
      api.logger.info(`Session started: ${event.sessionId}`);
    });
  },
});
```

### Example 3: Cross-hook orchestration Plugin

Full hook orchestration — `after_tool_call` records tool failures, `before_prompt_build` injects troubleshooting hints.

```ts
import { definePluginEntry } from '@octopi-agent/engine/plugin-sdk/plugin-entry';

export default definePluginEntry({
  id: 'focus-context',
  name: 'Focus Context',
  description: 'Inject troubleshooting hints into this turn after a tool call fails',

  register(api) {
    const pendingContext = new Map<string, string>();

    // Tool failure → stash a troubleshooting hint (session key is ctx.sessionId)
    api.on('after_tool_call', async (event: any) => {
      if (event.result?.isError) {
        pendingContext.set(
          event.ctx.sessionId,
          `The previous ${event.call.toolName} call failed: verify the path and parameters before continuing.`
        );
      }
      return null;
    });

    // priority: 10 — runs before the default 0
    api.on('before_prompt_build', async (event: any) => {
      const tip = pendingContext.get(event.ctx.sessionId);
      if (!tip) return null;

      pendingContext.delete(event.ctx.sessionId); // delete after use
      return { prependContext: tip };
    }, { priority: 10 });
  },
});
```

---

## Subpath exports

Subpath exports (`@octopi-agent/engine/plugin-sdk/*`):

```ts
// Plugin entry definition
import { definePluginEntry, defineChannelPluginEntry } from '@octopi-agent/engine/plugin-sdk/plugin-entry';
import type { OctopiPluginDefinition, OctopiChannelPluginDefinition } from '@octopi-agent/engine/plugin-sdk/plugin-entry';

// Plugin API
import { PluginApi } from '@octopi-agent/engine/plugin-sdk/api';
import type { PluginLogger, HookRegistrationOptions } from '@octopi-agent/engine/plugin-sdk/api';

// Manifest
import { validateManifest, parseManifest } from '@octopi-agent/engine/plugin-sdk/manifest';
import type { PluginManifest, PluginContracts } from '@octopi-agent/engine/plugin-sdk/manifest';

// Capability Registry
import { CapabilityRegistry } from '@octopi-agent/engine/plugin-sdk/capability';

// Plugin Loader
import { PluginLoader } from '@octopi-agent/engine/plugin-sdk/loader';
import type { LoadedPlugin, PluginLoaderConfig } from '@octopi-agent/engine/plugin-sdk/loader';

// Plugin Manager (top-level)
import { PluginManager } from '@octopi-agent/engine/plugin-sdk/manager';
```

You can also import from the main entry:

```ts
import { PluginManager, definePluginEntry, PluginApi } from 'octopi-agent';
```

---

## API reference

### `definePluginEntry(definition)`

Creates a Plugin definition. Returns the passed definition object (with validation).

**Parameter validation:**
- `id` — required, string
- `name` — required, string
- `register` — required, function

### `defineChannelPluginEntry(definition)`

Creates a Channel Plugin definition. Additionally validates that `channelId` is required.

### `PluginManager`

Top-level manager.

| Method | Returns | Description |
|------|--------|------|
| `discover()` | `Promise<LoadedPlugin[]>` | Discover and load all plugins |
| `getAllPlugins()` | `LoadedPlugin[]` | Get all loaded plugins |
| `getRegisteredIds()` | `string[]` | Get registered plugin IDs |
| `getPlugin(id)` | `LoadedPlugin?` | Get a specific plugin |
| `runHook(hookName, event, defaultResult, config?)` | `Promise<T>` | Run the named hook (interception semantics) |
| `runAllHooks(hookName, event)` | `Promise<void>` | Run the named hook (observation semantics) |
| `getProviders()` | `Array` | Get all registered providers |
| `getChannels()` | `Array` | Get all registered channels |
| `getTools(includeOptional?)` | `Array` | Get all registered tools |
| `getContextEngines()` | `Array` | Get all registered context engines |
| `getCommands()` | `Array` | Get all registered commands |
| `getServices()` | `Array` | Get all registered services |
| `onGatewayStart(config?, workspaceDir?)` | `Promise<void>` | Fire gateway_start + start services |
| `onGatewayStop()` | `Promise<void>` | Fire gateway_stop + stop services |
| `capabilities` | `CapabilityRegistry` | Capability registry |

### `PluginApi`

The api object received in the register() callback.

| Method | Description |
|------|------|
| `on(hookName, handler, opts?)` | Register a hook handler |
| `registerTool(definition, handler, opts?)` | Register an Agent Tool |
| `registerProvider(registration)` | Register an LLM Provider |
| `registerChannel(registration)` | Register a Channel Adapter |
| `registerContextEngine(id, engine)` | Register a Context Engine |
| `registerCommand(def)` | Register a Command |
| `registerService(service)` | Register a background service |
| `resolvePath(relativePath)` | Resolve a relative path |

### `CapabilityRegistry`

| Method | Description |
|------|------|
| `register(pluginId, manifest)` | Register a plugin’s capability declarations |
| `unregister(pluginId)` | Remove a plugin’s capability declarations |
| `getOwner(type, id)` | Get the owner plugin ID of a capability |
| `getCapabilitiesByType(type)` | Get all capabilities of a type |
| `getPluginCapabilities(pluginId)` | Get all capability declarations of a plugin |
| `hasCapability(type, id)` | Check whether a capability exists |
| `assertNoConflicts(pluginId, manifest)` | Assert there are no conflicts |
| `hasExclusiveSlotConflict(kind, manifest)` | Check for exclusive-slot conflicts |
| `listConflicts()` | List all conflicts |

### `PluginLoader`

| Method | Description |
|------|------|
| `discover()` | Discover and load all plugins |
| `getAllPlugins()` | Get all loaded plugins |
| `getRegisteredIds()` | Get registered plugin IDs |
| `getPlugin(id)` | Get a specific plugin |
| `capabilities` | CapabilityRegistry instance |

### `LoadedPlugin`

```ts
interface LoadedPlugin {
  id: string;
  manifest: PluginManifest;
  definition: OctopiPluginDefinition;
  api: PluginApi;
  registered: boolean;
  source: string;
  config?: Record<string, unknown>;
}
```

---

_Last updated: 2026-06-02_
