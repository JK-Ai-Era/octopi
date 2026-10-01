# AGENTS.md

This file governs AI coding agent behavior in the `octopi` repository. **Read this file before making any code changes.**

---

## Project Overview

- **Project name**: `octopi`
- **One-line summary**: An embeddable agent engine for building AI-powered applications.
- **Core stack**: TypeScript / Node.js / Vitest
- **Package manager**: `npm`
- **Runtime Directory**: `~/.octopi/`
- **SQLite**: built-in `node:sqlite` (`DatabaseSync`); requires **Node.js >= 24**. Do not reintroduce `better-sqlite3`.

---

## Repository Layout

npm workspaces monorepo (see `arch/npm-package-split.md`):

```
packages/core/       @octopi-agent/core — Loop + Kernel (Layer 0–1)
packages/engine/     @octopi-agent/engine — Harness 10 domains + library integrations + built-in subsystems
packages/gateway/    @octopi-agent/gateway — HTTP/WS + web runtime
packages/webui/      @octopi-agent/webui — prebuilt Web console
src/                 Suite octopi-agent — cli/, init, config IO + compose, testing/, tui/
tests/               Vitest suite (root)
docs/                Public documentation
arch/                Internal design handoffs
```

**Import map (do not invent alternatives):**

| Surface | Package |
|---------|---------|
| CLI / `loadConfig` / compose schema | `octopi-agent` |
| `Agent.run()` / Harness | `@octopi-agent/engine` |
| Kernel / Loop | `@octopi-agent/core` |
| Gateway / Web SDK | `@octopi-agent/gateway` |
| Plugin SDK | `@octopi-agent/engine/plugin-sdk/*` |

---

## Configuration Files

| File | Tracked? | Purpose |
|------|----------|---------|
| `octopi.schema.json` | yes | JSON Schema for editor autocomplete / validation |
| `octopi.example.json` | yes | Canonical template — keep in sync with Zod schema |
| `octopi.json` | **no** (gitignored) | Local runtime instance only |

**Do not commit or recreate a repo-root `octopi.json` for day-to-day work.** It shadows the workspace config when `loadConfig` resolves `./octopi.json` first.

Canonical runtime config lives at **`~/.octopi/octopi.json`** (`OCTOPI_HOME`).

```sh
# preferred
octopi serve start -c ~/.octopi/octopi.json
# or
cd ~/.octopi && octopi serve start
```

CLI helpers (`ensureInitialized` / `ensureDaemonConfig`) prefer `OCTOPI_HOME` over cwd. When changing config shape, update **Zod** under `packages/engine/src/config-schema/` + root compose (`src/config-schema/`); regenerate `octopi.schema.json` via `npm run generate:schema`.

### Runtime home layout (`OCTOPI_HOME`, default `~/.octopi`)

Scaffolded by `src/init.ts` (`initOctopi` / `ensureAgentDirs`). Keep init, types, schema, and docs aligned with this tree:

```
~/.octopi/
  octopi.json           # System config + system-level secrets (LLM providers…); do not put resource-access credentials here
  audit/
  logs/                 # gateway.log — serve start daemon log & startup failure diagnostics
  plugins/
  sessions/             # JsonlSessionStore (sessionId is first-class; the only runtime Session backend)
    sessions.json       # meta index (lifecycle / endedAt)
    <id>.jsonl / <id>.state.json
  sessions.index.db     # Rebuildable search projection (optional; not authoritative — see arch/session-history-search.md)
  archives/             # Cold archive backup *.sessions.jsonl.gz
  knowledge/            # Knowledge data plane (knowledge.db; see docs/knowledge.md)
  credentials/          # Integration credentials vault (credentials.db; env/file refs or AES-GCM ciphertext)
  agents/<id>/          # agent home
    AGENTS.md           # main persona (loaded first by loadPersona)
    persona/            # supplemental persona (*.md, numeric prefix for order)
    skills/             # skillDirectory target
  workspace/<id>/       # tool sandbox cwd
```

**Do not create `agents/<id>/memory/` or `agents/<id>/wisdom/` directories.** Memory / Cognition / Wisdom persist in a per-agent SQLite file via `AgentDatabase` (`packages/engine/src/harness/memory/sqlite/agent-db.ts`), not as sibling folders under home.

**Knowledge exogenous corpus does not live in `agent.db`.** Source registration + indexes are in `OCTOPI_HOME/knowledge/knowledge.db`; resource-access credentials are in `OCTOPI_HOME/credentials/credentials.db` (referenced via `authRef`; plaintext secrets never enter `knowledge.db` / `octopi.json`). See `docs/knowledge.md`.

**Do not use `memory.extractor` ETL or `MemoryExtractionWiring`.** Memory write path is agent `memory_store` + `memory.steward.*` subsystems. See `docs/memory.md` and `arch/memory-system-redesign.md`.

**Do not reintroduce `SqliteSessionStore`.** Runtime sessions are Jsonl-only (`OCTOPI_HOME/sessions/`). `sessions.index.db` is a rebuildable search projection (FTS5+LIKE), never a second authority. History tools: `session_search` / `session_read` (Information verbatim) vs `memory_search` (propositions). Spec: `arch/session-history-search.md`.

---

## Architecture & Invariants

**Dependency Direction**: Outer -> Inner. `Core` has zero outer dependencies. **Never introduce a dependency from `Core` to `Harness`.**

### Architecture constitution (required reading)

- **Constitution**: [`docs/north-star.md`](docs/north-star.md) — long-term invariants **I1–I6** / **E1–E7**. Implementation and review **must not violate** these.
- **External docs**: `docs/` (constitution, architecture, contracts). **Internal design**: `arch/` (gitignored; implementation handoffs live here).
- **Development constraints** (non-exhaustive; full list in the constitution):
  - **I1**: Mutable run context lives only in **RunScope**; `Agent` is a template + substrate, not a session workspace.
  - **E1/E5**: Same `sessionId` runs are serialized; Loop stays stateless; production path uses per-run context.
  - **E2/E7**: Lock/lease key is `sessionId`; v1 uses in-process `InProcessSessionLock` — **do not assume it is valid across processes**.
  - **E3**: Memory/Wisdom/Cognition write **only** that agent’s stores.
  - **E4**: Compact key is `(sessionId, agentId)`; do not borrow another agent’s compact as default.
  - **E6/I3**: Session ACL effective rights = L0 ∩ role.max ∩ agent.max ∩ binding; `preferredAgentId` ≠ `primaryAgentId`; handoff is host-plane by default.
  - **I5**: Tool cwd policy is `toolIsolation` (default `none`); `session-subdir` for multi-session file writes.
  - Config/schema changes: edit Zod (`packages/engine/src/config-schema/` + root `src/config-schema/` compose), then `npm run generate:schema`; keep `octopi.example.json` valid against generated schema.
- **Shipped runtime knobs** (see `docs/KNOWN-ISSUES.md` + `CHANGELOG` + `docs/observer-domain.md` + `docs/context-layer-contracts.md`): top-level `toolIsolation`, `sessionAcl`, **`observer`** (Run Observatory; default `level: off`; debug REST is `GET /debug/run/*`, **not** `/api/v1`; separate from Telemetry key `observability` and Core `Observer`); **`summary` / `compact` / `models.level.summary`** (Harness cross-cutting capabilities under `harness/context/capabilities/`: SummaryPort + CompactEngine; tools side L1 hard cap + L2 summary; E4 session compact state is **not** in capabilities); agents[].`workspace` / `maxSessionRights`; SessionData `primaryAgentId` / `preferredAgentId` / `participants` / `contextCompacts`. Gateway injects ACL + a **shared** session lease into all Runners. Observer sampling belongs to Runner `emitObserved` / Builder ContextEngine emit; Gateway must **not** call `hub.ingestEvent` a second time.
- **Default ports**: Gateway fallback **18180** (`channels[type=http].port`), WebUI fallback **8180** (`web.port`); precedence CLI `--port` > config > default. WebUI probes legacy `5173/5174/4173` only to adopt already-running instances — never hardcode `3000`/`5173` as defaults again (fallbacks live in `src/cli`, `src/init`, and three `packages/webui` components; the WebUI→Gateway URL fallback is build-time only, see `docs/KNOWN-ISSUES.md`).
- **Phase A–H minimum sets are closed.** Do not invent a parallel roadmap. For remaining work: open research items in internal `arch/open-problems.md`, capability-layer gaps (distributed Lease, session directory de-coupling, quota, role DB) in `docs/KNOWN-ISSUES.md`, and the short open-item list in `arch/NEXT-STEPS.md`. `arch/IMPLEMENTATION-PLAN.md` is an archival summary only.

### The 4-Layer Architecture
1.  **Layer 0: Loop** — Pure execution loop (`agentLoop`). Zero state, zero external dependencies. Protocol events only (`AgentLoopEvent`).
2.  **Layer 1: Core** — Mechanism primitives (EventBus, StateMachine) and Interface contracts. No strategy implementations. Does **not** re-export Loop.
3.  **Layer 2: Harness** — **10 product domains** (domain-first directories under `packages/engine/src/harness/`; counts only from `docs/domains.yaml`) + cross-cutting **capabilities** (`harness/context/capabilities/`: summary/compact ports). **Runnable Agent facade** lives at `harness/run/agent` (`Agent.run()` = reliability, E5 entry). Strategies and workflows live here. See `docs/domains.md`.
4.  **Layer 3: Integration** — External adapters (LLM Providers, Storage, Observability).

**Runtime entry**: prefer `Agent.run()` over hand-wiring `runAgentWithReliability`. Harness-level events (`budget_exceeded`, `run_guard_*`) are `HarnessLoopEvent`, not `AgentLoopEvent`.

### Context Intelligence (Eight-Layer Model)

Product context model has **eight layers** (see constitution §1.3 and `docs/architecture.md` §4):

1. Wisdom  2. Persona  3. Skills  4. Knowledge  5. Cognition  6. Memory  7. **Runtime**  8. **Information**

- **System prompt (ContextLayer contract, layers 1–7 including Runtime)**: produced under `harness/context/` (`ContextLayer` / `DefaultContextAssembler` / `system-prompt-assembler.ts`).
- **Information (layer 8)**: session messages via `DefaultContextEngine` — **not** a ContextLayer.
- Distillation (knowledge formation): Information → Memory → Cognition → Wisdom.
- Ownership: Agent substrate vs Run/Runtime vs Session/Information — see constitution; do not hang session state on `Agent.context`.

See `docs/context-layer-contracts.md` and `docs/north-star.md`.

---

## Common Commands

```sh
# Install dependencies
npm install

# Development
npm run dev

# Build
npm run build

# Test (Unit/Integration/Mock)
npm test

# Lint / format check
npm run lint
```
---

## Coding Conventions

### General Principles

- **ESM first**: use `"type": "module"`.
- **Explicit over implicit**: at module boundaries, do not hide default behavior behind `?? default`.
- **No hardcoded tunables**: deployment-varying configuration must be exposed through verifiable config fields.
- **Brand opaque cross-boundary IDs** (`Branded<T>`), never bare `string`.

### Code Style

- Do not comment on facts obvious from the code itself.
- `catch` blocks must state what they swallow and why no other path can reach it.
- **Preserve symmetry for parallel values**: unexplained asymmetry usually signals a missed extraction.

### Type Safety and Documentation

- Compile under `strict: true` / `noImplicitAny`.
- Function-like exports include `@param` / `@returns`.

---

## Testing Strategy

### Test Layers

| Layer | Purpose | Tool |
|-------|---------|------|
| **Unit tests** | Verify function/module behavior | `vitest` |
| **Integration tests** | Verify inter-module interaction | `vitest` |
| **Snapshot tests** | Prevent unintended changes to user-visible output | `vitest` |
| **End-to-end tests** | Verify real external dependency behavior | `vitest` |

### Testing Principles

- **Tests describe behavior, not correctness.** When behavior becomes obsolete, change it together with its tests.
- Non-trivial behavior changes must add or update tests in the same PR.
- **Mock only external services or nondeterministic inputs**; do not mock intra-project module interactions.

---

## Commit and PR Conventions

### Commit

- Use [Conventional Commits](https://www.conventionalcommits.org/) format: `<type>(<scope>): <description>`
- Types: `feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `ci`
- **`<description>` must be written in English.**
- Each commit has a single responsibility.
- **Every commit must update `CHANGELOG.md`**, recording changes under the corresponding version entry.

### Version Numbering Rules

**Lockstep (from v0.56.0):** all five packages (`octopi-agent`, `@octopi-agent/{core,engine,gateway,webui}`) **always share one version**. Internal dependencies are pinned to that exact version (not `^`).

Version format is `X.Y.Z` (semantic versioning), updated as follows:

| Segment | Trigger | Example |
|---------|---------|---------|
| **X** (major) | Updated on explicit user request | `1.0.0` → `2.0.0` |
| **Y** (minor) | Major feature addition or architecture change | `1.2.3` → `1.3.0` |
| **Z** (patch) | Updated on every commit / release | `1.2.3` → `1.2.4` |

**Release process (lockstep):**

1. `npm run release:prep -- <X.Y.Z>` — sets every package to `<X.Y.Z>`, pins internal deps to `<X.Y.Z>`
2. Update `CHANGELOG.md` under `## v<X.Y.Z>` (one entry for the product)
3. Commit + tag `v<X.Y.Z>`
4. Publish in dependency order (script prints the commands): `core` → `engine` → `gateway` → `webui` → `octopi-agent`

Historical note: `0.55.1` was a suite-only patch before this policy; `0.56.0` starts strict lockstep.

---
