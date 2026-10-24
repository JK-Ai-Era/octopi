# Known Issues

> **Language note**: This English edition is the **working authority**. The Chinese translation is [`KNOWN-ISSUES.zh.md`](./KNOWN-ISSUES.zh.md). Keep both in sync.
> Last updated: 2026-10-16 (cleaned resolved entries — this file keeps only **open items** and **existing boundaries**; resolved/closed issues live in `CHANGELOG` and the corresponding architecture docs)

## Session / ACL capability layer

**Runtime behavior notes (v0.42.0+ / v0.43.0):**

- Gateway injects `SessionAclService` + a **process-shared** `SessionLease` into all Runners **by default** (**not** an opt-in compatibility change).
- `handle` calls `authorizeRun` before the run: primary becomes owner automatically; non-primary without a binding → `engine.error`; the effective intersection includes `agents[].maxSessionRights` (E6 L1).
- handoff: `primaryAgentId` migrates; the old primary’s `owner` **demotes to specialist**.
- `preferredOnly` (default true): `switch(mode=handoff)` requires `intent=admin_handoff`.
- `filterHistory` / `appendRunAudit` / business grants remain host-callable; guest/handoff can read the same Session via first-class sessionId storage.

**Still open:** distributed Session Lease implementation; role DB/console; Quota economic layer.

**Session ACL per-tool rights (SEC-2, v0.78.0):** `SessionRights.toolRights` (`allow` / `deny` / `denyCapabilities`) intersects `agents[].tools` and `toolSurface` (narrow-only; deny wins). Enforced at tool listing and `beforeToolCall`. `agents[].maxSessionRights.toolRights` is an L1 ceiling; grant rejects expansions. Factory roles ship unrestricted tool surface; use custom roles for guest/readonly.

**L4 process jail (v0.75.0–0.76.0):** capability contract, supervised spawn, bwrap/Seatbelt, and **shell wired through ProcessSandbox** (`docs/process-isolation.md`). Still open: bundled Windows Job Object / restricted-token helper; container backend. `untrusted` without L4 refuses or degrades via `untrustedAdmission`. Subsystems declaring `boundary.security: sandboxed` are refused at load without L4 (SEC-6 fail-closed, v0.90.9) — on hosts without a jail backend (e.g. Windows today), declare `trusted`/`privileged` explicitly; first-party built-ins do exactly that.

**EffectPolicy default (v0.75.0):** omitting `mode` now means `workspace` (secure-by-default). Scaffolds set `"mode": "host"` explicitly. Deployments that relied on implicit host must add `"effectPolicy": { "mode": "host" }`.

**HITL single model (SEC-7, v0.79.0):** the only confirm surfaces are `confirmHighRisk` and `confirmEffect`, both returning `HitlDecision` (`deny` / `approve` / `approve_session` / `approve_always`). The engine caches session/always approvals (`HitlDecisionCache`); hosts only express the decision. `approve_session` is keyed by `sessionId`; `approve_always` is keyed by `agentId` (agents with different trust levels do not share always-grants). Missing scope id degrades to one-shot. `ApprovalManager` / `ApprovalProvider` were removed. Gateway confirms go through `pendingApprovals` (Web `/approvals`); `askUser` is reserved for the `ask_user` tool. Unattended / no-hook / timeout stays fail-closed. Tool *output* high/critical still blocks with no confirm path. Cache key granularity is tool name / effect kind (not per-argument) by design.

## Knowledge external-source outbound — known limits

**Status:** OP-14 mainline landed; the following are intentional boundaries

- **Connect-time re-validation, not IP pinning** (SEC-3, v0.77): `network-guard` re-validates addresses at connect `lookup` (Knowledge + `http_request`). True IP pinning / hostname allowlists need a custom `lookup`/`filterAddresses` injection or embedder dispatcher. Very high threat models should supply their own pinning.
- **`credential_bindings` are enforced when present** (SEC-3, v0.77): empty bindings resolve freely by default (compat); non-empty bindings require a matching `consumer_kind`+`consumer_id`. Set `credentials.requireBindings: true` (or run `effectPolicy.mode=untrusted`) to reject unbound credentials.
- **`http_request` has an SSRF gate** (SEC-3, v0.77): default rejects private/loopback/link-local/metadata; enable `security.network.allowPrivateNetwork` for intranet targets. Metadata/link-local (including IPv4-mapped and `fe80::/10`) stay blocked even then. Shell `curl`/`wget` still has no egress gate unless L4 jail `network: deny`.
- **OAuth**: `oauth2_client` is treated as bearer only when already exchanged for an access token.

## Session attachments (OP-15) — known limits

**Status:** main chain landed (v0.54.x); the spec is an internal document (including as-built and leftover list, not public)

- **Large files are not fully injected by default**: beyond `inject.fullTextMaxChars` only the head (about `headChars`) is injected; the model may `file_read` again — layered policy, not a defect.
- **Document extract**: session attachments and Knowledge ingest share `harness/capabilities/document` (`documents.*`); when extract is disabled or no backend is available, content is only written to disk and not recalled.
- **No Knowledge source by default**: retrieval needs an explicit “promote to searchable” or promote step.
- **manifest has no cross-request lock**: concurrent uploads to the same session may overwrite each other’s registration (rare in single-user web).
- **Upload API is JSON+base64**: very large files should move to multipart later.
- **FileBlock becomes a text pointer via convertToLlm**: not a provider-native file attachment format.

## Knowledge index / vectors — open boundaries (2026-10 as-built)

**Status:** Phase A/B, watch, abort/resume (**across restarts**), supersede reindex, BLOB vectors, FTS5, no code embedding, embed secret policy, **Knowledge Service split (sole writer + File identity)** landed (see `docs/knowledge.md` §8.1).

**Fixed in v0.59.1–v0.60.0** (summary): auth gate, path ownership, cross-domain credentials, SSRF/body timeouts, `.html` ownership, parse cancelable timeout, vector gate looks at KNN results, forced hybrid, FTS5, abort persistence, poll does not supersede, embed hard timeout, ANN-lite buckets, ingest module split, prune/LIKE/FTS sweep; **ingest-on-register, Document worker routing, Document capability moved to `harness/capabilities/document` + single factory, shutdown SSE deadlock, worker error serialization, walk does not supersede**.

**Still open:**

- **Oversized Office tables**: worker + cancelable timeout; may still `parse_timeout` skip without infinite retry.
- **sqlite-vec is production-required**: when not loaded, large stores (>50k vectors) **must not JS full-scan**; use neighbor buckets + forced keyword; million-scale requires `stats.sqliteVec=1`. HNSW optional backend is not scheduled yet.
- **File size after DROP**: SQLite does not shrink automatically; needs `VACUUM`.
- **watch may miss events**: reconcile parse-gap scan (~60s) as backstop, non-zero delay.
- **`running` slot**: UI “tasks” = job count; embed parallelism is lanes within a job.
- **catalog topics sampling**: at most 128 paths per source.
- **embed secret skip tombstone**: `dimensions=0` does not auto re-embed; changing policy needs reprocess.
- **Connect-time re-validation only**: no true IP pinning; very high threat models need custom dispatcher / lookup injection.
- **`ingest.ts` size**: already split into job-control/queue/embed-runner/fts/vector-ann; watch/poll/parse still live in the main file.

## Config keys declared but not yet wired (2026-10)

**Status:** the schema accepts these keys but no consumer exists yet — configuring them has **no effect**. Tracked here so they are not mistaken for wired behavior. The top-level mapping guard (`tests/config-gateway-top-level-mapping.test.ts`) classifies them as `ignored`; re-classify them as `mapped` when implementing.

- **`compact`** (compact capability defaults: `defaultProtectHead` / `defaultProtectTail` / `defaultTargetTokens` / `defaultMode`): session compaction reads the `contextEngine` keys (`protectFirstN` / `protectLastN` / `targetTokens`) instead; the capability-level defaults currently have no consumer.
- **`session.reset` / `session.maintenance`** (daily/idle reset and store-pruning knobs): `session` is a passthrough schema block, but neither the engine nor the gateway consumes these fields (they were removed from the `GatewayConfig` type as dead surface in v0.86.37).

Not defects — host-consumed keys that intentionally bypass `GatewayConfig`: `channels`, `web`, `webSearch`, `summary`, `defaults` (consumed by `src/cli/daemon.ts` / `src/config.ts`).

### Sub-key gaps inside sections classified `mapped` (2026-10, review follow-up)

The top-level mapping guard checks section-level keys only; these **sub-keys** are accepted by the schema but have no consumer yet (configuring them has no effect):

- **`plugins.configs`** (per-plugin config): passed through the boundary, but `PluginLoader` does not read it yet.
- **`models.mode`** (`merge` / `replace`): no consumer; provider/model merging behavior is fixed.
- **`session` passthrough extras** (`reset` / `maintenance` and any typo keys): `SessionConfigSchema` is `.passthrough()`; only `dmScope` / `idleExpiryMs` are consumed.
- **`wisdom.formation` / `wisdom.evaluation` / `wisdom.injection` / `wisdom.govern` / `wisdom.capacity.softCap`** and **`cognition.capacity` / `cognition.retrieval` / `cognition.consolidation`**: steward tuning currently lives in each subsystem's `config.yaml` `metadata.config`; only `*.enabled`, `wisdom.capacity.hardCap` and `cognition.identity.*` / `cognition.relations.*` are consumed from `octopi.json`.
- **`gateway`** (top-level: `port` / `host` / `debugRest`): planned Gateway override section (`arch/npm-package-split.md`); the daemon currently reads `args.port` / `channels[]` / `web` instead, so configuring it has no effect (the mapping guard classifies it `ignored`).
