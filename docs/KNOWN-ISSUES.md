# Known Issues

> **Language note**: This English edition is the **working authority**. The Chinese translation is [`KNOWN-ISSUES.zh.md`](./KNOWN-ISSUES.zh.md). Keep both in sync.
> Last updated: 2026-11-01 (cleaned resolved entries — this file keeps only **open items** and **existing boundaries**; resolved/closed issues live in `CHANGELOG` and the corresponding architecture docs)

## Session / ACL capability layer

**Runtime behavior notes (v0.42.0+ / v0.43.0):**

- Gateway injects `SessionAclService` + a **process-shared** `SessionLease` into all Runners **by default** (**not** an opt-in compatibility change).
- `handle` calls `authorizeRun` before the run: primary becomes owner automatically; non-primary without a binding → `engine.error`; the effective intersection includes `agents[].maxSessionRights` (E6 L1).
- handoff: `primaryAgentId` migrates; the old primary’s `owner` **demotes to specialist**.
- `preferredOnly` (default true): `switch(mode=handoff)` requires `intent=admin_handoff`.
- `filterHistory` / `appendRunAudit` / business grants remain host-callable; guest/handoff can read the same Session via first-class sessionId storage.

**Still open:** distributed Session Lease implementation; role DB/console; Quota economic layer.

**Session ACL per-tool rights (SEC-2, v0.78.0):** `SessionRights.toolRights` (`allow` / `deny` / `denyCapabilities`) intersects `agents[].tools` and `toolSurface` (narrow-only; deny wins). Enforced at tool listing and `beforeToolCall`. `agents[].maxSessionRights.toolRights` is an L1 ceiling; grant rejects expansions. Factory roles ship unrestricted tool surface; use custom roles for guest/readonly.

**L4 process jail (v0.75.0–0.76.0):** capability contract, supervised spawn, bwrap/Seatbelt, and **shell wired through ProcessSandbox** (`docs/process-isolation.md`). Still open: bundled Windows Job Object / restricted-token helper. **Not planned**: container backend (decision 2026-11-01) — the opt-in slot is structurally kept but unscheduled (see `docs/process-isolation.md`). `untrusted` without L4 refuses or degrades via `untrustedAdmission`. Subsystems declaring `boundary.security: sandboxed` are refused at load without L4 (SEC-6 fail-closed, v0.90.9) — on hosts without a jail backend (e.g. Windows today), declare `trusted`/`privileged` explicitly; first-party built-ins do exactly that.

**EffectPolicy default (v0.75.0):** omitting `mode` now means `workspace` (secure-by-default). Scaffolds set `"mode": "host"` explicitly. Deployments that relied on implicit host must add `"effectPolicy": { "mode": "host" }`.

**HITL single model (SEC-7, v0.79.0):** the only confirm surfaces are `confirmHighRisk` and `confirmEffect`, both returning `HitlDecision` (`deny` / `approve` / `approve_session` / `approve_always`). The engine caches session/always approvals (`HitlDecisionCache`); hosts only express the decision. `approve_session` is keyed by `sessionId`; `approve_always` is keyed by `agentId` (agents with different trust levels do not share always-grants). Missing scope id degrades to one-shot. `ApprovalManager` / `ApprovalProvider` were removed. Gateway confirms go through `pendingApprovals` (Web `/approvals`); `askUser` is reserved for the `ask_user` tool. Unattended / no-hook / timeout stays fail-closed. The confirm intent carries `timeoutMs` (the engine's confirm window) so hosts can align approval-card lifecycles, and denials record their provenance (timeout / human reject / channel error / cancel) — only an actual reject claims a human rejection. Tool *output* high/critical still blocks with no confirm path. Cache key granularity: high_risk is keyed by tool name; effect confirms are keyed by effect kind **plus target** (path / command / operation / domain) since v0.94.2 — one `approve_session` covers one target, not the whole kind (the former deliberately-coarse effect key was reversed on 2026-10-26).

Approval attribution: with `channels.http.apiKey` set, the web surface is credential-gated and `confirmedBy` records the key holder (credential-backed); without it the console is open to the LAN and the approver name is client-asserted (forgeable) — **LAN deployments should set `apiKey`**. Full multi-user auth is product-phase work.

**Ops privileged channel (ops P3/P4):** `priv_exec` (allowlist exact-match / `full` tier with `privilegedAck` + persistent `PRIVILEGED` badge + root/elevated declaration gate) and the dangerous-command speed bump. **Windows boundary:** before the win-job helper service lands (OP-ISO-1) there is **no physical isolation floor** on Windows — P3/P4 there is "elevated process + persistent badge + gates" and must not be described as a sandbox. `runas /savecred` and scheduled-task privilege bypasses are deliberately absent (unattended escalation must never depend on stored consent).

## Knowledge external-source outbound — known limits

**Status:** OP-14 mainline landed; the following are intentional boundaries

- **Connect-time re-validation, not IP pinning** (SEC-3, v0.77): `network-guard` re-validates addresses at connect `lookup` (Knowledge + `http_request`). True IP pinning / hostname allowlists need a custom `lookup`/`filterAddresses` injection or embedder dispatcher. Very high threat models should supply their own pinning.
- **`credential_bindings` are enforced when present** (SEC-3, v0.77): empty bindings resolve freely by default (compat); non-empty bindings require a matching `consumer_kind`+`consumer_id`. Set `credentials.requireBindings: true` (or run `effectPolicy.mode=untrusted`) to reject unbound credentials.
- **`http_request` has an SSRF gate** (SEC-3, v0.77): default rejects private/loopback/link-local/metadata; enable `security.network.allowPrivateNetwork` for intranet targets. Metadata/link-local (including IPv4-mapped and `fe80::/10`) stay blocked even then. Shell `curl`/`wget` still has no egress gate unless L4 jail `network: deny`.
- **OAuth**: `oauth2_client` is treated as bearer only when already exchanged for an access token.

## Session attachments (OP-15) — known limits

**Status:** main chain landed (v0.54.x); the spec is an internal document (including as-built and leftover list, not public)

- **Large-file local recall**: beyond `inject.fullTextMaxChars`, a local question injects up to `inject.recallTopK` keyword-matched passages with line locations; missing/stale indexes, no hits, or query failures fall back to the structure head (about `headChars`) plus `file_read`.
- **Document extract**: session attachments and Knowledge ingest share `harness/capabilities/document` (`documents.*`); when extract is disabled or no backend is available, content is only written to disk and not recalled.
- **Local recall is not Knowledge registration**: uploads build a session-private, rebuildable keyword projection, never a Knowledge source or embedding on the send path. `knowledge_search` / source management still require explicit “promote to searchable”; project persistence requires promote.
- **manifest has no cross-request lock**: concurrent uploads to the same session may overwrite each other’s registration (rare in single-user web).
- **Upload API is JSON+base64**: very large files should move to multipart later.
- **FileBlock becomes a text pointer via convertToLlm**: not a provider-native file attachment format.

## Knowledge index / vectors — open boundaries (2026-10 as-built)

**Status:** Phase A/B, watch, abort/resume (**across restarts**), supersede reindex, BLOB vectors, FTS5, no code embedding, embed secret policy, **Knowledge Service split (sole writer + File identity)** landed (see `docs/knowledge.md` §8.1).

**Fixed in v0.59.1–v0.60.0** (summary): auth gate, path ownership, cross-domain credentials, SSRF/body timeouts, `.html` ownership, parse cancelable timeout, vector gate looks at KNN results, forced hybrid, FTS5, abort persistence, poll does not supersede, embed hard timeout, ANN-lite buckets, ingest module split, prune/LIKE/FTS sweep; **ingest-on-register, Document worker routing, Document capability moved to `harness/capabilities/document` + single factory, shutdown SSE deadlock, worker error serialization, walk does not supersede**.

**Still open:**

- **Oversized Office tables**: worker + cancelable timeout; may still `parse_timeout` skip without infinite retry.
- **sqlite-vec is production-required — deployment note**: verify `stats.sqliteVec=1` right after startup; when not loaded, large stores (>50k vectors) **must not JS full-scan** — use neighbor buckets + forced keyword; million-scale deployments depend on sqlite-vec being loaded. HNSW optional backend is not scheduled yet.
- **File size after DROP**: SQLite does not shrink automatically; needs `VACUUM`.
- **watch may miss events**: reconcile parse-gap scan (~60s) as backstop, non-zero delay.
- **`running` slot**: UI “tasks” = job count; embed parallelism is lanes within a job.
- **catalog topics sampling**: at most 128 paths per source.
- **embed secret skip tombstone**: `dimensions=0` does not auto re-embed; changing policy needs reprocess.
- **Connect-time re-validation only**: no true IP pinning; very high threat models need custom dispatcher / lookup injection.
- **`ingest.ts` size**: already split into job-control/queue/embed-runner/fts/vector-ann; watch/poll/parse still live in the main file.

## Config keys declared but not yet wired (2026-10)

**Status:** the schema accepts these keys but no consumer exists yet — configuring them has **no effect**. Tracked here so they are not mistaken for wired behavior. The top-level mapping guard (`tests/config-gateway-top-level-mapping.test.ts`) classifies **top-level** keys (its `CLASSIFICATION` table); sub-key gaps are tracked in the list below and enforced by `src/config-schema/unwired-keys.ts`. Since v0.98.8 `loadConfig` **warns at startup** when these keys are present — no effect, but no longer silent.

- **`compact`** (compact capability defaults: `defaultProtectHead` / `defaultProtectTail` / `defaultTargetTokens` / `defaultMode`): session compaction reads the `contextEngine` keys (`protectFirstN` / `protectLastN` / `targetTokens`) instead; the capability-level defaults currently have no consumer.

Not defects — host-consumed keys that intentionally bypass `GatewayConfig`: `channels`, `web`, `webSearch`, `summary`, `defaults` (consumed by `src/cli/daemon.ts` / `src/config.ts`).

### Sub-key gaps inside sections classified `mapped` (2026-10, review follow-up)

The top-level mapping guard checks section-level keys only; these **sub-keys** are accepted by the schema but have no consumer yet (configuring them has no effect):

- **`plugins.configs`** (per-plugin config): accepted by the schema and forwarded across the boundary, but nothing translates it into `PluginLoaderConfig.pluginEntries` yet — `PluginLoader` itself does read `pluginEntries` (`enabled` + `config` → `api.pluginConfig`); the missing link is the gateway wiring.
- **`models.mode` — key removed (v0.98.16)**: provider/model merging behavior is fixed; the key is no longer accepted (falls back to an unknown-key warning, moved to `_legacy` by `octopi doctor --fix`).
- **`session.reset` / `session.maintenance` — keys removed (v0.98.16)**: they never had consumers (removed from `GatewayConfig` as dead surface in v0.86.37) and the daily-reset / store-pruning feature was decided against. `SessionConfigSchema` is no longer `.passthrough()` — `session` accepts exactly `dmScope` / `idleExpiryMs`, so any other sub-key is now reported as an unknown key.
- **Wisdom/cognition steward tuning — keys removed (v0.98.11, BREAKING)**: the former unwired keys `wisdom.formation` / `wisdom.evaluation` / `wisdom.govern` / `wisdom.capacity.softCap` / `wisdom.injection.coreMaxTokens` and `cognition.conceptualize` / `cognition.plasticity` / `cognition.consolidation` / `cognition.retrieval` / `cognition.capacity.{warnNodes,warnEdges}` / `cognition.identity.candidateBandLo` / `cognition.relations.{requireCue,allowCooccurEscalation}` are **no longer accepted** by `octopi.json` (they never took effect there); steward tuning lives in each subsystem's `config.yaml` `metadata.config`. Consumed from `octopi.json`: `*.enabled`, `wisdom.capacity.hardCap`, `wisdom.injection.{coreMaxItems,scenarioMaxItems,trialMaxItems,trialVisible}` (core/scenario/trialVisible since v0.97.25; trialMaxItems since v0.98.5), `cognition.identity.{mergeThreshold,candidateBandHi}`, `cognition.relations.causesMinIndependentMemories`, `cognition.capacity.{stopNodes,stopEdges}` (granular consumption verified against `wire-agent-builder.ts`, 2026-11-01).
- **`gateway.debugRest` — key removed (v0.98.16)**: `gateway.port` / `gateway.host` are consumed since v0.98.8 (`src/cli/listen-config.ts`, shared by daemon / WebUI / TUI — precedence CLI `--port` > `gateway.*` > `channels[type=http]` > defaults). Semantics: any configured port source (`--port` / `gateway.port` / `channels[]`) enables the listener; `apiKey` / `path` / `corsOrigins` still come from `channels[type=http]` only; `gateway.host` only rebinds the address (it does not enable the listener by itself); a listener started without `apiKey` prints an unauthenticated-API warning. `debugRest` never had a consumer — the `/debug/*` routes are gated by `observer.webPanel` instead — so the key was dropped.
- **`documents.legacy.converter: 'remote'` (enum value — forward reservation)**: the `converter` key itself is wired (`createLegacyConverterFromConfig` honors `'none'` = off and `'soffice'`); the `'remote'` value (MinerU / WPS / cloud converters) is a forward reservation with no implementation — configuring it returns `null` (no legacy conversion) and extraction silently falls back to T0-only. Value-level gap: it cannot be expressed as a path rule in `unwired-keys.ts`, so it is tracked here only.
- **Config keys removed in the §1c closeout (v0.98.12, BREAKING)**: `contextEngine.enableLLMSummary`, `summary.cache.{backend,dir}`, `agents[].model.temperature` (+ `fallbackModels[].temperature`) — never had consumers; migrated per CHANGELOG v0.98.12 (LLM summary has automatic fallbacks; memory cache remains via `maxEntries`/`ttlMs`; sampling temperature lives at `models.providers[].models[].temperature`). They now warn as unknown keys at startup.
- **Knowledge Service tuning keys apply to `manageLocal` only** (`embed.*` / `load.*` / `index.*` / `keywordWeight` / `autoInject.{minScore,minCoverage}` / `hint.minScore` / `catalog.autoDescribe` / `promotion.*` / `service.connectTimeoutMs`): a remote (`baseUrl`) Service is configured by its own deployment — these keys are silently ignored in remote mode.
- **`documents.extract.backend: 't0-only'` is forward-looking**: the routing pin is wired (probe / hasBackendFor / extract share one tier decision), but every in-tree backend is tier `t0` today — `auto` and `t0-only` are observably identical until T1/T2 backends land.
- **LLM descriptions require `models.level`** (v0.98.13): `generatedDescription` is upgraded from heuristic to LLM only when `models.level.mini`/`standard` resolves a provider (shared background-task model selection); without it, descriptions stay heuristic by design (never the main model). Samples are secret-shape scanned inside the Service; a hit blocks egress (`blocked_secret`) and the sample never leaves the Service.

## Compact summary paths — known boundaries (2026-10, F8 review follow-up)

- **`context.compact.summarize_fallback` has no web-UI consumer yet.** The event lands in the run timeline (observer `TIMELINE_TYPES`), but `web/runtime/store.ts` / `web/conversation/adapter.ts` have no case for it, so the conversation inspector does not render cache-miss fallbacks.
