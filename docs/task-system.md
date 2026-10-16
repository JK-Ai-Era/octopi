# SessionTask

> **Status**: The single design baseline for session tasks. When implementation, naming, or tests conflict with this document, this document wins.
> Other modules that were once stuffed into `task-system` have been split back into their product domains (see [domains.md](./domains.md)).
> Last updated: 2026-06-12

---

## 1. Problem

Agents live inside the "current conversation". The user delegated work that takes multiple turns; one unrelated interjection mid-way and the Agent forgets what it was doing.

What is needed is not a new "task runtime", but:

> Maintain a list of **open work items (two levels: goal / step)** on the **Session aggregate**, expose goals to the primary LLM every turn (steps only as a rollup), and let the primary LLM open and close items through tools.

---

## 2. Conceptual placement

| Layer | Carrier | Meaning |
|----|------|------|
| Current conversation | `Session.messages` | Working memory (scratchpad) |
| **Open work items** | **`Session.tasks`** | **This design (SessionTask)** |
| Cross-session distillation | Memory subsystem | Long-term memory |

This is **not** a "working-memory domain" peer of Session, **not** an execution primitive (`AsyncTask`), **not** an orchestration instance, and **not** process supervision.

It is also **not** a scheduler: timers and delayed agent wakes live in [session-schedules.md](./session-schedules.md) (`timer_*` / `schedule_*`).

In one sentence: **the session task list hangs on Session; a goal is the user's delegation, and a step is an execution item under that delegation (depth = 1).**

---

## 3. Goals and non-goals

### Goals

| # | Goal |
|---|------|
| G1 | The primary LLM sees open tasks every turn |
| G2 | Users add/remove/edit tasks in natural language; the LLM applies the change via tools |
| G3 | State projects to the UI in real time (**read-only**) |
| G4 | Single write path; no fork from conversation context |
| G5 | Persisted and restored with the Session |
| G6 | Complex tasks can carry a **step list**; the UI can show progress; injection stays lean |

### Non-goals

- No UI-side direct PATCH of task state (see §7)
- No sidecar LLM classification/extraction of tasks per user message
- No shared state machine with Workflow/AsyncTask
- No cross-session task sync (belongs to Memory / the product layer; decided separately)
- No task trees with depth > 1
- Do not inject every step description into the system prompt by default

---

## 4. Write model (core decision)

```text
User speaks ──► Primary LLM (full context) ──► task_* tools ──► SessionTaskService
                                                      │
                                                      ├─► SessionStore
                                                      └─► EventBus session.task.*
                                                              │
                                                              ▼
                                                         UI read-only panel
```

| Path | Allowed | Notes |
|------|----------|------|
| Primary LLM calls `task_*` | **Sole business write** | Create/delete/edit, status transitions |
| System lifecycle hooks | Allowed (narrow) | e.g. batch-drop still-open tasks on session archive; no semantic parsing |
| User UI directly edits status/content | **Not allowed (v1)** | To change a task, talk to the Agent |
| Sidecar model edits tasks per message | **Not allowed (default)** | Avoids dual writes and silent failure |

**Why UI direct-write is cut:**

1. Task changes must carry conversational context; the LLM holds the full messages, the UI does not.
2. Multiple writers introduce complexity: "the panel says done while the reply still writes in-progress", mid-run revocation, idempotency protocols — while the benefit is mostly saving a few keystrokes.
3. The product form is conversation-first: the user says "mark code analysis as done" or "skip step 4"; consistency is guaranteed by "whoever sees the context makes the change".

If the UI wants shortcuts, they should **send natural language into the session** (quick-phrase buttons), not bypass the LLM and write the Store.

---

## 5. State machine and two-level structure

### 5.1 Two-level model

```text
Session.tasks
├── goal     parentId empty      user-level delegation (list main entry)
│    ├── step  parentId=goal     execution plan item
│    └── step
└── goal
```

| Convention | Notes |
|------|------|
| depth = 1 | No children under a step |
| Zero steps is legal | Simple tasks need no breakdown |
| Steps do not get their own domain | Same table, same Service, same events as goals |

### 5.2 State transitions

```text
        task_create
            │
            ▼
        ┌───────┐   task_complete    ┌───────┐
        │ open  │ ─────────────────► │ done  │
        └───┬───┘                    └───────┘
            │  ▲                         ▲
     task_pause │ task_resume             │
            ▼  │                          │
        ┌────────┐   task_complete        │
        │ paused │ ───────────────────────┘
        └───┬────┘
            │ task_drop
            ▼
        ┌─────────┐
        │ dropped │
        └─────────┘
```

| State | Meaning | Injected? |
|------|------|--------|
| `open` | Incomplete | goal: yes; step: not listed separately, rolled up |
| `paused` | Explicitly paused | goal: yes; step: may appear in the rollup |
| `done` | Completed | no |
| `dropped` | Abandoned | no |

**Additional goal / step rules**

- goal `complete` must be invoked **explicitly** by the Agent; it does **not** auto-complete when the last step becomes done (all steps done may still lack a conclusion/deliverable).
- On goal `drop`, the Service **cascades** drop to child steps still `open`/`paused`.
- By convention at most one step under a goal is the "current step" (the open step with the smallest `order`); the UI may highlight it. The Service does not hard-constrain the number of concurrent open steps (v1).
- Terminal states do not transition back; to redo, create a new task.

---

## 6. Data model

```ts
/** Session aggregate extension */
interface SessionData {
  // ...existing fields
  tasks: SessionTask[]; // default []
}

interface SessionTask {
  id: string;
  /** Empty/omitted → goal; set → step of that goal */
  parentId?: string;
  description: string;
  status: 'open' | 'paused' | 'done' | 'dropped';
  /** Short progress note maintained by the Agent; display only */
  progressNote?: string;
  /** Display order for steps; goals may ignore */
  order?: number;
  createdAt: number;
  updatedAt: number;
}
```

**Persistence**: saved with `SessionStore`.
**Forbidden**: a standalone `data/tasks/**/tasks.jsonl`; a second `loadSession` path.

Migration period: legacy JSONL may be imported once into `Session.tasks` (legacy entries treated as goals); afterwards only SessionStore is read.

---

## 7. UI pass-through (read-only, two levels)

The task list is structured Session state, **not** a checklist parsed out of assistant prose.

```text
[open] Analyze code quality and produce a report    ← goal
         ✓ 1. Scan module structure
         ✓ 2. Static analysis
         → 3. Check circular dependencies           ← current step
         · 4. Summarize risk items
         · 5. Generate report
```

| Channel | Purpose |
|------|------|
| `session.task.snapshot` | Full snapshot on session open (includes steps; UI builds the tree) |
| `session.task.updated` | Single change (goal or step) |
| `GET /sessions/:id/tasks` | Refresh / history |

Conventions:

- The panel treats **SessionTask in the Store as authoritative**; chat narration may stay colloquial for a while.
- Step-driven event refresh → the "live progress" feel of complex tasks comes from steps, not from flipping goal status.
- Change events are emitted **after** the Service has successfully written the Store.
- v1 **does not provide** a business `PATCH .../tasks/:id` API.
- Optional quick buttons: send a canned user message into the session; still goes through the primary LLM.

---

## 8. Per-turn data flow

```text
SessionAwareRunner.handle(userMessage)
  1. session.messages.push(user)
  2. Render injection (goal + step rollup only; see §9)
  3. Primary Agent loop
       · task_* tools maintain goal/step
       · tools → SessionTaskService → Store → emit
  4. Save Session (including tasks)
```

Injection happens **once at run start**; the list is not re-read within the turn. State changed by tools within the turn is naturally reflected in the **next** turn's injection. When the Agent needs full step detail it calls `task_list` (lands in the conversation tool results, not in system injection).

---

## 9. Injection text (goal + rollup)

**Do not list every step by default**; avoid flooding the system prompt with plan items.

```xml
<session_tasks>
Open tasks in the current session:

- [g1] open | Analyze code quality and produce a report
      Progress: step 2/5 (current: Check circular dependencies)
      Note: static analysis complete
- [g2] paused | Draft release notes

Notes:
- When the user asks to continue or the topic returns, resume the corresponding task or report progress first.
- When the current message is unrelated, handle the current message first; do not force continuation.
- When finishing or abandoning, call task_complete / task_drop to keep the list consistent with the conversation.
</session_tasks>
```

Render rules:

1. List only goals with empty `parentId` and status ∈ {open, paused}.
2. If there are child steps, append `Progress: done+dropped / total (current: description of the open step with the smallest order)`.
3. Step `progressNote` values are not injected (avoid bloat).

Principle: state facts and tool obligations only; do not mandate "you must continue".

---

## 10. Tools

| Tool | Params | Behavior |
|------|------|------|
| `task_list` | `status?`, `parent_id?` | List tasks; by default may include child summaries |
| `task_create` | `description`, `parent_id?` | No parent → goal; with parent → step |
| `task_plan` | `goal_id`, `steps: string[]` | Create an ordered step list in one call (recommended for complex tasks) |
| `task_complete` | `task_id`, `progress_note?` | → `done` (goal/step shared) |
| `task_pause` | `task_id`, `reason?` | → `paused` |
| `task_resume` | `task_id` | `paused` → `open` |
| `task_drop` | `task_id`, `reason?` | → `dropped`; goal cascades drop to unclosed steps |
| `task_note` | `task_id`, `progress_note` | Update progress only; does not change status |

Conventions:

- The factory injects **the single** `SessionTaskService` (based on the current `SessionData`).
- Errors must carry a message (e.g. `Task not found: ${id}`); bare `throw new Error()` is forbidden.
- Illegal transitions: return an explicit error; let the model correct.
- **Idempotent (recommended)**: `complete` on an already-`done` task, `drop` on an already-`dropped` task → successful no-op.

---

## 11. SessionTaskService

The sole write entry in Harness (shared by tools and system hooks):

```ts
interface SessionTaskService {
  list(sessionId: string, opts?: { parentId?: string; status?: SessionTask['status'] }): SessionTask[];
  listActiveGoals(sessionId: string): SessionTask[];
  create(sessionId: string, description: string, parentId?: string): Promise<SessionTask>;
  /** Create only when the goal exists and is not terminal; write order=0..n-1 in array order */
  plan(sessionId: string, goalId: string, steps: string[]): Promise<SessionTask[]>;
  complete(sessionId: string, taskId: string, progressNote?: string): Promise<SessionTask>;
  pause(sessionId: string, taskId: string, reason?: string): Promise<SessionTask>;
  resume(sessionId: string, taskId: string): Promise<SessionTask>;
  drop(sessionId: string, taskId: string, reason?: string): Promise<SessionTask>;
  note(sessionId: string, taskId: string, progressNote: string): Promise<SessionTask>;
}
```

Implementation notes:

- Read and write the current `SessionData.tasks`, persist through `SessionStore`.
- The state machine and goal cascade-drop live in the Service, not scattered across tool handlers.
- `parentId` must point to an existing goal, otherwise error.
- `emit` task events on success; do not emit on failure.

---

## 12. System prompt conventions (for the primary LLM)

```text
You can maintain the "session task list" with the task_* tools.

- goal: a user-level delegation. For work that takes multiple turns, call task_create first, then start working.
- step: execution plan items for complex tasks. Register with task_plan(goal_id, steps) or task_create(parent_id);
  after each step call task_complete(step_id); at the end explicitly task_complete(goal_id).
- User clearly gives up: task_drop; shelve for now: task_pause; continue: task_resume.
- While working, use task_note to record a one-line progress note.
- Do not create tasks for trivial single-turn Q&A.
- When the user asks in natural language to add/remove/edit tasks or steps, apply it with the tools; do not only promise it in the reply.
```

---

## 13. Consistency notes (deliberate trade-offs)

| Phenomenon | Problem? | Handling |
|------|----------|------|
| Agent prose says "working on it" while the list is already open | No | The list is the intent source of truth; narration may be colloquial |
| Created this turn; injection only appears next turn | No | Injection is at run start; tools are this turn's executors |
| Model forgets the tool and only writes "noted" in prose | Yes | Rely on the §12 prompt; spot-check tests; if needed force tool-result echo |
| User sees the list in UI and wants to edit | — | **Talk to the Agent**, or click a quick-message button |

Do not introduce: version/CAS, in-run revocation, multi-writer alignment, sidecar alignment.

---

## 14. Mapping from the old design

| Old | New |
|----|----|
| `TaskTracker` + standalone JSONL | `Session.tasks` + `SessionTaskService` |
| `TaskManager` (LLM per message) | Removed (none by default) |
| `DefaultTaskDecisionProvider` | Injection render inside the Runner (no standalone Provider needed; if the interface stays it is only a render hook) |
| `task_create/list/update` | Semantics kept; handlers go through the Service; error messages completed |
| `interrupted` state | Removed |
| `harness/task-system/tasks/` | Moved to `harness/session/tasks/` or folded into the session module |
| UI direct-write task API | Not provided |

---

## 15. Test baseline

1. Empty `tasks` → no injection.
2. After `task_create` (no parent) it is a goal; next-turn injection includes that entry.
3. `task_create` / `task_plan` create steps: attached under the correct goal, `order` correct.
4. Injection does **not** list every step; only the `Progress: x/y (current: …)` rollup.
5. After `task_complete` on a goal it is no longer injected; completing a step only changes the rollup; the goal is still injected.
6. **No** auto-complete: after all steps are done the goal stays open until explicitly completed.
7. goal `drop` cascades drop to unclosed steps and emits events.
8. pause/resume/drop state matches injection.
9. Illegal tool transition / missing `parent_id` → explicit error.
10. Events: both goal and step changes emit `session.task.updated`.
11. Same Service: after a tool write, `list` sees it (no dual Store).
12. After Session reload, `tasks` (including steps) persist.
13. Two consecutive turns of injection do not stack `session_tasks` blocks into the same prompt base.

---

## 16. Design decisions (ADR)

| ID | Decision | Rationale |
|----|------|------|
| A1 | Hang on Session; not a WorkingMemory domain | Avoid collision with messages / second Store concepts |
| A2 | Name it SessionTask; bare Task forbidden | Isolation from AsyncTask and friends |
| A3 | **Primary LLM tools write only** | Changes must carry context; cut multi-writer complexity |
| A4 | UI read-only pass-through | Visibility is needed; direct write would fork |
| A5 | Inject once at turn start | Stable prompt; accept slightly stale within the turn |
| A6 | No default sidecar classification | Remove latency and silent failure |
| A7 | Persist inside SessionStore | Single source of truth |
| A8 | **Two-level goal/step, depth = 1** | Progress visible + recoverable; forbid tree sprawl |
| A9 | **Injection only rolls up steps** | Avoid plan items flooding the system prompt |
| A10 | Goals do not auto-complete | All steps done ≠ deliverable complete |

---

## 17. Landing order

1. `SessionData.tasks` + `SessionTask` types.
2. `SessionTaskService` (state machine + Store + events).
3. Wire tools to the Service; complete error messages.
4. Runner injects rendered `<session_tasks>`.
5. Gateway/Web expose read-only task API / events.
6. Remove legacy Tracker JSONL / default TaskManager path.
7. Split out run-guard / orchestration by domain (done; historical design records archived).

---

## 18. Related documents

| Document | Relation |
|------|------|
| [domains.md](./domains.md) | Product domains and module ownership |
| [Architecture constitution](./north-star.md) | Long-term invariants (including layering and Run scope) |
