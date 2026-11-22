# Octopi 🐙

**The Embeddable Agent Engine**

> An agent is not a class — it's a complete runtime.
> Runtime, continuity, and governance — in one constitution.

[中文文档](./README.zh.md) · [Documentation](./docs/) · [Architecture](./docs/architecture.md) · [Contributing](./docs/CONTRIBUTING.md)

[![CI](https://github.com/JK-Ai-Era/octopi/actions/workflows/ci.yml/badge.svg)](https://github.com/JK-Ai-Era/octopi/actions/workflows/ci.yml) ![License](https://img.shields.io/badge/license-Apache--2.0-blue) ![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen) ![npm](https://img.shields.io/npm/v/octopi-agent?label=octopi-agent)

---

## A loop is not a product

An agent loop is a hundred lines of code. Shipping one inside a product is not.

Between "works in the demo" and "runs in production" stand five walls:

- **Amnesia** — every session starts from zero; nothing the agent learned survives.
- **Garbage memory** — a bolted-on vector store happily remembers things it should never have believed.
- **Context rot** — the window fills until the model can no longer see what matters, and nobody can say why.
- **Unenforced authority** — permissions are a promise in a prompt, not a constraint in the engine.
- **Unattended runs** — the first time a run goes sideways at 3 a.m., nothing is watching, and the only policy is `maxSteps`.

Frameworks hand you the loop and wish you luck with the walls.

**Octopi is the engine that makes the walls its job.** Session continuity as a
first-class aggregate. A learning substrate with an actual theory of how
knowledge is formed. A context pipeline you can inspect down to the token.
Governance that cannot be opted out of. Supervision that knows the difference
between a resource limit and a behavioral anomaly.

---

## What is Octopi

Octopi is an **embeddable agent engine** — a component you build AI-powered
products on, not a standalone app, not a chat wrapper, not an orchestration DSL.

- **You keep the boundary.** The Host supplies the `Principal`, maps
  `conversationId ↔ sessionId`, and owns human-level IAM. The engine consumes
  structured `Intent`s and never does permission NLU.
- **The engine keeps the runtime.** Session, Run, memory, context, tools,
  security, budget, supervision — defined ontology, not glue code you invent.

```text
Your product ── Principal / Intent / IAM ──► Octopi engine ──► Model, Tools, World
                 (you own the boundary)      (runtime, continuity, governance)
```

---

## The Constitution

Most frameworks define classes. Octopi defines **law** — an ontology with
exclusive definitions and enforceable invariants. A few of the laws of physics:

| Object | What it is |
|---|---|
| **Session** | The first-class aggregate of continuity (`sessionId`) |
| **Discourse** | The session's append-only authoritative log |
| **Projection** | Any derived view (status / tasks / compact / index) — rebuildable, never authoritative |
| **Agent** | A template: persona, tools, default model, substrate — never a bag of live state |
| **Run / RunScope** | One episode; **all mutable context lives only inside a RunScope** and is discarded after write-back |
| **Substrate** | What the agent has learned across sessions: Memory / Cognition / Wisdom |
| **Principal / Intent** | Who drives, and a structured request (`run` / `consult` / `handoff`…) — auditable, never inferred from prose |

And the invariants they imply:

- **I1** — Mutable context exists only in a RunScope. Agents are templates; the same agent runs many sessions concurrently without cross-talk (the lease key is `sessionId` — from day one).
- **I2** — Discourse is the single authority. Everything else is a projection that can be invalidated and rebuilt.
- **I3** — Accountability ≠ Agency. Being able to act is not being responsible; switching executors is not a `handoff`.
- **I5** — The effect plane is governed exactly like the cognition plane. Tools touch the world; their effects are policy, not trust.
- **I6** — The engine consumes structured Intents and keeps every Principal in the audit log. "Understanding language" belongs to the host; enforcing the law belongs to the engine.

### Constitution-driven development

The constitution is not documentation decoration — **it is the development
method, and it is this project's single largest source of reliability.**

Every concept has exactly one authoritative definition. Every invariant is an
enforceable law with a named implementation site and a verification test.
Design decisions travel through change records and bilingual sync — never
through tribal memory. When code and constitution disagree, the code moves.

That is why the invariants above survive concurrency and growth: RunScope
isolation, Discourse authority, and the permission lattice are not aspirations
remembered by developers — they are **checked**: automated dependency
boundary checks, catalog single-sources-of-truth, and tests that fail when the
law is broken. New work is judged by one question first: *does it violate
the constitution?*

📖 **[Read the full constitution →](./docs/north-star.md)** (中文版：[docs/north-star.zh.md](./docs/north-star.zh.md))

---

## Five sciences you won't find in a framework

### 1. The science of knowledge — the distillation chain

Octopi does not "store memories". It models **how knowledge is formed, falsified,
and retired**:

```text
Information ──distil──► Memory ──weave──► Cognition ──condense──► Wisdom
 (raw interaction)     (propositions)    (concept graph)        (maxims)
```

**Memory — propositions, not blobs.** Every entry is a typed proposition:
`fact` (what is true), `method` (what works), `norm` (what one should do).
Activity logs, statistical summaries, and persona echoes are *rejected at the
door*. Six gates (G1–G6) enforce shape, provenance, anti-patterns, retrieval
anchors, conflict/capacity, and safety. Confidence is priced by origin: a
`user_directive` enters at **0.9**, the model's own inference at **0.4** — and
an inference without a quotable source lands in **shadow**: searchable, but
**never injected** into context. Zero memories is a legal state; this system
would rather know nothing than know garbage.

**Cognition — a graph that refuses superstition.** Concepts are nodes; edges must
carry a license. A `causes` edge requires **two independent memories** of
evidence (or one strengthened memory plus a fail→fix closure) — co-occurrence
can never graduate into causation. Edges have Hebbian plasticity
(`w = 1-(1-w)(1-η·e)`) and per-relation decay; new edges enter a fast shadow
graph and are consolidated into the slow graph. Retrieval is **spreading
activation** along relations, not keyword matching. The design rule is
explicit: *a wrongly-strong edge costs more than a missing one.*

**Wisdom — judgment that can be falsified.** A wisdom entry is a *maxim* — "how
to think about this class of problem" — with scenarios, anti-scenarios, and
effects. Maxims are hypotheses: born `candidate`, proven in `trial`, promoted to
`active`, and `contested` by counter-evidence or `superseded` by better ones.
Even factory presets ship at confidence **0.7**, not 1.0. Credit assignment
shows `applied / assisted / contested` counts — never a fake "87% success rate".

**The rule that makes it all work:** *the LLM judges intent; code enforces
structure.* No regex guesses at meaning. No schema pretending to understand.

### 2. The physics of context — eight layers × scope

"Context engineering" elsewhere means a prompt template. Here it is a **typed,
owned, budgeted pipeline**:

- **Eight content layers**, assembled by priority:
  `Wisdom → Persona → Skill → Knowledge → Cognition → Memory → Runtime → Information`.
  Seven layers the assembler composes, plus `Information` — the conversation itself.
- **A cache-stable prefix (E8 placement)** — the system prompt carries only what
  stays constant through the session; everything volatile — datetime, session
  tasks / guidance, query-dependent Memory / Cognition / Wisdom picks — rides in a
  turn-scoped `<turn_context>` inside that turn's `<turn_start>` user message.
  History is append-only and fully replayed: stale picks are frozen in their turn,
  never edited away.
  *Payoff: the provider's prefix cache hits turn after turn — warm latency at
  cached-token prices.*
- **Three ownership bands** — Agent substrate (persists across sessions) / Run
  (volatile, never written back to the template) / Session (first-class
  continuity). This *explains* why multiple agents can share one conversation
  while never sharing personality or memory.
- **Formation ≠ assembly.** The distillation chain (how knowledge forms) and the
  assembly order (what the model sees) are orthogonal axes — a distinction the
  rest of the industry has yet to put into words.
- **Token accounting with calibration** — three estimation tiers (LLM-reported →
  tokenizer → heuristic; segmented classification: 1 token/char for CJK), with a
  per-model calibration ledger (`ContextSizeLedger`) feeding measured actuals
  into every decision reading.
- **Per-layer budget competition and a manifest** — every layer's inclusion or
  drop is reasoned and inspectable. *Why this turn's prompt looks the way it
  does* is a question with an answer.
- **Compaction keyed by `(sessionId, agentId)`** — summaries follow the
  conversation × agent, never polluting the template.

### 3. The law of authority — accountability you can enforce

- **Effective permission is a lattice intersection**:
  `engine floor ∩ role max ∩ agent maxSessionRights ∩ binding overrides`.
  An illegal grant is rejected **at grant time**, not at use time.
- **A role catalog as first-class configuration** — `owner / specialist /
  reviewer / operator / steward` ship as seeds; your business roles join the
  same catalog. Specialist can read everything and write its own memory — but
  accountability stays with the primary.
- **`handoff` is an audited change of the Principal**, host-controlled by
  default; agents cannot promote themselves. Switching who answers is
  `preferred` + a grant — never a silent takeover.
- **Every run knows who asked.** Principal enters the run record and the audit
  trail; the engine never guesses who is driving.

### 4. The governance of power — security and effects as primitives

- **Two security layers**: a rule engine that is always on and has **no bypass
  option** (there is no `skip`/`disable` in the guard contract), plus an
  optional LLM safety agent for semantic edge cases.
- **Five guards** — input, output, tool call, tool output, behavior. Shell
  parsing is four layers deep (quote-aware splitting → command recognition →
  redirection parsing → wrapper recognition): `rm -rf /` is `critical`,
  `rm -rf ./dist` is `low`. Deterministic injection patterns (`$(...)`,
  backticks, `| bash`) are cut at the boundary.
- **Six degradation strategies**, not one blunt rejection: substitute command,
  restrict scope, require confirmation, add guardrails, reject, defer to safety
  agent.
- **Client Tools — devices as governed first-class tools.** Client capabilities
  (`photo_capture`, `html_ui`, `mic_listen`, `voice_play`, `location_watch`, …)
  register as tools the model can call like any other — but sensitive devices
  require an explicit `purpose` and consent (`none / prompt / strict`). Red
  lines: no silent collection, no forged consent, no empty success, no raw bulk
  bytes in context. Identity is four orthogonal axes — Principal ·
  ClientInstance · Agent · Run — so a device belongs to a *person*, not to an
  agent.
- **Retrieved knowledge is wrapped as material, not instruction** — grounding
  blocks are labelled untrusted reference content, and audit keeps the full
  text. Retrieval poisoning is defused at the wrapping layer.

### 5. The engineering of runs — reliability and activation

- **Budget ⊥ Guard, by design.** A resource cap is not a behavioral anomaly.
  Accounting **records and never kills**; policy is the deployer's opt-in;
  control degrades gracefully: `observe → warn → compact → wrap-up → stop`.
  The engine will not guillotine a healthy multi-tool task over nominal token
  sums — that bug killed real runs (31 turns aborted at a phantom "2M tokens"),
  and the redesign made it structurally impossible.
- **Cache-aware metering** — `inputUncached / inputCached / inputCacheWrite`
  are first-class quantities; fabricating cache by subtraction is forbidden.
- **A taxonomy of failure** — Loop · Thrash · Drift · Stall · Blowup · Burn —
  with a recovery escalation ladder: `inject_hint → stronger hint → truncate →
  stop`. Three consecutive recoveries of the same failure kind end the run.
- **The reliability toolbox**: planning-only retry, empty-response retry, no-op
  detection, tool-loop detection (Rabin–Karp fingerprinting), circuit breakers,
  and a two-layer TaskSupervisor (rule detection → LLM review).
- **Activation — stimuli become supervised runs.** Schedules, events,
  escalations, agent signals and webhooks are *compiled* into runs
  (Trigger → Dispatch → Coalesce) with de-duplication and a single session
  mutex — no second execution queue. Between two user messages, things happen.
- **Autonomous subsystems** with a five-dimension model —
  `Sense + Think + Act + Signal + Boundary` — declared as directories
  (`SUBSYSTEM.md` + `config.yaml` + `handler.ts`). Four ship in the box:
  `memory-steward`, `wisdom-steward`, `cognition-steward`, `safety-guard`.
  The stewards are how the substrate stays clean as it grows.

---

## Architecture

Four layers. One dependency rule: **outer → inner. Core has zero outer
dependencies.**

```text
┌────────────────────────────────────────────────────────────┐
│  Layer 3  Integration — providers · storage · telemetry ·   │
│           HTTP/WS gateway · TUI · web runtime              │
│  ┌────────────────────────────────────────────────────────┐│
│  │  Layer 2  Harness — 10 product domains + cross-cutting ││
│  │           governance · session · agent · memory ·      ││
│  │           knowledge · activation · run · context ·     ││
│  │           extension · collaboration                    ││
│  │  ┌────────────────────────────────────────────────────┐││
│  │  │  Layer 1  Core — EventBus · StateMachine ·         │││
│  │  │           Kernel ports (ModelProvider, Security-   │││
│  │  │           Guard, RunGuard, ErrorStrategy, …)       │││
│  │  │  ┌────────────────────────────────────────────────┐│││
│  │  │  │  Layer 0  Loop — pure async generator:         ││││
│  │  │  │  agentLoop · callModel · classifyError         ││││
│  │  │  └────────────────────────────────────────────────┘│││
│  │  └────────────────────────────────────────────────────┘││
│  └────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────┘
```

Octopi Harness is organized as **10 product domains** — governance, session,
agent, memory, knowledge, activation, run, context, extension, collaboration —
grouped on three planes: *authority* (governance · session · agent · memory ·
knowledge), *phase* (activation · run), and *capability* (context · extension ·
collaboration). The count authority is
[docs/domains.yaml](./docs/domains.yaml); the narrative is
[docs/domains.md](./docs/domains.md).

The Loop layer is a **pure async generator** — zero state, zero external
dependencies — so the entire runtime above it is contracts you can swap:
`ModelProvider`, `SessionStore`, `ContextEngine`, `SecurityGuard`, …

---

## Quick Start

**Prerequisites**: Node.js ≥ 24.

```bash
npm install -g octopi-agent
```

### Three minutes to your first conversation

```bash
octopi init
```

On a fresh machine `octopi init` **is** the first-run experience: it scaffolds
`OCTOPI_HOME` and then walks you through the setup wizard in your terminal. The
state machine has nine steps; terminal mode auto-selects CLI, so you answer
eight:

```text
language → deployment mode → model provider → API key → model
         → connectivity probe → start services → first message
```

- **Deployment mode** is a real decision, not a formality: *personal* (just you
  on this machine, no login), *organization* (one org, several users, shared
  knowledge base), *multi-organization* (isolated orgs on one deployment). The
  two org modes ask for an admin password — typed twice, stored hashed.
- **API key** is never written into `octopi.json`: it lands in
  `OCTOPI_HOME/.env` while the config keeps a `${VAR}` placeholder. The wizard
  probes the provider before it commits, and every failure comes with a way out
  (retry, re-enter the key, switch provider, save and exit).
- **Config takes effect immediately** — the wizard writes before it starts
  services, and the Web wizard hot-applies into the running gateway. If you
  re-run `octopi init` against an already-running gateway, restart it (or change
  config through the console) — the CLI wizard does not hot-apply.

When the wizard finishes it offers to start services and to chat right away,
and prints the console access key (the random `channels[type=http].apiKey`
scaffolded for you). Local access needs nothing; for LAN or remote access paste
that key into the WebUI login page's "Access key" field.

```bash
octopi serve start   # gateway + web console; the wizard can do this for you
octopi chat          # TUI chat, same agent, same config
octopi doctor        # diagnose deployment/config, no LLM needed
octopi --version     # installed version (also: octopi version, or -v)
```

Bare `octopi` follows the same rule: uninitialized → the init wizard,
initialized → TUI chat.

**Prefer the browser?** `octopi init --web` starts the service for you if it is
not running (`serve start`, itself idempotent), then opens the Web wizard at the
printed setup link. On a fresh deployment that link is what `octopi serve start`
prints:

```text
🧙 First-run setup wizard (Web): http://localhost:8180/?setup=<token>
```

(Port `8180` is the default; with `web.port` set, trust the printed link.) The
link is valid for 30 minutes and revoked once the wizard completes. The setup
endpoint requires that token from any source — loopback included — so nothing
else on the machine can drive the wizard and rewrite the config; requests a
browser sends from a non-local origin are refused. If no valid token exists
(already configured, or expired), `--web` says so and points at the console
instead of opening a page without a wizard. The CLI and Web wizards share one
state machine and write the same config — pick either.

**Non-interactive** (CI, dotfiles, scripted installs) — `--yes` skips the wizard
and reads everything from flags plus env, so nothing is probed:

```bash
OCTOPI_API_KEY=sk-… octopi init --yes --provider deepseek --model deepseek-flash
```

`--yes` takes defaults plus env: `OCTOPI_API_KEY` (required by presets that need
a key — omit it only for keyless `ollama`), `OCTOPI_DEPLOYMENT_MODE`,
`OCTOPI_ADMIN_PASSWORD` (required by the org modes), `OCTOPI_ORG_NAME`,
`OCTOPI_ADMIN_NAME`, `OCTOPI_LANG`. Defaults: provider `ollama`, deployment mode
`personal`. `--web` hands off to the browser wizard; `--cli` forces the terminal
one.

**A second agent** (journey B) is a wizard of its own — pick a type, name it and
say how it should address you, get pointed at attaching material, then try it.
It needs an initialized deployment (the registry must have a user):

```bash
octopi agent new
```

### Embed in code

```typescript
import { AgentBuilder, OpenAIProvider } from 'octopi-agent';

const { runner, runtime } = await new AgentBuilder()
  .model(new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    models: ['gpt-6.1-terra'],
    defaultModel: 'gpt-6.1-terra',
  }))
  .persona('./my-agent')
  .build();

const userMessage = { role: 'user' as const, content: 'hello', timestamp: Date.now() };

for await (const event of runner.handle('session-1', userMessage, {
  systemPrompt: '', // let the runner resolve persona per run (hot-reload aware)
  agentId: 'default',
  sessionId: 'session-1',
})) {
  if (event.type === 'llm_stream_delta') {
    process.stdout.write(String(event.data?.delta ?? ''));
  }
}

runtime?.dispose(); // autonomous subsystems hold timers — dispose so the process can exit
```

`runner.handle()` is the session-aware entry: it owns the session lifecycle and
write-back. Leaving `systemPrompt` empty lets the runner resolve persona per run
(editing `AGENTS.md` takes effect on the next message); passing a string pins
that prompt for the call. For a single agent with no host session store,
`build({ mode: 'core' })` plus `agent.run()` is the library-level path. Hosts
that already have a config file can skip the builder: `buildFromConfigFile()`
returns a `Map` of `agentId → BuiltAgent` (`agent`, `runner`, `runtime`, …).

### Files as configuration

Persona and skills are plain Markdown — diffable, reviewable, versionable.
Extension = add a file. Composition = overlay directories.

```text
my-agent/
├── AGENTS.md           # main persona — loaded first
├── persona/            # supplemental persona, alphabetical
│   ├── 10-soul.md
│   ├── 20-identity.md
│   └── 30-user.md
└── skills/
    └── deploy/
        └── SKILL.md    # two-stage loaded: metadata now, content on demand
```

The learning substrate (Memory / Cognition / Wisdom) lives in a per-agent
SQLite store — it is *grown*, not hand-written. See [docs/memory.md](./docs/memory.md).

### Mount MCP servers

The MCP SDK client is an Integration adapter — import it from its subpath, not
the package root:

```typescript
import { AgentBuilder, OpenAIProvider } from 'octopi-agent';
import { createSdkMcpClient } from '@octopi-agent/engine/integration';

const { agent, runner, mcpManager, runtime } = await new AgentBuilder()
  .model(new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY!, models: ['gpt-6.1-terra'], defaultModel: 'gpt-6.1-terra' }))
  .persona('./my-agent')
  .mcpClientFactory(createSdkMcpClient)
  .mcp({
    id: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
  })
  .build();

// same loop as above, now with the MCP server's tools in the tool set
console.log(agent.context.tools?.map((t) => t.name));

await mcpManager.disconnectAll(); // MCP servers keep child processes alive
runtime?.dispose();
```

Tools arrive namespaced as `{serverId}__{toolName}` (separator `__`), so the
server above registers its own tools under a `filesystem` prefix — two servers
advertising the same tool name cannot collide.

---

## Capability tour

| Capability | One-liner | Details |
|---|---|---|
| **Plugins & hooks** | Interceptor + observer semantics, priority-ordered, per-handler timeout; full lifecycle coverage from model resolve to loop end | [docs/plugin-system.md](./docs/plugin-system.md) |
| **Skills** | Two-phase loading: frontmatter at boot, content on demand — 100 skills cost a few hundred tokens | [docs/plugin-system.md](./docs/plugin-system.md) |
| **MCP** | Native, namespaced `{serverId}__{toolName}`; stdio/SSE | [docs/architecture.md](./docs/architecture.md) |
| **Knowledge** | Sources are authority, indexes are rebuildable; two-phase indexing (searchable in minutes); Global/Project/Session scopes; independent Knowledge Service owns `knowledge.db` | [docs/knowledge.md](./docs/knowledge.md) |
| **Session tasks** | Goals and steps as session projections with task tools | [docs/task-system.md](./docs/task-system.md) |
| **Web search** | `web_search` tool; providers duckduckgo / tavily / brave / serper / mimo with ordered fallbacks | `octopi.example.json` |
| **Document port** | PDF / Office extraction as a shared capability (`documents.*`) | [docs/architecture.md](./docs/architecture.md) |
| **Multi-agent** | Swarm topologies (hierarchical / pipeline / broadcast / peer-to-peer) over governed roles | [docs/domains.md](./docs/domains.md) |
| **Human-in-the-loop** | Approval requests/decisions as engine contracts, surfaced in gateway & UI | [docs/architecture.md](./docs/architecture.md) |
| **Observability** | Telemetry (traces, metrics, exporters) + a run observatory for debugging | [docs/observer-domain.md](./docs/observer-domain.md) |
| **Surfaces** | Terminal (TUI), gateway (REST + WS), web runtime with a context inspector | [docs/architecture.md](./docs/architecture.md) |

---

## Design principles

1. **An agent is a runtime, not a class.** Workspace, session store, tools,
   model config, persona — a scope, not an object.
2. **Mechanism, not policy.** The framework provides mechanisms; the integrator
   provides policies. Defaults are opt-in, never smuggled in as engine law.
3. **Interfaces over implementations.** Swap the model vendor, the storage, the
   context engine — the contract stays.
4. **Security is built in.** Not toggles. The more capable agents become, the
   less safety can depend on developer discipline.
5. **Files as configuration.** Markdown for persona, skills, commands. Git is
   the editor.
6. **The host keeps the boundary.** Human IAM, routing, and identity stay in
   your product; the engine enforces, never impersonates.
7. **Each domain is independently understandable.** You can work on one domain
   without holding the whole system in your head.

---

## Testing & quality

```bash
npm test
```

550+ test files on a three-tier discipline: unit (mocks), **record/replay**
(deterministic regressions), and E2E against real APIs — plus `ChaosProvider`
fault injection and architecture dependency checks. Testing is not coverage
theater; it is how the invariants stay invariant.

---

## Status & boundaries

Octopi is pre-1.0 and moving fast. Being honest about the edges:

- **Deployment assumption**: single process is the v1 reality; cross-process
  requires a distributed Session Lease (in-process lease exists today).
- **Collaboration domain** ships with `status: incomplete` — semantics are
  defined; some implementations are staged.
- **Not for everyone**: if a single-vendor SDK's loop is enough, or you need a
  vertical business workflow engine, or human-level IAM inside the engine —
  Octopi is not what you want. It is an engine for products that need
  continuity, learning, and governance *below* their own product logic.
- **Concrete blockers** (check these before you start, not after):
  - **Node.js ≥ 24 is a hard requirement.** We use the built-in `node:sqlite`
    instead of shipping a native SQLite binding, because native bindings break
    on cross-platform installs and are awkward to combine with vector search.
    Node 22 and older will not install.
  - **Multi-instance / horizontally-scaled deployments are not supported in v1.**
    In-process Session Lease exists; cross-process lease does not. Quota, sessions,
    and concurrency are single-process.

Open items live in [docs/KNOWN-ISSUES.md](./docs/KNOWN-ISSUES.md).

---

## Packages & import surfaces

Five publishable packages (npm workspaces):

```text
octopi-agent               Suite (CLI bin: octopi) + config IO
  ├─ @octopi-agent/engine    Harness 10 domains + integrations
  │    └─ @octopi-agent/core Loop + Kernel contracts
  ├─ @octopi-agent/gateway   HTTP/WS process plane + web runtime
  └─ @octopi-agent/webui     Prebuilt web console
```

| Need | Import |
|---|---|
| Suite / CLI | `octopi-agent` |
| Runtime | `@octopi-agent/engine` |
| Kernel | `@octopi-agent/core` |
| Gateway / web client | `@octopi-agent/gateway` |
| Plugin SDK | `@octopi-agent/engine/plugin-sdk/plugin-entry` |

---

## Documentation

- **Concepts** — [Constitution](./docs/north-star.md) · [Domains](./docs/domains.md) · [Memory](./docs/memory.md) · [Knowledge](./docs/knowledge.md) · [Context layers](./docs/context-layer-contracts.md) · [Tasks](./docs/task-system.md) · [Plugins](./docs/plugin-system.md) · [Autonomous subsystems](./docs/autonomous-subsystem.md) · [Observer](./docs/observer-domain.md)
- **Guides** — [Contributing](./docs/CONTRIBUTING.md) · [Known issues](./docs/KNOWN-ISSUES.md) · [Example config](./octopi.example.json) · [JSON schema](./octopi.schema.json)
- **Reference** — [Architecture](./docs/architecture.md) · [Domain catalog](./docs/domains.yaml) · [Changelog](./CHANGELOG.md)

---

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
