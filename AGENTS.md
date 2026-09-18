# AGENTS.md

This file governs AI coding agent behavior in the `octopi` repository. **Read this file before making any code changes.**

---

## Project Overview

- **Project name**: `octopi`
- **One-line summary**: An embeddable agent engine for building AI-powered applications.
- **Core stack**: TypeScript / Node.js / Vitest
- **Package manager**: `npm`
- **Runtime Directory**: `~/.octopi/`

---

## Repository Layout

```
src/           Source code entry point
tests/         Test directory
docs/          Documentation
arch/          Architecture design documents (internal)
config/        Configuration
web/           Web runtime interface
data/          Data/Session storage
```

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

CLI helpers (`ensureInitialized` / `ensureDaemonConfig`) prefer `OCTOPI_HOME` over cwd. When changing config shape, update **both** `src/config-schema.ts` and `octopi.schema.json` / `octopi.example.json`.

### Runtime home layout (`OCTOPI_HOME`, default `~/.octopi`)

Scaffolded by `src/init.ts` (`initOctopi` / `ensureAgentDirs`). Keep init, types, schema, and docs aligned with this tree:

```
~/.octopi/
  octopi.json
  audit/
  plugins/
  agents/<id>/          # agent home
    AGENTS.md           # main persona (loaded first by loadPersona)
    persona/            # supplemental persona (*.md, numeric prefix for order)
    sessions/           # JsonlSessionStore
    skills/             # skillDirectory target
  workspace/<id>/       # tool sandbox cwd
```

**Do not create `agents/<id>/memory/` or `agents/<id>/wisdom/` directories.** Memory / Cognition / Wisdom / Knowledge persist in a per-agent SQLite file via `AgentDatabase` (`src/harness/memory/sqlite/agent-db.ts`), not as sibling folders under home.

**Do not use `memory.extractor` ETL or `MemoryExtractionWiring`.** Memory write path is agent `memory_store` + `memory.steward.*` subsystems. See `docs/memory-system-redesign.md`.

---

## Architecture & Invariants

**Dependency Direction**: Outer -> Inner. `Core` has zero outer dependencies. **Never introduce a dependency from `Core` to `Harness`.**

### The 4-Layer Architecture
1.  **Layer 0: Loop** — Pure execution loop (`agentLoop`). Zero state, zero external dependencies. Protocol events only (`AgentLoopEvent`).
2.  **Layer 1: Core** — Mechanism primitives (EventBus, StateMachine) and Interface contracts. No strategy implementations. Does **not** re-export Loop.
3.  **Layer 2: Harness** — Self-contained domains. **Runnable Agent facade** lives at `harness/agent` (`Agent.run()` = reliability). Strategies and workflows live here.
4.  **Layer 3: Integration** — External adapters (LLM Providers, Storage, Observability).

**Runtime entry**: prefer `Agent.run()` over hand-wiring `runAgentWithReliability`. Harness-level events (`budget_exceeded`, `run_guard_*`) are `HarnessLoopEvent`, not `AgentLoopEvent`.

### Context Intelligence (The 7-Layer Model)
When modifying context-related code, understand the information distillation order:
1.  **Wisdom** (Thinking patterns)
2.  **Persona** (Identity)
3.  **Skills** (Workflow guidance)
4.  **Knowledge** (External references)
5.  **Cognition** (Concept graph)
6.  **Memory** (Extracted insights)
7.  **Information** (Raw messages)

**Implementation lives in `harness/context/`** (`ContextLayer` / `DefaultContextAssembler` / `system-prompt-assembler.ts`), not in `harness/memory/`. Layers 1–6 are system-prompt content providers; Information is the message window (`DefaultContextEngine`). See `docs/context-layer-contracts.md`. Old `ContextIntelligence` has been removed.

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
- Each commit has a single responsibility.
- **Every commit must update `CHANGELOG.md`**, recording changes under the corresponding version entry.

### Version Numbering Rules

Version format is `X.Y.Z` (semantic versioning), updated as follows:

| Segment | Trigger | Example |
|---------|---------|---------|
| **X** (major) | Updated on explicit user request | `1.0.0` → `2.0.0` |
| **Y** (minor) | Major feature addition or architecture change | `1.2.3` → `1.3.0` |
| **Z** (patch) | Updated on every commit | `1.2.3` → `1.2.4` |

---
