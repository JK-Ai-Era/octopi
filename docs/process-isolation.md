# Process Isolation & `untrusted`

> Public contract for process-level sandboxing (L4 process tier) and the
> `untrusted` effect mode. Related: ToolEffectPolicy / invariant I5 in
> [`north-star.md`](./north-star.md) and run modes in [`architecture.md`](./architecture.md).

Octopi separates **containment** (what code may touch) from **recoverability**
(whether damage can be undone). This document describes the containment half for
**process execution** and how `untrusted` is admitted when a process jail is
missing.

---

## 1. What "process sandbox" means here

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

**L4 process minimum** (must all hold to call a run "process-jailed"):

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
| Linux + `bwrap` on PATH | `linux-bwrap` | root-jailed, contained, network deny (default), scrubbed env |
| Linux without `bwrap` | `supervised-spawn` | killable + cwd-pin + scrubbed env |
| macOS + `sandbox-exec` | `mac-seatbelt` | write-jailed (profile generated at execute time) |
| macOS without Seatbelt | `supervised-spawn` | same as Linux fallback |
| Windows (no bundled Job helper) | `supervised-spawn` | tree kill via `taskkill /T`, scrubbed env |
| Unknown / embedded | `supervised-spawn` | same baseline |

`SandboxResult.isolation` always carries the profile used for that command.

The built-in `shell` tool **always** runs through `ProcessSandbox` (jail backend
when probed, supervised spawn otherwise). There is no second spawn path.

**Jail roots and network (D4).** `SandboxConfig.allowRoots` (falls back to cwd)
are bind-mounted / write-allowed inside the jail (`--bind-try`). Network posture
is `open | deny | allowlist`. **Mode defaults:** `host` / `project` → `open`;
`workspace` / `untrusted` → `deny` (reduced surface always `deny`).
`allowlist` is interface-only and enforced as `deny` with an honest note.

**macOS Seatbelt (D3).** At execute time Octopi generates a Seatbelt profile
covering `allowRoots` and the network posture, writes it to a temp file (`0600`),
and runs `sandbox-exec -f <profile> -- …`. `OCTOPI_SB_PROFILE` remains a host
override. `write-jailed` is only reported when a profile is actually applied. The profile
also keeps POSIX stdio sinks (`/dev/null`, `/dev/zero`, `/dev/tty`, `/dev/std*`,
`/dev/fd`) writable — git opens `/dev/null` O_RDWR and shells redirect to it;
a jail that blocks them breaks basic tooling. Jail roots are emitted in both
their lexical and canonical (`realpath`) form so subpath rules match through
symlink aliases (macOS `/var` → `/private/var`, `/tmp` → `/private/tmp`).

**Exec denials are attributed.** `Operation not permitted` from an `execve` has
two causes a caller cannot tell apart from inside the jail: Seatbelt refuses to
exec any **setuid** binary (an OS invariant — `ps` and `top` are setuid on macOS,
so process listing dies there, and no profile edit can allow it), and the
generated profile explicitly denies privileged helpers that are *not* setuid
(`chroot`, `dscl`). Octopi attributes the first attributable denial onto two
honest channels: a factual line in `isolation.notes` and one actionable entry in
`diagnostics.hints` (surfaced by the `shell` tool as `hints`). Write and network
denials print the same wording and are deliberately left unattributed —
blaming them on `exec` would misdirect the caller. Attribution also runs on the
supervised fallback (an enclosing jail refuses the exec but no profile of ours
is in force, so no deny-list claim is made).

**Working around a setuid denial.** The refusal is permanent, so the fix is to
avoid needing the privileged binary rather than to retry it. Where Octopi itself
read process state through `ps`, it now uses a non-setuid source: the CLI reads a
process's executable image from `lsof -a -d txt -Fn` (first `txt` entry) on macOS,
so `getProcessName` and `identifyPortOccupant` keep working inside the jail
instead of silently degrading to `null`. Other useful non-setuid readers:
`pgrep -fl`, `lsof`, `vm_stat`, and `libproc`'s `proc_pidinfo`/`proc_pidpath`.

**Jail setup failure (D7).** If a jail backend was selected but cannot be applied:
`requireJail` (effective `untrusted`, `jail: "require"`, or
`onJailUnavailable: "refuse"`) **throws** `jail_required_unavailable` instead of
running unsandboxed; other modes fall back to supervised spawn, report
`cwd-pin` + `jail_setup_failed`, and notify the run-level `securityDegraded` hook
with the normalized code `no_process_jail: …` (consumers can match one prefix for
both probe-time and runtime jail loss).
Backend selection is probe-aligned (bwrap smoke test / Seatbelt `sandbox_apply`
smoke test): when the jail cannot apply at all, the mode fork happens **before**
the command runs. Once a wrapper has run, a suspected wrapper setup failure
**never re-executes the user command** (no double side effects; a forged wrapper
error cannot buy an unsandboxed run): `requireJail` refuses, other modes report
the wrapper outcome with downgraded isolation (`cwd-pin`) and the run-level
`securityDegraded` note. Detection only accepts line-start wrapper signatures
(`bwrap:` / `sandbox-exec:` / `newuidmap:` / `newgidmap:`); bare
`operation not permitted` is never matched.

**Privilege (`dropped`)** means the jail **denies privilege-gaining operations**
(user namespace and/or Seatbelt `process-exec` denials for `sudo`/`su`/…).
It does **not** require a different uid. Notes record `userns` vs
`ops-denied; uid unchanged`.

The Seatbelt deny list is a **cross-platform superset**, not a survey of the
running host: every helper is listed under all its distribution spellings
(`/bin/su` *and* `/usr/bin/su`; `chroot` under `sbin` *and* `bin`), plus modern
escalators (`pkexec`, `doas`, `run0`, `sudoedit`). SBPL `literal` matching is
exact, so a missing spelling is an open door, while a dead entry costs nothing
(no error, no runtime overhead). Never trim the table by inspecting one machine.
The table is deliberately static rather than probed at start-up: a profile that
changes with the host makes the same config behave differently per machine, and
that debugging cost outweighs the noise of harmless entries.

**Jail write mounts (2).** `allowRoots` ∪ cwd ∪ `os.tmpdir()` are writable in
every mode; on POSIX the shared temp dirs `/tmp` and `/var/tmp` (each in their
lexical and canonical `realpath` form) are writable too — tools that hardcode
`/tmp` regardless of `TMPDIR` must keep working inside the jail. `$HOME` is
writable only for `project` / `host` (`SandboxConfig.homeWrite`). **tmp writes
are not journaled** (`notReversed`); shared temp is world-writable, so treat
anything left there as exposed. System trees remain read-only.

**untrusted egress** is always `deny` — `effectPolicy.network` cannot open it
(product promise, same class as `pathContainment`).


**Env hygiene is deny-by-default** on every backend: only keys the caller passes
are filtered against a small allowlist (`PATH`, `HOME`, `TMP`, locale, shell/OS
basics). Host `process.env` is never spread. The built-in `shell` tool currently
passes only `PATH`. Host secrets (`*_API_KEY`, `*_TOKEN`) must not ride along.

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

There is **no** "degraded untrusted" label. If process jail is missing, the
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

`toolSurface: reduced` keeps content tools under L2 and **strips by capability
tags** (`ToolDefinition.capabilities`), not by display name:

- `exec` (shell and any executor; also forced `shellEscape: deny`)
- `egress` (`http_request`, `web_search`, MCP/client channels, `package_install`)
- `send` / `dynamic-code`
- `runner` (`project_run` — executes workspace-defined scripts)

**Not stripped:** `vcs` (local git porcelain: `git_status`/`git_diff`/`git_log`/
`git_show`/`git_commit`/`git_branch`/`git_restore`). These tools spawn `git`
with a fixed argv allowlist — not a shell — so workspace and untrusted agents
can still review and commit without `shell`. Isolation measures: nonexistent
`core.hooksPath`, `--no-verify` on commit, command-line `-c` overrides for
`diff.external` / `gpg.program` / `core.sshCommand` / … (command line beats
local `.git/config`), and `GIT_CONFIG_NOSYSTEM` + `GIT_CONFIG_GLOBAL/SYSTEM`
pointed at `NUL`/`/dev/null`. Filter drivers (`filter.*`) discovered from config are pinned to `cat` before `git add`/`commit`, so a malicious `.gitattributes` cannot run clean/smudge/process.
`shellEscape` gates the shell tool only; it does not block `vcs`/`runner`
effect kinds.

Unknown or untagged tools are **rejected** on the reduced surface
(unknown-reject). Builtins are fully tagged.

`onClose: discard` is kept as residue of untrusted intent.

---

## 5. Platform notes

| Platform | Notes |
|----------|-------|
| **Linux** | Strongest path: `bwrap` (user namespaces) for a real root jail. Without it, supervised spawn only. |
| **macOS** | Seatbelt via `sandbox-exec` when available; a profile covering `allowRoots` is generated at execute time (host may override with `OCTOPI_SB_PROFILE`). |
| **Windows** | No mount namespace in pure Node. Tree kill uses `taskkill /T`. Write jail is best-effort (ACLs). A native Job Object helper is a future enhancement. |
| **Embedded** | Probe result is authoritative. If there is no jail, use `refuse` for third-party code. |

---

## 6. Configuration reference

```jsonc
{
  "effectPolicy": {
    "mode": "untrusted",              // workspace | project | host | untrusted
    "untrustedAdmission": "refuse",   // refuse | degrade (untrusted only)
    "jail": "auto",                   // auto | require | none (none needs privilegedAck)
    "onJailUnavailable": "degrade",   // refuse | degrade (jail != none)
    "privilegedAck": "…",             // explicit declaration (jail=none/full per block; elevated declaration: top-level only)
    "shellEscape": "deny",            // deny | confirm | allow
    "pathContainment": "strict",      // strict | soft | none
    "processLimits": true,
    "escalation": {                 // priv_exec channel (ops P3/P4); policy: none | allowlist | full
      "policy": "allowlist",
      "via": "sudo",                 // sudo (argv spells `sudo -n` explicitly) | direct (root/elevated)
      "allow": [
        { "cmd": "/usr/bin/sudo", "args": ["-n", "/usr/bin/systemctl", "restart", "nginx"], "confirm": true }
      ]
    },
    "dangerousCommands": {          // §6 speed bump (not a security boundary); security field: restart-only
      "policy": "confirm",          // confirm | deny | off (default confirm)
      "timeoutMs": 120000           // confirm timeout — timeout is always deny (outcome not configurable)
    },
    "opsAudit": "on",                 // ops audit journal (security field: restart-only); default on
    "opsAuditPath": "…/audit/ops.jsonl"   // default `<OCTOPI_HOME>/audit/ops.<agentId>.jsonl`
  }
}
```

**Jail intent (authorization ≠ degradation).** `jail` separates "chose to run
unjailed" from "lost the jail": `auto` applies the jail whenever a backend is
available and, when none exists, records run-level `no_process_jail` (never
silent) per `onJailUnavailable`; `require` / `onJailUnavailable: "refuse"` refuse
to run instead (`jail_required_unavailable`); `none` is an **authorized**
unjailed run — it requires `privilegedAck`, reports
`jail=disabled_by_config (privileged)` with an empty `securityDegraded`, and
stays refused on `untrusted`. Contradictory combinations are rejected at config
load: `jail: none` without `privilegedAck`, `jail: none` + `untrusted`,
`jail: none` + `onJailUnavailable: refuse` (a dead knob), `network: deny|
allowlist` + `jail: none` (network is enforced by the jail only — an unenforceable
promise is rejected; the resolved network posture collapses to `open`), and
(`jail: require` | `onJailUnavailable: refuse`) + `untrustedAdmission: degrade`
(same condition, opposite outcomes). Every run records `ops.jail.state`
(intent × probed backend × `authorized`) so authorized-unjailed and
failed-unjailed are distinguishable after the fact.

Known boundary: host-side **read** surfaces (WebUI git status snapshot) keep jail
wrapping whenever a backend is available, regardless of `jail` intent — stricter
than the run, intentional.

**Ops audit journal (prerequisite for privilege).** With `opsAudit: "on"` every
run appends to a tamper-evident JSONL journal (`<OCTOPI_HOME>/audit/ops.<agentId>.jsonl`
by default — one journal per agent so concurrent appends keep the chain strict;
an explicit `opsAuditPath` makes the journal shared at your own risk): `ops.jail.state`
(jail intent × probed backend), `ops.command.executed`
(unified action record: argv, cwd, exit code, duration, `escalated`, `confirmed`,
jail summary, origin), `ops.system_path.write` (writes outside the effect roots), `ops.policy.degraded`,
and `ops.config.security_changed`.
Entries form a hash chain (`verify()` detects edits, insertions, and mid-file
truncation; **tail truncation or whole-file deletion needs an external witness** —
that is the P5 export tier, per the honesty principle). On top of that, a
**security-config drift guard** fingerprints the security-relevant fields
(top-level `effectPolicy`/`security`, per-agent `effectPolicy`/`tools`, plugin
load paths) at startup and re-checks before each new run: if the config file's
security fields changed on disk (e.g. the agent editing its own config), the run
is **refused** with `security_config_drift`. Restarting the daemon adopts
whatever is on disk and re-anchors — treat the **human restart as the attestation
act**; automated attestation lands with the ConfigService write-back.

Known boundaries (honest scope, not oversell):

- Shell writes **outside** the effect roots are not enumerable from the shell
  journal (which only inventories roots). When shell runs unjailed
  (`jail: "none"`), its audit record carries `jail.unconfined: true` — read it
  as "writes were possible and are not itemized". File-tool writes outside the
  roots are recorded (`ops.system_path.write`) and stay undo-backed.
- Audit records contain the **full argv** (fidelity over redaction — a credential
  on a command line is visible in the audit; redaction is a P5 option).
- No rotation yet; the journal grows until P5 shipping/rotation.
- The journal is **single-writer** per file: the default is one file per agent;
  pointing several agents at one `opsAuditPath` needs external serialization.

**Privileged channel (`priv_exec`, P3).** Privilege escalation is a separate
tool, not a mode side effect: engine-side `execFile` of the **exact** argv
(absolute cmd + element-by-element args — no prefix/regex matching), no shell,
no jail, scrubbed env, **cwd pinned by the rule (default `/`, never the agent's
cwd)**, timeout + real tree-kill. `via: "sudo"` rules must spell the form
explicitly (`sudo -n <absolute target>`) and the guard checks **every effective
target** — the sudo binary *and* the real one after it. Relative-path arguments
in a rule resolve against the pinned cwd: prefer absolute paths in rule args. The shell tool keeps its jail — a
few allowlisted sudo commands never justify unleashing the whole shell channel.
Four gates, all fail-closed: exact-rule match (mismatches are refused **and**
audited as `ops.escalation.denied`), a HITL gate for `confirm: true` rules
(SEC-7 decision model, cache key includes the full argv so one approval covers
exactly one command), requester authorization via SEC-2 `toolRights.deny('priv_exec')`,
and audit (`ops.escalation.requested` / `ops.privileged.exec`). Startup probes
refuse to start when the declared escalation is not actually available
(`sudo -n true` / root-or-elevated assertion), and allow rules whose binary sits
in an agent-writable location or is writable by the agent uid are rejected
(replaceable-binary TOCTOU).

**Full tier (`policy: "full"`, P4) — full sudo on explicitly designated
machines.** The full tier runs **any** argv through the same privileged channel
(via `sudo -n <target…>` spelling is still mandatory under `via: "sudo"`; a bare
command would pretend to be privileged without being). It is admitted only under
`mode: "host"` + `jail: "none"` + `privilegedAck` — every other combination is a
config contradiction rejected at load time (`allowlist` stays contradiction-free
and keeps its jail). Root deployments get the same treatment from the other
side: an elevated process (root / Windows admin token, detected by behavior, not
by a config bit) must carry an explicit top-level `effectPolicy.privilegedAck` or
the daemon refuses to start. The declaration is deployment-scoped: agent
`effectPolicy` blocks do not carry it (their `privilegedAck` has a different job —
declaring that agent's own `jail: "none"` / `escalation.policy: "full"`). Either way the UI
and CLI show a **persistent `PRIVILEGED` badge**
(header badge + run observatory; `octopi serve status`) — the standing
counterpart of `privilegedAck`, not a one-time toast.

**Dangerous-command speed bump (not a security boundary).** Under `full`, argv
hitting a conservative table (`rm -rf`, `dd of=/dev/*`, `mkfs.*`, `iptables -F`,
`systemctl disable`, `chmod -R`, `chown -R`, `truncate`) passes a HITL gate per
`dangerousCommands.policy` (`confirm` default | `deny` | `off`); everything else
runs — no "unknown = dangerous". A confirm timeout is **always deny**. This
classifies *accidents*, not attacks: `sh -c 'rm -rf /'`, `python -c`, base64 and
redirects all bypass it by construction (pinned as tests). The real boundary is
the permission scope + the audit trail; the gate only slows down a misfire.

**Remote hardening (P5).** Four host-side facilities for unattended (T1)
deployments:

- **Async confirm, dual channel.** Pending confirms are delivered over the
  gateway channel (WS broadcast + `/approvals`) *and*, when
  `gateway.hitlWebhook` is configured, an HMAC-SHA256-signed webhook POST to the
  owner's endpoint. A decision carries **who approved and through which
  channel** (`approver` / `channel: gateway|webhook`) — recorded on the approval
  and in the ops audit (`confirmedBy` / `confirmChannel`). Confirm timeout is
  **always deny** (the outcome is not configurable).
- **Audit export (the only non-repudiable tier).** With
  `effectPolicy.opsAuditExportPath` every entry is forwarded append-only to a
  host-side file **outside the agent's writable surface**, wrapped in an envelope
  carrying `count` (= journal seq — gaps are detectable) and `tailHash` (chain
  anchor) plus the entry verbatim, so the host can replay `verifyOpsAuditChain`
  on its own copy. This is what covers tail truncation / whole-file deletion.
- **Kill switch.** `octopi ops kill <agentId>` writes a host-side sentinel
  (`<OCTOPI_HOME>/agents/<id>/KILL`); the engine refuses the run *and* every tool
  call while it exists — no LLM judgment, no agent cooperation, no self-release.
  `octopi ops revive <agentId>` resumes. `octopi ops status` shows the state.
- **Requester ≠ confirmer.** Who may *request* privilege is decided by SEC-2
  `toolRights` intersection (T1: only the owner role by default); a participant
  denied `priv_exec` is refused **before** the confirm gate with an audited
  `not_authorized` — the confirm gate only answers "this one time".

Windows boundary (honest): before the win-job helper service exists (OP-ISO-1),
P3/P4 on Windows is "elevated process + persistent `PRIVILEGED` badge + gates"
with **no physical isolation floor** — never describe it as a sandbox.

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

> **Config-level paths** (`agents[].workspace`, `agents[].home`,
> `agents[].skillDirectory`, `effectPolicy.transactionRoots`)
> differ slightly: they must be an **absolute path or `~`-prefixed** (`~/…`,
> `~\…`, or bare `~`; `~user/…` is not supported). `~` is expanded to the user
> home directory at the config/policy/tool-cwd/builder boundaries (trim →
> expand, idempotent). Relative paths are rejected at load: `home` decides where
> `persona/`, `skills/` and `agent.db` live, so resolving it against the process
> cwd would silently bind an agent's memory store to the launch directory.
> Session temporary roots above stay absolute-only.

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
