# Octopi 🐙

**An Embeddable Agent Runtime Framework**

> An agent is not a class — it's a complete runtime.
> A session is not a chat log — it's a full interaction lifecycle.
> A framework's value lies not in how many defaults it ships, but in how many clean interfaces it defines.

[中文文档](./README_CN.md)

---

## Why Octopi

Most agent frameworks give you a monolith: a fixed agent loop, a fixed session model, a fixed set of integrations. You can use them as-is, but the moment you need something different — a custom context pipeline, a different storage backend, an embedded agent inside your own product — you're fighting the framework.

Octopi takes a different approach. It's a **runtime toolkit** built from first principles:

- **AgentEngine** — a stateless message loop (input → context assembly → model inference → tool execution → output)
- **Session management** — lifecycle, persistence, concurrency control, all pluggable
- **Multi-provider LLM** — OpenAI, Anthropic, or any provider implementing the `ModelProvider` interface
- **Plugin system** — full lifecycle hooks with interceptor and observer semantics
- **Task system** — LLM-driven task tracking, context recovery, and autonomous planning
- **Security built-in** — injection detection, sensitive data filtering, trust levels — not optional, not removable

Use it to build a CLI bot, a web app AI backend, an embedded assistant, or something you haven't imagined yet.

---

## Architecture: Three-Layer Onion

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 3: Integration                                        │
│  Protocols · Storage Backends · Observability                │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Layer 2: Harness                                        │ │
│  │  Persona · Plugin · Skill · Task · Planner               │ │
│  │  Strategy · Resources · Security Policy · Builder        │ │
│  │                                                          │ │
│  │  ┌─────────────────────────────────────────────────────┐ │ │
│  │  │  Layer 1: Core                                       │ │ │
│  │  │  AgentEngine · EventBus · SecurityGuard · Budget     │ │ │
│  │  │  AsyncTask · ProcessModel · Interfaces               │ │ │
│  │  └─────────────────────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Dependency direction: outer → inner. The core never knows about the harness.**

### Core (Layer 1) — Pure Engine

Zero implementation dependencies. Just interfaces and the minimal agent loop.

| Component | Responsibility |
|---|---|
| `AgentEngine` | Stateless loop engine — the heart of the framework |
| `EventBus` | Full-chain observability via typed events |
| `SecurityGuard` | Injection detection + sensitive data filtering (non-disableable) |
| `IterationBudget` | Resource constraints: iterations, tool calls, tokens, time |
| `AsyncTask` | Async primitive: cancel, timeout, retry, persistence |
| `ProcessModel` | Agent process model: lifecycle, spawn, IPC |
| `ModelProvider` | LLM call interface |
| `ToolExecutor` | Tool execution interface |
| `ContextPipeline` | Context assembly pipeline interface |
| `ErrorStrategy` | Error classification and recovery interface |

### Harness (Layer 2) — Assembly Layer

Where the agent gets its personality, tools, and intelligence.

| Component | Responsibility |
|---|---|
| `AgentBuilder` | Fluent API — one line to launch an agent |
| `SessionAwareRunner` | Session lifecycle: locks, persistence, reset |
| `PersonaLoader` | File-based persona system (AGENTS.md, SOUL.md, etc.) |
| `DefaultContextPipeline` | Pluggable pipeline: Persona → Skill → Task → History → Knowledge → Filter |
| `AgentSupervisor` | Persistent agent core: Perceive → Think → Act → Reflect |
| `TaskTracker` / `TaskManager` | LLM-driven task tracking and recovery |
| `RulePlanner` / `LLMPlanner` / `HybridPlanner` | Planning: rule-driven, LLM-driven, or hybrid |
| `TaskScheduler` | Scheduling: once, interval, cron, at |
| `MemoryKnowledgeStore` | Knowledge CRUD, keyword search, confidence filtering |
| `LLMReflector` | Quality assessment, pattern recognition, experience storage |
| `RuleTaskClassifier` | 7 task types × 3 complexity levels |
| `DefaultStrategyRouter` | 6 reasoning strategies: direct, chain-of-thought, plan-and-execute, tool-use, reflect, multi-agent |
| `ResourceManager` | Token budget, cost tracking, rate limiting |
| `CapabilityEnforcer` | Plugin trust-level runtime enforcement |
| `SecurityPresets` | Preset policies: development / testing / production / maximum |

### Integration (Layer 3) — Connectors

Protocol adapters, storage backends, observability.

| Component | Responsibility |
|---|---|
| `JsonlSessionStore` | JSONL file storage (default) |
| `InMemorySessionStore` | In-memory storage (testing) |
| `NoopObserver` | Zero-overhead no-op observer |
| `LogObserver` | Logging observer for development |
| `TraceLogger` | Structured event logging with level filtering |
| `TraceCollector` | Auto-collect engine events into trace |
| `ConsoleExporter` / `JsonlFileExporter` / `WebhookExporter` | Trace export backends (Exporter SPI) |
| `MetricsAggregator` | LLM/token/latency/cost metrics from event stream |
| `RecordingProvider` | Record real LLM interactions for replay |
| `ReplayProvider` | Replay recorded interactions (deterministic testing) |
| `ChaosProvider` | Fault injection: empty response, timeout, rate-limit, malformed |
| `ScenarioRunner` | E2E scenario testing with built-in assertions |
| `ScenarioComposer` | Compose, extend, parameterize test scenarios |

---

## Quick Start

```typescript
import { AgentBuilder } from 'octopi';
import { OpenAIProvider } from 'octopi';

const { engine, runner } = await new AgentBuilder()
  .model(new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }))
  .persona('./my-agent')
  .build();

// Process a message
for await (const event of runner.handle('session-1', userMessage)) {
  console.log(event);
}
```

### With custom storage

```typescript
import { AgentBuilder } from 'octopi';

const { engine, runner } = await new AgentBuilder()
  .model('gpt-4')
  .store(new RedisSessionStore({ host: 'localhost' }))
  .build();
```

### Event subscription

```typescript
import { AgentEvents } from 'octopi';

engine.deps.events.on(AgentEvents.MODEL_CALL_END, (event) => {
  console.log(`Model call: ${event.data.durationMs}ms`);
});

engine.deps.events.on(AgentEvents.INJECTION_DETECTED, (event) => {
  console.warn(`Injection detected: ${event.data}`);
});
```

### Security policy

```typescript
import { AgentBuilder, SecurityPresets } from 'octopi';

const { engine } = await new AgentBuilder()
  .model('gpt-4')
  .securityPolicy(SecurityPresets.production)
  .build();
```

---

## Design Principles

### AgentEngine is stateless

The engine doesn't hold session state. Message history is passed in by the caller, results are returned as an async generator. This means:

- **Testable** — no need to mock a session store
- **Reusable** — the same engine works with or without sessions
- **Separation of concerns** — "how to loop" and "how to store" are independent problems

### Persona is file-based

```
my-agent/
├── AGENTS.md    ← Operating instructions
├── SOUL.md      ← Personality traits
├── IDENTITY.md  ← Identity definition
└── USER.md      ← User context
```

No schema, no config format. Just markdown files. Extension = add a file. Composition = overlay directories.

### Security is built-in, not bolted on

- **SecurityGuard** cannot be disabled — injection detection + sensitive data filtering
- **IterationBudget** cannot be bypassed — hard resource constraints
- **CapabilityEnforcer** — runtime trust-level enforcement for plugins

### Plugin system with dual semantics

Plugins support both **interceptor** semantics (return a value to short-circuit the chain) and **observer** semantics (all handlers execute). Hooks are prioritized, with per-handler timeout support.

```typescript
import { definePluginEntry } from 'octopi/plugin-sdk/plugin-entry';

export default definePluginEntry({
  id: 'my-plugin',
  name: 'My Plugin',
  register(api) {
    api.on('before_tool_call', async (event) => {
      if (event.toolName === 'shell') {
        return { requireApproval: { title: 'Execute shell', severity: 'warning' } };
      }
      return null; // pass through
    }, { priority: 50 });
  },
});
```

### Task system — Agent's working memory

LLM-driven task tracking. When a user drifts to a different topic and comes back, the agent automatically recovers context:

```typescript
import { TaskTracker, TaskManager } from 'octopi/harness';

// Integrated via ContextPipeline's TaskStage
// The agent sees task context in the system prompt and naturally decides how to proceed
```

---

## What We Learned from OpenClaw

Octopi started as an exploration of OpenClaw's architecture. OpenClaw is a full-featured AI assistant platform — it handles channels, memory, heartbeats, plugins, and more. We learned a great deal from studying its design:

- **Plugin hook semantics** — OpenClaw's dual interceptor/observer pattern is elegant and practical. We adopted the same model.
- **Persona as files** — The AGENTS.md / SOUL.md pattern proved to be a powerful way to define agent behavior without code.
- **Context pipeline thinking** — The idea of assembling context through a staged pipeline (rather than a single monolithic prompt builder) is something we refined from OpenClaw's approach.
- **Session as first-class citizen** — OpenClaw treats sessions seriously, not as afterthoughts. We took this further by making session management completely pluggable.

Where we diverged:

| Aspect | OpenClaw | Octopi |
|---|---|---|
| **Scope** | Full AI assistant platform | Embeddable runtime toolkit |
| **Architecture** | Integrated system | Three-layer separation (Core / Harness / Integration) |
| **Agent model** | Class-based with state | Stateless engine + pluggable session |
| **Coupling** | Platform-bound (channels, memory, scheduling) | Zero platform dependencies in Core |
| **Target user** | End users building assistants | Developers embedding agents in products |
| **Extensibility** | Plugin system | Plugin system + pluggable interfaces at every layer |

OpenClaw is a great project. Octopi is what happens when you ask: "What if we extracted just the runtime and made it composable?"

---

## Testing

```bash
npm test
# 428 tests passed
```

### Test Pyramid

| Layer | Tool | Description |
|---|---|---|
| L1: Unit | Mock + Vitest | Fast, deterministic, every save |
| L2: Record/Replay | RecordingProvider + ReplayProvider | Record real interactions, replay for regression |
| L3: E2E | ScenarioRunner + ChaosProvider | Real API, fault injection, full scenarios |

### Observability

```json
{
  "observability": {
    "level": 3,
    "consoleLevel": 2,
    "traceDir": "~/.octopi/traces",
    "exporters": [
      { "type": "jsonl-file", "dir": "~/.octopi/traces" },
      { "type": "webhook", "url": "https://monitoring.example.com/ingest" }
    ]
  }
}
```

Trace levels: `FATAL(0)` → `ERROR(1)` → `WARN(2)` → `INFO(3)` → `DEBUG(4)` → `TRACE(5)`

---

## Tech Stack

- **Language:** TypeScript (ESM, Node.js >=20)
- **Build:** tsc
- **Test:** Vitest (node --experimental-vm-modules)

---

## Documentation

| Document | Content |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | Design philosophy, three-layer architecture, decision records |
| [Plugin System](docs/plugin-system.md) | Hook semantics, capability ownership, examples |
| [Task System](docs/task-system.md) | Task management, LLM decision maker, state machine |
| [Refactoring Plan](docs/REFACTORING-PLAN.md) | Three-layer refactoring strategy and migration path |
| [Migration Audit](docs/MIGRATION-AUDIT.md) | Code migration status, priorities, progress |
| [Development Guide](docs/development-guide.md) | Setup, conventions, testing |

---

## License

MIT
