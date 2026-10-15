# Process Isolation & `untrusted`

> Public contract for process-level sandboxing (L4 process tier) and the
> `untrusted` effect mode. Related: ToolEffectPolicy / invariant I5 in
> [`north-star.md`](./north-star.md) and run modes in [`architecture.md`](./architecture.md).

Octopi separates **containment** (what code may touch) from **recoverability**
(whether damage can be undone). This document describes the containment half for
**process execution** and how `untrusted` is admitted when a process jail is
missing.

---

## 1. What “process sandbox” means here

A process jail is a **capability profile**, not a single OS API. Every run reports
the isolation it actually enforced — never the name of a class.

| Capability | Meaning |
|------------|---------|
| `processTree` | `supervised` / `killable` / `contained` — can the tree be killed as a unit? |
| `filesystem` | `none` / `cwd-pin` / `write-jailed` / `write-jailed-best-effort` / `root-jailed` |
| `resources` | `none` / `best-effort` / `os-enforced` (time, output, memory) |
| `network` | `open` / `deny` / `allowlist` (**not** part of the L4 floor) |
| `privilege` | `same` / `dropped` |
| `envHygiene` | `inherit` / `scrubbed` |

**L4 process minimum** (must all hold to call a run “process-jailed”):

1. `processTree` is `killable` or `contained`
2. `filesystem` is `write-jailed`, `write-jailed-best-effort`, or `root-jailed`
3. `resources` is `best-effort` or `os-enforced`
4. `envHygiene` is `scrubbed`
5. `privilege` is `dropped`

Windows write confinement may be `write-jailed-best-effort` and still meet the
floor (Job Object + restricted token + directory ACLs). Linux/macOS prefer
stricter jails when available.

---

## 2. Backends and probing

At runtime Octopi probes the host and selects a backend. There is **no** silent
upgrade and **no** fake jail.

| Host condition | Backend | Typical profile |
|----------------|---------|-----------------|
| Linux + `bwrap` on PATH | `linux-bwrap` | root-jailed, contained, scrubbed env |
| Linux without `bwrap` | `supervised-spawn` | killable + cwd-pin + scrubbed env |
| macOS + `sandbox-exec` | `mac-seatbelt` | write-jailed (with Seatbelt profile) |
| macOS without Seatbelt | `supervised-spawn` | same as Linux fallback |
| Windows (no bundled Job helper) | `supervised-spawn` | tree kill via `taskkill /T`, scrubbed env |
| Unknown / embedded | `supervised-spawn` | same baseline |

`SandboxResult.isolation` always carries the profile used for that command.

**Env hygiene is deny-by-default** on every backend: only an allowlist of keys
(`PATH`, `HOME`, `TMP`, locale, shell/OS basics) is passed to the child. Host
secrets (`*_API_KEY`, `*_TOKEN`, …) are **not** inherited via `process.env`.

---

## 3. What `untrusted` promises

`untrusted` is a **product promise**, not a config knob:

> The host will review the work product of this code, but does **not** trust its
> intent or supply chain. The runtime guarantees it cannot reach beyond the
> declared world, cannot walk away with host secrets, and can be rolled back.

Three questions must all hold:

1. **Containment** — cannot mutate outside transaction roots (L2 + shell policy)
2. **Exfiltration** — cannot phone home or abuse host credentials (tool surface + env scrub)
3. **Recoverability** — effects can be undone (L3 turn undo + `onClose: discard`)

There is **no** “degraded untrusted” label. If process jail is missing, the
system either refuses or **renames** the effective mode and **reduces power**.

---

## 4. Admission: `refuse` vs `degrade`

```jsonc
{
  "effectPolicy": {
    "mode": "untrusted",
    "untrustedAdmission": "refuse"   // or "degrade"
  }
}
```

| Admission | When L4 process is missing |
|-----------|----------------------------|
| `refuse` (default) | Start/run **fails** with `untrusted_refused` (missing capabilities listed) |
| `degrade` | Allowed only as a **weaker** policy (below) |

### Degrade semantics (reduce power, not walls)

| Field | Value |
|-------|--------|
| `requestedMode` | `untrusted` (audit trail) |
| `mode` (effective) | `workspace` |
| `toolSurface` | `reduced` |
| `securityDegraded` | e.g. `["no_process_jail", …]` |
| UI / Observer | Show **effective** mode, never the requested name |

`toolSurface: reduced` keeps content tools under L2 and **strips**:

- `shell` / exec-class tools (also forced `shellEscape: deny`)
- `http_request` and web/fetch tools
- MCP / client tools / `send_file`

`onClose: discard` is kept as residue of untrusted intent.

---

## 5. Platform notes

| Platform | Notes |
|----------|-------|
| **Linux** | Strongest path: `bwrap` (user namespaces) for a real root jail. Without it, supervised spawn only. |
| **macOS** | Seatbelt via `sandbox-exec` when available; write jail outside the work root is denied in the profile. |
| **Windows** | No mount namespace in pure Node. Tree kill uses `taskkill /T`. Write jail is best-effort (ACLs). A native Job Object helper is a future enhancement. |
| **Embedded** | Probe result is authoritative. If there is no jail, use `refuse` for third-party code. |

---

## 6. Configuration reference

```jsonc
{
  "effectPolicy": {
    "mode": "untrusted",              // workspace | project | host | untrusted
    "untrustedAdmission": "refuse",   // refuse | degrade (untrusted only)
    "shellEscape": "deny",            // deny | confirm | allow
    "pathContainment": "strict",      // strict | soft | none
    "processLimits": true
  }
}
```

Related (still true):

- Dedicated file tools honor L2 `pathContainment` and transaction roots.
- Turn undo (L3) is independent of jail presence.
- `host` is **not** a sandbox: full shell, no path jail.

---

## 6a. Engine default vs scaffold

| Layer | Omitted `mode` behavior | Purpose |
|-------|-------------------------|---------|
| **Engine / library** | **`workspace`** (secure-by-default) | Embedders who forget to configure stay contained |
| **`octopi init` / `octopi.example.json`** | Explicit `"mode": "host"` | Evaluation and local automation get full capability out of the box |

`project` is a **coding** mode, not an isolation mode: file L2 is strict, but shell may touch paths outside roots until process jail is available.

Gateway `/health` and channel health expose `effectPolicy` (`configuredMode` / `effectiveMode` / `engineDefaultMode` / `warnings`). Web UI + `mode: host` logs a startup warning.

---

## 6b. Session temporary transaction roots

Hosts can **append** extra allow/transaction roots for **the current session only** (UI / REST). Semantics:

| Rule | Behavior |
|------|----------|
| Scope | One session; dropped when the session is deleted (metadata) |
| Mutability | **Append / remove one path**; does not replace agent `transactionRoots` |
| Privilege | **Cannot loosen** `pathContainment` / `shellEscape` / mode |
| Paths | Must be **absolute**; normalized; de-duplicated |

```http
GET    /api/v1/sessions/:id/effect-roots
POST   /api/v1/sessions/:id/effect-roots          { "path": "/data/scratch" }
DELETE /api/v1/sessions/:id/effect-roots?path=...
```

```json
{
  "temporaryRoots": ["/data/scratch"],
  "configuredRoots": ["/data/projects/repo"],
  "mode": "project"
}
```

`allowRoots` at run time = `agent.workspace` + `effectPolicy.transactionRoots` + `session.temporaryRoots`.

---

## 7. What we do not claim

- **Not** a container runtime; container isolation remains an opt-in slot.
- **Not** syscall filtering (seccomp) as a product floor.
- **Not** network isolation as part of L4 process minimum (`network: open` is common).
- **Not** that supervised spawn equals a process jail — it does not.
- **Not** that `untrusted` works on every host — it requires L4 or explicit degrade.

For third-party skills and marketplace plugins, prefer `untrustedAdmission: refuse`.
