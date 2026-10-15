# Known Issues

> **Language note**: This English edition is the **working authority**. The Chinese translation is [`KNOWN-ISSUES.zh.md`](./KNOWN-ISSUES.zh.md). Keep both in sync.
> Last updated: 2026-10-14 (cleaned resolved entries — this file keeps only **open items** and **existing boundaries**; resolved/closed issues live in `CHANGELOG` and the corresponding architecture docs)

## Session / ACL capability layer

**Runtime behavior notes (v0.42.0+ / v0.43.0):**

- Gateway injects `SessionAclService` + a **process-shared** `SessionLease` into all Runners **by default** (**not** an opt-in compatibility change).
- `handle` calls `authorizeRun` before the run: primary becomes owner automatically; non-primary without a binding → `engine.error`; the effective intersection includes `agents[].maxSessionRights` (E6 L1).
- handoff: `primaryAgentId` migrates; the old primary’s `owner` **demotes to specialist**.
- `preferredOnly` (default true): `switch(mode=handoff)` requires `intent=admin_handoff`.
- `filterHistory` / `appendRunAudit` / business grants remain host-callable; guest/handoff can read the same Session via first-class sessionId storage.

**Still open:** distributed Session Lease implementation; session-ACL per-tool rights (ToolEffectPolicy modes / L2 containment / turn undo / host-gate / L1 limits landed in v0.73–v0.74; `SessionRights` still has no per-tool bits); role DB/console; Quota economic layer.

**L4 process jail (v0.75.0–0.76.0):** capability contract, supervised spawn, bwrap/Seatbelt, and **shell wired through ProcessSandbox** (`docs/process-isolation.md`). Still open: bundled Windows Job Object / restricted-token helper; container backend. `untrusted` without L4 refuses or degrades via `untrustedAdmission`.

**EffectPolicy default (v0.75.0):** omitting `mode` now means `workspace` (secure-by-default). Scaffolds set `"mode": "host"` explicitly. Deployments that relied on implicit host must add `"effectPolicy": { "mode": "host" }`.

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
