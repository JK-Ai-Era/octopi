# Octopi Architecture Design

> Version: v0.36.0 (initial) | Date: 2026-09-21 | **Proofread: 2026-10-11 (as of v0.70.0; module trees corrected against code; counts authoritative from `docs/domains.yaml`; specialized topics follow their dedicated docs)**
>
> This document is the complete architecture design of Octopi.
> Long-term invariants: see the [Architecture Constitution](./north-star.md).
> Aligned with implementation: Observer Run Observatory (v0.43.3+) see [observer-domain.md](./observer-domain.md); shared capabilities Summary/Compact (v0.44.0+) see [context-layer-contracts.md](./context-layer-contracts.md) and `packages/engine/src/harness/context/capabilities/`.

---

## 1. Design Philosophy

### 1.1 An Agent is a runtime, not a class

Traditional frameworks model an Agent as a class. But a real Agent needs a **complete runtime environment**:

- A message-loop engine
- A set of context-assembly strategies
- A model-invocation capability
- A set of tool-execution capabilities
- A state-persistence backend
- A set of security policies
- A memory and learning system

The ways these components can be composed are infinite. The framework does not preset a composition; it provides **clear interfaces** and **replaceable components**.

### 1.2 Four-layer separation

```
Loop          → pure execution loop, zero external dependencies
Core          → mechanism primitives + interface contracts + core types
Harness       → domain implementations; each domain is self-contained
Integration   → external system adapters
```

**Dependency direction: outer → inner. Inner layers do not know outer layers exist.**

### 1.3 Evolving toward the unknown

AI is in an early stage; application-building ideas keep evolving. The core goals of the architecture:

- **Understandable in isolation** — every module can be understood on its own, without global context
- **Self-contained domains** — changing one domain does not affect others
- **Explicit dependencies** — modules communicate through interfaces; blast radius is statically analyzable
- **Progressive extension** — new capabilities enter as new domains; existing structure does not change

### 1.4 Security is built in, not bolted on

Security is not “add a security module”; every layer carries a security responsibility. Core defines the `SecurityGuard` interface; Harness implements security policies. Together they form a non-bypassable security line.

---

## 2. The Four-Layer Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Layer 3: Integration — external adapters                        │
│  LLM Provider · Web Search · Storage · Observability · Protocols · Gateway · TUI · Web Runtime │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │  Layer 2: Harness — 10 product domains + cross-cutting/infra ││
│  │                                                              ││
│  │  ┌──────────────────────────────────────────────────────────┐││
│  │  │  Layer 1: Core — mechanism primitives + interface contracts + core types │││
│  │  │                                                          │││
│  │  │  ┌──────────────────────────────────────────────────────┐│││
│  │  │  │  Layer 0: Loop — pure execution loop                 ││││
│  │  │  │  agentLoop · callModel · classifyError           ││││
│  │  │  └──────────────────────────────────────────────────────┘│││
│  │  └──────────────────────────────────────────────────────────┘││
│  └──────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

### Layer 0: Loop — pure execution loop

**Responsibility**: call LLM → parse response → execute tools → loop. Emits an event stream via async generator `yield`.

**Traits**: zero external dependencies. Does not depend on EventBus, SecurityGuard, or Budget. All extensions are injected through `AgentLoopConfig` callbacks.

**Key invariants**:
- LLM business failures never throw (`onError` only `retry`/`abort`; termination always yields `agent_end`)
- All items in a tool batch with `terminate=true` → `agent_end(should_stop)`
- `tool_results` and `tool_calls` correspond one-to-one (including abort placeholders)
- Streaming prefers the provider passthrough `finishReason` (`done` chunk)
- `turn_end.phase`: `pre_tools` (tools about to run) / `final` (this turn ends on a no-tool path)
- Event vocabulary is Loop-protocol only; budget/run_guard events live in `HarnessLoopEvent`
- Messages entering `ModelProvider` are normalized (toolResults expanded, tool_calls stringified)
- The engine only manages systems with `metadata.source === 'systemPrompt'`; systems without metadata are always kept

#### `turn_end.phase` — UI / upper-layer consumption contract

| phase | Meaning | What the UI should do |
|-------|---------|------------------------|
| `pre_tools` | This turn’s LLM returned tool_calls; messages are already in history; **tools have not run / are running** | Keep “in progress”; may show the tool list; **do not** set the run to idle |
| `final` | This turn ends on a no-tool path (plain text / followUp / truncation re-feed / error retry) | May finalize the assistant message; may set idle |

**Do not** treat every `turn_end` as “this run ended”. On the tool path there are `tool_*` events after `pre_tools`; on termination it may go straight to `agent_end` — **no** final `turn_end` is added afterwards.

When the Runner maps this to EventBus `turn.end`, it carries `data.phase`. Web `runStatus`: `pre_tools → 'tools'`, `final → 'idle'`. TUI stays in processing on `pre_tools`.

```
packages/core/src/loop/
├── agent-loop.ts         # agentLoop() — pure function
├── call-model.ts         # callModel() — LLM call (watchdog + finishReason)
├── error-classifier.ts   # classifyError() — error classification
├── types.ts              # AgentLoopConfig, AgentLoopEvent, etc.
└── index.ts
```

The runnable Agent facade lives at `packages/engine/src/harness/agent/` (`run()` = reliability wrapper).

### Layer 1: Core — mechanism primitives + interface contracts

**Responsibility**: define all of the framework’s contracts (interfaces), provide infrastructure primitives (EventBus, etc.), and define core types.

**Traits**: depends on no outer layer. Contains no strategy implementations. **Does not re-export Loop** (`agentLoop` / `AgentLoopEvent` are imported from `loop/`; the Agent facade is imported from `harness/agent/`).

```
packages/core/src/core/
├── interfaces/           # Kernel + Product port types
│   ├── kernel.ts
│   ├── model-provider.ts
│   ├── security-guard.ts
│   ├── session-store.ts
│   ├── observer.ts
│   ├── error-strategy.ts
│   ├── run-guard.ts
│   ├── reliability.ts
│   ├── tool-bus.ts
│   └── index.ts
├── types/                # Kernel vocabulary
│   ├── messages.ts
│   ├── agent-definition.ts  # ModelInfo / ToolPolicy
│   ├── session.ts
│   ├── turn.ts
│   ├── tools.ts
│   ├── queue-mode.ts
│   ├── thinking-level.ts
│   └── index.ts
├── primitives/           # EventBus, StateMachine, Cron (pure mechanisms)
│   ├── event-bus.ts
│   ├── state-machine.ts
│   └── index.ts
├── security-guard.ts
└── index.ts              # octopi/core — Kernel
```

Product event vocabulary lives in `harness/shared/events/` (AgentEventMap / AgentEvents / scenario-events).

Domain contracts live **inside harness domains** (memory, mcp, multi-agent, orchestration, …), not in Core.

### Layer 2: Harness — 10 product domains + cross-cutting/infrastructure

**Responsibility**: implement concrete strategies for Core Kernel ports; provide all of the framework’s high-level features; hold Domain product contracts and implementations.

**Organization**: the top level of `packages/engine/src/harness/` is the product-domain directory (domain = bounded context). Counts and module lists take [`docs/domains.yaml`](./domains.yaml) as the sole authority; narrative is in [`docs/domains.md`](./domains.md).

**Traits**: each domain has its own types, implementations, and entry files. Domains communicate through each other’s **types**; they do not share internal state.

(See Section 3 for details.)

### Layer 3: Integration — external adapters

**Responsibility**: connect to external systems (LLM providers, storage backends, observability, protocols, UI).

**Traits**: performs adaptation/translation only; makes no business-logic decisions.

```
packages/engine/src/integration/   # library capabilities (ship with @octopi-agent/engine)
├── providers/            # LLM Provider (OpenAI, Anthropic)
├── web-search/           # Web Search Provider (DuckDuckGo, Tavily, Brave, Serper, MiMo)
├── storage/              # storage backends (JSONL, SQLite, Memory)
├── observability/        # Telemetry: Trace, Metrics, Exporters (Core Observer adapters)
├── mcp/ · agent-runtime/

packages/gateway/src/              # process plane (@octopi-agent/gateway)
├── gateway/              # Gateway HTTP/WS
├── protocols/            # protocol adapters (HTTP)
└── web/                  # Web Runtime / SDK

src/integration/tui/               # suite product shell
```

> **Observer Domain**: Telemetry (the `observability/` above + Core `Observer`) and **Run Observatory** (`harness/observability/observer/`, config key `observer`) belong to the same observation domain but are implemented separately. See [docs/observer-domain.md](./observer-domain.md). Run Observatory defaults to `observer.level=off`; debug REST is at the root path `/debug/run/*` (not `/api/v1`).

---

## 3. Harness Product Domains

> **10 product domains** (governance / session / agent / memory / knowledge / activation / run / context / extension / collaboration)
> Authoritative list: [`docs/domains.md`](./domains.md) · [`docs/domains.yaml`](./domains.yaml)
> This section describes implementation details by capability; directories follow the domain-first layout (`packages/engine/src/harness/governance|session|agent|memory|knowledge|activation|run|context|extension|collaboration/`).

### 3.1 Agent Building

**Responsibility**: assemble the Agent runtime, load persona configuration, bridge config files. Produces a `harness/agent` Agent with `setHarness` applied.

```
harness/run/agent/
├── builder.ts            # AgentBuilder — Fluent API
├── persona.ts            # persona loading (root AGENTS.md + persona/*.md)
├── config-bridge.ts      # config file → new-architecture bridge
└── index.ts
```

Agent home directory convention (scaffolded by `initOctopi` / `ensureAgentDirs`):

```
<agentHome>/
  AGENTS.md              # main persona; loaded first
  persona/               # supplemental persona (alphabetical; numeric prefixes control order)
  skills/                # skills (can be pointed at by skillDirectory)
# Note: sessions are not in agent home — see OCTOPI_HOME/sessions/
```

Memory / Cognition / Wisdom / Knowledge **are not persisted by directory**; they are carried uniformly by the per-agent SQLite `AgentDatabase` (`agent.db`).

The Jsonl session directory is **sessionId-first** at `OCTOPI_HOME/sessions/`; `SessionData` includes the model-2 fields (`primaryAgentId` / `preferredAgentId` / `participants` / `contextCompacts`). `SessionStore.load(sessionId)` is implemented; there is **no** `agents/<id>/sessions/` compatibility fallback. The **only** runtime Session backend is `JsonlSessionStore` (`SqliteSessionStore` has been removed). The optional projection `sessions.index.db` (rebuildable) is only for `session_search` pre-filtering and is **not** a second authority (the index projection is internal spec, not public).

> The old `extract/` (JsonlExtractorStore) directory was removed with the memory ETL extractors; backfill/governance goes through the `memory.steward.*` subsystem, and source material is read from SessionStore.

### 3.2 Context Management

**Responsibility**: message selection, compaction, token estimation, smart routing; plus the seven-layer system-prompt content-layer contracts and assembly.

```
harness/context/
├── layer-types.ts          # ContextLayer contract (seven layers)
├── assembler.ts            # DefaultContextAssembler
├── layers.ts               # thin adapter layer + createDefaultLayers
├── system-prompt-assembler.ts
├── summarize.ts
├── compact-key.ts          # E4: compact key (sessionId, agentId)
├── default-context-engine.ts   # message-window entry (state key includes agentId)
├── smart-router.ts             # smart-routing decisions
├── message-selector.ts         # four-region message selection
├── hybrid-compressor.ts        # hybrid compressor
├── llm-summarizer.ts           # LLM summary compaction
├── truncate-compressor.ts      # truncation fallback
├── budget-allocator.ts         # token budget allocation
├── token-estimator.ts          # HeuristicTokenEstimator
├── token-estimate-fns.ts
├── token-constants.ts
└── (catalog contract moved to harness/knowledge/catalog-types.ts)
└── (structural compaction delegated to harness/context/capabilities/compact; E4 state stays in this engine)

harness/capabilities/document/       # cross-domain Document extraction (createDocumentPortFromConfig + documents.*)
harness/context/capabilities/          # shared context-assembly capabilities: SummaryPort + CompactEngine
harness/governance/session-acl/        # E6: role catalog + authorizeRun + switch
harness/extension/execution-environment/        # ToolEffectPolicy: modes/L2/turn undo/resource limits + I5 cwd
harness/observability/observer/           # Run Observatory: ObserverHub + Run projection (observer.level)
harness/run/concurrency/session-lease.ts  # E2/E7: SessionLease
harness/knowledge/                       # exogenous corpus domain + Knowledge Service (http-app/serve/client; sole writer of knowledge.db)
```

Domain exports are in `harness/index.ts`. Design notes: [docs/context-layer-contracts.md](./context-layer-contracts.md), [docs/observer-domain.md](./observer-domain.md).

**Shared capabilities (cross-cutting)**: `harness/context/capabilities/summary|compact` provides injectable LLM summarization/information extraction and a configurable compaction pipeline. `harness/capabilities/document` is the cross-domain Document extraction Port (shared by session/knowledge/tools; `createDocumentPortFromConfig` + `documents.*`). Boundary with `plugin-ecosystem/tools`: tools **only consume** `SummaryPort`; prompt/policy/algorithms live only in capabilities; session compact **E4** keys and Session persistence are not in capabilities (they stay on the context / session path). Config keys: `summary` / `compact` / `models.level.summary` / `documents.*`.

### 3.3 Security

**Responsibility**: tool-call risk assessment, shell command parsing, safe degradation, security agents.

**Layering (security is non-bypassable)**: hard boundaries (deterministically harmful; unaffected by `enforce`) → always-wired `ToolCallRiskPolicy` (tiering for contested cases) → configurable-only `enforce` / `allowedPaths` / `injectionSensitivity`. Opaque payloads (e.g. `file_write.content`) are not scanned for shell metacharacters.

```
harness/governance/security/
├── default-security-guard.ts   # hard boundaries + always-wired RiskPolicy + Input/Output
├── default-risk-policy.ts      # DefaultToolCallRiskPolicy — rule engine
├── risk-evaluator.ts           # operation+target combo risk assessment + hard-boundary probes
├── shell-parser.ts             # shell command parser (4 layers)
├── degradation.ts              # 6 degradation strategies
├── capability-enforcer.ts      # trust tiering
└── index.ts
```

The safety-guard subsystem is defined in `subsystems/safety-guard/` (config.yaml + SUBSYSTEM.md) and loaded by the Autonomous Subsystem domain; it is not in this directory.

### 3.4 Human-in-the-Loop

**Responsibility**: approval-request management, approval policy, user-decision caching.

```
harness/governance/human-in-the-loop/
├── approval-manager.ts    # approval request management
├── approval-policy.ts     # approval policy (auto / confirm-all / confirm-high-risk)
├── decision-cache.ts      # user decision cache
├── feedback-collector.ts  # user feedback collection
├── types.ts
└── index.ts
```

### 3.5 Execution Environment

**Responsibility**: sandbox management, workspace lifecycle, advanced file operations (search/glob/diff handled by `workspace.ts` FileWorkspace); sandbox-level resource limits (timeout/output caps etc., see `types.ts` `ResourceLimits`) stay in this domain; run-level hard stops (token/iteration/wall-clock) belong to the Budget/Run plane (checked 2026-10-11).

```
harness/extension/execution-environment/
├── sandbox.ts             # sandbox management (process isolation, filesystem isolation)
├── workspace.ts           # workspace lifecycle
├── isolation.ts           # I5 toolIsolation cwd (none / session-subdir / session-lock)
├── effect-policy.ts       # ToolEffectPolicy mode presets + gateEffect (host-gate)
├── undo-log.ts            # P1 file turn undo (sessions/<sid>/undo/)
├── shell-journal.ts       # shell journal (before snapshot → same undo log)
├── memory-undo.ts         # P2 memory journal + JournaledMemoryStore
├── resource-limits.ts     # P5 L1 timeoutMs watchdog
├── types.ts               # includes ResourceLimits (sandbox-level) and other contracts
└── index.ts
```

### 3.6 Memory

**Responsibility**: memory storage/retrieval, cognition graph, wisdom generation. Persistence uniformly goes through the per-agent SQLite single database (built-in `node:sqlite`; requires Node.js >= 24).

```
harness/memory/
├── store.ts              # InMemoryMemoryStore (default in-memory implementation)
├── confidence.ts         # write provisional confidence / injectFilter / profile mapping
├── gates.ts              # structure gating + mapLegacyType
├── similarity.ts         # normalization / trigram / findDuplicate (no semantic polarity)
├── decay-policy.ts       # per-type decay curves (fact/method/norm)
├── backfill-coverage.ts  # backfill coverage table + density pre-filter
├── backfill-trigger.ts   # backfill pulses (hard convergence / idle / gap)
├── health-probe.ts       # inventory watermark dual pulse (memory.health.*)
├── cognition.ts          # InMemoryConceptGraph
├── cognition-gates.ts    # concept/relation licensing gates
├── cognition-decay.ts    # edge decay / Hebbian / counter-evidence
├── cognition-trigger.ts  # proposition persisted → cognition.conceptualize.request
├── conceptualizer.ts     # proposition + contextSlice → conceptualization (no regex extractFromText)
├── types.ts              # MemoryType = fact|method|norm; Store contracts (incl. Cognition)
├── sqlite/
│   ├── agent-db.ts       # AgentDatabase — per-agent agent.db
│   ├── memory-store.ts   # SqliteMemoryStore
│   ├── backfill-coverage.ts
│   ├── wisdom-store.ts   # SqliteWisdomStore
│   ├── cognition-store.ts
│   ├── knowledge-registry.ts
│   └── embedding.ts
└── index.ts
```

> **Removed**: `harness/memory/extraction/` (ETL capture/bridge/Pending) and `subsystems/memory-extractor`.
> Memory writes = agent `memory_store` tool; bypass = `memory.steward.backfill` / `memory.steward.govern` (public surface: [`docs/memory.md`](./memory.md)).
> Knowledge (exogenous corpus / layer 4) public surface: [`docs/knowledge.md`](./knowledge.md). **v0.60+**: Knowledge is split into an independent HTTP Service (sole writer of `knowledge.db`; Gateway goes through the Client; File identity + Membership); the HTTP contract is internal spec (not public). Document extraction lives in `harness/capabilities/document` (`createDocumentPortFromConfig`). **Thread boundary** (v0.64): main thread `/health` + auth + **read-only goes straight to Meta/Search Worker** + SSE; write HTTP lives in Engine/API (orchestration only); **Writer Worker** exclusively owns the writable database + ingest; parse CPU runs in nested Workers (see `docs/knowledge.md` §2.1.1).

`FileWisdomStore` / `FileProjectMemory` / `ContextIntelligence` have been removed; do not assume `memory/` or `wisdom/` file directories. System prompt layer assembly is in `harness/context/`.

### 3.7 Reliability

**Responsibility**: reliability wrapping of the Agent loop — retry, detection, supervision, circuit breaking. Emits `HarnessLoopEvent`.

```
harness/run/reliability/
├── run-agent.ts          # runAgentWithReliability() (low-level; business entry uses Agent.run)
├── harness-events.ts     # HarnessLoopEvent = AgentLoopEvent | budget/run_guard extensions
├── circuit-breaker.ts    # CircuitBreaker — circuit breaker
├── provider-wrapper.ts   # wrapProviderWithCircuitBreaker()
└── index.ts
```

The runnable facade is in `harness/agent/` (see 3.0).

### 3.0 Agent — runtime facade

**Responsibility**: hold context/config/harness; provide the **sole recommended run entry `Agent.run()`** (= reliability wrapper).

```
harness/run/agent/
├── agent.ts              # Agent class
└── index.ts
```

The Loop layer only has the pure `agentLoop` function; do not hand-wire `runAgentWithReliability` on business paths.

### 3.8 Plugin Ecosystem (extension points + call surface)

**Responsibility**: Plugin system, Skill management, tool registration, MCP integration, **conversational slash commands (Principal call surface)**.

Dual to tools/ (Agent function-call call surface); Command is **not** a top-level capability domain, and is **not** Human-in-the-Loop (HITL only does risk approval).

```
harness/extension/plugin-ecosystem/
├── plugins/              # PluginManager, HookRegistry, Loader
├── tools/                # ToolBus, BuiltinTools, web_search (Agent call surface)
├── skills/               # SkillManager (two-phase load; frontmatter.command → /name)
├── mcp/                  # McpManager, Bridge, Discovery
├── commands/             # CommandRouter / builtin / skill·user·plugin bridges
└── index.ts
```

**Command essentials** (implementation: `commands/`; issue surface: `harness/observability/diagnostics`):

- Inbound `/xxx` is adjudicated **before** the Agent Loop; handlers only return `sessionOps`; the Host materializes them
- Conflicts are fail-closed: reserved names are hard-protected; multiple same-name candidates default to reject-all (sticky, until candidates converge)
- `/stop` is the only default `preempt` control (aborts conversation across channels)
- Sources: builtin / plugin `registerCommand` / `agents/<id>/commands/*.md` / SKILL.md `command`
- Catalog: `GET /api/v1/commands` + WS welcome; UI `/` input completion

### 3.9 Autonomous Subsystem

**Responsibility**: a subsystem framework that runs autonomously outside the main Agent loop to solve specific problems.
Five-dimension model: Sense + Think + Act + Signal + Boundary.

```
harness/collaboration/autonomous-subsystem/
├── types.ts              # full type definitions for the five-dimension model
├── loader.ts             # subsystem directory loader
├── runtime.ts            # SubsystemRuntime — core runtime
├── sense/
│   ├── engine.ts         # SenseEngine (condition expressions, cooldowns, depth limits)
│   ├── metrics.ts        # MetricsStore
│   └── input-builder.ts  # input builder
├── think/
│   ├── executor.ts       # ThinkExecutor (code/llm/hybrid)
│   └── model-resolver.ts # ModelResolver (models.level + fallback)
├── signal/
│   └── bus.ts            # SignalBus (four-channel delivery)
├── session/
│   └── manager.ts        # SubsystemSessionManager
├── audit/
│   ├── writer.ts         # AuditWriter
│   └── reader.ts         # AuditReader
├── boundary/
│   └── validator.ts      # BoundaryValidator
└── index.ts
```

Subsystem definition directories (may come from framework built-ins, user-defined specs, or npm packages):
```
subsystems/
├── safety-guard/
│   ├── SUBSYSTEM.md
│   └── config.yaml
└── ...
```

**Supported sources**: framework built-ins, user-defined, npm packages (`@octopi-agent/subsystem-*` / `octopi-subsystem-*`)

### 3.10 Multi-Agent orchestration

**Responsibility**: Agent registration and discovery, multi-Agent collaborative orchestration, traceable Agent processes.

```
harness/collaboration/multi-agent/
├── registry.ts           # DefaultAgentRegistry
├── swarm.ts              # AgentSwarm + orchestration strategies
├── process.ts            # AgentProcess / spawn / fork
├── types.ts
└── index.ts
```

Core interfaces: none (contracts live in `harness/collaboration/multi-agent/agent-registry-types.ts`).

Orthogonal to Autonomous Subsystem: Multi-Agent governs “how multiple Agent instances collaborate”; Autonomous Subsystem governs “how a subsystem senses and writes back to the main system”.

### 3.11 Session Tasks

**Responsibility**: open work-item list (goal/step two levels), attached to the Session aggregate.

```
harness/session/tasks/
├── service.ts            # SessionTaskService — sole write entry
├── render.ts             # <session_tasks> injection (goal + step rollup)
├── tools.ts              # task_* tools
├── types.ts
└── index.ts
```

Design baseline: [docs/task-system.md](./task-system.md).

### 3.12 Run Guard

**Responsibility**: decide whether a single run has gone off the rails (continue / recover / stop).

```
harness/run/run-guard/
├── default-run-guard.ts  # DefaultRunGuard — rule detection + optional LLM review
├── types.ts
└── index.ts
```

Core interface: `core/interfaces/run-guard.ts` (`RunGuard`).

### 3.12b Agent Runtime — activation host

**Responsibility**: compile non-user stimuli (Triggers) into 0..N supervised Runs; explicit multi-Agent routing. Serial mutual exclusion belongs to the Session-level Runner lock (model A); see the [Architecture Constitution](./north-star.md) and Section 5 data flow.

```
harness/activation/
├── runtime.ts            # AgentRuntime
├── router.ts / compiler.ts / coalesce.ts / dispatcher.ts
└── sources/              # Schedule / Escalate / AgentSignal

integration/agent-runtime/
├── channel-message-source.ts
├── webhook-source.ts
└── file-watch-source.ts
```

The Gateway message path goes through `runtime.dispatch`; SessionGate is the only concurrency hard gate; model A (no second session queue).

### 3.13 Orchestration (experimental)

**Responsibility**: deterministic multi-step jobs. Off the main path by default; sub-path `octopi/harness/collaboration/orchestration`.

```
harness/collaboration/orchestration/
├── workflow/             # WorkflowEngine — DAG orchestration
├── scheduler/            # TaskScheduler
├── planner/              # Rule/LLM/Hybrid planner
├── strategy/             # task classification + strategy routing
├── quality/              # OutputQualityGate
├── reflector/            # LLMReflector
└── index.ts
```

Domain split: [`docs/domains.md`](./domains.md).

### 3.14 Concurrency

**Responsibility**: multi-key distribution, session stickiness, rate limiting.

```
harness/run/concurrency/
├── provider-pool.ts      # ProviderPool — multi-key load balancing
├── rate-limiter.ts       # RateLimiter — token-bucket rate limiting
├── session-gate.ts       # SessionGate — concurrency gating
├── tool-validator.ts     # ToolValidator — tool-result validation
└── index.ts
```

### 3.15 Observer — Run Observatory (development/debug observability)

**Responsibility**: package an inspectable Run scene (Scope / messages / timeline / guard / security / memory / tool.effect) for the Web Run panel and `/debug/run/*`. Different subdomains of the same Observer Domain as Core `Observer` (Telemetry); implementations are **not** merged.

```
harness/observability/observer/
├── hub.ts            # ObserverHub — event ingestion + Run projection cache
├── types.ts          # ObserverConfig / Run* DTO / resolveObserverConfig
├── run-snapshot.ts   # RunScope → UI view
└── index.ts
```

| Convention | Value |
|------|-----|
| Config key | `observer` (Telemetry uses `observability`) |
| Default | `level: 'off'`; `webPanel` follows level |
| Run identity | `RunScope.runId` / `createRunId` |
| Sampling | Runner `emitObserved`; Builder ContextEngine `emit`; Gateway does **not** re-ingest |
| Debug REST | `GET /debug/run/:sessionId/scope\|messages` (root path) |

See [docs/observer-domain.md](./observer-domain.md).

---

## 4. Context Intelligence — eight-layer model

> **Architecture Constitution**: [`docs/north-star.md`](./north-star.md) (type axis × Scope axis; invariants I1–I6). Implementation and review take that document as authoritative.
> **Product eight layers = system-side ContextLayer (1–7, including Runtime) + Information (layer 8, message window).**

### Core idea

To make an agent smart, the core is to give the session more effective context.
The context model contains two orthogonal axes:

1. **Information distillation (epistemology)**: refine raw information layer by layer and let it settle into the Agent substrate.
2. **Per-turn assembly (runtime)**: what the LLM sees this turn = Agent substrate system layers + Run live state (Runtime) + Session message window (Information).

**Implementation landing point**: `harness/context/` (`ContextLayer` contract + `DefaultContextAssembler` + thin adapter layer).
Design details: [docs/context-layer-contracts.md](./context-layer-contracts.md).

```
Distillation upward (Agent growth):
  Information → Memory → Cognition → Wisdom

Three more Agent substrate dimensions:
  Persona = the agent's DNA
  Knowledge = external reference material (multi-scope capable)
  Skill = workflow definitions
```

### Eight-layer definition (product concept model)

| # | Layer | Essence | Ownership | Default-path status |
|---|---|---|---|---|
| 1 | **Wisdom** | thinking paradigm | Agent substrate | **wired** (maxim + scenario injection + `wisdom.steward`) |
| 2 | **Persona** | the agent's DNA | Agent substrate | **wired** |
| 3 | **Skill** | workflow definitions | Agent substrate | **wired** (`formatForPrompt` index) |
| 4 | **Knowledge** | external reference material | Knowledge scope (agent by default) | **wired** (in-process store) |
| 5 | **Cognition** | concept-relation network | Agent substrate | **wired** (Conceptualizer + ConceptGraphStore + CognitionLayer) |
| 6 | **Memory** | insights extracted from interaction | store belongs to Agent; raw material from Session | **wired** (`SqliteMemoryStore`) |
| 7 | **Runtime** | live injection for this turn / this session | **Run** (Session-aware) | **wired** (tasks / guidance / `injectedContext`) |
| 8 | **Information** | raw interaction records (session messages) | **Session** | **wired** (message window; **not** a ContextLayer) |

**Concept model vs implementation contract (must-read):**

- Layer 7 of the **product eight layers** is **Runtime** (system side); layer 8 is **Information** (message window).
- `ContextLayerId` (system assembly contract) = product layers **1–7**: `wisdom / persona / skill / knowledge / cognition / memory / runtime`.
- **Information does not enter ContextAssembler**; `DefaultContextEngine` does message selection / compaction / proactive summarization.
- Identity: **product eight layers = system ContextLayer (7) + Information (1)**. `ContextLayerId` needs no add/remove for the eight layers.

### Assembly division of labor

```
Distillation (epistemology):
  Information (session) → Memory → Cognition → Wisdom

What the LLM actually receives:
  system prompt  = ContextLayer assembly (Wisdom/Persona/Skill/Knowledge/Cognition/Memory/Runtime)
  messages       = Information window (ContextEngine)
```

System contract-layer order (= product layers 1–7):

```
1. Wisdom     ← order 10   Agent substrate
2. Persona    ← order 20   Agent substrate
3. Skill      ← order 30   Agent substrate
4. Knowledge  ← order 40   Knowledge scope
5. Cognition  ← order 50   Agent substrate
6. Memory     ← order 60   Agent store + Run recall
7. Runtime    ← order 70   Run live state (tasks/guidance/injectedContext)
8. Information ← not a ContextLayer; ContextEngine manages the window (product layer 8)
```

### Abstractions of the memory/ domain (after redesign)

```
Information → Memory   distill: actionable propositions (fact / method / norm)
Memory → Cognition     structure: relations among concepts (cognition.steward.conceptualize)
Memory → Wisdom        sublimate: thinking paradigm (wisdom.steward.formation)
```

Write channel: primary agent `memory_store` (constitution + gating + confidence) → MemoryStore;
bypass governance: `memory.steward.backfill` / `memory.steward.govern`.
**No** session ETL extractors.

---

## 5. Core Data Flow

```
User message
  ↓
SessionAwareRunner.handle()           ← Session lifecycle; seeds contextCompact
  ↓
SessionTask / guidance → injectedContext
  ↓
ContextAssembler (system contract layers)   ← Persona + Skill + Knowledge + Memory + Cognition + Wisdom + Runtime
  ↓
Agent.run() / runAgentWithReliability()
  ↓
agentLoop() → convertToLlm
  ↓
DefaultContextEngine.assemble()        ← Information: proactive summary + window selection/compaction
  ↓
ModelProvider.call()
  ↓
[tool_calls] → SecurityGuard → [HITL?] → ExecutionEnv → Tool
  ↓
HarnessLoopEvent + context.compact.* / context.layers.assembled events
  ↓
Session save: full messages + contextCompact snapshot
  ↓
[after the task ends] → when salient to the primary agent, memory_store / memory.steward backfill·govern (Information→Memory); Memory→Cognition goes through cognition.steward.conceptualize; Memory→Wisdom goes through wisdom.steward.formation (multi-source gating)
```

---

## 6. Interface Inventory

| Interface | File | Current implementation |
|------|------|---------|
| `ModelProvider` | `core/interfaces/model-provider.ts` | OpenAI, Anthropic, ProviderPool |
| `ContextEngine` | `harness/context/types.ts` | DefaultContextEngine |
| `ErrorStrategy` | `core/interfaces/error-strategy.ts` | DefaultErrorStrategy |
| `SecurityGuard` | `core/interfaces/security-guard.ts` | DefaultSecurityGuard |
| `ToolCallRiskPolicy` | `core/interfaces/security-guard.ts` | DefaultToolCallRiskPolicy |
| `Observer` | `core/interfaces/observer.ts` | NoopObserver, LogObserver, ObserverBridge (**Telemetry**) |
| `ObserverHub` / Run Observatory | `harness/observability/observer/*` | ObserverHub (**development/debug**; see [observer-domain.md](./observer-domain.md)) |
| `SessionStore<T>` | `core/interfaces/session-store.ts` | JsonlSessionStore, InMemorySessionStore |
| `SessionHistoryPort` | `harness/session/history/` | DefaultSessionHistoryPort (`session_search` / `session_read`) |
| `SessionIndexBackend` | `integration/storage/session-index.ts` | SqliteSessionIndex (rebuildable projection, not authoritative) |
| `AsyncTaskStore` | `harness/collaboration/orchestration/async-task-store.ts` | orchestration |
| `RunGuard` | `core/interfaces/run-guard.ts` | DefaultRunGuard |
| `AgentRegistry` | `harness/collaboration/multi-agent/agent-registry-types.ts` | DefaultAgentRegistry |
| `McpClient` | `harness/extension/plugin-ecosystem/mcp/types.ts` | SdkMcpClient |
| `EventSource` | `harness/activation/event-source-types.ts` | — |
| `MessageChannel` | `harness/collaboration/multi-agent/message-channel-types.ts` | — |
| `MemoryStore` etc. | `harness/memory/types.ts` | InMemory / Sqlite |
| `KnowledgeCatalogProvider` | `harness/knowledge/types.ts` | (Tier 0 catalog) |
| Knowledge Service / Client | `harness/knowledge/{http-app,serve,client}.ts` | sole writer of `knowledge.db`; Gateway does not open the db |
| Knowledge Source/Index/Ingest | `harness/knowledge/` | File identity + Membership; see `docs/knowledge.md` |
| `DocumentPort` | `harness/capabilities/document/` | `createDocumentPortFromConfig(documents.*)` |
| CredentialStore | `harness/governance/credentials/` | resource-access credentials; not octopi.json |
| `ContextLayer` / `ContextAssembler` | `harness/context/layer-types.ts` | DefaultContextAssembler + layers |
| `Planner` / `Reflector` | `harness/collaboration/orchestration/cognitive-loop.ts` | Rule/LLM/Hybrid |

### Model resolution funnel (ResolvedModel)

**Contract**: each run / catalog entry resolves model capability once; downstream reads only the snapshot.

| Module | Responsibility |
|------|------|
| `harness/run/model/resolver.ts` | `resolveModel` / `resolveCatalogEntry` — **sole** binding + capability policy |
| `harness/run/model/run-scope.ts` | ALS only passes `ResolvedModel` |
| `harness/run/model/types.ts` | `ResolvedModel.contextWindow?` / `known` / `source` |
| `core/types/model-info.ts` | `DEFAULT_CONTEXT_WINDOW` (**config-layer historical constant only**; the engine does not use it as a runtime budget fallback) |

**contextWindow semantics (unknown means no guessing)**:

- **Only explicit configuration** counts as known: `models.providers[].models[].contextWindow`, values hard-coded in agent.model, user-configured `defaults.contextWindow`
- Providers do **not** auto-merge builtin tables; the resolver does **not** use builtin/200k as budget
- Unconfigured → `contextWindow: undefined` / REST `null`; UI shows “unknown”

**Unknown vs configured**:

| Feature | Window configured | Window unknown |
|------|------------|----------|
| LLM call | ✓ | ✓ |
| Automatic/proactive compaction | ✓ | **skipped** |
| assemble truncates messages by token | ✓ | **skipped** |
| Seven-layer system window-ratio budget | ✓ | no hard cut by window; optional `contextAssembler.systemBudgetTokens` |
| Manual/force **structural compaction** | ✓ | ✓ (head/tail + summary; `POST /sessions/:id/compact`) |
| `compactTargetTokens` | optional | explicit target, not a guess |

**Model reference priority**:

```text
Message-level RunConfig.model (only explicit metadata.model)
  > session.metadata.model (session override)
  > undefined → Resolver resolves the agent default (isOverride=false)
```

**Do not** write the agent default model into `runConfigDefaults.model` (it swallows the session override).

**Data flow**:

```text
config → Gateway.setModelResolver → Runner (once per run, and before the system assembler)
  → ResolvedModel
    ├─ Agent.run({ resolvedModel }) → ALS
    ├─ convertToLlm / summarize: read-only snapshot.contextWindow (may be undefined)
    ├─ system assembler: post-resolve contextWindow
    └─ REST /models, sessions/:id/model, compact: same-source known/source
```

WebUI does **not** do budget policy; it only renders `known` / `source` / `contextWindow`.

`harness/run/reliability/model-binding.ts` and `run-model-context.ts` are compatibility re-exports; new code should import `harness/run/model`.

> Concurrency and Run scope: under the same Agent across multiple Sessions, mutable context lives only in **RunScope** (see [Architecture Constitution](./north-star.md) I1). `SessionAwareRunner` does not use shared `Agent.context` as a session workspace.
>
> Tool effects (ToolEffectPolicy / I5): configure `effectPolicy` (modes workspace|project|host|untrusted). Omitting `mode` defaults to **workspace** (secure-by-default); scaffolds (`octopi init` / example config) set `"mode": "host"` explicitly for local evaluation. Cwd layout can still be overridden by `toolIsolation`. Edit-replay via turn undo (file + memory + shell snapshot). Tool calls must include `purpose`. Process isolation and `untrusted` admission: [`process-isolation.md`](./process-isolation.md).
> Session lock (E2/E7): `SessionLease` interface; v1 is `InProcessSessionLock`; distributed deployments must replace the implementation.
> Session data (model 2): `primaryAgentId` + `preferredAgentId` (≠ primary); compact key `(sessionId, agentId)`; ACL role catalog under the `sessionAcl` config.
> Gateway defaults: injects Session ACL + shared SessionLease (compatible with the single-agent primary path; multi-agent guests without a grant are rejected).
> Leftover items: [`docs/KNOWN-ISSUES.md`](./KNOWN-ISSUES.md).

---

## 7. AgentBuilder — Fluent API

The public build entry is **`build(options?)`** (default `mode: 'full'`). `buildAgent()` is deprecated and equals `build({ mode: 'core' })` (Agent facade only).

```typescript
const { agent, harness, runner, runtime, events, contextHealth } = await new AgentBuilder()
  // model
  .model(myProvider)
  .provider('backup', backupProvider)
  .concurrency({ providerPool: { ... } })

  // persona / skill / memory (home and persona are decoupled; agent.db uses home)
  .agentHome('~/.octopi/agents/my-agent')
  .agentId('my-agent')
  .persona('./my-agent')
  .skillDirectory('./my-agent/skills')
  .memoryStore(myMemoryStore)   // seven-layer MemoryLayer, memory_* tools, steward share this instance
  .knowledgeCatalog(myCatalogProvider)

  // tools
  .tool(myTool)
  .mcpClientFactory(createSdkMcpClient)   // Integration injection (exported by octopi)
  .mcp({ id: 'fs', transport: 'stdio', command: 'npx', args: [...] })

  // context
  .contextEngine(myContextEngine)
  .summarize(mySummarizeFn)          // optional; auto-wires the primary model/mini by default
  .disableAutoSummarize()            // optional: turn off automatic summarize

  // security (rule engine; the safety-guard subsystem is auto-loaded from subsystems/)
  .withRiskPolicy(myRiskPolicy)

  // reliability
  .runGuard()
  .reliability({ planningRetry: { maxAttempts: 3 } })

  // observability (import 'octopi' already registers createRunTelemetry; or .telemetryFactory(...))
  .trace({ captureToolArgs: true })

  // autonomous subsystems
  .withSubsystem(mySubsystemSpec)
  .subsystemAllowlist('memory-steward')     // id / packageId / memory.steward.*
  .subsystemDenylist('safety-guard')        // optional: forbid (takes precedence over allow)

  // Session
  .store(mySessionStore)

  // build: autoLoadSubsystems defaults to true (full); unrelated to memoryStore
  .build({
    // mode: 'core',
    // autoLoadSubsystems: false,
    // subsystemAllowlist: [...],
    // subsystemDenylist: [...],
  });
```

**build() default behavior (full)**

| Item | Behavior |
|----|------|
| Subsystem discovery | `autoLoadSubsystems` defaults to `true`; allow/deny support id / packageId / `memory.steward.*` (deny wins) |
| `memoryStore` | `registerDependency('memoryStore')` + `sessionStore`/`constitution`; and registers `memory_store` / `memory_search` with the **same instance** |
| Memory bypass | `memory.steward.backfill` / `memory.steward.govern` (**no** ETL `memoryExtraction` handle) |

The Gateway serve path is assembled via `builder.build()`; governance-type subsystem signals go only through events and are not injected into the main session.

---

## 8. Tech Stack

- **Language:** TypeScript (ESM, Node.js >=24)
- **SQLite persistence layer:** Node built-in `node:sqlite` (`DatabaseSync`); do not introduce `better-sqlite3`
- **Build:** tsc
- **Tests:** Vitest (node --experimental-vm-modules)

---

## 9. Related Documents

- [Architecture Constitution](./north-star.md) — ontology and long-term invariants
- [Known Issues](./KNOWN-ISSUES.md) — public issue summary
- `docs/plugin-system.md` — Plugin system detailed documentation
- `docs/task-system.md` — SessionTask design baseline
- `docs/domains.md` — product domains and module ownership (run-guard / orchestration / AsyncTask see the Collaboration / Run domains)
- `docs/CONTRIBUTING.md` — development guidelines
- `docs/context-layer-contracts.md` — ContextLayer / Assembler contracts
- `packages/webui/DESIGN.md` — WebUI (Playground) visual and eight-layer inspector design
- Web Runtime / session display / context UI design — internal archive (as-built; not public)
