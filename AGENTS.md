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
changelog/           Archived changelog minor segments (see AGENTS.md → Changelog Discipline)
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

Config/schema changes: edit Zod (`packages/engine/src/config-schema/` + root `src/config-schema/` compose), then `npm run generate:schema`; keep `octopi.example.json` valid against generated schema.

```sh
# preferred
octopi serve start -c ~/.octopi/octopi.json
# or
cd ~/.octopi && octopi serve start
```

CLI helpers (`ensureInitialized` / `ensureDaemonConfig`) prefer `OCTOPI_HOME` over cwd.

**Default ports**: Gateway fallback **18180** (`channels[type=http].port`), WebUI fallback **8180** (`web.port`), Knowledge Service fallback **18280** (`knowledge.service.port`); precedence CLI `--port` > config > default.

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
  knowledge/            # Knowledge data plane (knowledge.db — **sole writer is Knowledge Service**; see docs/knowledge.md)
  credentials/          # Integration credentials vault (credentials.db; env/file refs or AES-GCM ciphertext)
  agents/<id>/          # agent home
    AGENTS.md           # main persona (loaded first by loadPersona)
    persona/            # supplemental persona (*.md, numeric prefix for order)
    skills/             # skillDirectory target
  workspace/<id>/       # tool sandbox cwd
```

---

## Architecture & Invariants

**Dependency Direction**: Outer -> Inner. `Core` has zero outer dependencies. **Never introduce a dependency from `Core` to `Harness`.**

### Architecture constitution (required reading)

- **Constitution**: [`docs/north-star.md`](docs/north-star.md) - **Read the constitution before any design, implementation, or review.**
  - Invariants **I1–I6** / **E1–E7** are binding; **violation = bug**.
  - Do not restate or paraphrase invariants in this file. Semantics live only in the constitution (§2 definitions, §8 implementation mapping).
  - Architecture acceptance is judged by invariants (constitution §8), not by "tests green" alone.
  - To change an invariant: edit the constitution and its change log — never patch the summary here.
- **External docs**: `docs/` (constitution, architecture, contracts). **Internal design**: `arch/` (gitignored; implementation handoffs live here).

### The 4-Layer Architecture
1.  **Layer 0: Loop** — Pure execution loop (`agentLoop`). Zero state, zero external dependencies. Protocol events only (`AgentLoopEvent`).
2.  **Layer 1: Core** — Mechanism primitives (EventBus, StateMachine) and Interface contracts. No strategy implementations. Does **not** re-export Loop.
3.  **Layer 2: Harness** — **10 product domains** (domain-first directories under `packages/engine/src/harness/`; counts only from `docs/domains.yaml`) + cross-cutting **capabilities**: `harness/context/capabilities/` (summary/compact — Context assembly only) and `harness/capabilities/document` (Document extraction Port, shared by session/knowledge/tools; sole wiring `createDocumentPortFromConfig` + `documents.*`). Admission bar: stable Ports spanning ≥2 domains; no product policy; not Integration peripherals. **Runnable Agent facade** lives at `harness/run/agent` (`Agent.run()` = reliability, E5 entry). Strategies and workflows live here. See `docs/domains.md`.
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
- **No fake-data stubs**: an API that accepts parameters MUST return real computed data or `throw`. Forbidden patterns in production paths:
  - `void arg; return [];` / `return {};` / `return []` as a placeholder body
  - hardcoded booleans that ignore state (`canAbort: true`, `aborted: false`, …)
  - hardcoded empty collections where the caller expects live data (`assignedProjects: []`, `hiddenSourceIds: []`, …)
  - silently ignoring filter/scope parameters and returning the full set
  Allowed: a **failure/degraded** fallback to empty only after a real attempt failed (and that must not look like success-with-data). If a feature is not implemented yet, `throw new Error('not_implemented: …')` so the UI/API can surface it.

### Engineering Discipline

- **First principles over surface fixes**: engineering problems must be analyzed from first principles (data flow, ownership, process/thread boundaries, invariants)—not patched at the symptom layer. If a design choice is wrong (e.g. shared event loop, ignored filter, stubbed return), change the design; do not add another band-aid on top.
- **Verify uncertainty; never guess**: when something is unclear (API shape, runtime behavior, config meaning, cross-process contract), **read the relevant code, docs, tests, or config schema and confirm** before acting. Do not invent APIs, field names, or root causes from memory. If evidence is still insufficient, say so and investigate further—do not ship a guess.
- **Root-cause bug fixes under complete business semantics**: a bug is fixed only when (1) the **root cause** is identified and removed, and (2) the **intended business behavior remains complete**. Hiding symptoms (skip/drop/degrade/silence/swallow) is not a fix. “The error went away” is not success if capability was lost or data is now wrong.

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

## Public docs language policy

- **English is authoritative** for all public docs (`docs/*`, `README.md`, `CONTRIBUTING.md`). Chinese translations live beside them as `*.zh.md` (e.g. `docs/north-star.zh.md`, `README.zh.md`).
- **Every public-doc change must land in both languages** in the same content commit (update `*.md` and `*.zh.md` together). Do not ship a one-sided edit.
- When English and Chinese disagree, **follow English**; fix the Chinese side (or vice versa only after amending English first).

---

## Documentation Sync (`arch/`)

`arch/` is the map used before code changes. Run `bash arch/check-sync.sh` after any of the following (also see `arch/sync-protocol.md`):

1. Adding / deleting / renaming a module, or moving files (including `packages/*` splits).
2. Changing cross-layer imports or dependency direction.
3. Editing path lists or structure trees inside `arch/*.md`.
4. Before content commits or releases that affect structure — treat a red result as a gate.

**Discipline:** red lights are the asset. For a **locator** miss, fix the arch path or add the code; mark **historical** / **proposal** references by context wording. **Never weaken the checker** (skip directories, allowlists, looser regex) just to turn a result green.

**Where remaining work lives**: open research items in internal `arch/open-problems.md`; capability-layer gaps (distributed Lease, quota, role DB) in `docs/KNOWN-ISSUES.md`; short open-item list in `arch/NEXT-STEPS.md`.

---

## Commit and PR Conventions

### Commit

- Use [Conventional Commits](https://www.conventionalcommits.org/) format: `<type>(<scope>): <description>`
- Types: `feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `ci`
- **`<description>` must be written in English.**
- Each commit has a single responsibility.
- **Every content commit must include a version bump and a CHANGELOG entry** (see Version Numbering Rules). Do not leave `package.json` at an older version while landing behavior/docs/tests changes.

### Version Numbering Rules

**Lockstep:** all five packages (`octopi-agent`, `@octopi-agent/{core,engine,gateway,webui}`) **always share one version**. Internal dependencies are pinned to that exact version (not `^`).

Version format is `X.Y.Z` (semantic versioning), updated as follows:

| Segment | Trigger | Example |
|---------|---------|---------|
| **X** (major) | Updated on explicit user request | `1.0.0` → `2.0.0` |
| **Y** (minor) | Major feature addition or architecture change | `1.2.3` → `1.3.0` |
| **Z** (patch) | Every other content commit (fix/docs/test/chore/small feat) | `1.2.3` → `1.2.4` |

**Content commit checklist (same commit, no later “release chore” required):**

1. Pick `X` / `Y` / `Z` from the table above.
2. Run `npm run release:prep -- <X.Y.Z>` (skip only if that version is already set on all five packages).
3. Prepend a `## v<X.Y.Z> (YYYY-MM-DD)` section to `CHANGELOG.md` per **Changelog Discipline** (directly below the index table).
4. Commit code + version files + CHANGELOG together.

**Tag / publish are separate** (do them when cutting a release or when the user asks):

1. `git tag v<X.Y.Z>` (if not already tagged for that version)
2. Publish in dependency order (`node scripts/release.mjs print`): `core` → `engine` → `gateway` → `webui` → `octopi-agent`

### Changelog Discipline

`CHANGELOG.md` is the landing-record ledger (`arch/NEXT-STEPS.md` routes completed work here). The layout is mechanical — never improvise a new one:

- `CHANGELOG.md` = intro + **index table of all minor segments** + entries of the **current (in-progress) minor only**.
- Each completed minor segment is archived in `changelog/v<X.Y>.md` (newest first, moved verbatim).

Write rules (every content commit):

1. **Where** — prepend the new `## v<X.Y.Z> (YYYY-MM-DD)` section directly below the `---` that follows the index table, above all existing entries. Never reorder, reflow, or edit other entries.
2. **Shape** (new entries) — `## v<X.Y.Z> (YYYY-MM-DD)` heading; below it one or more `### <type>(<scope>): <summary>` blocks (same `type` vocabulary as commits); a blank line on each side of the `---` separator. Historical headings predate this rule and stay as-is.
3. **Content** — record conclusions: what changed and why, decisions/trade-offs not derivable from code, verification results, and any **breaking note** (mandatory when applicable). Do **not** write process narrative (review back-and-forth, step-by-step debugging, derivations of rejected alternatives) — it belongs to git log and `arch/`. A reader must be able to tell "does this affect me" without reading the diff.
4. **Roll rule** — when writing the **first entry of a new minor**: (a) move the previous minor's complete block (all its `## v<prev>.*` sections) into `changelog/v<prev>.md`, creating the file with the standard preamble if missing — `# Changelog v<prev>.x`, then ``> Archived minor segment (<N> entries, <oldest date> – <newest date>). Moved verbatim from `CHANGELOG.md`.`` and ``> Append-only history: corrections go into newer entries, never rewrite these.``, then `---`; (b) change that minor's index row from `this file (current)` to its link row. `CHANGELOG.md` must not carry a completed minor nor two `this file (current)` rows.
5. **Archives are append-only** — never rewrite archived entries, including their dates; corrections go into the newer entry that made them. A late entry for an already-archived minor is inserted directly below the preamble (keeping newest-first), never appended at EOF.
6. **Index** — keep the table header (`| Segment | Location |`) and exactly one row per minor, newest first; archived rows link `[changelog/v<X.Y>.md](./changelog/v<X.Y>.md)`, the current minor's row says `this file (current)`.

---
