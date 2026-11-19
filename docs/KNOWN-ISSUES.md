# Known Issues

**Language note:** Chinese translation lives in [`KNOWN-ISSUES.zh.md`](./KNOWN-ISSUES.zh.md).

> Last updated: 2026-11-19. This file lists only **confirmed known problems and traps that users / integrating developers can actually hit**. How things work belongs in `docs/`; what changed lives in `CHANGELOG`.

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

## Browser tools

- **No network-layer egress limit for the browser**: `browser.network` gates every request (redirects included) at the interception layer, but the browser process itself is an open network channel (proxy / whitelist egress is future work).
- **Browser DNS is not re-validated at connect**: `assertUrlAllowed` checks resolve-time addresses only — no DNS-rebinding TOCTOU closure inside the browser engine (same caveat as network-guard).
- **Page-script writes are audited but not gated**: the submit-confirmation gate covers document-level submissions (forms/uploads, incl. Enter-key and JS-triggered submits); `fetch`/`XHR` writes from page scripts only land in the audit ledger (tightening is P2).
- **Popups are closed on sight (single-page P1 contract)**: `target="_blank"` / `window.open` windows are not covered by the session's request policy (CDP interception is per-page); they are closed + recorded, but the popup's very first request can race the close (full target-birth interception is P2).
- **Screenshots land as files, not inline images**: tool results are text-only at the LLM boundary — `browser_screenshot` returns a file path; the model cannot "see" the image.
