# Observer Domain

> **Language note**: This English edition is the **working authority**. The Chinese translation is [`observer-domain.zh.md`](./observer-domain.zh.md). Keep both in sync.
> **Status**: external document (tracked). Consistent with [architecture.md](./architecture.md) and [north-star.md](./north-star.md).  
> **Internal design notes** live in the internal directory (gitignored, not in the repo, not public).

---

## 1. Product Mindset: One Domain, Two Subdomains

Octopi’s “Observer” is not a single class. It is two orthogonal subdomains under the **Observer Domain**:

| Subdomain | Code location | Consumers | Production default |
|------|----------|--------|----------|
| **Telemetry** (operational observability) | `core/interfaces/observer.ts` + `integration/observability/*` (NoopObserver / LogObserver / ObserverBridge / TraceLogger / MetricsAggregator) | Metrics, tracing, exporters | Can run in production (`observability` config) |
| **Run Observatory** (dev debugging) | `harness/observability/observer/*` (ObserverHub + Run projections) | Web right-rail **Run** panel, `/debug/run/*` | **`observer.level=off`** |

```text
Observer Domain
├── Telemetry        — Core Observer → Trace / Metrics (ops)
└── Run Observatory  — ObserverHub → snapshots / debug REST / Run panel (dev)
         ▲
         └── Shared event sources: EventBus / HarnessLoopEvent / SecurityGuard
```

**Do not merge into one implementation class**: sensitive surfaces, failure policies, retention policies, and consumers all differ. Config keys stay on two rails:

- `observability` — Telemetry  
- `observer` — Run Observatory (live Run scene)

Both belong to the Observer Domain mindset; implementations stay separate.

---

## 2. Run Observatory (dev debugging)

### 2.1 Responsibilities

Observe the **mutable Run scene** during development/test (constitution I1): RunScope, workspace vs LLM messages, Guard metrics, timeline, plus security / memory / tool.effect projections.  
**EventBus remains the coordination bus**; ObserverHub packages inspectable snapshots. Observation failures are fail-open and never interrupt the business path.

### 2.2 Difference from Core `Observer`

| | Core `Observer` | Run Observatory `ObserverHub` |
|--|-----------------|-------------------------------|
| Interface | `recordMetric` / `startSpan` / `log` | Event ingestion + snapshot projection |
| Data | Counts, latency, spans | systemPrompt, messages, tools, security events |
| Default | May be Noop / always on | **`level=off`** |
| Egress | OTel/Webhook/file | `/debug/run/*` + Web Run panel |

Do not implement the product `ObserverHub` as a Core `Observer`, and do not depend on the Hub in the Core→Harness direction.

### 2.3 Configuration (`octopi.json`)

```json
{
  "observer": {
    "level": "full",
    "webPanel": true,
    "failOpen": true
  }
}
```

| Field | Semantics |
|------|------|
| `level` | `off` (**default**, no collection) / `summary` (no full message text) / `full` (full text + `context.llm`) |
| `webPanel` | Follows level: forced off at `off`; default true at enabled levels, can be explicitly false |
| `channels` | Per-channel overrides; unlisted channels use the level preset |
| `payload` / `retention` | Body switches and retention; **full message text** requires `payload.messageFullText && retention.messagesPerRun==='full'` |
| `failOpen` | Observation errors only warn (default true) |

summary/full presets default-enable already-implemented channels: `run.scope` / `run.messages` / `run.timeline` / `run.guard` / `context.layers` / `context.compact` / `tool.effect` / `security` / `memory`; `context.llm` only at `level=full`.

Config shape must stay in sync with `src/config-schema.ts`, `octopi.schema.json`, `octopi.example.json`.

### 2.4 Run Identity

- `RunScope.runId` + `createRunId(sessionId, agentId)` (`harness/run/run-scope.ts`)  
- Observer **does not mint a separate authoritative Run ID**; Hub prefers `scope.runId`  
- Aligned with constitution Run = `(sessionId, agentId, …)`  

### 2.5 Sampling Paths (avoid double-counting)

| Source | Path |
|------|------|
| Runner lifecycle / loop adapter events | `SessionAwareRunner.emitObserved` → **first** `hub.ingestEvent` **then** EventBus |
| ContextEngine (compact etc.) | Builder `assemble`’s `emit` callback → Hub + bus |
| SecurityGuard | `emitRunEvent` carries RunScope identity; reliability intercept → `security_blocked` → `security.blocked` |
| Gateway | **Only writes** the layers Map for the Context panel; **does not** call `hub.ingestEvent` again (prevents timeline/lifecycle double-counting) |

Context contract layer (product “Context” tab) and the Run scene (Observer) **coexist**:

- Gateway `lastContextLayers` — Context panel, independent of `observer.level`  
- ObserverHub — Run observation, snapshots when level≠off  

### 2.6 Debug REST (not a product API)

Mounted at the HTTP root (**not** under `/api/v1`):

```http
GET /debug/run/:sessionId/scope
GET /debug/run/:sessionId/messages?phase=entry|final&runId=&view=workspace|llm
```

Gated by `observer.level` / `webPanel`. SDK uses `baseUrl + /debug/run/...` (`getDebugJson`); do not fold it into `restBase=/api/v1`.

### 2.7 Channel Projections (`RunObservatorySnapshot`)

| Channel | Content |
|------|------|
| run.scope | agentId / model / cwd / isolation / systemPrompt length and preview (full also has full-text toggle) |
| run.messages | workspace entry/final; body text at full; diff |
| run.timeline | Adapted engine / tool / compact / security events |
| run.guard | iteration, tokensΣ nominal (diagnostics), usageLedger breakdown (uncached/cached/out + cacheAware), consecErr, etc. |
| context.llm | ContextEngine egress message summary (body visible at full) |
| tool.effect (I5) | This Run’s cwd/isolation + per-tool calls/errors |
| security | injection / policy / sensitive / blocked structured events |
| memory | memory_store / memory_search **read-only** summary (Observer does not write stores, E3) |

Web UI: right-rail **Run** tab (`RunObservatoryPanel`).

### 2.8 Memory and Retention

- runs / timeline: FIFO (`retention.runsPerSession` / `timelineEvents`)  
- session keys and `lastLlmBySession` are cleaned up as runs/sessions are evicted  
- In-process cache; under multi-process deployment observation is naturally per-process (consistent with the E7 single-process assumption)  

---

## 3. Developer Notes

1. **Production/embedded defaults collect nothing**; to debug, explicitly set `observer.level=summary|full` and restart the engine.  
2. **Only new runs are sampled**; changing config does not backfill historical runs.  
3. When changing config shape, sync Zod + schema + example + this doc.  
4. Do not call `hub.ingestEvent` in Gateway for events the Runner already ingested.  
5. Do not mix config keys between Core Telemetry (`observability`) and Run Observatory (`observer`).  
6. Constitution constraints still apply: I1 (scene only in RunScope), I2 (Discourse authority), E3 (memory read-only projection), I5 (tool effect plane).

---

## 4. Related Documents

- [architecture.md](./architecture.md) — layering and Harness domains  
- [north-star.md](./north-star.md) — constitutional invariants  
- [CONTRIBUTING.md](./CONTRIBUTING.md) — documentation/test sync standards  
- `packages/engine/src/harness/observability/observer/*` — Hub / DTO / snapshot implementation  
- `octopi.schema.json` — `observer` config schema  
