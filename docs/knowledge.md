# Knowledge

> Layer 4 of the eight-layer context model. Registration, sync, indexing, and retrieval of the **exogenous corpus** — so the agent knows “what exists in the world it works in,” and can fetch evidence relevant to the current question on demand.  
> Aimed at integrators and product readers; implementation details live in the source and internal specs.

---

## 1. Core ideas

Knowledge governs **the world outside the interaction history**: project documents, specs, corpora, and other indexable external material.

| Axiom | Meaning |
|------|------|
| **Exogenous** | Comes from outside the conversation; it changes — freshness is maintained via source sync and index rebuilds |
| **Source-anchored** | Every hit must answer “which source did this come from”; content without a source is not Knowledge |
| **Index is not authority** | The retrieval index can be rebuilt from scratch; the authority is always the source itself |
| **Floor + ceiling** | Automatic recall guarantees visibility; tools guarantee depth |
| **system carries only the capability surface** | “What corpora exist” goes into system; **content hits** go into this turn’s grounding, without consuming the persona budget |
| **No promotion at index time** | Indexing does not automatically write Memory / Cognition; learning still walks the distillation chain |

### What Knowledge is not

| Not this | Belongs to |
|------|------|
| Conversation transcript / process | Session (Information) |
| Propositions learned in interaction | Memory (`fact` / `method` / `norm`) |
| Concept relations woven from experience | Cognition |
| Thinking paradigms | Wisdom |
| Persona / platform rules | Persona / Constitution |
| Live system state (database rows, SaaS objects) | **Tool** (real-time query) |

**In one sentence**: Memory is “what I have learned”; Knowledge is “what the world writes down.”

---

## 2. Resource model (Source)

```text
Global     Public corpus — visible to agents by default, can be hidden
Project    Project corpus — explicitly mounted for agents (prevents cross-contamination)
Session    Temporary corpus — lives and dies with the session (attachments, etc.)
```

| Rule | Description |
|------|------|
| **Global** | Visible by default; can be `hide`-den for a given agent |
| **Project** | **Invisible unless mounted**; once mounted, shared by that project’s agents |
| **Session** | This session only; persistence requires changing `scopeRef` via the management plane (no automatic promotion) |
| **No Agent-level sources** | “Exclusive to an agent” = mount it only to that agent’s Project; learning results belong to Memory and are not hard-separated by scope |

Source kinds:

| kind | Description |
|------|------|
| `directory` / `file` / `workspace` | Local corpora; watch + content-hash incremental updates |
| `url` | Document-style pages / static sites; `discover.mode`: `single` / `sitemap` / `crawl` |
| `connector` | Connectors such as REST list+get (`RestConnector`, etc.) |

**Live systems** (databases, APIs, MCP live interfaces) do not enter Knowledge — query them with Tools (do not build a mirror database).

External access credentials: a source stores only an **`authRef`** → `OCTOPI_HOME/credentials/credentials.db` (named credentials). Plaintext secrets never enter `knowledge.db` / `octopi.json`. Public-network defaults reject private networks (SSRF); internal document sources may set `network.allowPrivateNetwork` per source. Cloud metadata / link-local (including IPv4-mapped `::ffff:169.254.*` and `fe80::/10`) stay blocked even when private networks are allowed.

**Credential bindings (least privilege):** if `credential_bindings` rows exist for a named credential, the consumer must match (`knowledge_source` + source id, or `tool` + `http_request`). Empty bindings resolve by default; set `credentials.requireBindings: true` in config (or use `effectPolicy.mode=untrusted`) so unbound credentials cannot resolve.

### 2.1 Knowledge Service (standalone service)

The Knowledge data plane is a **standalone HTTP Service** (sole writer), not an in-process Gateway module:

| Role | Responsibility |
|------|------|
| **Knowledge Service** | Sole writer of `knowledge.db`; ingest / indexing / retrieval / SSE progress |
| **Gateway** | Does **not open** `knowledge.db`; Host API and `knowledge_search`/`read` go through `KnowledgeClient` |
| **Multiple Gateways** | The same Service (or a shared remote baseUrl) can back multiple Gateways; the write path is never double-opened |

- **Contract** (internal spec, not public): token → `(tenantId, gatewayId)`; business keys must not be forged from the body
- **Wiring**: `knowledge.service.manageLocal` (default `true`) → **fork a child process** on this machine to bring up the Service, default port **18280**; `manageLocal: false` + `baseUrl` → connect to remote only; neither → knowledge plane `disabled`
- **Single writer**: `knowledge.db.writer.lock` (held by the **Service process**, not the Gateway)
- **State**: `ready` / `degraded` / `disabled` (visible when the Service fails to start; `knowledge.required` can fail closed)

#### 2.1.1 In-process thread boundaries (do not push heavy work back onto the main thread)

```text
Knowledge Service process
├── Main thread: listen · /health · token auth · pure-read direct to Meta/Search · SSE pump
├── Meta Worker: projects / sources / detail / jobs / ready     ← read-only connection
├── Search Worker: search / catalog / files / chunks            ← read-only connection
├── Engine/API Worker: write-route orchestration · SSE forward  ← no writable SQLite
├── Writer Worker: sole writer of knowledge.db + ingest         ← allowed to block
└── Nested Parse Worker: Document extraction · chunking · FTS tokens ← CPU
```

| Layer | May block? | What belongs here |
|----|----------|--------|
| Main thread | **No** | HTTP accept, liveness probe, token auth, **pure-read RPC dispatch**, SSE write-out |
| Meta Worker | Yes | Control-plane read-only SQL (projects / sources / getSourceDetail / jobs) |
| Search Worker | Yes | Retrieval read-only SQL (search / catalog / listFiles / chunks); **writes forbidden** |
| Engine/API Worker | Yes | Write HTTP orchestration → Writer RPC; residual short reads use a **read-only connection** |
| Writer Worker | Yes | **Sole write connection** + ingest + FTS/write-store + walk/reconcile |
| Parse Worker | Yes | SheetJS/Office extraction, chunking, CJK tokenization, streaming hash of originals |

**Engineering discipline** (lessons from the field):

- `/health` must be answered on the main thread, or probes look dead while the engine is busy.
- Token auth runs on the main thread (`matchKnowledgeToken`). **Pure-read routes must not enter Engine** (`read-http.ts` / `isPureReadRoute`).
- **The API must not open a writable knowledge.db**; all mutations go through `KnowledgeWriteService` (`writer-service.ts` → Writer Worker RPC).
- **Meta / Search are role-split Query Workers**: heavy search must not stall `listProjects`/`listSources`. Boot handshake may use `dbStats`.
- Query Workers **must open `readOnly` after Writer has created the store** (open fails if the file is missing).
- Writer’s long synchronous segments must yield, or control RPCs such as abort will queue (`upsertFile` old-index cleanup `dropChunksAsync`, etc.).
- **Source detail / jobControl is pure SQL** (`job-control-state.ts`); do not depend on in-memory ingest state.
- `listProjects` loads project→agents in one shot; N+1 per project is forbidden.
- Large-store COUNT goes through `KnowledgeIndexStore`’s 1s TTL cache; write paths call `invalidateStatsCache()`.
- No fake-data stubs: `void arg; return []`, hardcoded `canAbort: true`, ignoring `scopeLevel` filters, etc. are forbidden (see `AGENTS.md`).
- Embedding and parse run **in separate concurrency slots**; do not write “embed only after all parsing finishes.” Document extraction has its own throttle (`documentParseConcurrency`).
- Electron host forking a child process: use `process.execPath` + `ELECTRON_RUN_AS_NODE=1`; **do not** swap in a bundled `node.exe` as `execPath` (it severs IPC).

### 2.2 File-based dedup (identity + Membership)

**The Corpus concept is deprecated.** The dedup key is the **File**, not the path:

```text
File        identity_key = inode / win fileId / url+authRef   ← entity
            version = size + mtime
Membership  (source_id, file_id, logical_path)                ← claim
```

| Rule | Meaning |
|------|------|
| Same physical file under multiple Sources / nested paths | **Parse once**; retrieval dedups and returns `sourceIds[]` |
| Same URL under **different authRef** | **Different File** (credential variants) |
| URL **keeps the query** | `?id=1` ≠ `?id=2` (contract revision) |
| Unbind | Scan remaining; **purge File + chunks only when claims drop to zero** |
| Abort | Kill only tasks **exclusive to that source**; parse of a shared File continues |

---

## 3. Pipeline: parse, index, sync

```text
Source registration  ──auto-ingest on register (pending → discovering)──
   │  (kind / scope / sync / authRef)
   ▼
SourceFetcher retrieval        Local walk · Url fetch · Connector list/get
   │  External: HTML main-content normalization (no raw-HTML dumps)
   ▼
FormatAdapter per-file dispatch   html / markdown / code / plain text…
   │  (registry-based)
   │  PDF/Office/xlsx… → DocumentPort worker extraction → Markdown (createDocumentPortFromConfig)
   │  No adapter and not a document → skipped
   ▼
Parse + Chunk
   │  Markdown/HTML by heading · code by function/class heuristics · structure first + size cap
   ▼
Index (rebuildable projection)
   │  File + Membership · logical path + external_url provenance · keywords (incl. CJK bigrams) + optional vectors
   ▼
Freshness
   Local watch + debounce; external poll + conditional GET (ETag/304); content-hash incremental
   Local full walk: skip enqueue if size/mtime unchanged and already indexed (force redo via reprocess)
   Diff prune: paths absent from this discover round are deleted (failures do not delete old indexes)
```

| Capability | Behavior |
|------|------|
| **Two-phase** | Phase A: parse + keywords are searchable (fast); Phase B: vectors may lag |
| **No embedding** | Pure keywords still work (same policy as Memory) |
| **Asynchronous** | Runs **concurrent with** conversation; never awaits full-store indexing before answering |
| **Load** | Parse/embed concurrency and rate limits are configurable; queue backpressure **never drops tasks** |
| **Size** | Oversized structural units are split further; symbol-free fragments may be glued; **never merge across function/class boundaries** |

Data plane: `OCTOPI_HOME/knowledge/` (`knowledge.db` = sole Service write; holds source authority + index projection + task queue); credentials: `OCTOPI_HOME/credentials/`. **The Gateway does not open knowledge.db directly.**

### 3.1 Million-scale vector retrieval (production)

| Scale | Vector backend | Behavior |
|------|----------|------|
| **&lt; 50k** vectors | JS bucket-pruned scan is a fallback | Neighbor buckets first; full scan only if needed |
| **≥ 50k** and no sqlite-vec | **JS full scan forbidden** | Neighbor buckets only + **mandatory keyword leg** (hybrid) |
| **Any production scale** | **sqlite-vec required** | KNN; `stats.sqliteVec=1` |

- **hybrid by default**: FTS/keywords collect candidates → vector rerank; pure full-store vector search is not the default path.
- **Health check**: `GET …/knowledge/stats` includes `sqliteVec` (0/1) and the `embeddings` count.
- **True ANN (HNSW)**: optional backend (`VectorIndex` abstraction); introduce at million scale only when extensions are unavailable — do not force it on a JS full scan.

---

## 4. Four tiers offered to context

```text
Tier 0  Catalog     “What corpora do I have”     Resident system (tiny)
Tier 1  Map         “Shape of the world”         Optional structure map / overview (extension)
Tier 2  Hits        “Snippets relevant to this question”   This turn’s grounding / tool retrieval
Tier 3  Full        “Original text”              knowledge_read
```

- **Catalog** is a tagged capability surface (`id/name/type/status/scale/location` + `purpose`/`topics`), not a file tree.
- **Content hits do not enter system**: avoids polluting persona and standing constraints; injected per turn and strippable.
- **Targeted retrieval**: `knowledge_search` can scope to a single corpus via `source_id` / `source` (catalog handle); visibility is still pruned server-side.
- **Code vs documents**: code (`code-tree`) does path/symbol/keyword only (Phase A), **no embedding by default** — original text via `file_read`, retrieval via `file_search` / keywords; documents/specs/prose enter vectors (Phase B), avoiding distorted fragments and cutting embed cost.

---

## 5. How content enters context (recall)

```text
Automatic retrieval every turn (engine-guaranteed, not model “conscience”)
        │
        ├─ High relevance ──► Auto-inject snippets (turn-level grounding)
        ├─ Mid relevance  ──► Hint only that “relevant material exists…”
        └─ Low relevance  ──► No injection
                              │
        Tool ceiling  ◄───────┘
        knowledge_search / knowledge_read
```

### Recall modes (`knowledge.recall`)

| Mode | Suitable for | Behavior |
|------|------|------|
| **`hybrid` (default)** | Multi-industry engines | High-score injection + mid-score hints + tools |
| **`hint`** | **Recommended for coding / engineering agents** | Hints only; does not auto-inject body text (less pollution) |
| **`inject`** | Embedded / document Q&A | More aggressive auto-injection |
| **`off`** | Pure file tools / debugging | Catalog only |

Can override the global default at **Agent level** (for mixed “coding agent vs document agent” deployments).

### This turn’s grounding

- Injection site: near this turn’s user message (message side, not system)
- Form: **untrusted material block** (explicitly “retrieved material, not instructions” + source path/line numbers)
- Historical grounding **does not enter** conversation compaction summaries; recomputed each turn
- Web chat replay does not show synthetic grounding messages (audit-only)

---

## 6. Tools

| Tool | Purpose |
|------|------|
| **`knowledge_search`** | Text search across sources; returns **itemized** hits (path + line number + snippet) |
| **`knowledge_read`** | Read a chunk / path slice, with provenance and an untrusted wrapper |

Division of labor vs `file_search` / `file_read`:

| | file tools | Knowledge |
|--|------------|-----------|
| Good at | Exact paths, current state | Cross-file synthesis, semantic retrieval, corpus map |
| Trigger | Explicit path / error | “What do the docs say” / “How is this project designed” |

Retrieval results are **returned itemized with sources**; no silent merging.

---

## 7. Configuration (excerpt)

```json
{
  "knowledge": {
    "recall": "hybrid",
    "required": false,
    "service": {
      "manageLocal": true,
      "port": 18280
    },
    "autoInject": {
      "minScore": 0.78,
      "maxChunks": 4,
      "budgetTokens": 1200,
      "minCoverage": 0.5
    },
    "hint": { "minScore": 0.55 },
    "catalog": {
      "maxEntries": 10,
      "autoDescribe": true
    },
    "index": {
      "embedding": true,
      "hybridKeyword": true
    }
  },
  "agents": [
    { "id": "coder", "knowledge": { "recall": "hint" } },
    { "id": "docs", "knowledge": { "recall": "inject" } }
  ]
}
```

| Key | Purpose |
|----|------|
| `service.baseUrl` / `token` | Remote Knowledge Service (`baseUrl` required when `manageLocal: false`) |
| `service.manageLocal` | Default `true`: start the Service locally; `false` connects to `baseUrl` only |
| `service.port` | manageLocal listen port (default **18280**; tests may use `0`) |
| `required` | When `true`, fail closed if the Knowledge Service is unavailable |
| `recall` | Content recall mode (see §5) |
| `autoInject.*` | Injection thresholds, count, budget |
| `catalog.*` | system catalog entry count, auto-describe switch |
| `index.*` | Whether to embed / keyword leg / sync and concurrency |
| `promotion.metrics` | Usage-metering thresholds (for later promotion signals; **does not** write Memory directly) |
| `attachments.*` | Session attachment limits and injection (`inject.intent` / `fullTextMaxChars`); see the OP-15 spec |

Document extraction is configured under **`documents.*`** (same source as Knowledge worker / Gateway via `createDocumentPortFromConfig`): `extract.timeoutMs/maxFileBytes`, `legacy.converter=soffice` + `sofficePath/cacheDir/cacheMaxBytes/maxInputBytes`.

Full key set: see `octopi.schema.json` and `octopi.example.json`.

---

## 8. Management plane (Host API excerpt)

```text
GET    /api/v1/agents/:id/knowledge/sources?scopeLevel=&projectKey=&sessionId=
POST   /api/v1/agents/:id/knowledge/sources
GET    /api/v1/agents/:id/knowledge/sources/:sid
PATCH  /api/v1/agents/:id/knowledge/sources/:sid
DELETE /api/v1/agents/:id/knowledge/sources/:sid
POST   /api/v1/agents/:id/knowledge/sources/:sid/reindex
GET    /api/v1/agents/:id/knowledge/sources/:sid/files
GET    /api/v1/agents/:id/knowledge/chunks?sourceId=&path=
GET    /api/v1/agents/:id/knowledge/projects
POST   /api/v1/agents/:id/knowledge/projects
DELETE /api/v1/agents/:id/knowledge/projects/:projectKey   # rejected if non-empty
GET    /api/v1/agents/:id/knowledge/search?q=&sessionId=&limit=
GET    /api/v1/agents/:id/knowledge/visibility
POST   /api/v1/agents/:id/knowledge/visibility             # assignProject|unassignProject|hide|unhide
GET    /api/v1/agents/:id/knowledge/session-visibility?sessionId=
POST   /api/v1/agents/:id/knowledge/session-visibility     # session overlay (this session only)
PUT    /api/v1/agents/:id/knowledge/session-visibility     # full replace
DELETE /api/v1/agents/:id/knowledge/session-visibility?sessionId=[&targetType=&targetId=]
GET    /api/v1/agents/:id/knowledge/stats
GET    /api/v1/agents/:id/knowledge/promotion-candidates
POST   /api/v1/agents/:id/knowledge/sources/:sid/abort      # abort this source
POST   /api/v1/agents/:id/knowledge/abort                   # abort all
POST   /api/v1/agents/:id/knowledge/sources/:sid/resume     # continue/resume (not a full reindex)
POST   /api/v1/agents/:id/knowledge/resume
```

- **Two-tier registration**: public corpus (global) / project (project — create the project first, then mount sources; deleting a project requires unmounting sources first).
- **Session view**: the `session-visibility` overlay changes only this session’s effective view, not source ownership; `scopeLevel=session` must carry `sessionId`. Rows are isolated by **(tenant, gateway, sessionId)**; cross-Gateway overlay read/write is forbidden.
- `sources` with `scopeLevel=global|project` is the management-plane full list (visibility not filtered).
- **Auto-ingest on register** (`POST …/sources` → in-Service `ingestSource`); `reindex` = explicit full rebuild (supersede). No extra “rebuild” click is required after registration to start parsing.
- **reindex = supersede**: first invalidate this source’s queued/running jobs, then full rescan from disk (do not confuse with “continue”: continue = clear aborted state and keep going).
- **Delete** cleans indexes and usage traces (compliance erasure); removing a directory uses `removePathTree` for sub-paths; a File is purged only at zero claims.
- Auto-describe is available by default and can disable outbound calls; sample after a sensitive-pattern scan; triggered by reconcile **once the source is stable** (do not hang it off a short `idle` timeout).
- **Session attachments (temporary uploads)**: land in `sessions/<sid>/attachments/`, this session only; message side is a `FileBlock` pointer + a turn-side untrusted material block (body text). Optionally **promote to searchable** (register a `scopeRef: session` source) or **file under a project** (promote=move, not automatic promotion). API: `/api/v1/sessions/:id/attachments`; known boundaries in [`KNOWN-ISSUES.md`](./KNOWN-ISSUES.md).
- External sources may carry **`authRef`** (named credentials in the vault), **`network`** (`allowPrivateNetwork` / timeouts), **`discover`** (sitemap/crawl budgets). Failures/skips **do not delete** already-ingested chunks.
- Provenance: hits use the stable logical **`path`**; the full URL is stored as `external_url` on the file record.
- Host API goes through **KnowledgeClient** → Service; the Gateway process has **no** ingest write path.

### 8.1 Indexing job semantics (implementation conventions; pitfalls)

| Topic | Convention |
|------|------|
| **Phase A / B** | Parse + chunk + keywords **first**; embedding **must not** steal parse slots (do not claim embed work while parse has backlog) |
| **time-to-search** | Keyword search works as soon as parse finishes; vectors fill in the background (only `embeddable` counts toward vector progress) |
| **Code** | `adapter_id=code-tree` **does not embed** (use `file_search` / `file_read`); **`.html` belongs to `htmlAdapter`** (may embed) — do not declare it under code-tree |
| **Vector store** | `knowledge_chunk_embeddings.embedding` = **Float32 BLOB** + `bucket` (ANN-lite); `dimensions=0` = secret-skip tombstone (no retry) |
| **Vector retrieval** | Prefer sqlite-vec KNN; **gate on whether KNN returns results** (not a flag); no KNN and >50k vectors → **JS full scan forbidden** |
| **Keywords** | FTS5 inverted index (CJK bigram tokens) first, fall back to SQL LIKE; aligned with Memory tokenization |
| **embed egress** | Default `embedSecretPolicy=redact`; audit via `knowledge_embed_secret_log` |
| **Office / large files** | Document extraction goes through a **worker** (`createDocumentPortFromConfig`, same source as Gateway) + **cancellable** timeout + **streaming hash**; never block the event loop with sync xlsx / whole-file `readFile`; throttle with `documentParseConcurrency` |
| **File identity** | `identity_key` (inode/win fileId/url+authRef) + Membership; same file under multiple sources parses once; purge only at zero claims |
| **Service** | **Sole writer** of `knowledge.db`; Gateway uses the Client only; `writer.lock` (`wx`); default port 18280 |
| **Startup recovery** | `startIngestRuntime`: restore watch, catch up pending, start reconciler/poll |
| **watch** | Directory increments; missed events are covered by the reconciler’s **parse-gap scan** (on disk but not indexed, or `status='indexing'` half-written → parse) |
| **Enqueue increments** | Local discover carries `size`/`mtime`; if `status='indexed' && chunk_count>0 && content_hash` and the version is unchanged, **do not enqueue** `parse_file`; force redo via `reprocessFiles` (invalidates hash) |
| **Half-written** | `upsertFile` writes in batches; on failure/abort clear partial and stop at `indexing` (`chunk_count=0`, not searchable); **never** mark partial as `error` so it becomes searchable |
| **Deleted files** | watch → `drop_file` → `removePathTree` (sub-paths + FTS/vec); `(source_id,path)` must be indexed |
| **Watchdog** | `startReconciler`: reclaim orphan running jobs, backfill embed, backfill parse gaps (including indexing), clear `path:` zero-claim entries, clean terminal jobs, auto-describe after stability (**also triggers on pure-keyword deployments**) |
| **Abort** | **Survives restart**: `knowledge_source_control` is authoritative; claim skips aborted; resume revives only `aborted` cancellations; **shared File parse is not killed** |
| **poll vs reindex** | reindex=supersede; **poll=`incremental`**: skipped if anything active; `walk_source`=`fromQueue` does not invalidate the queue |
| **Modules** | `job-control` / `job-queue` / `embed-runner` / `fts` / `vector-ann` / `http-app` / `serve` / `client` are split out; `ingest.ts` orchestrates only |
| **Path ownership** | `sourceOwnsPath`: local sources only inside `location`; external sources accept only registered logical keys (enforced at `reprocess`/`parse`/`fetch`) |

---

## 9. Quality bar

1. The exogenous corpus is **source-traceable**; without a source it is not Knowledge.  
2. **The floor does not rely on conscience; depth relies on tools**; prefer less injection over noise.  
3. **The Index can be fully rebuilt**; the source is the sole authority.  
4. **Zero promotion at index time**; what is learned goes Memory → Cognition → Wisdom.  
5. **time-to-first-searchable ≪ time-to-fully-ready**: searchable first; vectors can follow.

---

## Related

| Document | Content |
|------|------|
| [docs/memory.md](./memory.md) | Memory (layer 6): propositions and distillation |
| [docs/context-layer-contracts.md](./context-layer-contracts.md) | system contract layers and assembly |
| [docs/architecture.md](./architecture.md) | Eight-layer overview and directory |
| Internal design specs (not public) | Knowledge Service HTTP contract, knowledge-layer ontology/pipeline, external ingest |
| `harness/capabilities/document/` | Document extraction Port (`createDocumentPortFromConfig` + `documents.*`) |
