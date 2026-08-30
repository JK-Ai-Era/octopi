# Octopi 🐙

**The Embeddable Agent Engine**

> An agent is not a class — it's a complete runtime.
> A framework's value lies not in how many defaults it ships, but in how many clean interfaces it defines.

[中文文档](./README_CN.md) | [Architecture](./docs/ARCHITECTURE.md) | [Contributing](./docs/CONTRIBUTING.md)

---

## What is Octopi?

Octopi is an embeddable agent engine for building AI-powered applications. It provides the runtime infrastructure your product needs to have AI capabilities — just like a car needs an engine, your product needs an agent engine.

- **Embeddable** — Not a standalone app, but a component for your product
- **4-layer architecture** — Loop → Core → Harness → Integration, clean boundaries, independent layers
- **11 self-contained domains** — Each domain is independently understandable, testable, and replaceable
- **7-layer context intelligence** — Wisdom, Persona, Skill, Knowledge, Cognition, Memory, Information
- **Security built-in** — Injection detection, risk evaluation, approval workflows — not optional, not removable
- **Natively multi-agent** — Distributed intelligence from the ground up

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 3: Integration — External adapters                     │
│  LLM Providers · Storage · Observability · Gateway · TUI · Web Runtime │
│                                                              │
│  ┌──────────────────────────────────────────────────────────┐│
│  │  Layer 2: Harness — 11 self-contained domains             ││
│  │  agent-building · context · security · reliability         ││
│  │  plugin-ecosystem · distributed-agents · task-system       ││
│  │  concurrency · execution-env · human-in-the-loop · memory  ││
│  │                                                          ││
│  │  ┌──────────────────────────────────────────────────────┐││
│  │  │  Layer 1: Core — Primitives + Interfaces + Types      │││
│  │  │  EventBus · StateMachine · AsyncTask · Contracts      │││
│  │  │                                                      │││
│  │  │  ┌──────────────────────────────────────────────────┐│││
│  │  │  │  Layer 0: Loop — Pure execution loop             ││││
│  │  │  │  agentLoop · Agent · callModel · classifyError   ││││
│  │  │  └──────────────────────────────────────────────────┘│││
│  │  └──────────────────────────────────────────────────────┘││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

**Dependency direction: outer → inner. Core has zero outer dependencies.**

### Layer 0: Loop — Pure Execution

The heart of the engine. `agentLoop()` is a pure async generator: input messages → LLM call → tool execution → output events. Zero state, zero external dependencies.

### Layer 1: Core — Primitives + Contracts

Infrastructure primitives (EventBus, StateMachine, AsyncTask, ProcessModel) and all interface contracts (ModelProvider, ContextEngine, SecurityGuard, SessionStore, etc.). No strategy implementations.

### Layer 2: Harness — 11 Domains

| Domain | Responsibility |
|--------|---------------|
| **Agent Building** | Builder, persona loading, config bridge |
| **Context Management** | Message selection, compression, token estimation, 7-layer intelligence |
| **Security** | Risk evaluation, shell parsing, degradation strategies, safety agent |
| **Reliability** | `runAgentWithReliability()`, circuit breaker, retry, supervision |
| **Plugin Ecosystem** | Plugins, tools, skills, MCP, slash commands |
| **Distributed Agents** | Multi-agent orchestration, distributed runtime, triggers |
| **Task System** | Task management, planning, scheduling, workflow, quality gates |
| **Concurrency** | Multi-key LLM load balancing, rate limiting, session gating |
| **Execution Environment** | Sandboxing, workspace management, file operations |
| **Human-in-the-Loop** | Approval workflows, decision caching, risk-based policies |
| **Memory** | Memory storage/retrieval, cognition graph, wisdom, project memory |

### Layer 3: Integration — External Adapters

LLM providers (OpenAI, Anthropic), storage backends (JSONL, SQLite, Memory), observability (trace, metrics, exporters), protocols (HTTP), Gateway, TUI, and Web Runtime.

---

## Context Intelligence — 7-Layer Model

Octopi's unique approach to making agents smarter through better context assembly:

```
Wisdom (thinking patterns)     ← Highest priority, front of system prompt
Persona (identity, personality)
Skills (workflow guidance)     ← Conditionally loaded
Knowledge (external references)← Retrieved on demand
Cognition (concept graph)      ← Concept relationships
Memory (extracted insights)    ← From past interactions
Information (raw messages)     ← Window managed + compressed
```

This is an **information distillation system**: raw information is refined through layers of increasing abstraction, producing progressively higher-level understanding.

---

## Quick Start

```typescript
import { AgentBuilder, OpenAIProvider } from 'octopi';

const { agent, runner } = await new AgentBuilder()
  .model(new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }))
  .persona('./my-agent')
  .build();

for await (const event of runner.handle('session-1', userMessage)) {
  if (event.type === 'llm_stream_delta') {
    process.stdout.write(event.data.delta);
  }
}
```

### MCP Integration

Connect any MCP Server with one line:

```typescript
const { agent, runner } = await new AgentBuilder()
  .model('gpt-4o')
  .mcp({
    id: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
  })
  .build();
```

---

## Core Design Principles

**Agent is a runtime, not a class.** An agent is a complete runtime scope: workspace, session store, tool set, model config, persona. The framework provides mechanisms; the integrator provides policies.

**Interfaces > implementations.** A framework's value is in its interfaces. `ModelProvider` lets you swap LLM vendors; `SessionStore` lets you change storage; `ContextEngine` lets you compose context management.

**Security is built-in.** Injection detection, risk evaluation, approval workflows — these are not configuration toggles, but built-in constraints. The more powerful agents become, the less security can rely on developer discipline.

**Files as configuration.** Persona, skills, wisdom, operating instructions — all defined as Markdown files. Extension = add a file. Composition = overlay directories.

**Each domain is independently understandable.** In a vibe coding environment with limited context, you can focus on one domain without understanding the entire system.

---

## Testing

```bash
npm test
```

64 test files, 1022 tests. Three-layer strategy: unit tests (mock), recording/replay, E2E with real APIs. ChaosProvider for fault injection.

---

## Project Structure

```
src/
├── loop/                    Layer 0  Pure execution loop
├── core/                    Layer 1  Primitives + interfaces + types
│   ├── primitives/               EventBus, StateMachine, AsyncTask, ProcessModel
│   ├── interfaces/               18 interface contracts
│   └── types/                    Core type definitions
├── harness/                 Layer 2  11 self-contained domains
│   ├── agent-building/           Builder, persona, config bridge
│   ├── context/                  Context engine, compression, intelligence
│   ├── security/                 Risk evaluation, shell parsing
│   ├── reliability/              Reliability wrapper, circuit breaker
│   ├── plugin-ecosystem/         Plugins, tools, skills, MCP
│   ├── distributed-agents/       Multi-agent, distributed runtime
│   ├── task-system/              Tasks, planner, scheduler, workflow
│   ├── concurrency/              Load balancing, rate limiting
│   ├── execution-environment/    Sandboxing, workspace
│   ├── human-in-the-loop/        Approval workflows
│   ├── memory/                   Memory, cognition, wisdom
│   └── runner.ts                 SessionAwareRunner (orchestrator)
├── integration/             Layer 3  External adapters
└── testing/                 Test utilities
```

---

## Related Docs

- [Architecture](./docs/ARCHITECTURE.md) — Full architecture design
- [Architecture Overview](./arch/overview.md) — DDD domain organization
- [Layer Rules](./arch/layer-rules.md) — Dependency rules
- [Invariants](./arch/invariants.md) — Architecture invariants
- [Plugin System](./docs/plugin-system.md) — Plugin system details
- [Task System](./docs/task-system.md) — Task system details
- [Contributing](./docs/CONTRIBUTING.md) — Development guidelines
- [Changelog](./CHANGELOG.md) — Version history
- [Web Runtime Design](./docs/web-runtime-design.md) — Web Protocol SDK / Runtime Store / WebUI design
- [Web Conversation Model Design](./docs/web-conversation-model-design.md) — Session display model design

---

## License

MIT
