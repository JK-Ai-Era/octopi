# Context Layer Contract Design

> Status: contracts landed (`packages/engine/src/harness/context/layer-types.ts` / `assembler.ts` / `layers.ts`)
> Scope: **contracts and the minimal assembly closed loop only**; business implementations of each layer are filled in one by one later.
> Date: contracts finalized in v0.26; kept current with implementation (reviewed 2026-10-12)

---

## 1. Division of labor: who owns system, who owns the window

| Component | Responsibility | Not responsible for |
|------|------|--------|
| **Constitution preamble** | Global run constitution (product/custom/off); fixed at the front of system, budget pre-charged | Layer content, retrieval |
| **ContextLayer** | How a single layer's content is produced (fetch + format + in-layer truncation) | Global budget, concatenation order |
| **DefaultContextAssembler** | Constitution preamble + multi-layer budget competition, include/drop, concatenate system prompt, produce manifest | Retrieval scoring, message compression |
| **ContextEngine** (existing) | Message window selection / routing / compression (Information layer) | What is inside the system prompt |

```
Constitution + Layer Providers ──► ContextAssembler ──► systemPrompt ──► ContextEngine.assemble ──► LLM
     │                                      │                      │
     └── retrieval/formatting           manifest              message-window compression
```

**Information (history messages) is not a ContextLayer**; it remains under `DefaultContextEngine`.

### Concept model vs contract layers (eight-layer terminology)

| Terminology | List | Meaning |
|------|------|------|
| **Product eight layers** (authoritative) | Wisdom → Persona → Skill → Knowledge → Cognition → Memory → **Runtime** → **Information** | Runtime = layer 7 (live Run, system); Information = layer 8 (session messages) |
| **ContextLayer contract (system)** | wisdom → persona → skill → knowledge → cognition → memory → **runtime** | **= product layers 1–7**; describes only system prompt fragments |

- **Identity**: product eight layers = system ContextLayer (7) + Information (message window, 1). Implementations need not add or remove ids.
- **Runtime**: product layer 7; absorbs `injectedContext` (session tasks / guidance), owned by **Run**, never enters the message window.
- **Information**: product layer 8; session / message history; **forbidden** from being stuffed into `DefaultContextAssembler` as a ContextLayer.
- Assembly invariant: the Assembler only produces systemPrompt + manifest; the message window always goes through ContextEngine.
- Ownership alignment with Session/Agent/Run is in the [architecture constitution](./north-star.md).

---

## 2. System layer identifiers and default parameters (product layers 1–7)

| id | order (position) | priority (retain order) | share | droppable | Current provider source |
|----|---------------|------------------|---------------|-----------|-------------------|
| wisdom | 10 | 70 | 0.12 | yes | `WisdomStore.selectForInjection` (core+scenario) |
| persona | 20 | **100** | 0.35 | **no** | `PersonaSource` / Runner resolve |
| skill | 30 | 60 | 0.15 | yes | `SkillManager.formatForPrompt()` |
| knowledge | 40 | 40 | 0.12 | yes | `KnowledgeCatalogProvider` (Tier 0 catalog) |
| cognition | 50 | 20 | 0.06 | yes | `ConceptGraphStore.spreadingActivate` |
| memory | 60 | 30 | 0.10 | yes | `MemoryStore.retrieve` |
| runtime | 70 | 80 | 0.10 | yes | session tasks + injectedContext |

Notes:

- **order ≠ priority**: order decides left-to-right position in the system prompt; priority decides who is retained first when the total budget is insufficient.
- **defaultShare**: historical reference values; they **no longer** drive Assembler quotas. For a per-layer limit, configure `contextAssembler.layerShares` (hard cap).
- **runtime** is product layer 7 (system side, owned by Run); it absorbs the Runner's existing `injectedContext` (session tasks / subsystem guidance), sits near the conversation side; it is **not** Information.
- **placement (E8)**: layers declare `placement: 'system' | 'snapshot'` (default `'system'`). Query-dependent picks (Memory / Cognition / Wisdom) and per-run dynamic injection (Runtime: datetime / tasks / guidance) are `'snapshot'`; stable fragments (Persona / Skill / Knowledge catalog / Runtime anchors: workspace / root instructions) stay `'system'`. `'snapshot'` layers assemble into the per-turn `<turn_context>` **inside that turn’s user message** (`<turn_start id>`), never into the system prompt (constitution E8: cache-stable prefix + full-replay history).

---

## 3. Contract essentials (`ContextLayer`)

```ts
interface ContextLayer {
  id: ContextLayerId;
  priority: number;      // budget competition; higher is retained first
  defaultShare: number;  // share normalized across enabled layers
  droppable: boolean;    // can the whole layer be dropped when over budget (persona=false)
  order: number;         // position in the system prompt
  placement?: 'system' | 'snapshot';  // E8: 'snapshot' → per-turn <turn_context> inside <turn_start> user message, never system prompt

  fingerprint?(ctx): Promise<string | null> | string | null;
  assemble(ctx: LayerAssembleContext): Promise<LayerContent | null>;
}
```

Design invariants:

1. A layer only produces its own fragment and **must not** rewrite other layers.
2. An `assemble` error **must not** take down overall assembly (the Assembler isolates it and records it in the manifest).
3. Returning `null` / empty text = this layer has no content (manifest marked `empty`).
4. A layer **must not assume** it will be included in the final system prompt.
5. Self-reported `tokens` are overwritten by the Assembler's unified `TokenEstimator`.
6. In the assembly product, each layer body is wrapped in **`<layer name="…">`** (display names match the product eight layers: Wisdom/Persona/…/Runtime) so the LLM can attribute ownership; a layer may still have its own inner heading.

---

## 4. Assembly algorithm (DefaultContextAssembler)

**Budget semantics:**

1. **By default only the total budget is controlled**: `systemBudget` (minus `structureReserve` → `contentBudget`)
2. Each layer `assemble`s its actual content; **no** global quota based on `defaultShare`
3. Consume the total budget from **highest priority down**; if it does not fit, droppable layers are truncated to the remainder or dropped
4. **Optional hard cap**: only if `layerShares[id]` is configured — `maxTokens = floor(contentBudget × share)`; overflow is first truncated to the hard cap, then competes for the total; unconfigured layers have no per-layer cap
5. Concatenate by `order` with `\n\n---\n\n`
6. Return `{ systemPrompt, manifest }`

**Hosted systemPrompt and session persistence:**

- Each turn Loop injects `context.systemPrompt` into messages as `role=system` + `metadata.source='systemPrompt'`
- **Session persistence keeps that message** (audit: "what was this turn's system" can be reconstructed afterwards)
- **Web chat history does not replay it**: `buildHistoryItems` skips `source==='systemPrompt'` and long persona systems with obvious signatures
- Runtime observability still goes through `context.layers.assembled` / the context panel; it does not depend on chat bubbles

**Observability channels:**

- The Assembler may write layer bodies into `manifest.layers[].content` (local cache / REST on selection)
- **WS broadcast of `context.layers.assembled` strips `content`** (preview is kept); when the UI selects a layer it fetches the full text via `GET /sessions/:id/context/layers`
- Gateway `lastContextLayers` FIFO cap is 256 sessions

---

## 5. Thin adapter layers (as-built)

| Class | What it does | Deliberately does not |
|----|--------|----------|
| `PersonaLayer` | Wraps the already-loaded persona text | File watching (still on PersonaSource) |
| `SkillLayer` | Wraps `formatForPrompt()` | Task-matched full-text loading |
| `RuntimeLayer` | Wraps per-turn dynamic injection | — |
| `KnowledgeLayer` | `KnowledgeCatalogProvider` → Tier 0 catalog formatting | Content retrieval / embedding (Knowledge service) |
| `MemoryLayer` | `retrieve({text, limit})` | Tuning decay policy (curve in `memory/decay-policy.ts`, executed by govern) |
| `CognitionLayer` | `spreadingActivate` + strong/weak edge formatting (strong edges `A —[rel]→ B` / weak edges collapsed as "related: …") | Co-occurrence promotion, fake-causal writes (cognition-gates) |
| `WisdomLayer` | Small core + keyword scenario match + maxim layout | embedding/llm matching (later) |
| `createDefaultLayers` | Registers only layers whose dependencies exist | Auto-discovery |

When upgrading any layer later: **replace only the `assemble` implementation or the class; do not change the contract.**

---

## 6. Relationship to the existing production path

**Already wired (P0):**

```
Runner.handle
  → persona resolve (PersonaSource hot reload, unchanged)
  → session compact seeding (E4 key = sessionId × agentId)
  → session tasks / guidance → injectedContext
  → createDefaultSystemPromptAssembler
       system contract layers: Persona + Skill + Knowledge + Memory + Cognition + Wisdom + Runtime
  → runContext.systemPrompt (written into RunScope; never written back to the shared Agent)
  → convertToLlm → DefaultContextEngine (**Information**: message window + proactive summary)
  → AssembleResult.compactState → Agent.setSessionCompactState(sessionId, agentId)
  → Runner writeSessionCompact before save → SessionData.contextCompacts[agentId]
```

- Builder `build()` mounts the Assembler by default; assembly failure falls back to the old string concatenation
- Without an explicit `.summarize()`, the Builder auto-mounts `createProviderSummarize` with the primary model
- `config-bridge` / capabilities resolution chain: **`models.level.summary`** → `contextEngine.summaryModel` → mini → standard → primary model
- Auto-summarize can be disabled with `.disableAutoSummarize()`
- **Skill**: `skillDirectory` or `home/skills` is discovered at build time; every turn injects `<available_skills>`
- **Memory recall**: `builder.memoryStore`; config-bridge and Gateway build a `SqliteMemoryStore` from `home/agent.db`. **Knowledge**: system only injects the catalog (`builder.knowledgeCatalog`); the catalog is **tagged** `id/name/type/status/scale/location` + `purpose`/`topics`; sources/indexes/exogenous ingest see `docs/knowledge.md`
- **MemoryStore single instance**: `AgentBuilder.build()` registers `memory_store`/`memory_search` from `builder.memoryStore` before `buildCore`; MemoryLayer recall and `memory.steward.*` writes share the same instance. Gateway **no longer** mounts global memory tools on a process-level `InMemoryMemoryStore`
- **Compact state persistence (E4)**: authoritative bucket `SessionData.contextCompacts[agentId]`; `contextCompact` is the primary/single-agent compatibility view. Jsonl `*.state.json` persistence. `Agent` in-memory bridge key = `(sessionId, agentId)`. **Different agents do not borrow each other's compact**. Manual compact: `SessionAwareRunner.compactSession` (**same session lock** as handle, queued; do not rely only on `status==='processing'`)
- **Shared capabilities Summary / Compact** (`harness/context/capabilities/`, cross-cutting; not counted in product-domain counts):
  - **SummaryPort**: LLM summarization + information extraction; Policy is data-driven; `ContentChannel` ⊥ `ContentKind` (**no** `tool_output` kind)
  - **Tool L1/L2**: decisions live on the tools side; L1 `maxReturnChars` hard cap always applies; L2 goes through SummaryPort; `summarize=off` still L1; `file_read`+code defaults to no L2
  - **CompactEngine**: callers may specify head/tail counts / target token / mode; `DefaultContextEngine.structuralCompact` **delegates** to this engine; **E4 state still lives only on the ContextEngine / Session path**
  - **structured_json**: L0 parse + L1 lightweight contract `fields`/`fieldTypes` (`structuredError`); full Schema is an optional port
  - Config: `summary` / `compact`; examples in `octopi.example.json`; internal design specs (not public)
  - **P2 subsystem wrapping deferred**: current consumers are tools L1/L2 and session compact; mount `subsystems/content-summary|compact` when bypass/event-batch needs appear
- **Cross-domain Document extraction** (`harness/capabilities/document`, not Context-specific): shared by session attachments / knowledge ingest / document tools; sole assembly `createDocumentPortFromConfig(documents.*)`. Context layers do not hold DocumentPort directly.

**Proactive summary (prevent long-session amnesia):**

- Path-A trigger keeps **both** lines and takes their `min` (do not drop either; intentionally not named "legacy"):
  - **target line** `targetTokens × compactFallbackRatio` (defaults `200000` / `3`) — decoupled from the window so long sessions still compact (a 1M window × ratio alone never fired)
  - **window ratio line** `messagesBudget × proactiveCompactRatio` (default `0.6`) — so small/known windows (256k etc.) still compact before hard overflow
- `targetTokens: 0` uses only the window ratio line. The trigger measures the **aged request payload** (a conservative upper bound of what is sent), so B2's steady state never trips it (double-mechanism guard, unit-locked). Re-compression additionally requires material token growth since the last compaction (occasional fallback, not periodic re-compression)
- `DefaultContextEngine.proactiveCompactRatio` (default `0.6`) scales the window ratio line. **`0` forbids starting new path-A compression (not only LLM) — it does not discard an existing sticky compact view** (`previousSummary` / `lastProactiveMessageCount` still rebuild `head + summary + post-cover increments + tail`). Mid-turn (tool activity after the last genuine user) never starts new LLM summaries either (方案 E); only mechanical grading (B2 aging / tool-ledger truncate) runs so active work records are not summarized away
- When the view exceeds the fallback line, compress the middle segment before hard overflow (turn boundary only for LLM; mid-turn is mechanical)
- When the increment is tiny (or `proactiveCompactRatio=0`), rebuild the sticky view with `previousSummary` + **messages after `lastProactiveMessageCount`** + head/tail instead of hitting the LLM — never expand back to full history
- `fallbackTruncate` / overflow degradation is **middle replacement**: archival notice + tool-call ledger (name+args) + recent tail — never “keep last 4 only”
- LLM summarize consumes **original** tool outputs (mechanical redaction of old results is discard-only, F-b); error fields are never redacted
- Config: `octopi.json` → `contextEngine.targetTokens` / `contextEngine.compactFallbackRatio` / `contextEngine.proactiveCompactRatio`

**Proactive LLM summary cooldown (`proactiveCooldownMs`, default 30s, `0` disables):**

- Inside the cooldown window, even if the increment reaches the re-summarize threshold, **prefer cached rebuild**, avoiding a double LLM hit from a single-turn proactive summary + hard-overflow summary
- **Known edge**: with `protectLastN = 20`, if new messages inside the cooldown window exceed `protectLastN`, those middle messages are covered by neither the old summary nor the current tail; they only enter the LLM view on the next assemble after the cooldown ends
  - Bursting 20+ messages within 30s is uncommon; automation/subsystems writing the session at high frequency can lower `proactiveCooldownMs` or set it to `0`
- Config: `octopi.json` → `contextEngine.proactiveCooldownMs`

**Compact observability events (UI anti-"fake stuck"):**

- `AssembleParams.emit` → Builder bridges to EventBus
- `context.compact.start` / `end` / `error` (`reason: proactive|overflow`, `cached` marks a cached rebuild)
- Failure does not abort the turn (falls back to truncation); UI can show "Compacting context…" after subscribing

**LLM message contract (P1 fix):**

- Hosted system (`metadata.source === 'systemPrompt'`) is skipped in `buildLlmMessages`, avoiding double injection with the `systemPrompt` parameter
- Compact summaries / truncation notes use **`role: 'user'`** + `metadata.source === 'contextSummary'`, producing no mid-conversation system
- **Turn envelope (E8 + full replay)**: each real user input is **write-once** formatted as
  `<turn_start id="tN" at="…"> <turn_context authority="ephemeral" …>…slots…</turn_context> <user_message>…</user_message> </turn_start>`.
  The turn closes with a trailing `<turn_end id="tN"/>` message (`metadata.source: 'turnEnd'`).
  Volatile slots (runtime snapshot / knowledge grounding / session attachments) live only inside `<turn_context>`.
  `buildLlmMessages` **replays the full history** (append-only): old turn contexts and turn_end markers stay in the request
  so the prefix cache holds. Stale retrieval picks are contained by turn scoping + “latest wins” semantics (and excluded
  from `previousSummary`), not by deleting them. Web chat replay shows only `<user_message>` and hides `turnEnd`.
- **View authority**: the runner’s `baseMsgs` view (detach slice of the session log, including baked `turn_start` user messages)
  must **unconditionally** replace `runContext.messages`. Do not strip historical turn slots — stripping is a mid-history
  rewrite and busts the provider prefix cache every user turn.
- **Compact notices never enter the system prompt**: `droppedSummary` / truncation notes are observability only
  (message-side `contextSummary` already tells the model). Dynamic text at the request head invalidates the entire cache.
- External system messages without metadata are kept as-is
- **History aging (B2, view-level)**: cross-turn tool results beyond the recent window degrade to structured pointers (tool name + args outline + result outline + archival note — **do not re-run**) inside `buildLlmMessages` only — the session log keeps the full output. Aging is **batch-frozen** (the boundary advances only in `freezeBatch` steps; no per-turn rewrite at the recency edge — a mid-history rewrite would burn the prefix cache) and **write-once** (pointer bytes are stable; the plan is computed over the full history, never re-derived from a trimmed view). The current run and the newest `rawWindow` results stay verbatim; **error results are never degraded** (error traceability first); a body is only degraded when the pointer is strictly smaller. Tool-call **arguments** of the same aged calls are degraded in lockstep (`ageToolArgs`, default on): key names are preserved and only payload-sized values collapse to `…[N chars]`. Arguments were the only unbounded component of the context — after a result became a pointer its arguments stayed verbatim (measured at 1.1× the pointer body, growing linearly with session length). `id`/`name` are untouched and `arguments` stays valid JSON, so the call/result pairing is unchanged. Config: `contextEngine.historyAging`
- **Engine hints are not user speech**: reliability injections (wrap-up / planning steer / noop-hint / truncate notice) are tagged `metadata.source: 'engineHint'` (in `ENGINE_CARRIER_SOURCES`). Turn-boundary detection (`isMidTurn`) and B2’s last-genuine-user scan ignore them — never treat `[System: …]` text as a new user turn

**Verifying prefix stability (`octopi llm-diff`):**

Provider prefix caches only match the **previous request's** byte prefix, so the assembled view (Observer `context.llm`)
cannot tell you *where* a break happened — it has no tools and no provider-side transforms. Set
`observability.llmRequestDump.enabled: true` and every LLM call writes its exact wire body to
`<OCTOPI_HOME>/logs/llm-requests/<sessionId>/<id>.json`, plus a lightweight `index.jsonl` (per-message hash + length,
`toolsHash`, usage, TTFT, outcome).

```sh
octopi llm-diff                      # most recently updated session, last 20 calls
octopi llm-diff <sessionId> --limit 0 --json
```

Adjacent calls are compared unit by unit and classified as `identical`, `append-only` (cache safe), `truncated` (tail
dropped) or `diverged` (mid-history rewrite). A divergence reports the first differing message index, its role, and the
character offset inside that message with prev/next snippets. `tools` changes are flagged separately because they
invalidate the cache too, without touching the message prefix.

When the divergence is caused by **history aging** (tool results rewritten as `[aged tool result · pointer]`), the report
adds the aging cost/benefit: how many tokens the batch removed from every future call versus how many had to be
recomputed once, and the resulting payback point in calls. `--cache-discount` (default `0.1`) sets the cache-hit price
ratio used for that estimate. Aging pays when the batch removed enough tokens to amortise the one-off recompute — small
batches can be net negative, which is exactly what the payback line surfaces.

The dump is **off by default** (volume ≈ request bytes × calls per turn); `maxCallsPerSession` (default 200) keeps a
per-session ring of the newest calls and compacts the index on eviction. Identity comes from the RunScope, so one
process-wide sink serves every session that shares a provider.

**Already wired (including P1/P2 layer extensions):**

- Builder can inject `wisdomStore` / `cognitionStore`; **`wireAgentBuilder` (shared by config-bridge / Gateway / createAgent)** mounts Memory/Wisdom/Cognition on the agent-home `AgentDatabase` and discovers `skills/` (sole discover entry); Gateway layers Knowledge catalog / tools on top
- Gateway sets `builder.agentHome(home)` + `builder.agentId(id)` for the agent; Memory SQLite (agent.db) hangs on the agent home; **no** extract-to-disk directory
- Default `createDefaultSystemPromptAssembler` registers Wisdom / Cognition layers when their dependencies exist
- `octopi.json` → `contextAssembler.includeLayerPreview` can write layer previews into the manifest (Web context panel)
- `GET /api/v1/agents/:id/context/health` exposes store counts (data-plane health)
- Knowledge no longer uses an in-process proposition store; catalog / indexes / grounding see `docs/knowledge.md`

---

## 7. Deliberately not done (long-term boundaries)

- No embedding retrieval / relevance re-ranking
- No change to `DefaultContextEngine` **message-window selection** itself (structural compact is already delegated to `capabilities/compact`; state key remains E4)

---

## 8. Related files

| File | Notes |
|------|------|
| `packages/engine/src/harness/context/layer-types.ts` | Contract + default order/priority/share |
| `packages/engine/src/harness/context/assembler.ts` | `DefaultContextAssembler` |
| `packages/engine/src/harness/context/layers.ts` | Thin adapter layers + `createDefaultLayers` |
| `packages/engine/src/harness/context/system-prompt-assembler.ts` | Per-turn system assembly port for the Runner |
| `packages/engine/src/harness/context/summarize.ts` | Summary provider selection (summary→mini→standard→primary) |
| `packages/engine/src/harness/context/capabilities/**` | Shared capabilities SummaryPort / CompactEngine |
| `tests/harness/context-layer-contracts.test.ts` | Contract behavior tests |
| `tests/harness/context-wiring-p0.test.ts` | Wiring regression |
