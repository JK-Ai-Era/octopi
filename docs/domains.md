# Octopi Product Domain Map

> **Language note**: This English edition is the **working authority**. The Chinese translation is [`domains.zh.md`](./domains.zh.md). Keep both in sync.
> **Status**: narrative authority for product domains. Numbers and the module catalog take [`domains.yaml`](./domains.yaml) as the **sole counting authority**; concept definitions take [`north-star.md`](./north-star.md) as the constitution.  
> **Do not** hand-write domain counts or alternate tables in README / CONTRIBUTING / architecture and similar docs.  
> Date: 2026-09-26

---

## 1. Three-Layer Vocabulary (do not mix)

| Layer | Meaning | Count | Appears in |
|----|------|------|--------|
| **Product Domain** | Bounded context: one language per domain, independently replaceable | **10** | External intro, this doc |
| **Module** | Implementation unit `packages/engine/src/harness/<dir>/` | 20–30, may change | `domains.yaml`, CI |
| **Capability / Foundation** | Cross-cutting shared capabilities, layer vocabulary | 7 (capabilities 3 + foundations 4) | Catalog `kind`, **not counted as domains** |

**Domain ≠ directory.** Creating a directory does not make a domain; facades, vocabularies, and cross-cuts do not count.

---

## 2. Overview

```text
                    ┌─────────────────────────────────────────────┐
                    │  10 product domains (one language each)      │
                    │                                             │
   Authority (who   │  Governance · Session · Agent · Memory ·    │
   owns the truth)  │  Knowledge                                  │
   Phase (when)     │  Activation · Run                           │
   Capability       │  Context · Extension · Collaboration       │
   (outward half)   └─────────────────────────────────────────────┘
   Cross-cut / foundation (not counted): Observability · Summary&Compact · events/paths/types
```

External wording:

> **Octopi Harness is organized into 10 product domains** — Governance, Session, Agent, Memory, Knowledge, Activation, Run, Context, Extension, Collaboration.

---

## 3. Product Domain Cards

### 3.1 Governance

| | |
|---|---|
| **Question** | Who can do what? |
| **Plane** | Control |
| **Owns** | Principal, Intent, RoleDefinition, RoleBinding, Policy, Approval, Credential, Quota |
| **Modules** | `session-acl` `security` `human-in-the-loop` `credentials` `accounting` |
| **Failure modes** | Wrong authorization, privilege escalation, credential leakage |
| **Does not** | Business NLU; human-level IAM (Host); vertical workflow engines |

---

### 3.2 Session

| | |
|---|---|
| **Question** | How is continuity maintained, and how are past accounts queried? |
| **Plane** | Continuity |
| **Owns** | Session aggregate, Discourse, Projection, Compact state, SessionTask |
| **Modules** | `session/` (types / compact / state-machine) `session/tasks` `session/history` `session/attachments` |
| **Failure modes** | Continuity lost or polluted, tasks lost, compact keys crossed |
| **Does not** | Substrate content quality; whether this turn ran correctly (Run) |

**Note**: Discourse append is the authority (I2); everything else is a rebuildable Projection. ACL language belongs to Governance, not this domain.

---

### 3.3 Agent

| | |
|---|---|
| **Question** | Who is it, and how is it configured at factory time? |
| **Plane** | Agent & Substrate |
| **Owns** | Agent template, Persona, Revision, Mount |
| **Modules** | `agent-building` (+ `types/agent-definition` contract) |
| **Failure modes** | Wrong persona/tools installed, template version drift |
| **Does not** | Learning products (Memory); exogenous corpus (Knowledge); conversation state |

---

### 3.4 Memory

| | |
|---|---|
| **Question** | What has it learned? |
| **Plane** | Agent & Substrate |
| **Owns** | Substrate: Memory / Cognition / Wisdom |
| **Modules** | `memory` |
| **Failure modes** | Learned wrong lessons, forgetting, substrate pollution |
| **Does not** | Exogenous documents (Knowledge); conversation originals (Discourse) |

**Substrate = learning products**; E3 writes only this Agent. **Not merged** with Knowledge (product decision 2026-09-26).

---

### 3.5 Knowledge

| | |
|---|---|
| **Question** | What is written in the world? |
| **Plane** | Agent & Substrate |
| **Owns** | Knowledge, Source, KnowledgeScope, File identity / Membership |
| **Modules** | `knowledge` (including **Knowledge Service** `http-app`/`serve`/`client`) |
| **Failure modes** | No source / wrong source, wrong corpus retrieved, index treated as authority, double-writing knowledge.db |
| **Does not** | Propositional memory; live system state (Tool) |

**Independent domain**: covers exogenous resource management, parsing, embedding, retrieval; **not Substrate**. Scope = Global / Project / Session (no Agent-level sources). **v0.60+**: a standalone HTTP Service is the sole writer of `knowledge.db` (Gateway goes through the Client); File-based identity dedup + Membership. Inside the Service (v0.64) threads are split: main thread `/health` + auth + read-only dispatch, **Writer Worker** for writes/ingest, Meta/Search Query Workers read-only. See [`knowledge.md`](./knowledge.md) (the Service HTTP contract is an internal spec, not public).

---

### 3.6 Activation

| | |
|---|---|
| **Question** | How do stimuli become 0..N supervised Runs? |
| **Plane** | Activation |
| **Owns** | Trigger, Dispatch, Coalesce, preferred resolve |
| **Modules** | `agent-runtime` |
| **Failure modes** | Should-run-not-run, duplicate runs, wrong Agent |
| **Does not** | A second execution engine; silently changing primary |

---

### 3.7 Run

| | |
|---|---|
| **Question** | How does this turn finish safely and correctly? |
| **Plane** | Execution |
| **Owns** | Run, RunScope, SessionLease, Effect execution, Reliability, RunGuard, Budget valves |
| **Modules** | `run/` (run-scope / runner) `run/reliability` `run/run-guard` `run/budget` `run/concurrency` `run/model` `run/agent` (facade) |
| **Failure modes** | Cross-session bleed, runaway runs, effects out of control, budget burn |
| **Does not** | Session UI; template content |

**Facade**: `Agent.run()` is the E5 production entry; it belongs to this domain and is **not** a separate product domain.

---

### 3.8 Context

| | |
|---|---|
| **Question** | What does the LLM actually see this turn? |
| **Plane** | Context |
| **Owns** | ContextLayer, Assembler, Token, message window, compression entry |
| **Modules** | `context` `capabilities` |
| **Failure modes** | Model sees what it must not / misses what it must see |
| **Does not** | Persistence authorities (Discourse/Memory/Knowledge stores) |

Eight layers × Scope cross product (I4). Compact **algorithm** lives in capability; **state key** lives in Session (E4).

---

### 3.9 Extension

| | |
|---|---|
| **Question** | How are capabilities extended? Where do tools run? |
| **Plane** | Extension |
| **Owns** | Tool, Effect, Plugin, Skill, MCP, Sandbox, Workspace |
| **Modules** | `plugin-ecosystem` `execution-environment` |
| **Failure modes** | Plugin blow-ups, tools stomping the disk, cwd escape |
| **Does not** | Risk decisions (Governance policy); conversation semantics |

---

### 3.10 Collaboration

| | |
|---|---|
| **Question** | How do multiple Agents / subsystems coordinate? |
| **Plane** | Collaboration |
| **Owns** | Delegation, Swarm, Subsystem, Signal, Workflow, AgentProcess, Discovery |
| **Modules** | `delegation` `orchestration` `autonomous-subsystem` |
| **Failure modes** | Coordination deadlock, lost signals, autonomous bodies out of bounds |
| **Does not** | Human-level IAM; vertical business workflows |

**Status**: `incomplete` — required for product completeness; implementation can be phased, **still counted among the 10** (product decision 2026-09-26).

---

## 4. Cross-Cuts and Foundations (not product domains)

| Kind | id | Modules | Notes |
|----|-----|------|------|
| Capability | observability | `observer` `diagnostics` | Debug/metrics/issues; compliance Audit lives in Session |
| Capability | summary-compact | `context/capabilities` | Shared summary/compression algorithms (Context assembly only) |
| Capability | document-extract | `capabilities/document` | Cross-domain Document extract Port (session/knowledge/tools; `documents.*`) |
| Foundation | events | `events` | Event vocabulary |
| Foundation | types | `types` | Layer-shared types |
| Foundation | harness-entry | `index.ts` | Layer-wide exports |

---

## 5. Ontology Concept → Domain

| Concept | Domain |
|------|-----|
| Host | Boundary (outside the engine) |
| Principal, Intent, RoleDefinition, RoleBinding, Policy, Approval, Credential, Quota | Governance |
| Session, Discourse, Projection, Compact state, SessionTask | Session |
| Agent, Persona, Revision, Mount | Agent |
| Substrate, Memory, Cognition, Wisdom | Memory |
| Knowledge, Source, KnowledgeScope | Knowledge |
| Trigger, Dispatch, Coalesce, PreferredResolve | Activation |
| Run, RunScope, SessionLease, Effect execution, Reliability, RunGuard, Budget | Run |
| ContextLayer, Assembler, Token, MessageWindow | Context |
| Tool, Effect, Plugin, Skill, MCP, Sandbox, Workspace | Extension |
| Delegation, Swarm, Subsystem, Signal, Workflow, AgentProcess | Collaboration |

---

## 6. Anti-Drift

1. **Sole counting authority**: `docs/domains.yaml`  
2. **No hand-written numbers**: README, CONTRIBUTING, architecture.md, harness/README must cite this doc or the catalog  
3. **CI**: `tests/architecture/domains-catalog.test.ts` checks that `harness/` directories match `module_catalog` (every directory must be registered, or contain a registered submodule; `planned: true` may be temporarily missing); unregistered fails  
4. **DoD**: PRs that create/rename/merge/delete harness directories must update `domains.yaml` in the same PR  

---

## 7. Change Log

| Date | Content |
|------|------|
| 2026-09-26 | **Domain-first directories landed**: top level of `packages/engine/src/harness/` = 10 domains + observability + shared; tool-effect folded into execution-environment; knowledge contracts unified; orphan files moved under session/ and run/ |
| 2026-09-26 | Initial version: 10 product domains (Memory/Knowledge separate; Collaboration independent and counted); catalog `domains.yaml` |
| 2026-10-12 | Catalog registered `session/attachments` `activation/sources` `context/constitution` `memory/sqlite`; document-extract counted as cross-cut capability (capabilities 3 + foundations 3); tool-effect folded into execution-environment; removed stale orphan notes; directory catalog CI landed (`tests/architecture/domains-catalog.test.ts`) |
