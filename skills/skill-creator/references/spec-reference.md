# Skill Spec Reference (Agent Skills, aligned to agentskills.io)

The validator (`skill_submit`) is the authority. This reference explains the
fields it checks. Multi-line YAML block scalars (`>` / `|`) are **not supported**
— write single-line values.

## Required frontmatter fields

| Field | Rule | On failure |
|---|---|---|
| `name` | 1–64 chars; lowercase `a-z`, digits, single hyphens; no leading/trailing/double hyphens; **must equal the directory name** | error |
| `description` | 1–1024 chars, single line; "what + when" | error |

## Optional fields

| Field | Type | Notes |
|---|---|---|
| `allowed-tools` | space-separated tool names | Tools the skill's instructions rely on. Legacy alias: `tools` (comma-separated) is still accepted |
| `license` | string | SPDX id or name |
| `compatibility` | string, ≤500 chars | Environment/version constraints |
| `metadata` | string map (one nesting level) | Extension point. Recognized keys: `metadata.command` — registers a slash command (`/name`) that loads this skill; value normalized (leading `/` stripped, lowercased); invalid values are **dropped silently** — the installed skill simply has no command |
| `command` | `^[a-z][a-z0-9_-]*$` | Legacy top-level alias of `metadata.command` (same semantics); new skills should prefer `metadata.command` |
| `disable-model-invocation` | `"true"`/`"false"` | `true` = hidden from the model index (command/manual use only) |

Unknown top-level keys pass through unmodified (spec-compatible tolerance).

## Directory rules (validator)

- `SKILL.md` required; total bundle size has a hard cap (oversize = error).
- No symlinks anywhere in the bundle (path-escape defense, error).
- `SKILL.md` > 500 lines → warning (progressive disclosure: move long content to `references/`).
- Content warnings (`danger_*` codes: credential access, exfiltration, pipe-to-shell,
  destructive commands, dynamic eval) are **review hints**, not auto-reject — expect a
  reviewer to ask about them.

## Review & lifecycle semantics

```
submit → pending_review → approved  → enabled ⇄ disabled
                       ↘ rejected  (fix + resubmit)
```

- The audit binds to a **content hash** of the staged copy. Editing the draft
  after submit voids the ticket (`staging_changed_since_submit`) — resubmit.
- Skills dropped into a skills directory by hand (outside `skill_submit`) are
  trusted-by-placement: auto-enrolled as `dropped-in`, flagged `unreviewed`.
- A submitted+approved skill whose content changes on disk falls back to
  `pending` (the old review is void) until resubmitted and re-approved.
