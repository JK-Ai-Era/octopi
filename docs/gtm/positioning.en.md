# Octopi — Positioning & Narrative (EN)

> Status: draft for review (低调期备料，未发布)
> Derived from: `README.md`, `docs/north-star.en.md`, `packages/webui/DESIGN.md` (voice rules)
> All claims below are traceable to the codebase. Do not add unverifiable superlatives.

---

## 1. One-line positioning

**Octopi is an embeddable agent engine — runtime, continuity, and governance in one constitution.**

Alternates (by audience):
- Developer shorthand: **"Agent is a runtime, not a class."**
- For architects: "An agent engine you can embed, inspect, and govern."
- Category: embeddable **agent engine** (not a framework, not a chat wrapper, not an orchestration DSL).

## 2. Elevator pitch (30 s)

Most "agent frameworks" give you a chat loop and a bag of abstractions, then leave you to
invent sessions, memory, permissions, and observability. Octopi is an engine: you embed it,
your host keeps IAM and identity, and the engine supplies what agents actually need at
runtime — session continuity as a first-class aggregate, a learning substrate
(Memory / Cognition / Wisdom), an 8-layer context assembly pipeline that is inspectable
down to the token, and governance (ACL, HITL, credentials, injection detection) built in,
not bolted on. 4-layer architecture with a strict dependency rule, 1000+ tests, and a
web runtime where you can see why each turn was assembled the way it was.

## 3. Audience

| Segment | Who | Message that lands |
|---|---|---|
| **Primary** | Platform/infra engineers embedding agents into products | "Engine, not framework. You keep the IAM; we keep the runtime honest." |
| **Secondary** | Agent-tooling builders (MCP, tools, multi-agent) | "Mount tools and MCP servers; the engine handles run scope, budget, effects." |
| **Tertiary** | Technical founders / leads evaluating agent stacks | "Constitution-level design: sessions, substrate, governance are ontology, not afterthoughts." |

## 4. Differentiation

| They see elsewhere | Octopi |
|---|---|
| Framework: you assemble loops, memory, sessions yourself | **Engine**: RunScope, Session, Discourse, Projection are defined ontology (see `north-star.en.md`) |
| "Memory" = a vector store bolted on | **Substrate**: Memory / Cognition / Wisdom as durable learning products, scoped per Agent |
| Context = "system prompt + history" | **8-layer context model** with budgets, per-layer include/drop reasons, and a manifest you can inspect |
| Security = sanitize your inputs | **Governance domain**: ACL, security policy, HITL approval, credentials, injection detection as engine primitives |
| Black-box agent behavior | **Instrument-grade web runtime**: in 10 seconds see why this turn answered this way |
| Vendor-shaped agents | **Embeddable boundary**: Host supplies Principal, maps conversationId↔sessionId, owns human IAM |
| Multi-agent = prompt-chaining scripts | **Collaboration semantics**: Accountability / Agency / Exposure / Learning, explicit handoff |

Head-to-head framing (internal guidance, not for public copy):
- vs **LangChain / LangGraph**: they are orchestration libraries; sessions/substrate/governance are your problem. Octopi's ontology is the product.
- vs **Vercel AI SDK**: excellent provider/streaming layer for app UIs; not a runtime with continuity or governance.
- vs **OpenAI Agents SDK / Claude Agent SDK / Google ADK**: strong runtimes, but shaped around one vendor's models and ecosystem; Octopi's ModelProvider is a port and the host keeps the boundary.
- vs **AutoGen / CrewAI**: multi-agent orchestration focus; Octopi treats collaboration as governed roles (Accountability ≠ Agency), not chat rooms.

## 5. Proof points (all verifiable)

1. **4-layer architecture** (Loop → Core → Harness → Integration) with a strict dependency rule: Core has zero outer dependencies.
2. **10 product domains**, each independently understandable (Governance, Session, Agent, Memory, Knowledge, Activation, Run, Context, Extension, Collaboration).
3. **8-layer context intelligence model** (Wisdom → Persona → Skill → Knowledge → Cognition → Memory → Runtime → Information) with budget assembly and per-layer drop reasons.
4. **Testing as a discipline**: 64 test files, 1000+ tests — unit (mock), recording/replay, E2E with real APIs, plus `ChaosProvider` fault injection.
5. **Files as configuration**: persona / skills / wisdom are Markdown, diffable and reviewable.
6. **MCP-native**: mount MCP servers (stdio/SSE) as first-class tools.
7. **Runtime, not a class**: `agentLoop()` is a zero-state async generator; everything above is a contract you can swap (ModelProvider, SessionStore, ContextEngine).
8. **Node >= 24**, built-in `node:sqlite`, zero native-module install pain.

## 6. Voice & tone (from brand rules in `packages/webui/DESIGN.md`)

- Register: **technical, instrument-grade, verifiable.** Short sentences. Truth over polish.
- Address: "you" to the developer.
- **Words we use**: engine, runtime, layer, budget, included, dropped, provenance, manifest, session, substrate, governance.
- **Words we refuse**: seamless, elevate, unlock, "AI-powered magic", 一站式 / 全方位赋能, "agent 变聪明了" — no empty claims. Never "the most advanced".
- **Anti-patterns**: no KPI-card walls, no hype adjectives, no claims we cannot show in a demo.

## 7. Messaging skeleton (for all downstream materials)

```
Category      → Embeddable agent engine
For whom      → Engineers embedding agents into real products
Problem       → Frameworks hand you a loop; sessions, memory, permissions, and
                observability end up as your glue code
Solution      → A constitution-level engine: continuity, substrate, governance,
                and an 8-layer context pipeline you can inspect
Proof         → 4-layer arch · 10 domains · 1000+ tests · MCP-native · web runtime demo
Tone          → Technical, calm, verifiable. The demo is the marketing.
```

## 8. Low-profile-period rules (低调期)

- No public repo link, no download counts, no launch date promises on the website.
- Website CTA: **request access / join waitlist**, not "npm install".
- Materials in this folder are prepared, **not published**, until 大哥 opens the launch window.
