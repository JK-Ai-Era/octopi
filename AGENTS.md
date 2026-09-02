# AGENTS.md

This file governs AI coding agent behavior in the `octopi` repository. **Read this file before making any code changes.**

**Final replies must be in Chinese.** All user-facing answers, summaries, and explanations are written in Chinese; code, commands, and variable names remain in English.

---

## Project Overview

- **Project name**: `octopi`
- **One-line summary**: An embeddable agent engine for building AI-powered applications.
- **Core stack**: TypeScript / Node.js / Vitest
- **Package manager**: `npm`
- **Minimum runtime**: Node.js >= 20
- **Runtime Directory**: `~/.octopi/`
- **Core Philosophy**: An Agent is not a class, but a complete **Runtime Scope** (workspace, session, tools, persona). The framework provides mechanisms; the integrator provides policies.

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

## Architecture & Invariants

**Dependency Direction**: Outer -> Inner. `Core` has zero outer dependencies. **Never introduce a dependency from `Core` to `Harness`.**

### The 4-Layer Architecture
1.  **Layer 0: Loop** — Pure execution loop (`agentLoop`). Zero state, zero external dependencies.
2.  **Layer 1: Core** — Mechanism primitives (EventBus, StateMachine) and Interface contracts. No strategy implementations here.
3.  **Layer 2: Harness** — 11 self-contained domains (Agent Building, Context, Security, Reliability, etc.). Strategies and workflows live here.
4.  **Layer 3: Integration** — External adapters (LLM Providers, Storage, Observability).

### Context Intelligence (The 7-Layer Model)
When modifying context-related code, understand the information distillation order:
1.  **Wisdom** (Thinking patterns)
2.  **Persona** (Identity)
3.  **Skills** (Workflow guidance)
4.  **Knowledge** (External references)
5.  **Cognition** (Concept graph)
6.  **Memory** (Extracted insights)
7.  **Information** (Raw messages)

### Security First
Security is built-in, not a toggle. Injection detection and risk evaluation are core constraints.

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

### Check-running Principles

- **Only run checks relevant to this change**; do not default to the full test suite.
- CI owns exhaustive coverage and cross-platform matrices; run everything locally only when explicitly requested, diagnosing CI, or making an irreducibly repository-wide change.
- Run relevant checks before pushing and **report only the commands actually executed**.

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
- **Every commit must update the version number**, following the versioning rules below.

### Version Numbering Rules

Version format is `X.Y.Z` (semantic versioning), updated as follows:

| Segment | Trigger | Example |
|---------|---------|---------|
| **X** (major) | Updated on explicit user request | `1.0.0` → `2.0.0` |
| **Y** (minor) | Major feature addition or architecture change | `1.2.3` → `1.3.0` |
| **Z** (patch) | Updated on every commit | `1.2.3` → `1.2.4` |

**Rules:**
- Every commit increments at least `Z`.
- When `Y` increments, `Z` resets to zero.
- When `X` increments, both `Y` and `Z` reset to zero.
- Version number is recorded in `package.json` and `CHANGELOG.md`.

---

## Git Workflow

- **Default branch**: `main`
- **Branch naming**: `<type>/<short-description>`, e.g. `feat/add-auth`, `fix/timeout-race`
- **Rebase preferred**: local branches use `git rebase` for linear history; use `--force-with-lease` when pushing.
- **Merge strategy**: squash merge for small features, merge commit for large feature branches.
