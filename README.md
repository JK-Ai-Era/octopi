# Octopi 🐙

**The Embeddable Agent Engine**

> An agent is not a class — it's a complete runtime.
> A session is not a chat log — it's a full interaction lifecycle.
> A framework's value lies not in how many defaults it ships, but in how many clean interfaces it defines.

[中文文档](./README_CN.md)

---

## The Future of Software

What will the future look like? What will future software look like?

The way users interact with systems may change fundamentally. The logic that drives systems may change. A large portion of business logic may no longer be code-driven, but LLM-driven. But LLMs are fundamentally stateless content generation models — they may know all the world's knowledge, yet they don't know the specifics of your work, and they can't directly read or write data on your computer. To make an LLM truly work for you, it needs **senses** — to perceive your environment and context; it needs **hands** — to operate files, call APIs, execute commands; it needs **memory** — to remember who you are, what you've done, and what you prefer.

So how will software evolve? Will rich graphical interfaces simply be replaced by a chat window?

We don't think so. Graphical interfaces still offer irreplaceable advantages in information density, interaction efficiency, and operational convenience. A well-designed dashboard, a structured data table, a smooth drag-and-drop workflow — none of these are easily replaced by a chat box.

**Future software shouldn't replace all interfaces with chat windows and wait for LLMs to generate answers word by word.** Instead, it should integrate AI capabilities as part of the system, seamlessly. AI can handle ops monitoring, data analysis, content moderation, workflow orchestration, intelligent decision-making — but all of this requires a foundation: your system needs an agent runtime that is powerful enough, stable, secure, and highly extensible.

---

## Why Octopi?

Most agent frameworks give you a monolith: a fixed agent loop, a fixed session model, a fixed set of integrations. You can use them as-is, but the moment you need something different — a custom context pipeline, a different storage backend, an embedded agent inside your own product — you're fighting the framework.

**Octopi is not another framework. It's an engine.** Think of it as the "engine" for your AI agent — just like a car needs an engine to run, your product needs an agent engine to have AI capabilities.

- **Embeddable by design** — Not a standalone app, but a component for your product
- **Pure function agent loop** — `agentLoop()` is a pure async generator: input messages → LLM call → tool execution → output events. Zero state, zero side effects
- **Reliability layer** — `runAgentWithReliability()` wraps the loop with planning-only retry, empty response retry, noop detection, loop detection, and TaskSupervisor checkpoints
- **Agent class** — Lightweight state holder: model, tools, context, system prompt. Constructed via `AgentBuilder`, run via `runAgentWithReliability()`
- **Session management** — lifecycle, persistence, concurrency control, all pluggable
- **Multi-provider LLM** — OpenAI, Anthropic, or any provider implementing the `ModelProvider` interface
- **Plugin system** — full lifecycle hooks with interceptor and observer semantics
- **Task system** — LLM-driven task tracking, context recovery, and autonomous planning
- **Security built-in** — injection detection, sensitive data filtering, trust levels — not optional, not removable

Use it to build a CLI bot, a web app AI backend, an embedded assistant, or something you haven't imagined yet.

---

## Core Philosophy

### Agent is a runtime, not a class

An agent is not an object you can `new` up. It's a complete runtime scope: workspace, session store, tool set, model configuration, persona definition — these together constitute an agent. The framework provides the engine and mechanisms; the integrator provides the policies and business logic.

### Kernel and Harness separation

The framework is split into two layers: the **Core** provides mechanisms — agent loop, event bus, security guard, resource constraints; the **Harness** provides policies — persona, plugins, skills, task planning, reliability wrappers. The core never knows about the harness; the harness mounts onto the core through interfaces. This means you can write a minimal agent using just the core, or build a complex autonomous system with the full harness.

### Session is a first-class citizen

All state belongs to the session, not the agent. The agent loop itself is stateless — it takes messages and returns results as an async generator of events. The lifecycle, persistence method, and concurrency control of state are all determined by the session layer. This allows the same engine to serve stateless API calls or power long-running conversational agents.

### Interfaces > default implementations

A framework's value lies not in how many defaults it ships, but in how many clean interfaces it defines. `ModelProvider` lets you swap LLM vendors by implementing one interface; `SessionStore` lets you change storage backends without touching any upper-layer logic; `ContextEngine` lets you freely compose every stage of context management. Good interfaces are a framework's most precious asset.

### Security is not optional

Injection detection, sensitive data filtering, resource consumption constraints — these are not configuration toggles, but built-in constraints of the framework. The more powerful agents become, the less security can rely on developer discipline.

### Files as configuration

Persona, skills, operating instructions — all defined as Markdown files. No schema, no config format. Extension = add a file. Composition = overlay directories. This is one of the most elegant designs we learned from OpenClaw: expressing the most flexible configuration in the simplest form.

### Natively multi-agent

An octopus has eight arms, each capable of independent perception and action, yet sharing the same body. Octopi is designed the same way — multi-agent collaboration is supported from the ground up. Each agent has its own isolated runtime scope (session, tool set, persona), with no interference between agents; at the same time, built-in communication and coordination mechanisms allow multiple agents to work together like tentacles. This isn't a feature bolted on after the fact — it's a native capability of the architecture.

### Distributed intelligence

In most agent frameworks, a session task runs entirely within a single LLM call chain — which means the system can only think on the main chain, and has difficulty planning for itself. Octopi takes a different approach: we embed independent LLM logic at key points in the workflow to plan and manage the main chain. For example, the LLMPlanner in the task system is not part of the main chain — it's an independent decision-maker responsible for reviewing task progress, adjusting execution strategy, and deciding the next steps.

Just as an octopus's intelligence is not concentrated solely in its brain but distributed across ganglia in each arm — each capable of independent response — intelligence in Octopi is not a single point but a distributed network. We plan to embed more small autonomous agents at additional logic nodes in the future, making the entire architecture more flexible and powerful.

### MCP — Connect to the tool ecosystem

Octopi supports [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), the open standard for connecting AI applications to external tools and data. Any MCP Server — filesystem, GitHub, databases, Sentry, and hundreds more — can be connected to Octopi with a single line of code:

```ts
const { agent, runner, mcpManager } = await new AgentBuilder()
  .model('gpt-4o')
  .mcp({
    id: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
  })
  .build();
// Agent can now use filesystem__read_file, filesystem__write_file, etc.
```

MCP tools are automatically namespaced (`{serverId}__{toolName}`), support runtime dynamic management, and can be auto-discovered from `~/.octopi/mcp-servers/`.

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
│  │  Reliability · Distributed Intelligence                  │ │
│  │                                                          │ │
│  │  ┌─────────────────────────────────────────────────────┐ │ │
│  │  │  Layer 1: Core                                       │ │ │
│  │  │  agentLoop · Agent · EventBus · SecurityGuard        │ │ │
│  │  │  Budget · AsyncTask · ProcessModel · Interfaces      │ │ │
│  │  └─────────────────────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Dependency direction: outer → inner. The core never knows about the harness.**

### Core (Layer 1) — The Engine

Zero implementation dependencies. Just interfaces and the minimal agent loop.

| Component | Responsibility |
|---|---|
| `agentLoop()` | Pure async generator — the heart of the engine. Input messages → LLM call → tool execution → output events. Zero state, zero side effects |
| `Agent` class | Lightweight state holder: model, tools, context, system prompt. Created by `AgentBuilder` |
| `callModel()` | Watchdog-mode streaming LLM call with idle timeout, absolute timeout, and abort signal support |
| `classifyError()` | Error classification: rate_limit, timeout, auth, server, network, unknown |
| `EventBus` | Full-chain observability via typed events |
| `SecurityGuard` | Injection detection + sensitive data filtering (non-disableable) |
| `IterationBudget` | Resource constraints: iterations, tool calls, tokens, time |
| `AsyncTask` | Async primitive: cancel, timeout, retry, persistence |
| `ProcessModel` | Agent process model: lifecycle, spawn, IPC |
| `ModelProvider` | LLM call interface (OpenAI, Anthropic, or custom) |
| `ContextEngine` | Context management interface (replaces ContextPipeline) |
| `ErrorStrategy` | Error classification and recovery interface |

### Harness (Layer 2) — Assembly Layer

Where the agent gets its personality, tools, and intelligence.

| Component | Responsibility |
|---|---|
| `AgentBuilder` | Fluent API — one line to launch an agent |
| `runAgentWithReliability()` | Reliability wrapper: planning-only retry, empty response retry, noop detection, loop detection, TaskSupervisor checkpoints, SecurityGuard injection |
| `SessionAwareRunner` | Session lifecycle: locks, persistence, reset |
| `PersonaLoader` | File-based persona system (AGENTS.md, SOUL.md, etc.) |
| `DefaultContextEngine` | Smart context routing: fits / truncate / compact / compact_then_truncate |
| `AgentSupervisor` | Persistent agent core: Perceive → Think → Act → Reflect |
| `TaskTracker` / `TaskManager` | LLM-driven task tracking and recovery |
| `RulePlanner` / `LLMPlanner` / `HybridPlanner` | Planning: rule-driven, LLM-driven, or hybrid |
| `TaskScheduler` | Scheduling: once, interval, cron, at |
| `MemoryKnowledgeStore` | Knowledge CRUD, keyword search, confidence filtering |
| `LLMReflector` | Quality assessment, pattern recognition, experience storage |
| `SecurityPresets` | Preset policies: development / testing / production / maximum |
| `AgentRuntime` | Distributed intelligence infrastructure |

### Integration (Layer 3) — Connectors

Protocol adapters, storage backends, observability.

| Component | Responsibility |
|---|---|
| `JsonlSessionStore` | JSONL file storage (default) |
| `InMemorySessionStore` | In-memory storage (testing) |
| `TraceCollector` | Auto-collect engine events into trace |
| `MetricsAggregator` | LLM/token/latency/cost metrics from event stream |
| `RecordingProvider` | Record real LLM interactions for replay |
| `ReplayProvider` | Replay recorded interactions (deterministic testing) |
| `ChaosProvider` | Fault injection: empty response, timeout, rate-limit, malformed |
| `ScenarioRunner` | E2E scenario testing with built-in assertions |
| `SdkMcpClient` | MCP Client (connect to external MCP Servers via stdio/HTTP) |

---

## Quick Start

```typescript
import { AgentBuilder } from 'octopi';
import { OpenAIProvider } from 'octopi';

const { agent, runner } = await new AgentBuilder()
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

const { agent, runner } = await new AgentBuilder()
  .model('gpt-4o')
  .store(new RedisSessionStore({ host: 'localhost' }))
  .build();
```

### Direct agent loop (without harness)

```typescript
import { Agent } from 'octopi/core';
import { runAgentWithReliability } from 'octopi/harness/reliability';

const agent = new Agent({
  model: provider,
  systemPrompt: 'You are a helpful assistant.',
  tools: [myTool],
});

// Inject initial message
agent.context.messages.push({ role: 'user', content: 'Hello', timestamp: Date.now() });

// Run with reliability wrapper
const harness = { config: { planningRetry: { maxAttempts: 2, steerInstruction: '...' }, emptyResponseRetry: { maxAttempts: 2, steerInstruction: '...' }, noopThreshold: 3, loopDetection: { enabled: true } } };
for await (const event of runAgentWithReliability(agent.context, { model: agent.model }, harness)) {
  if (event.type === 'assistant_message') {
    console.log(event.message.content);
  }
}
```

### Event subscription

```typescript
import { AgentEvents } from 'octopi';

agent.events.on(AgentEvents.ENGINE_START, (event) => {
  console.log(`Agent started at ${event.timestamp}`);
});
```

### Security policy

```typescript
import { AgentBuilder, SecurityPresets } from 'octopi';

const { agent } = await new AgentBuilder()
  .model('gpt-4o')
  .securityPolicy(SecurityPresets.production)
  .build();
```

---

## Design Principles

### agentLoop is a pure function

The core loop doesn't hold session state. It's an async generator that yields events: `agent_start`, `turn_start`, `assistant_message`, `turn_end`, `agent_end`. Message history is passed in via the context, results come out as events. This means:

- **Testable** — no need to mock a session store
- **Reusable** — the same loop works with or without sessions
- **Composable** — wrap with reliability, security, or custom logic

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
- **RiskPolicy** — deterministic risk evaluation for tool calls (Core injects via interface, Harness implements)

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

// Integrated via ContextEngine's TaskStage
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
| **Scope** | Full AI assistant platform | Embeddable agent engine |
| **Architecture** | Integrated system | Three-layer separation (Core / Harness / Integration) |
| **Agent model** | Class-based with state | Stateless loop + pluggable session |
| **Coupling** | Platform-bound (channels, memory, scheduling) | Zero platform dependencies in Core |
| **Target user** | End users building assistants | Developers embedding agents in products |
| **Extensibility** | Plugin system | Plugin system + pluggable interfaces at every layer |

OpenClaw is a great project. Octopi is what happens when you ask: "What if we extracted just the engine and made it composable?"

---

## Testing

```bash
npm test
# 1050+ tests passed
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
| [Architecture](docs/ARCHITECTURE.md) | Design philosophy, three-layer architecture, decision records, API reference |
| [Plugin System](docs/plugin-system.md) | Hook semantics, capability ownership, examples |
| [Task System](docs/task-system.md) | Task management, LLM decision maker, state machine |
| [Contributing Guide](docs/CONTRIBUTING.md) | Setup, conventions, testing, documentation sync |

---

## License

MIT
