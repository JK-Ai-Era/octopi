# Octopi Contributing Guide

> **Language note**: This English edition is the **working authority**. The Chinese translation is [`CONTRIBUTING.zh.md`](./CONTRIBUTING.zh.md). Every change must land in both files in the same commit; when the two disagree, English wins.
> This document is for developers and contributors to the Octopi project.
> If you are an integration developer (adopting Octopi as your agent substrate), see the public API examples in [architecture.md](./architecture.md).

## Requirements

- Node.js >= 24 (the persistence layer uses built-in `node:sqlite`; no native SQLite extension build)
- TypeScript 6.x for the root/engine/gateway build (`packages/webui` stays on 5.x); both come from
  `devDependencies`, so `npm install` is enough

## Development Commands

```bash
# Build (root + all four packages)
npm run build          # clean → core → engine → gateway → webui → root tsc → assets → schema → bin

# Test — always go through the npm script: it supplies --experimental-vm-modules
npm test               # full suite (root tests/** plus packages/webui tests)
npm run test:coverage

# A single file / a filtered subset
npm test -- tests/core-engine.test.ts
npm test -- -t "SecurityGuard"

# Typecheck
npm run lint           # eslint + tests typecheck + webui tsc
npm run typecheck      # tests typecheck against the known-error baseline

# Development (each package watches its own tsc target)
npm run dev            # root src/ only (tsc --watch)
npm --prefix packages/engine run dev   # per-package watch; repeat for core/gateway
npm run web            # webui vite dev server
```

`npm test` and `npm run test:coverage` set `--experimental-vm-modules` for you. A bare
`npx vitest run` works for the current suite, but going through the npm scripts keeps every
contributor on the same flags.

## Architecture Layers

The project uses a four-layer onion architecture + DDD domain organization:

| Layer | Directory | Responsibility | Dependencies |
|---|---|---|---|
| Core (kernel) | `packages/core/src/core/` | Mechanism primitives + interface contracts + core types (the shared vocabulary) | No external dependencies (dependency floor) |
| Loop | `packages/core/src/loop/` | Pure execution loop (`agentLoop`, `callModel`) | Core types & pure utilities (stateless, no I/O) |
| Harness | `packages/engine/src/harness/` | Product domain organization (see `docs/domains.md`) | Core + Loop |
| Integration | `packages/engine/src/integration/` + `packages/gateway/src/` | External system adapters | Core + Loop + Harness |

The suite package (`src/cli/`, `src/init.ts`, config IO) sits outside the four layers and composes them;
`packages/webui` is the prebuilt console served by the gateway.

For the detailed architecture see [docs/architecture.md](./architecture.md); for long-term invariants see the [Architecture Constitution](./north-star.md).
Implementation status and open items: [docs/KNOWN-ISSUES.md](./KNOWN-ISSUES.md) and [CHANGELOG](../CHANGELOG.md).

**Development notes (runtime semantics already fixed by the constitution):**

- `effectPolicy` (omitting `mode` defaults to `workspace`; `octopi init` scaffolds `project`): tool effect mode + L2 + turn undo (file/memory/shell snapshot) + host-gate + `shellJournal`/`undoLimit`; `toolIsolation` covers cwd layout only (I5). Multi-session file writes use `session-subdir` or `project` mode. LLM tool calls require `purpose` (brief action description).
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
- Config changes: edit the Zod schemas in `packages/engine/src/config-schema/` + the root `src/config-schema/` compose, then run `npm run generate:schema` (`src/config-schema.ts` is only a compatibility re-export; `octopi.schema.json` is generated — never hand-edit it). Keep `octopi.example.json` valid against the generated schema

**Dependency direction: outer → inner. When changing an inner layer, confirm it does not affect outer layers.** Concrete order: Integration → Harness → Loop → Core (Loop builds on Core types; Core never imports Loop).

## Testing Standards

```bash
# Full suite
npm test

# A single test file
npm test -- tests/core-engine.test.ts

# Matching test names
npm test -- -t "SecurityGuard"
```

**Test file naming:** `tests/<module>.test.ts` (webui component tests live beside their source under
`packages/webui/src/**/*.test.{ts,tsx}` and are picked up by the same run).

**Current test distribution:** see the repository `tests/**` (shared-capability tests for
summary/compact/document live under `tests/harness/capabilities/`).

| Test area | Coverage |
|---|---|
| Loop protocol | agentLoop pure functions, callModel, error classification, terminate/finishReason/phase contracts |
| Harness facade | Agent.run, AgentBuilder, SessionAwareRunner, reliability wrappers |
| Security | SecurityGuard, RiskEvaluator, DefaultRiskPolicy, ShellParser |
| Context management | ContextEngine, DefaultMessageSelector, BudgetAllocator, turn envelopes, ContextLayer/Assembler, proactive summary |
| Shared capabilities | SummaryPort types / `summarizeFn` injection, CompactEngine, document Port (`tests/harness/capabilities/`) |
| Session tasks / process supervision | SessionTaskService, task_* tools, DefaultRunGuard |
| Plugin system | Manifest-first loader, contribution registry, PluginManager hooks |
| Skill management | SkillManager two-phase loading |
| Tool system | DefaultToolBus, tool registration/replace, plugin tool authorization |
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
| Module add/remove/rename, moved files, structure trees in `arch/*.md` | `bash arch/check-sync.sh` must be green (see `arch/sync-protocol.md`); treat red as a gate, never weaken the checker. **Maintainer-only**: `arch/` is gitignored (internal handoff docs), so a fresh clone has no `arch/check-sync.sh` |
| Change architecture invariants | **`docs/north-star.md`** (explicit review required) + `CHANGELOG.md` |
| Test count changes | `README.md` + `CHANGELOG.md` |

### Module README Sync

When modifying any module, update that module directory’s `README.md` in sync:

- **Responsibility changes** — update “Responsibilities” and “What it does not do”
- **Files added/removed** — update “File notes”
- **Dependency changes** — update “Dependencies”
- **New module** — create the corresponding `README.md`

### Documentation Update Checklist

Before committing, confirm:

- [ ] Matching section in `docs/architecture.md` updated (if applicable)
- [ ] The modified module’s `README.md` is updated (responsibilities / file notes / dependencies)
- [ ] New interfaces/types are documented
- [ ] Test count updated
- [ ] `CHANGELOG.md` records the change
- [ ] Public-doc changes land in both `*.md` and `*.zh.md` in this commit (English authoritative)
- [ ] No violation of [Architecture Constitution](./north-star.md) invariants (live list: §2 of `north-star.md`)

### Architecture Document Revision Stamp

There is no document-level semantic version for `architecture.md` (the former v0.x scheme is retired — it stopped being maintained after v0.36.0). When you materially change `architecture.md`, update its header stamp **`Revised: <date> (as of <repo version>)`**; full history lives in git, and user-visible architecture changes are recorded in `CHANGELOG.md`.

## New Module Checklist

When adding a module:

1. Decide which layer it belongs to (Loop / Core / Harness / Integration / Gateway / suite `src/`)
2. Export it from that layer’s `index.ts`
3. Add the export in `src/index.ts` (if it is public API)
4. Write test file `tests/<module>.test.ts`
5. Update the matching section of `docs/architecture.md` (if externally visible behavior/structure changed)
6. Update `CHANGELOG.md`

## Plugin Development

Plugin directory layout (full Manifest v1 contract: [Plugin system docs](plugin-system.md)):

```
my-plugin/
├── octopi.plugin.json   ← Manifest v1 (`apiVersion: "1"`) — unversioned manifests are rejected before import
├── index.js             ← compiled ESM entry (path declared in the manifest; `definePlugin`)
└── package.json
```

Notes: the manifest is the installation-time declaration authority (`entry`, `engine.octopi` range; `contributes` must match what the entry registers); registration is **not** Tool exposure — a contributed Tool is only mounted when listed in the target Agent's `tools.allow`.

## Commit & Pull Request Conventions

- **Commit format**: [Conventional Commits](https://www.conventionalcommits.org/) — `<type>(<scope>): <description>`; types: `feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `ci`. The `<description>` must be written in **English**. Each commit has a single responsibility.
- **Every content commit carries its release chores in the same commit**: pick the version segment (major = explicit user request; minor = major feature or architecture change; patch = everything else), run `npm run release:prep -- <X.Y.Z>`, prepend the `## v<X.Y.Z> (YYYY-MM-DD)` entry to `CHANGELOG.md`, commit code + version files + `CHANGELOG.md` together, and tag the commit right away (`git tag v<X.Y.Z>`).
- **Public docs are bilingual**: any change to `docs/*`, `README.md`, or `CONTRIBUTING.md` lands in both the English file and its `*.zh.md` translation **in the same commit**; English is authoritative.
- **Before opening a PR**: `npm run lint` and `npm test` pass locally; documentation is synced per [Documentation Sync](#documentation-sync); the change does not violate the [Architecture Constitution](./north-star.md) invariants.

### Release Versions (five-package lockstep)

Since **v0.56.0**, `octopi-agent` and `@octopi-agent/{core,engine,gateway,webui}` **always share one version number**, with internal dependencies pinned to that exact version (not `^`).

```sh
npm run release:prep -- 0.56.0   # same version on all five packages + pin deps
npm run release:print            # print publish order
```

Version bumps happen on **every content commit** (see above); publishing is a separate, maintainer-driven step in dependency order `core → engine → gateway → webui → octopi-agent`. Full discipline: `AGENTS.md` → Version Numbering Rules / Changelog Discipline.

## License and Contribution Grant

This project uses the **Apache License 2.0** (see repository root [`LICENSE`](../LICENSE) and [`NOTICE`](../NOTICE)).

By submitting a Contribution to this project (including pull requests, patches, and documentation revisions), you agree that:

1. You license that Contribution to the project under **Apache-2.0** (no separate CLA required unless maintainers ask);
2. You grant the project and downstream users the **patent license** described in Apache-2.0 §3 (including the patent retaliation clause);
3. You have the right to make that grant (for example: the work does not infringe third-party rights, or you have employer/rightsholder consent).

Keep existing copyright and license notices in modified files; for new files, prefer an Apache-2.0 file header or rely on the root `LICENSE` / `NOTICE`.
