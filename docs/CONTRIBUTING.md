# Octopi Contributing Guide

> **Language note**: This English edition is the **working authority**. The Chinese translation is [`CONTRIBUTING.zh.md`](./CONTRIBUTING.zh.md). Keep both in sync.
> This document is for developers and contributors to the Octopi project.
> If you are an integration developer (adopting Octopi as your agent substrate), see the public API examples in [architecture.md](./architecture.md).

## Requirements

- Node.js >= 24 (the persistence layer uses built-in `node:sqlite`; no native SQLite extension build)
- TypeScript >= 5.0

## Development Commands

```bash
# Build
npm run build          # tsc compile

# Test
npm test               # run all tests (node --experimental-vm-modules)
npx vitest run         # equivalent command
npx vitest watch       # watch mode

# Development
npm run dev            # tsc --watch
```

## Architecture Layers

The project uses a four-layer onion architecture + DDD domain organization:

| Layer | Directory | Responsibility | Dependencies |
|---|---|---|---|
| Loop | `packages/core/src/loop/` | Pure execution loop | Core types only |
| Core | `packages/core/src/core/` | Mechanism primitives + interface contracts + core types | No external dependencies |
| Harness | `packages/engine/src/harness/` | Product domain organization (see `docs/domains.md`) | Core + Loop |
| Integration | `packages/engine/src/integration/` + `packages/gateway/src/` | External system adapters | Core + Loop + Harness |

For the detailed architecture see [docs/architecture.md](./architecture.md); for long-term invariants see the [Architecture Constitution](./north-star.md).
Implementation status and open items: [docs/KNOWN-ISSUES.md](./KNOWN-ISSUES.md) and [CHANGELOG](../CHANGELOG.md).

**Development notes (runtime semantics already fixed by the constitution):**

- `effectPolicy` (default `host`): tool effect mode + L2 + turn undo (file/memory/shell snapshot) + host-gate + `shellJournal`/`undoLimit`; `toolIsolation` covers cwd layout only (I5). Multi-session file writes use `session-subdir` or `project` mode. LLM tool calls require `purpose` (brief action description).
- compact key = `(sessionId, agentId)`; do not share one agent compact under a bare sessionId (E4)
- Shared capabilities `harness/context/capabilities/`: summary/compact are **not** LLM tool surfaces; tools only consume `SummaryPort`; prompt/policy/algorithms must not go into `plugin-ecosystem/tools`; E4 session compact state does not live in capabilities
- Before a tool result enters the main session: the **L1 hard cap** (`maxReturnChars`) must apply; “return the full text first, then let the Agent call summary” is forbidden as the main anti-overflow path
- Session lock/lease key = `sessionId`; Gateway injects a **shared** `InProcessSessionLock`; do not assume an in-memory lock is valid across processes (E2/E7)
- Gateway injects Session ACL by default; `preferredAgentId` ≠ `primaryAgentId`; handoff is host-only by default (I3/E6)
- SessionStore treats sessionId as first-class: `load(sessionId)` / `save(sessionId, data)`; directory `OCTOPI_HOME/sessions/` (sole runtime backend `JsonlSessionStore`)
  - **`save` shallow-merges metadata for existing sessions** (on-disk keys are not wiped by a stale empty object); **deleting keys requires `updateMetadata`** (e.g. `abortedTurn`, `setSessionModel(null)`)
  - `contextDetachIndex` is an index into `messages`; any path that rewrites `messages` (write-back filtering / truncate) must clamp or recompute it
  - Gateway paths that mutate `session.messages` (e.g. `truncateMessagesFrom`) must hold the **same `sessionLease`** to avoid races with Runner write-back
  - Context lease `session.idleExpiryMs`: **opt-in**; only truncates the LLM default window, does not delete Discourse; over-window goes to compact; start fresh with `/new`
- History retrieval: `session_search` / `session_read` (Information originals, ≠ `memory_search` propositions); index projection is an internal spec (not public)
- Config changes: keep `src/config-schema.ts`, `octopi.schema.json`, `octopi.example.json` in sync

**Dependency direction: outer → inner. When changing an inner layer, confirm it does not affect outer layers.**

## Testing Standards

```bash
# Run all tests
npm test

# Run a single test file
npx vitest run tests/core-engine.test.ts

# Run matching tests
npx vitest run -t "SecurityGuard"
```

**Test file naming:** `tests/<module>.test.ts`

**Current test distribution:** see the repository `tests/**` (including shared capabilities under `tests/harness/context/capabilities/`)

| Test area | Coverage |
|---|---|
| Loop protocol | agentLoop pure functions, callModel, error classification, terminate/finishReason/phase contracts |
| Harness facade | Agent.run, AgentBuilder, SessionAwareRunner, reliability wrappers |
| Security | SecurityGuard, RiskEvaluator, DefaultRiskPolicy, ShellParser |
| Context management | ContextEngine, SmartRouter, MessageSelector, Compressor, ContextLayer/Assembler, proactive summary |
| Shared capabilities | SummaryPort/L1L2/structured/oversized, CompactEngine, tools wiring (`tests/harness/context/capabilities/`) |
| Session tasks / process supervision | SessionTaskService, task_* tools, DefaultRunGuard |
| Plugin system | PluginManager, HookRegistry, CapabilityRegistry |
| Skill management | SkillManager two-phase loading |
| Tool system | ToolRegistry, tool versioning |
| Autonomous subsystem | SubsystemRuntime, SenseEngine, ThinkExecutor, SignalBus |
| Delegation | DelegateService, DelegateTransport, AgentRegistry, RunnerChildRunPort |
| Concurrency | ProviderPool, SessionGate, RateLimiter |
| Observability | TraceCollector, MetricsAggregator, ObserverBridge (Telemetry) |
| Run Observatory | ObserverHub, resolveObserverConfig, security/memory/tool.effect projections, store session guards |
| Integration | OpenAI/Anthropic Provider, MCP Client |
| Record & replay | RecordingProvider, ReplayProvider, ChaosProvider |
| Architecture gates | Layered dependency direction (boundaries), domains.yaml directory catalog (domains-catalog, `tests/architecture/`) |

## Code Standards

- TypeScript strict mode
- ESM (`"type": "module"`)
- Import specifiers use the `.js` suffix (TypeScript ESM requirement)
- Comments use JSDoc format
- Every file must have a module-level header comment

## Documentation Sync

**Core principle: code changes must update documentation in sync.**

| Change type | Docs to update |
|----------|---------------|
| Add/modify a core interface | Matching section in `docs/architecture.md` + `CHANGELOG.md` |
| Add a Plugin hook | `docs/plugin-system.md` + `docs/architecture.md` (if applicable) |
| Add a module | `docs/architecture.md` + the module’s `README.md` |
| Observer / `observer` config | `docs/observer-domain.md` + `docs/architecture.md` + `octopi.schema.json` / `octopi.example.json` |
| Shared capabilities summary/compact | `docs/context-layer-contracts.md` + `docs/architecture.md` + `packages/engine/src/harness/README.md` + `packages/engine/src/harness/context/README.md` + schema/example; internal spec (not public) |
| Change inter-layer dependencies / layering | `docs/architecture.md`; must not violate the [Architecture Constitution](./north-star.md) or this file’s “dependency direction” |
| Change architecture invariants | **`docs/north-star.md`** (explicit review required) + `CHANGELOG.md` |
| Test count changes | `README.md` + `CHANGELOG.md` |

### Documentation Update Checklist

Before committing, confirm:

- [ ] Matching section in `docs/architecture.md` updated (if applicable)
- [ ] New interfaces/types are documented
- [ ] Test count updated
- [ ] `CHANGELOG.md` records the change
- [ ] No violation of [Architecture Constitution](./north-star.md) invariants (I1–I6 / E1–E7)

### Architecture Document Versioning

`architecture.md` uses semantic versioning:

- **Major (v2 → v3)**: overall architecture changes, core concept changes
- **Minor (v2.0 → v2.1)**: new modules, important interface changes
- **Patch (v2.0.1 → v2.0.2)**: errata, detail supplements

### Release Versions (five-package lockstep)

Since **v0.56.0**, `octopi-agent` and `@octopi-agent/{core,engine,gateway,webui}` **always share one version number**, with internal dependencies pinned to that exact version (not `^`).

```sh
npm run release:prep -- 0.56.0   # same version on all five packages + pin deps
npm run release:print            # print publish order
```

Flow: bump version → write `CHANGELOG` → commit + tag → publish in order `core → engine → gateway → webui → octopi-agent`. See `AGENTS.md` Version Numbering Rules.

## New Module Checklist

When adding a module:

1. Decide which layer it belongs to (Core / Harness / Integration)
2. Export it from that layer’s `index.ts`
3. Add the export in `src/index.ts` (if it is public API)
4. Write test file `tests/<module>.test.ts`
5. Update the matching section of `docs/architecture.md` (if externally visible behavior/structure changed)
6. Update `CHANGELOG.md`

## Plugin Development

Plugin directory layout:
```
my-plugin/
├── octopi.plugin.json   ← manifest
└── index.ts             ← entry (definePluginEntry)
```

See the [Plugin system docs](plugin-system.md).

## Documentation Sync Rules

### 1. Architecture Documentation Sync

When a change involves architecture adjustments (interface changes, new modules, dependency direction changes), update `docs/architecture.md` in sync; if it touches long-term invariants, you must revise **`docs/north-star.md`** and go through review.

### 2. Module README Sync

When modifying any module, update that module directory’s `README.md` in sync:

- **Responsibility changes** — update “Responsibilities” and “What it does not do”
- **Files added/removed** — update “File notes”
- **Dependency changes** — update “Dependencies”
- **New module** — create the corresponding `README.md`

Checklist:
- [ ] I updated the modified module’s `README.md`
- [ ] I updated `docs/architecture.md` (if applicable)
- [ ] I updated `CHANGELOG.md`

## License and Contribution Grant

This project uses the **Apache License 2.0** (see repository root [`LICENSE`](../LICENSE) and [`NOTICE`](../NOTICE)).

By submitting a Contribution to this project (including pull requests, patches, and documentation revisions), you agree that:

1. You license that Contribution to the project under **Apache-2.0** (no separate CLA required unless maintainers ask);
2. You grant the project and downstream users the **patent license** described in Apache-2.0 §3 (including the patent retaliation clause);
3. You have the right to make that grant (for example: the work does not infringe third-party rights, or you have employer/rightsholder consent).

Keep existing copyright and license notices in modified files; for new files, prefer an Apache-2.0 file header or rely on the root `LICENSE` / `NOTICE`.
