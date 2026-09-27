# Octopi Architecture Constitution

> **Architecture Constitution**  
> **Status**: Core ideas and long-term invariants. Above any single delivery cycle; implementations may iterate in layers, but **must not violate the invariants**. Revisions must explicitly edit this document and go through the change log.  
> **Product positioning**: Octopi = an **embeddable Agent engine** (runtime + continuity + governance substrate), not a chat wrapper.  
> **Language note**: The Chinese edition [`north-star.md`](./north-star.md) is the working authority for day-to-day review; this English edition is a full peer translation. Keep both in sync on every constitutional revision.

---

## 0. Why this document exists

Multi-session concurrency on one Agent, context ownership, the eight-layer model, Session↔Agent cardinality, and role governance are easy to misread as “over-engineering” when judged only by short-term delivery pressure.

This document fixes the **mid- to long-term ontology, invariants, and reserved slots**, so implementation, review, and embedder integration share one constitution.

---

## 1. Ontology

The ontology of an embeddable Agent engine is not “a chat loop”. It is the following concepts. Each concept has an **exclusive definition**; double-booking (two words, one meaning) and grab-bags (one word, many homes) are constitutional defects and must be split when found.

### 1.0 Concept table

| Concept | Definition | Plane |
|---------|------------|-------|
| **Host** | Embedding boundary: supplies Principal, maps `conversationId`↔`sessionId`, owns human IAM | Boundary (outside the engine) |
| **Principal** | Driver: host user / tenant / service / timer / subsystem / another agent | Control; must enter audit |
| **Intent** | Structured drive request (`run` / `preferred` / `consult` / `handoff`…); the engine does not do NLU | Control |
| **Agent** | Identity + **template**: persona, tool/skill mounts, default model, `workspace` (cwd), revision | Agent & Substrate / `agents/<id>` |
| **Substrate** | That Agent’s durable **learning products** across Sessions: Memory / Cognition / Wisdom | Agent & Substrate |
| **Knowledge** | **Exogenous corpus** (source-anchored; indexes rebuildable); Scope = Global / Project / Session | Agent & Substrate |
| **Session** | Conversation/task **continuity aggregate** (identity `sessionId`; Host may map conversationId) | Continuity / Session Store |
| **Discourse** | The Session’s **append-only authoritative log** (information stream; content type = eight-layer Information) | Continuity |
| **Projection** | **Rebuildable-if-invalidated** derived views (status / tasks / compact views / search indexes…) | Continuity |
| **RoleDefinition** | Role catalog entry (first-class configuration; not a closed code enum) | Control |
| **RoleBinding** | Participation record: an Agent appearing on a Session under a role (rights preset + overridable) | Control |
| **Run** | One episode: `(sessionId, agentId, …)` | Execution |
| **RunScope** | All **mutable context** of that episode (messages workspace, systemPrompt identity, tool runtime, compact seeding, resolvedModel…) | **Run only** / Execution |
| **Tool** | Callable capability (definition + executor); mounted on Agent, invoked via Run | Extension |
| **Effect** | A tool’s effect on the world (cwd / side effects / concurrency / idempotence); constrained by I5 | Extension definition + Execution enforcement |

```text
Host ──(conversationId ↔ sessionId)── Session aggregate
  │                                     Discourse(I2) · Projection · compact[(s,a)]
  └── Principal ──Intent──► Control ──► Activation ──► Run( Session × Agent[× Role] )
                                                         │
                                                      RunScope
                                         (sole home of mutable context, I1)
```

**Write-back relation (not an entity)**: when a Run ends → Discourse is appended + Projection updated + Audit persisted. The former “Episode artifacts” are **not** an ontology entity.

**Confusables (enforced vocabulary)**:

| Question | Concept |
|----------|---------|
| What have I learned? | **Substrate / Memory** |
| What does the world write down? | **Knowledge** (source-anchored; index is not authority) |
| What happened? | **Discourse** (append authority) |
| This turn’s temporary stage? | **RunScope** (Run only) |
| Who is it / how is it configured at birth? | **Agent** (template; excludes learning products) |
| The hand vs what the hand touched? | **Tool** vs **Effect**; live system state → Tool, documents → Knowledge |

### 1.1 Accountability vs execution (collaboration semantics)

| Field | Meaning |
|-------|---------|
| **Accountability** | Primary duty: `primaryAgentId`; answerable to user/compliance; change = handoff |
| **Agency** | Right to advance the current task: determined by Role and preferred/explicit Run |
| **Exposure** | `readScope`: how much Discourse a Run can see |
| **Learning** | `writeMemory`: whether it may write **this Agent’s** substrate |
| **Responsibility transfer** | handoff: changes Accountability; **not** an implicit result of specialist rights |

A stock `specialist` may have Agency + Learning + full Exposure, and **by default does not have Accountability**.

### 1.2 preferred vs primary

| Field | Serves | Who changes it |
|-------|--------|----------------|
| **primaryAgentId** | Accountability and default persona | Host / control plane (handoff) |
| **preferredAgentId** | Activation: the **session default executor** when a Trigger names no agent | Host switch intent / policy; **not** a business-routing substitute for the Host |

- External `run(sessionId, agentId)` should still pass an **explicit agentId** (auditable).  
- Engine Runtime may resolve to `preferred` on schedule/escalate paths.  
- The engine **must not** silently turn preferred into primary.

### 1.3 Context: type axis × scope axis (eight-layer cross product)

**Content type (product eight layers)** and **ownership Scope** are two orthogonal axes and must not be welded together.

```text
Type axis (eight layers):
  1 Wisdom · 2 Persona · 3 Skill · 4 Knowledge · 5 Cognition
  6 Memory · 7 Runtime · 8 Information

Scope axis:
  Global / Tenant / Project / Agent / Session / (Session×Agent) / Run
```

| Layer | Common Scope | Notes |
|-------|--------------|-------|
| Persona / Skill | **Agent** | **Template** (Agent identity), not Substrate |
| Wisdom / Cognition / Memory stores | **Agent** | **Substrate** (learning products; E3 writes only this Agent) |
| Knowledge | **Global / Project / Session** | Exogenous corpus; **no Agent-level sources** (“exclusive” = mount only its Project); Tenant reserved. Authoritative model: `docs/knowledge.md` |
| Runtime | **Run** (Session-aware) | tasks / guidance / injectedContext |
| Information | **Session** (Discourse) | Message authority |
| Compact | **(Session × Agent)** | Derived view of the Information window, **not** Agent template state |
| Assembled systemPrompt | **RunScope** | Product; never written back to the Agent singleton |

**Identity:** product eight layers = system-side ContextLayer (1–7, including runtime) + Information (message window).  
Implementations need not add/remove `ContextLayerId` for narrative convenience; **implementations must obey ownership and cache keys**.

---

## 2. Long-term invariants (must be verifiable)

### Constitutional (violation = bug)

| # | Invariant |
|---|-----------|
| **I1** | **Mutable conversation/run context lives only in RunScope**; Agent is template and substrate and must not act as the “current session workspace”. |
| **I2** | **Discourse authority = Session append log**; status / compact / tasks etc. are projections and **may be rebuilt if invalidated**. |
| **I3** | **Accountability ≠ Agency**; execution switch (preferred / Run target) ≠ duty transfer (handoff). |
| **I4** | **Context = type (eight layers) × Scope cross product**; a “seven/eight-layer bar chart” must not stand in for ownership. |
| **I5** | **The effect plane is policy-bound like the cognitive plane**: tool cwd / side effects / MCP have concurrency and isolation semantics; not a lawless land. |
| **I6** | **The engine consumes structured Intent and does no permission NLU**; **Principal must enter Run/audit**; human IAM stays with the Host; the engine enforces Agent×Session decisions. |

### Engineering (implementations must obey)

| # | Invariant |
|---|-----------|
| **E1** | Runs on the same `sessionId` are **serialized** (session consistency); the same Agent on different Sessions **may run concurrently**. |
| **E2** | Lock/lease authority key = `sessionId` (logical key of **Session Lease** when distributed). |
| **E3** | Memory/Wisdom/Cognition **write only that Agent’s store**; no default path for “guest writes owner substrate”. |
| **E4** | Compact key = `(sessionId, agentId)`; never borrow another agent’s compact as default. |
| **E5** | Loop stays stateless; sole production path: `Agent.run` / `runAgentWithReliability` + **per-run context**. |
| **E6** | Effective role rights = `L0 floor ∩ role max ∩ Agent maxSessionRights ∩ binding overrides`; illegal grants are rejected at grant time. |
| **E7** | Single process is the v1 deployment assumption; cross-process requires a real **Session Lease**; never pretend an in-memory lock is globally valid. |

---

## 3. Planes

Planes answer “who owns the truth / when does it happen / what is the engine’s outward half”. **Do not** mix data ownership and runtime phase into one ungrouped list. Three groups:

```text
Authority planes (who owns truth)   Phase planes (when)      Capability faces (outward half)
──────────────────────────────     ──────────────────       ──────────────────────────────
Control                            Activation               Context
Continuity                         Execution                Extension
Agent & Substrate                                             Collaboration
```

```text
Host ── Principal ──Intent──► Control
                                │ Role/Policy/Credential/Quota decisions
                           Activation ──► Run( Session × Agent[× Role] )
                                               │
                                            RunScope (I1)
                                               │
         ┌─────────────────────────────────────┼─────────────────────────────────────┐
         ▼                                     ▼                                     ▼
    Execution physics                     Context assembly                    Extension execution
    Lease/serial/Reliability              Eight layers × Scope (I4)           Tool/Effect (I5)
    Guard/Budget valves                   systemPrompt → RunScope             Plugin/Skill/MCP
                                               │
                                               ▼
                              Write-back: Discourse append (I2) + Projection + Audit

Agent & Substrate (durable across Runs):
  Agent template · Substrate(Memory/Cognition/Wisdom) · Knowledge(Global/Project/Session)
```

### 3.1 Authority planes — who owns the truth

| Plane | Owns | Does not own |
|-------|------|--------------|
| **Control** | Principal, Intent, RoleDefinition, RoleBinding decisions, Policy, Approval (HITL), Credential, Quota/Economy mount points | Business NLU; human IAM (Host); vertical process engines |
| **Continuity** (formerly Session) | Session aggregate, Discourse, Projection, compact[(s,a)], SessionTask, Audit stream | Agent substrate content quality; whether this turn ran correctly |
| **Agent & Substrate** (formerly Agent Registry) | Agent template, Revision, Memory/Cognition/Wisdom I/O, Knowledge store & retrieval | State of a particular conversation; this turn’s systemPrompt instance |

### 3.2 Phase planes — when it happens

| Plane | Owns | Does not own |
|-------|------|--------------|
| **Activation** | Trigger sources, Dispatch, Coalesce, preferred resolve, explicit multi-Agent routing | A second execution engine; changing primary on its own |
| **Execution** (formerly Run Physics) | Run, RunScope, SessionLease/serialization, isolation, Effect policy **enforcement**, Reliability, RunGuard, Budget valves | Session product UI; template content |

### 3.3 Capability faces — the engine’s outward half

| Plane | Owns | Does not own |
|-------|------|--------------|
| **Context** | ContextLayer, Assembler, eight-layer assembly, Token, message window, compression policy entry | Persistence authority (Discourse/Memory/Knowledge stores) |
| **Extension** | Tool registration & call surface, Plugin, Skill, MCP, Sandbox, `workspace` (cwd), commands | Risk **decisions** (policy authority in Control); session semantics |

### 3.4 Collaboration and cross-cuts

| Name | Covers | Notes |
|------|--------|-------|
| **Collaboration** (product domain; implementation may phase) | Swarm, Subsystem, Signal, Workflow, AgentProcess, Discovery | **Required for product completeness**; multi-Agent / subsystem coordination. `status: incomplete` does not remove domain status (see `docs/domains.md`) |
| **Observability** (cross-cut) | Telemetry, Run Observatory, Issue registry | Debug/metrics; **not** compliance ledger (Audit lives in Continuity) |

---

## 4. Role catalog (long-term shape)

Roles split into **RoleDefinition** (catalog entry) × **RoleBinding** (participation on a Session); catalog is configuration, binding is participation.

- The role catalog is **first-class configuration** (file is the authoritative default; DB/console are optional override backends), **not** a closed code enum.  
- Factory seeds (product decision): **owner / specialist / reviewer / operator / steward**.  
- Business roles (consultant, etc.) enter the **same catalog** as custom entries; they do not hard-code into the engine.

| Concept | Long-term requirement |
|---------|----------------------|
| specialist | full Exposure + Learning + Agency (canManageTasks); no Accountability |
| reviewer | full Exposure; no Learning / no Agency to change tasks |
| operator | minimal Exposure; side-path execution |
| steward | governance: read-all, may write own substrate, may manage tasks |
| handoff | by default only Principal control plane (Host); `allowAgentInitiatedHandoff` defaults false |

**Switch default (product):** `preferred` + grant `specialist`; **not** automatic handoff.

---

## 5. Reserved design slots (may stay empty for now; must not be imaginary)

These slots **will** exist in the long-term architecture. Implementation may phase them, but API/storage/docs must not pretend they do not.

| Slot | Meaning | Minimum reservation |
|------|---------|---------------------|
| **Principal** | Driver in Run/Intent/audit | `actorId?` / `tenantId?` fields and audit dimensions |
| **Session Lease** | Replaces in-memory lock when distributed | Lock interface + `sessionId` key; in-process implementation is fine for now |
| **ToolEffectPolicy** | Tool effect concurrency / sandbox / idempotence | Invariant I5 + cwd/sandbox field slots in tool context |
| **AgentRevision** | Template version bound to Run | RunRecord: `agentRevision?` |
| **Quota / Economy** | token/cost by Principal/Session/Agent/Role | Budget already per-run; mount points reserved |
| **Replay** | Replay from Discourse + audit | append authority (I2); projections rebuildable |
| **Scope cross product** | Multi-scope such as Knowledge | store interfaces must not hard-bind a sole `agentId` key; Knowledge follows `docs/knowledge.md` (Global/Project/Session) |
| **Briefing** | handoff / consult handover summary | Optional Participant `briefing`; ≠ the other side’s compact |
| **Intent kinds** | preferred / consult / handoff / run… | Intent is now first-class; control-plane API shape may start minimal |

---

## 6. Boundary with “over-engineering”

### 6.1 Not over-engineering (long-term curriculum)

- RunScope isolation and Session continuity aggregate  
- Role catalog and ACL  
- Eight layers × Scope  
- Audit, attribution, split compact keys  
- preferred + Activation  
- Principal / Intent / Host in contracts  
- Knowledge and Memory kept separate (exogenous vs learning products)

### 6.2 Still real over-engineering (avoid)

| Pattern | Why it is wrong |
|---------|-----------------|
| Multiple truths for one concept with no authority order | Roles/config need “one semantics, pluggable backends” |
| Vertical business routing inside the engine | Provide resolve hooks; do not write the Host’s ticket system |
| Narrative/UI gated before Run physics | Eight-layer UI ≠ invariant I1 is implemented |
| Over-designing for a hypothetical consensus system | A replaceable Lease is enough; not v1 distributed consensus |
| Using “internally breakable” to deny end-state contracts | Intermediate APIs may break; **invariants and ontology follow this file** |

### 6.3 Scope slicing vs architecture judgment

```text
Ideation     ← this file (settled now; stable long-term)
Physical     ← RunScope / Lease / append authority / Effect Policy (full design; iterative implementation)
Capability   ← console, quota UI, multi-scope Knowledge…
Tactical     ← concurrency tests vs grant API this quarter (does not change the constitution)
```

Implementation acceptance is judged by **invariants**, not by “can we skip the role table today”.

---

## 7. Known long-term risks (on record; not vetoes)

| Risk | Mitigation |
|------|------------|
| specialist approaches owner; product later demands implicit handoff | I3; handoff only on control plane; docs stress Accountability |
| full Exposure cost | Quota slot; tenants tighten role max |
| Multi-instance misuse of in-memory locks | E7; Lease interface reserved |
| Tools stomping `workspace` | I5; session-level sandbox or lease policy |
| Template hot-reload breaking Memory semantics | AgentRevision bound to Run |
| Eight-layer bar chart hiding Scope | I4; docs force cross-product wording |
| Host treating engine ACL as human IAM | I6; contracts state the boundary |

---

## 8. Implementation mapping (where invariants land in code)

| Invariant | Primary landing |
|-----------|-----------------|
| I1 / E1 / E5 | RunScope: `SessionAwareRunner` / `Agent.run` / convertToLlm / toolContext |
| I2 | Session store: append authority + Projection |
| I3 / E6 | RoleDefinition / RoleBinding and handoff (session ACL) |
| I4 | Eight layers × Scope (context ownership; Knowledge see `docs/knowledge.md`) |
| I5 | Tool / Effect: context and `workspace` policy |
| I6 / Principal / Intent / Host | Control-plane API: actor/tenant/Intent field slots; human IAM boundary at Host |
| E2 / E7 | Lock → replaceable Lease |
| E3 / E4 | Substrate write paths (Memory/Wisdom/Cognition); compact `(sessionId, agentId)` |
| Knowledge source anchoring | `knowledge/` pipeline; index is not authority; source is |

**Architecture acceptance:** not merely “cross-flavor tests green”, but implementation must not violate I1/E1/E5, tool identity comes from RunScope; the tool effect plane at least has document-level policy and interface slots.

---

## 9. Related documents

| Document | Role |
|----------|------|
| **`docs/north-star.md`** | **Architecture constitution (Chinese working authority)** |
| **`docs/north-star.en.md` (this file)** | English peer translation; keep in sync |
| **`docs/domains.md`** | **Product domain map (10 domains)** |
| **`docs/domains.yaml`** | Sole machine authority for domain/module counts |
| `docs/architecture.md` | Product-facing architecture notes |
| `docs/KNOWN-ISSUES.md` | Known-issue summary |
| `docs/context-layer-contracts.md` | ContextLayer / Assembler contracts |

Implementation phases and internal topics live in the development-repo handoff materials (not public).

---

## 10. Change log

| Date | Content |
|------|---------|
| 2026-09-26 | **Collaboration promoted to a formal product domain** (required for product completeness; implementation may be incomplete); landed `docs/domains.md` / `docs/domains.yaml` (10 product domains). I1–I6 / E1–E7 unchanged. |
| 2026-09-26 | English peer translation of the constitution (post ontology/planes patch). |
| 2026-09-26 | **Ontology patch + planes re-partition** (prerequisite for domain structure): split Agent/Substrate double-booking; Session clarified as aggregate; deleted “Episode artifacts” entity in favor of write-back relation; Role split into RoleDefinition×RoleBinding; added Host/Intent/Knowledge/Tool/Effect/Projection; Knowledge Scope corrected to Global/Project/Session (no Agent-level sources; follow `docs/knowledge.md`); planes become three groups of seven (Control/Continuity/Agent&Substrate · Activation/Execution · Context/Extension) plus cross-cuts Observability/Collaboration. **I1–I6 / E1–E7 unchanged**. |
| 2026-09-21 | Draft: ontology, invariants I1–I6 / E1–E7, control-plane layering, eight layers × Scope, Accountability/Agency, reserved slots, over-engineering boundary, implementation mapping |
| 2026-09-21 | **Finalized**; subsequent implementation and review follow this document’s invariants |
| 2026-09-21 | **I1 landed**: RunScope ALS + per-run AgentContext; see CHANGELOG v0.35.0 |
| 2026-09-21 | Opening positioned as **Architecture Constitution**; body does not expand the docs tree |
| 2026-09-21 | Related docs limited to public `docs/`; implementation planning stays in internal handoff materials |
| 2026-09-21 | **Phase B–G implementation status** (internal acceptance, CHANGELOG v0.36–v0.41): I5 toolIsolation, model 2 primary/attribution, compact E4, ACL E6, preferred/handoff I3, Lease interface slot E2/E7, AgentRevision field slot. Invariants themselves unchanged. |
| 2026-09-21 | Removed stale opening “status” line (only marked I1/v0.35.0, behind current implementation); the “revisions must go through the change log” requirement moved into Status. Invariants and body unchanged. |
