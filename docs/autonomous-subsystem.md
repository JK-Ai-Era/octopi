# Autonomous Subsystems — Developer Guide

> This document is for subsystem authors. It describes how to write a subsystem spec, capability boundaries, and audit conventions.

---

## 1. Subsystem directory structure

```
# Single-spec package
subsystems/my-subsystem/
├── config.yaml           # Runtime config (required)
├── SUBSYSTEM.md          # LLM cognitive instructions (system prompt; required for llm; code injects it into the handler)
├── handler.ts            # Code logic (required for code/hybrid mode)
├── references/           # Reference knowledge (optional; loader does not scan it yet)
└── scripts/              # Auxiliary scripts (optional)

# Multi-spec package (multiple subsystems + shared code under one package)
subsystems/memory-steward/
├── shared/               # Shared policy (loader skips; handlers relatively import)
├── backfill/
│   ├── config.yaml       # id: memory.steward.backfill
│   ├── SUBSYSTEM.md
│   └── handler.ts
└── govern/
    ├── config.yaml       # id: memory.steward.govern
    ├── SUBSYSTEM.md
    └── handler.ts
```

**Loader rules**:

- If a first-level directory under the search root contains `config.yaml`/`SUBSYSTEM.md` → single-spec package
- Otherwise scan its subdirectories; subdirectories that contain a spec are `loadOne`d separately; `shared`/`lib`/`references`/`scripts` are silently skipped
- `packageId` = package directory name (e.g. `memory-steward` or `safety-guard`); `packageRoot` = package path
- allow/deny supports: full id (`memory.steward.govern`), packageId (`memory-steward`), prefix (`memory.steward.*`)

**Role of SUBSYSTEM.md**: same family as a main Agent's SKILL.md — Markdown cognitive instructions.

| implementation | How the body takes effect |
|----------------|--------------|
| `llm` / `hybrid` | → `think.systemPrompt` → the framework Agent's system prompt |
| `code` | Injected into the handler as `deps.__subsystem_prompt__`, and used as the default system for `llmPort.chat()` |

Author docs (dependency tables, observability, recovery policy, etc.) belong in `README.md`, not `SUBSYSTEM.md`.

Subsystems can be loaded from the following locations (by priority; same-name overrides):

| Location | Scope | Managed by |
|------|--------|--------|
| `<project>/.octopi/subsystems/` | Project | Project team |
| `~/.octopi/subsystems/` | User | Individual user |
| `<octopi-bundle>/subsystems/` | Framework | octopi team |
| `node_modules/@octopi-agent/subsystem-*` | npm | npm packages |
| `node_modules/octopi-subsystem-*` | npm | Community packages |

---

## 2. Explicit required fields

The following three fields **must be declared explicitly** in `config.yaml`; missing fields cause load failure:

```yaml
# Required
act:
  mode: none | block | modify | inject

signal:
  severity: info | advisory | warning | critical
  channel: [event, context, steering, escalate]

boundary:
  visibility: isolated | structured | partial | full
  authority: observe | suggest | act | override
  security: sandboxed | trusted | privileged
```

The framework provides no defaults for these three fields. This is a design constraint — a subsystem's capability boundary must be declared explicitly.

> **`boundary.security` status**: currently an author declaration and documentation contract. The runtime does **not yet** perform differentiated I/O checks or sandboxing by level. Hard constraints are carried by `authority` (limits act.mode) and `visibility` (trims input).

---

## 3. Signal channels (signal.channel)

`signal.channel` decides how signals are delivered to the main system. The framework routes strictly by configuration and no longer infers from action alone:

| Channel | Semantics | Timing |
|------|------|------|
| `context` | Injected as context information | Takes effect before the next LLM call (`applyPendingInjections`) |
| `steering` | Injected as a guidance message | Takes effect immediately in the current turn (Runner `consumePendingGuidance`) |
| `event` | Broadcast via EventBus | Asynchronous; other subsystems can listen |
| `escalate` | Request main-system intervention | Prioritized in the current turn (same as steering; escalate section is placed first) |

Example:

```yaml
signal:
  severity: advisory
  channel: [context, event]   # signal is injected as context and broadcast as an event
```

---

## 4. Lifecycle constraints (lifecycle)

```yaml
lifecycle:
  maxDurationMs: 15000        # timeout interrupt (ms); audit records status=timeout on expiry
  maxTokens: 10000            # token budget cap (estimated from input/output size)
  maxConcurrent: 1            # maximum concurrent instances
  degradeOn: timeout | error | both   # degradation policy
```

- `maxDurationMs`: code handlers are also aborted via AbortSignal, not only LLM mode.
- `degradeOn`: decides whether to send a signal on interrupt. On `timeout` nothing is sent (the subsystem did not finish; there is no valid signal); on `error`/`both` an interrupt signal is sent.
- `maxTokens`: estimated on the `HeuristicTokenEstimator` basis. If the input estimate already exceeds the budget before execution, it fails immediately; the LLM path re-validates against real usage after return. Overflow is handled by the `degradeOn` policy.

---

## 5. Conditional triggering (condition / conditionRef)

### 5.1 Declarative condition

```yaml
sense:
  source: eventBus
  filter:
    events: [iteration.end]
    condition: "turn.count % 10 === 0"
```

- Variable names map to `ctx.metrics[key]`, injected by the main loop.
- Supports multiple variables and dot-separated keys (e.g. `sessionLifecycle === 'recent'`).
- Mutually exclusive with `conditionRef`.

### 5.2 Code reference conditionRef

```yaml
sense:
  source: eventBus
  filter:
    events: [session.lifecycle.updated]
    conditionRef: "./handler.ts:shouldExtract"
```

- Format: `<modulePath>:<exportName>`
- Function signature: `(ctx: SenseContext) => boolean | Promise<boolean>`
- The framework dynamically imports and caches the first load result.
- Mutually exclusive with `condition`.

### 5.3 schedule timed sensing

```yaml
sense:
  source: schedule
  interval: 60000          # milliseconds; must be >= 1000
  isolation: structured
  filter:
    condition: "turn.count > 0"   # optional
```

- `interval` is required and must be ≥ 1000ms, otherwise registration fails.
- When the interval fires, it reuses the same cooldown, propagation depth, condition / conditionRef and `onTrigger` as eventBus.
- `unregister` / `dispose` tears down the corresponding timer.
- cron syntax is a separate topic and is not yet on the main path.

---

## 6. Loop protection (emits declaration)

### 6.1 Why emits is needed

When subsystems trigger each other through EventBus signals, a cycle can form: A → B → A. The framework performs static detection at registration time.

### 6.2 How to declare

```yaml
sense:
  filter:
    events: [session.lifecycle.updated]
    emits: [memory.steward.backfilled]     # event types this subsystem may produce
```

Or declare at the top level (higher precedence):

```yaml
emits: [memory.steward.backfilled]
sense:
  filter:
    events: [session.lifecycle.updated]
```

### 6.3 Wildcard

When an LLM-driven subsystem cannot statically determine its emitted events, it may declare a wildcard:

```yaml
emits: ["*"]   # may produce any listened event (conservative participation in multi-node cycle detection)
```

- `*` is **not** rejected for a "self-loop" (eventBus listen + `emits: ['*']` registers fine).
- `*` **is still** rejected when it forms a multi-node cycle with other subsystems.
- When you can name the event types precisely, prefer concrete `emits`.

### 6.4 Detection behavior

- At registration, build the emits → listen dependency graph.
- Self-loop: reject when `listen ∩ emit` concrete events overlap.
- Multi-node cycle: DFS on the dependency graph; on discovery, reject and return the path.
- Three-layer protection: static detection (startup) + depth limit (runtime, default 5) + cooldown (per subsystem, default 5 seconds).

---

## 7. Custom tools (tools.definitions)

### 7.1 Four modes

```yaml
tools:
  mode: none | subset | full | custom
```

| Mode | Semantics |
|------|------|
| `none` | No tools (default) |
| `subset` | Subset of the main Agent tool set (requires `names`) |
| `full` | Inherit all main Agent tools |
| `custom` | Fully custom tool set (requires `definitions`) |

### 7.2 Register in code

```typescript
import { SubsystemRuntime } from '@octopi-agent/engine';

runtime.register({
  id: 'my-sub',
  // ...
  tools: {
    mode: 'custom',
    definitions: [
      {
        definition: {
          name: 'analyze',
          description: 'Analyze content',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Input text' },
            },
            required: ['text'],
          },
        },
        handler: async (args, ctx) => {
          return { result: `analyzed: ${args.text}` };
        },
      },
    ],
  },
});
```

### 7.3 Declare in YAML

```yaml
tools:
  mode: custom
  definitions:
    - name: analyze
      description: "Analyze content"
      parameters:
        type: object
        properties:
          text:
            type: string
            description: "Input text"
        required: [text]
```

> **Note**: YAML-declared definitions contain no runtime handler. If the LLM calls such a tool, it throws "does not have a runtime handler". A complete custom tool must be registered in code, or provide an executable script under `scripts/`.

### 7.4 LLM capability for code handlers (llmPort)

The framework **always** injects a unified LLM port and cognitive prompt into `handler(input, deps)`; no `runtimeInject` declaration is required:

| deps key | Constant | Meaning |
|---------|------|------|
| `llmPort` | `DEP_LLM_PORT` | Unified LLM port: `chat()` + full fallback chain |
| `__subsystem_prompt__` | `DEP_SUBSYSTEM_PROMPT` | `SUBSYSTEM.md` body |
| `__resolved_model__` | `DEP_RESOLVED_MODEL` | Resolved primary model name |
| `__resolved_models__` | `DEP_RESOLVED_MODELS` | `{ primary, fallback, fromLevel }` |

```typescript
import type { SubsystemLLMPort } from '@octopi-agent/engine';

export async function handler(input, deps) {
  const port = deps.llmPort as SubsystemLLMPort;
  // Default system = SUBSYSTEM.md; override per call if needed
  const res = await port.chat({
    messages: [{ role: 'user', content: 'Extract memory from this conversation…' }],
    // systemPrompt: 'temporary override',
    // model: 'mini',
    temperature: 0.3,
    maxTokens: 2048,
  });
  // res.content / res.usage
}
```

`runtimeInject.requires` remains for business dependencies (e.g. `memoryStore`). `modelProvider` may still be used; prefer `llmPort` for new code.

**API trigger**: `SubsystemRuntime.trigger(id, senseCtx?)` → `{ triggered, status }`. Sense overrides such as `eventData.bundle` may be passed; `status` is the run terminal state (`failed`/`timeout` ≠ business success).

**implementation semantics**: `code` = the handler orchestrates itself (may call `llmPort`); `llm`/`hybrid` = the framework runs the Agent loop with the same model resolution.

---

## 8. npm subsystem distribution

### 8.1 Naming

- Official: `@octopi-agent/subsystem-<name>`
- Community: `octopi-subsystem-<name>`

### 8.2 Package structure

```
@octopi-agent/subsystem-safety-guard/
├── package.json          # name: "@octopi-agent/subsystem-safety-guard"
├── config.yaml
├── SUBSYSTEM.md
├── handler.ts
└── references/
```

### 8.3 Usage

```sh
npm install @octopi-agent/subsystem-safety-guard
```

At startup the framework automatically scans `node_modules/` for packages matching the naming convention and merges them with project/user/framework-level subsystems.

---

## 9. Session isolation and teardown

```yaml
session:
  mode: ephemeral | persistent
  scope: global | agent | session
  ttl: "24h"
```

| scope | Semantics |
|-------|------|
| `global` | All Agents, all Sessions share one persistent session |
| `agent` | Shared across Sessions for the same Agent |
| `session` | Independent per main Session |

For subsystems with `session.scope=session`, the subsystem session is cleaned up automatically when the main session ends (on the `session.ended` event), avoiding cross-session pollution.

---

## 10. Audit records

Every execution writes an audit record (success or failure). Path:

```
~/.octopi/audit/[agentId/]<subsystemId>/<date>.jsonl
```

Key fields:

| Field | Notes |
|------|------|
| `status` | `success / failed / timeout / degraded` |
| `input` | Subsystem input snapshot |
| `output` | Subsystem output (may be empty on failure) |
| `signals` | List of signals emitted |
| `acts` | List of direct actions performed |
| `tokenUsage` | Token consumption (success path estimated from input/output size) |
| `durationMs` | Execution duration |
| `sessionKey` | Session identifier |
