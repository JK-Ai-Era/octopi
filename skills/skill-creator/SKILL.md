---
name: "skill-creator"
description: "Create, submit, and manage agent skills (SKILL.md bundles) following the open Agent Skills spec. Use when the user asks to create/generate a new skill, when a recurring task pattern is worth capturing as a skill, or when a skill needs to be submitted for review or revised after rejection. Do NOT use for merely loading or listing existing skills — that is native (skills index + file_read)."
metadata:
  command: "skill-creator"
---

# Skill Creator — Authoring & Submission Workflow

You can create skills yourself. Skills you author go through a **review gate**
before they become usable — this page teaches the full loop.

## The loop

```
1. draft   — write the skill bundle in your workspace:  scratch/<task>/<id>/
2. submit  — skill_submit(path)  → engine stages it, opens a review ticket
3. review  — human (or LLM, if policy allows) approves or rejects with findings
4. live    — on approval it is materialized and enabled; new skills reach this
             session via the snapshot skill-delta block, and the next session's
             stable index
```

### 1. Draft in the workspace

Create the bundle under your workspace (e.g. `scratch/<task>/<id>/`).
You cannot write to `~/.octopi/agents/<id>/skills/` directly — the engine
stages and installs approved skills for you. That is intentional.

### 2. Bundle layout

```
<id>/
├── SKILL.md          # required — frontmatter + Markdown instructions
├── scripts/          # optional — executable code (highest scrutiny in review)
├── references/       # optional — docs loaded on demand
└── assets/           # optional — templates, static resources
```

### 3. SKILL.md frontmatter — quick reference

```yaml
---
name: "<id>"            # required: lowercase letters/digits/hyphens,
                              # single hyphens only, <=64 chars,
                              # MUST equal the directory name
description: "What it does and WHEN to use it."   # required: <=1024 chars
allowed-tools: "file_read shell"   # optional: tools the skill may rely on
license: "MIT"                # optional
compatibility: "…; requires Node >= 24"           # optional, <=500 chars
metadata:                     # optional: free-form string map (extensions go here)
  key: value
---
```

Full field rules and legacy aliases: read
[references/spec-reference.md](references/spec-reference.md) (one `file_read`).

**Description quality decides discoverability** — it is the only thing shown in
the always-on skills index. State the trigger ("Use when…") explicitly; vague
descriptions make the skill dead weight.

Body guidance: instructions for the model, progressive-disclosure style. Keep
SKILL.md under ~500 lines; put long references in `references/` and load them
on demand.

### 4. Submit

```
skill_submit(path="scratch/<task>/<id>", summary="what this skill is for")
```

- The tool validates the bundle against the spec and **returns itemized errors
  on failure** — those errors are the authoritative spec. Fix what they say and
  resubmit; this document is only a mental model.
- On success you get a `submissionId`. Check progress anytime with
  `skill_status(submissionId=…)` — including **findings** when rejected.

### 5. Review contract

- The audited object is the **staged copy**, bound to a content hash. After you
  submit, do not edit the draft expecting the ticket to follow — if content
  drifts, the ticket is void and you must resubmit.
- **Rejected** → read `findings` from `skill_status`, fix the draft, resubmit.
  Do not argue in place; iterate.
- **Approved** → the skill is installed and enabled. It becomes visible to you
  in this session through the snapshot skill-delta block (mid-session), and in
  the stable index from the next session.
- A skill already approved+enabled cannot be knocked offline by resubmitting the
  same id — disable it first (owner action) before replacing.

## When to propose creating a skill

- The user explicitly asks for one.
- You have done the same kind of task ≥2 times and the procedure is stable.
- A capability gap keeps recurring and the workaround is worth capturing.

Before drafting: check the existing skills index first — do not recreate what
already exists; extend or revise instead (resubmission of an improved version is
the upgrade path).
