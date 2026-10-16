# SessionSchedule — Agent-initiated timers (`timer_*` / `schedule_*`)

> **Status**: Product design baseline for session schedules and in-turn timers.
> When implementation, naming, or tests conflict with this document, this document wins.
> Last updated: 2026-10-16

---

## 1. Problem

Agents are turn-based. Without scheduling they cannot:

1. **Wait inside the current turn** (build output, short polling)
2. **Wake this session later** ("look at the PR in two hours")
3. **Run periodic turns** ("check deploy every hour")

A blocking `sleep` tool only covers (1) and holds the run. Cross-turn work must be a **durable job** that injects a wake message and starts a **new Run** on the same session.

---

## 2. Two tool families (different interaction contracts)

| | `timer_*` (in-turn) | `schedule_*` (cross-turn) |
|--|---------------------|---------------------------|
| Question | How long to wait before continuing *this* turn? | When should the platform start a new turn? |
| Interaction | **Blocking** | **Non-blocking** (immediate ack) |
| Lifetime | Bound to the Run | Durable in `schedules.db` |
| Typical | Short poll loops | Reminders, periodic checks |

**Choose by intent, not duration.**

- Stay in this turn → `timer_wait`
- End this turn and continue later → `schedule_set`

**Periodic full Runs only use `schedule_*`.** In-turn short polling is an LLM loop over `timer_wait`.

---

## 3. Tools

### 3.1 `timer_*`

| Tool | Semantics |
|------|-----------|
| `timer_wait` | Block the current turn for a duration (`"30s"` / `5m` / seconds) |
| `timer_cancel` | Abort in-flight `timer_wait`(s) in this session |

Default max wait **10 minutes**, hard cap **30 minutes**. Over the limit returns an error and suggests `schedule_set`.

### 3.2 `schedule_*`

| Tool | Semantics |
|------|-----------|
| `schedule_set` | Register once / interval / cron job; returns immediately |
| `schedule_update` | Change prompt / title / max_runs / catch_up / time (re-arms) |
| `schedule_list` | List jobs in this session |
| `schedule_cancel` | Cancel |
| `schedule_pause` / `schedule_resume` | Freeze / re-arm (applies catch-up) |

Time is **exactly one of**: `delay` (`"2h"`), `at` (ISO or epoch), `every` (`"30m"`), `cron` (`分 时 日 月 周`).

`at` must be **in the future**. Unix seconds and milliseconds are both accepted.

Default `delivery` is **`wakeup`**: at fire time the platform injects a wake message into **this session** and starts a full agent Run (same tool rights as interactive). `notify` only writes a session message and does not start a model run.

**Do not execute the scheduled prompt in the turn that registers it.** End the turn and wait for the wake.

---

## 4. State machine

`active | paused | completed | cancelled | failed`

```
create → active
active ⇄ paused
active → completed   (once fired | max_runs reached)
active|paused → cancelled
active → failed      (cannot compute next fire / bookkeeping failure)
terminal: completed | cancelled | failed
```

Fire is **not** a state. Accounting is written **before** dispatch (at-most-once).

---

## 5. Persistence and budget

- Source of truth: `~/.octopi/schedules.db` (`node:sqlite`), created on `SessionScheduleService.open()`
- Restart: re-arm `active` jobs; overdue fires follow `catch_up` (`skip` default, or `fire_once`)
- Fallback tick re-arms lost timers (`schedules.tickIntervalMs`, default 60s)
- Budget (`octopi.json` → `schedules`):
  - `maxOpenPerSession` (default 50)
  - `maxWakesPerHour` (default 120) — over budget skips dispatch but still accounts
  - `tickIntervalMs` (default 60000)

Same `coalesceKey` within a short window merges dispatches.

---

## 6. Context and UI

- Open jobs are injected as `<session_schedules>` every turn (Runtime layer)
- Web console: session panel **日程** with pause / resume / cancel
- REST: `GET /sessions/:id/schedules`, `POST …/schedules/:id/{cancel,pause,resume}`

---

## 7. Non-goals

- Not a central process-wide scheduler (execution stays domain-owned)
- Not a replacement for SessionTask (goals/steps) or AsyncTask (orchestration)
- Not in-turn multi-hour blocking waits
