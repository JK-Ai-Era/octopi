# Known Issues

**Language note:** Chinese translation lives in [`KNOWN-ISSUES.zh.md`](./KNOWN-ISSUES.zh.md).

> Last updated: 2026-11-18. This file lists only **confirmed known problems and traps that users / integrating developers can actually hit**. How things work belongs in `docs/`; what changed lives in `CHANGELOG`.

## Session / ACL

- **No physical isolation floor on Windows**: write confinement is best-effort (ACLs) and there is no Job Object / restricted-token helper yet — do not treat `untrusted` / jail settings as a sandbox there.
- **Tool output rated high/critical is blocked with no confirm path**: the output scan has no pre-confirmation semantics — a run can be stopped by its tool output even after the call itself was approved.
- **No distributed Session Lease**: never point multiple gateway processes at one `OCTOPI_HOME` — the in-process lock is not a cross-process guard.

## Knowledge external-source outbound

- **Source URLs with embedded credentials are capability-bearing**: treat skill-level `sources[]` as untrusted input.
- **`credential_bindings` is allow-by-default when empty** (compatibility): set `credentials.requireBindings: true` (or run `effectPolicy.mode=untrusted`) for fail-closed credential gating.
- **No true IP pinning**: network-guard re-validates addresses at connect/lookup only; extreme threat models need custom pinning (inject `lookup` / `filterAddresses`).
- **Outbound SSRF protection covers `http_request` / Knowledge only**: shell `curl` / `wget` have no outbound gate unless the L4 jail sets `network: deny`.
- **No built-in OAuth flow or refresh**: an `oauth2_client` credential is sent as bearer only when already exchanged to an access token — you own token renewal; expiry surfaces as a 401 on the next call.

## Knowledge index / vectors

- **Huge Office tables can be skipped**: extraction has a cancelable timeout — oversized sheets may land as `parse_timeout` skips (by design, no infinite retries).
- **file-watch can miss events**: a reconcile scan (~60s) backfills gaps — new files can lag up to a minute.
- **Secret-skipped embeds leave tombstones**: `dimensions=0` chunks are never re-embedded automatically — `octopi doctor` reports them (KN009); run reprocess on affected sources after fixing embed credentials/policy.
