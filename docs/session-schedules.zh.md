# SessionSchedule — Agent 自发起定时（`timer_*` / `schedule_*`）

> **Status**：会话日程与回合内定时的产品设计基准。实现、命名或测试与本文冲突时，以本文为准。
> 最近更新：2026-10-16

---

## 1. 问题

Agent 是回合制的。没有定时能力时无法：

1. **在当前回合内等待**（构建输出、短轮询）
2. **延后唤醒本会话**（「两小时后看 PR」）
3. **周期性自动跑 Run**（「每小时检查部署」）

阻塞式 `sleep` 只能覆盖 (1) 且会拉长 Run。跨回合工作必须是**可持久化作业**，到点向本会话注入唤醒消息并启动**新 Run**。

---

## 2. 两族工具（交互契约不同）

| | `timer_*`（回合内） | `schedule_*`（跨回合） |
|--|---------------------|------------------------|
| 回答的问题 | 本轮还要等多久？ | 何时由平台再开一轮？ |
| 交互 | **阻塞** | **非阻塞**（立刻 ack） |
| 生命周期 | 随 Run | 持久化于 `schedules.db` |
| 典型 | 短轮询 | 提醒、周期巡检 |

**按意图选型，不按时长。**

- 留在本轮 → `timer_wait`
- 结束本轮、到点继续 → `schedule_set`

**周期完整 Run 只属于 `schedule_*`。** 回合内短轮询 = LLM 循环调用 `timer_wait`。

---

## 3. 工具面

### 3.1 `timer_*`

| 工具 | 语义 |
|------|------|
| `timer_wait` | 在当前回合阻塞等待（`"30s"` / `5m` / 秒数） |
| `timer_cancel` | 取消本会话在途 `timer_wait` |

默认最大 **10 分钟**，硬顶 **30 分钟**。超限报错并提示改用 `schedule_set`。

### 3.2 `schedule_*`

| 工具 | 语义 |
|------|------|
| `schedule_set` | 登记 once / interval / cron；立刻返回 |
| `schedule_update` | 改 prompt / title / max_runs / catch_up / 时间并 re-arm |
| `schedule_list` | 列出本会话作业 |
| `schedule_cancel` | 取消 |
| `schedule_pause` / `schedule_resume` | 暂停 / 恢复（套用 catch-up） |

时间**四选一**：`delay`（`"2h"`）、`at`（ISO 或 epoch）、`every`（`"30m"`）、`cron`（`分 时 日 月 周`）。

`at` 必须在**未来**；Unix 秒与毫秒均可。

默认 `delivery` 为 **`wakeup`**：到点向**本会话**注入唤醒消息并启动完整 Agent Run（与交互同权）。`notify` 只写会话消息，不跑模型。

**登记后不要在本回合执行 prompt**，应结束回合等待唤醒。

---

## 4. 状态机

`active | paused | completed | cancelled | failed`

```
create → active
active ⇄ paused
active → completed   （once 已点火 | 达 max_runs）
active|paused → cancelled
active → failed      （无法计算下次点火 / 记账失败）
终态：completed | cancelled | failed
```

点火**不是**状态。先记账再 dispatch（at-most-once）。

---

## 5. 持久化与预算

- 真源：`~/.octopi/schedules.db`（`node:sqlite`），`SessionScheduleService.open()` 时建库
- 重启：重臂 `active`；过期点火按 `catch_up`（默认 `skip`，可选 `fire_once`）
- 兜底 tick 补丢 timer（`schedules.tickIntervalMs`，默认 60s）
- 预算（`octopi.json` → `schedules`）：
  - `maxOpenPerSession`（默认 50）
  - `maxWakesPerHour`（默认 120）— 超限跳过 dispatch，仍记账
  - `tickIntervalMs`（默认 60000）

同 `coalesceKey` 在短窗口内合并 dispatch。

---

## 6. 上下文与 UI

- 未闭合作业每轮注入 `<session_schedules>`（Runtime 层）
- Web 控制台会话面板 **「日程」**：暂停 / 恢复 / 取消
- REST：`GET /sessions/:id/schedules`，`POST …/schedules/:id/{cancel,pause,resume}`

---

## 7. 非目标

- 不是进程级中心 Scheduler（执行分域）
- 不替代 SessionTask（目标/步骤）或 AsyncTask（编排）
- 不做回合内数小时阻塞等待
