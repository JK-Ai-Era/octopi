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
- **10 product domains** — Each domain is independently understandable, testable, and replaceable
- **8-layer context intelligence** — Wisdom, Persona, Skill, Knowledge, Cognition, Memory, Runtime, Information (see [docs/memory.md](./docs/memory.md) for Memory, [docs/knowledge.md](./docs/knowledge.md) for Knowledge)
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
│  │  Layer 2: Harness — 10 product domains             ││
│  │  agent-building · context · security · reliability         ││
│  │  plugin-ecosystem · multi-agent · autonomous-subsystem     ││
│  │  session-tasks · run-guard · orchestration · concurrency   ││
│  │  execution-env · hitl · memory                             ││
│  │                                                          ││
│  │  ┌──────────────────────────────────────────────────────┐││
│  │  │  Layer 1: Core — Kernel Contract                       │││
│  │  │  EventBus · StateMachine · Kernel ports                │││
│  │  │                                                      │││
│  │  │  ┌──────────────────────────────────────────────────┐│││
│  │  │  │  Layer 0: Loop — Pure execution loop             ││││
│  │  │  │  agentLoop · callModel · classifyError           ││││
│  │  │  └──────────────────────────────────────────────────┘│││
│  │  └──────────────────────────────────────────────────────┘││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

**Dependency direction: outer → inner. Core has zero outer dependencies.**

### Layer 0: Loop — Pure Execution

The heart of the engine. `agentLoop()` is a pure async generator: input messages → LLM call → tool execution → protocol events. Zero state, zero external dependencies. Runnable facade is Harness `Agent.run()`.

### Layer 1: Core — Kernel Contract

Infrastructure primitives (EventBus, StateMachine) and **Kernel ports** (ModelProvider, ErrorStrategy, SecurityGuard, RunGuard, ReliabilityHarness) plus shared vocabulary types. **Product ports** (ToolBus, SessionStore, Observer = Telemetry metrics/span) and domain contracts (ContextEngine, Memory, MCP, …) live in Harness. Run Observatory (`harness/observability/observer`) is a separate debug product surface — see [docs/observer-domain.md](./docs/observer-domain.md). No strategy implementations. **Does not re-export Loop.**

### Layer 2: Harness — Product Domains

| Product Domain | Directory | Question |
|----------------|-----------|----------|
| **Governance** | `governance/` | Who may do what? (ACL, security policy, HITL, credentials, ledgers) |
| **Session** | `session/` | How does continuity hold? (aggregate, Discourse, tasks, history) |
| **Agent** | `agent/` | Who is it / how is it configured? (template, persona, builder) |
| **Memory** | `memory/` | What has it learned? (Memory / Cognition / Wisdom substrate) |
| **Knowledge** | `knowledge/` | What does the world write down? (exogenous corpus, sources, retrieval) |
| **Activation** | `activation/` | How do stimuli become Runs? |
| **Run** | `run/` | How does this episode stay safe? (RunScope, reliability, guard, budget) |
| **Context** | `context/` | What does the model see? (eight-layer assembly, tokens, window) |
| **Extension** | `extension/` | How are capabilities extended? (Plugin/Tool/Skill/MCP, sandbox) |
| **Collaboration** | `collaboration/` | How do multi-Agents / subsystems coordinate? |

Cross-cutting / foundation (not counted): `observability/`, `context/capabilities/`, `shared/`.  
Sole count authority: [docs/domains.yaml](./docs/domains.yaml) · narrative: [docs/domains.md](./docs/domains.md).

### Layer 3: Integration — External Adapters

LLM providers (OpenAI, Anthropic), storage backends (JSONL, SQLite, Memory), Telemetry observability (trace, metrics, exporters — config key `observability`), protocols (HTTP), Gateway, TUI, and Web Runtime.

---

## Context Intelligence — 8-Layer Model

Octopi's unique approach to making agents smarter through better context assembly:

```
Wisdom (thinking patterns)     ← Highest priority, front of system prompt
Persona (identity, personality)
Skills (workflow guidance)     ← Conditionally loaded
Knowledge (external references)← Retrieved on demand
Cognition (concept graph)      ← Concept relationships
Memory (actionable insights)    ← fact / method / norm from past sessions
Runtime (live run context)     ← tasks / guidance / injectedContext (system side)
Information (raw messages)     ← Window managed + compressed (message window, not a ContextLayer)
```

> Product eight layers = system ContextLayer (1–7, including Runtime) + Information (layer 8, message window).

This is an **information distillation system**: raw information is refined through layers of increasing abstraction, producing progressively higher-level understanding.

**Implementation**: `ContextLayer` contracts + `DefaultContextAssembler` in `harness/context/`.  
Default path wires Persona / Skill / Knowledge / Memory / Runtime; Wisdom / Cognition remain optional.  
See [docs/context-layer-contracts.md](./docs/context-layer-contracts.md).

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

Connect any MCP Server (inject the Integration client factory):

```typescript
import { AgentBuilder, createSdkMcpClient } from 'octopi';

const { agent, runner } = await new AgentBuilder()
  .model('gpt-4o')
  .mcpClientFactory(createSdkMcpClient)
  .mcp({
    id: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
  })
  .build();
```

### Web Search (multi-provider)

Configure in `octopi.json` / `~/.octopi/octopi.json` to register the `web_search` tool:

```json
{
  "webSearch": {
    "provider": "mimo",
    "fallbacks": ["duckduckgo"],
    "defaultLimit": 5,
    "timeoutMs": 90000,
    "providers": {
      "mimo": { "api": "mimo", "apiKey": "${MIMO_API_KEY}", "model": "mimo-v2.5-pro" },
      "duckduckgo": { "api": "duckduckgo" }
    }
  }
}
```

Built-in providers: `duckduckgo` (no key), `tavily`, `brave`, `serper`, `mimo`. Failures and empty results fall through `fallbacks`.

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
│   ├── primitives/               EventBus, StateMachine
│   ├── interfaces/               18 interface contracts
│   └── types/                    Core type definitions
├── harness/                 Layer 2  Product domains
│   ├── agent-building/           Builder, persona, config bridge, runner injection
│   ├── context/                  ContextLayer assembly, window compression, compact-key (E4)
│   ├── capabilities/             Cross-cutting capabilities: summary extract + compact engine
│   ├── session-acl/              Role catalog, authorizeRun, preferred/handoff (E6/I3)
│   ├── tool-effect/              toolIsolation cwd policy (I5)
│   ├── security/                 Risk evaluation, shell parsing
│   ├── reliability/              Reliability wrapper, circuit breaker
│   ├── plugin-ecosystem/         Plugins, tools, skills, MCP
│   ├── multi-agent/              Agent registry, Swarm, AgentProcess
│   ├── autonomous-subsystem/     Sense/Think/Act/Signal/Boundary framework
│   ├── session-tasks/            SessionTask (goal/step) — default path
│   ├── run-guard/                Checkpoint supervision (DefaultRunGuard)
│   ├── orchestration/            Experimental workflow/scheduler/planner
│   ├── concurrency/              Load balancing, rate limiting, SessionLease
│   ├── execution-environment/    Sandboxing, workspace
│   ├── human-in-the-loop/        Approval workflows
│   ├── memory/                   Memory, cognition, wisdom
│   └── runner.ts                 SessionAwareRunner (session lock, tool cwd, ACL)
├── integration/             Layer 3  External adapters
│   └── web-search/               DuckDuckGo, Tavily, Brave, Serper, MiMo
└── testing/                 Test utilities
```

Runtime config knobs (see `octopi.example.json` + `docs/KNOWN-ISSUES.md`): `toolIsolation`, `sessionAcl`, `agents[].workspace` / `maxSessionRights`, plus capability keys `summary` / `compact` / `models.level.summary`.

---

## Related Docs

- [Architecture](./docs/ARCHITECTURE.md) — Full architecture design
- [Architecture Overview](./arch/overview.md) — DDD domain organization
- [Layer Rules](./arch/layer-rules.md) — Dependency rules
- [Invariants](./arch/invariants.md) — Architecture invariants
- [Plugin System](./docs/plugin-system.md) — Plugin system details
- [Session Tasks](./docs/task-system.md) — SessionTask design baseline
- [Domain Split](./docs/domain-split.md) — run-guard / orchestration / AsyncTask boundaries
- [Contributing](./docs/CONTRIBUTING.md) — Development guidelines
- [Changelog](./CHANGELOG.md) — Version history
- [Web UI Design](./web/DESIGN.md) — Playground visual system & eight-layer inspector

---

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
