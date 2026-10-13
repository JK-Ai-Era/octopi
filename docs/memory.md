# Memory

> **Language note**: This English edition is the **working authority**. The Chinese translation is [`memory.zh.md`](./memory.zh.md). Keep both in sync.
> Layer 6 of the eight-layer context. Still improves future decisions and behavior after the conversation window (Information) is gone.  
> Aimed at integrators and product readers; implementation details live in source and internal specs.

---

## 1. Core Ideas

| Axiom | Meaning |
|------|------|
| **The unit is a proposition** | What is recorded is a checkable, actionable proposition — not a summary, counter, or activity log |
| **Better empty than noisy** | Zero entries is legal. Content with no evidence, no anchors, and no effect on future behavior must not enter the store |
| **Many writers, one admission gate** | Agent self-writes / subsystem backfill / admin API all pass the same gating and confidence rules |
| **Intent to the LLM, enforcement in code** | “Is this worth remembering?” and “which class is it?” are model judgments; shape, provenance, and safety are enforced by code |
| **Confidence is earned** | Tentative at write time, reinforced by retrieval and time; no manual “confirm” UI required |

Memory is **not** a conversation backup, not a task list, not an external document store. Those belong elsewhere (Session / Tasks / Knowledge).

---

## 2. Value Model: Three Proposition Classes

| type | Answers | Examples |
|------|------|------|
| **fact** | What is true now | Environment facts, settled technical choices, project conventions confirmed in session |
| **method** | How to handle similar problems more effectively | Situation → action → reason (reusable practice) |
| **norm** | How we should / should not act later | Behavior switches (“never commit octopi.json”) |

Do not store: open loops (in-progress tasks), external static material, persona/platform rules, secrets, statistical sentences (“there are 3 constraints”).

**Freshness**: every memory has **`recorded` (when it entered the store)**; time-sensitive facts may also carry **`as of` (when the proposition held)** — distinguishing “when we wrote it down” from “what was true then”. Both recall paths (MemoryLayer injection / `memory_search`) include these times for comparison with Runtime’s `Current datetime`.

---

## 3. Write Path

```text
                    ┌─ Agent salience → memory_store (primary channel)
User / session ────┼─ Steward.backfill (after convergence; can be disabled)
                    └─ Admin API / integrators
                              │
                              ▼
               Slots: type / proposition / evidence
                    / future_use / anchors / channel
                              │
                    confidence tentative + structural gates
                              │
                              ▼
                       MemoryStore (agent.db)
```

The **primary channel** is guided by the product constitution (system preamble): write only on salience hits (preferences / constraints / decisions / fail→fix / stable facts / explicit user request). Zero entries is normal.

**Backfill (`Steward.backfill`)** after session convergence (hard end / idle drift) extracts missed propositions from Session originals; disable with `memory.backfill.enabled: false` to save LLM cost.

**Gating (structural)** rejects: empty propositions, too short/too long, no evidence, fake evidence, statistical sentences, activity logs, no retrieval anchors, injection shapes, secrets, and similar. Rejections carry a reason code and are observable.

**Confidence (channel tentative)** sets `status` at write time:

| status | Meaning |
|--------|------|
| `shadow` | Searchable, **not injected** into system by default (hypothesis-level) |
| `active` | Recallable and injectable |
| `strengthened` | Reinforced by time/use; looser injection |

---

## 4. Read Path

| Path | Behavior |
|------|------|
| **MemoryLayer** | Recalls active/strengthened for the current task and splices them into the system prompt (each with `recorded` / `as of`); excludes shadow / deleted |
| **`memory_search`** | LLM-initiated retrieval; includes shadow (weak leads); excludes deleted; results carry `recordedAt` / `asOf` |
| **`memory_store`** | Write; optional `as_of` (when the proposition held) and `supersedes_id` to replace outdated conclusions (soft-deletes the old entry) |

Division of labor with **`session_search`**: Memory = distilled propositions; Session = originals and process.

**Relevance floor (better empty than noisy)**: the vector path filters by cosine similarity (default `minSimilarity=0.35`), ranked as `similarityWeight·sim + (1-w)·(importance×confidence×decay)`; the keyword path requires hit score ≥ `minKeywordScore` (default 3; CJK sliding-window bigrams get half weight). No hits returns empty; when embedding succeeds but fails the floor, keyword fallback is **not** used. Config under `memory.retrieval`.

**Recall query**: default = the latest user message; if that utterance is a pure acknowledgment (“continue”, “ok”), look back at most 2 earlier user intents and splice task-topic clues (open goals + current step). A standalone new question uses only that sentence, without task/context bleed.

---

## 5. Governance (`Steward.govern`)

On a schedule (default 1h) it “tidies the shelves” of the memory store and **does not create new propositions**:

1. **Continuous decay** — lower `decayFactor` on per-type idle curves (method goes stale faster; norm is more stable)
2. **Soft delete** — junk re-check, shadow expiry, long-unused, capacity overflow, near-duplicate merge (`winnerId` auditable)
3. **Protect list** — high-confidence user instructions, recently strengthened entries, high-scoring norms, safety/environment tags are not casually deleted
4. **Earning** — entries still retrieved get weak reinforcement; shadow entries retrieved multiple times can promote to active

Soft-delete only, recoverable, dry-runnable. Governance signals do not pollute the main session.

**Trigger times (backfill)**: immediately on hard session end (close / `/new`); idle drift (default 20min); coverage-gap scan as a backstop. Dedup via a coverage table avoids burning LLM cost twice.

---

## 6. Configuration

```json
{
  "memory": {
    "profile": "embedded_interactive",
    "backfill": {
      "enabled": true,
      "idleDelayMs": 1200000,
      "gapScanMs": 21600000,
      "minUserTurns": 2
    },
    "decay": {
      "typeParams": {
        "method": { "idleDays": 21, "factor": 0.93, "min": 0.1 }
      }
    },
    "health": {
      "intervalMs": 3600000,
      "shadowBacklogLimit": 50,
      "limits": { "fact": 200, "method": 100, "norm": 150 }
    },
    "confidence": { "injectMinScore": 0.55 },
    "retrieval": {
      "minSimilarity": 0.35,
      "similarityWeight": 0.65,
      "minKeywordScore": 3
    },
    "gates": { "maxLength": { "fact": 400, "method": 500, "norm": 300 } }
  }
}
```

| Key | Role |
|----|------|
| `profile` | Channel prior (`personal_assistant` / `embedded_interactive` / `embedded_headless`) |
| `backfill.enabled` | Auto-backfill switch (default on); does not affect govern |
| `decay.typeParams` | Decay idle / step / floor per fact/method/norm |
| `health.*` | Inventory levels / shadow backlog probe thresholds (governance dual pulse) |
| `confidence` / `gates` | Injection score floor, structural lengths |
| `retrieval.*` | Retrieval relevance floor and hybrid ranking (auto-injection better empty than noisy) |

---

## 7. Boundaries

| Not Memory | Belongs to |
|-------------|------|
| Conversation originals / process | Session (`session_search`) |
| In-progress tasks / open loops | Session Tasks |
| API docs, static material | Knowledge |
| Persona, tone, platform rules | Persona / Constitution |
| Second-pass distillation of thinking patterns | Wisdom / Cognition (internal formation spec, not public) |

Persistence is **per-agent** `agent.db` (built-in `node:sqlite`, Node ≥ 24). Memory shares the database with Cognition/Wisdom but uses different tables; **memory.steward writes Memory only**; Cognition is derived from propositions by `cognition.steward.conceptualize`.

---

## 8. Quality Bar

1. Prefer zero memories over one entry with no evidence, no anchors, and no effect on future behavior.  
2. The unit is a proposition, not a summary.  
3. Intent understanding does not go into regex; structural enforcement does not guess semantics.  
4. All writers share one gate; governance is auditable, soft-deletable, recoverable.

---

## Related

- Knowledge (exogenous corpus): [docs/knowledge.md](./knowledge.md)
- Layer contracts and system assembly: `docs/context-layer-contracts.md`
- Architecture overview: `docs/architecture.md`
- Implementation entry: `packages/engine/src/harness/memory/`
