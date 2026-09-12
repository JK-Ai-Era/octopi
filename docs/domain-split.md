# 领域切分：任务相关模块

> **地位**：与 [docs/task-system.md](./task-system.md) 配套。  
> 会话任务（SessionTask）的设计以 task-system.md 为准；本文规定其余模块归哪一域、叫什么、能否依赖谁。  
> **状态**：迁移已完成（2026-06-12）；`harness/task-system/` 已删除。  
> 最后更新：2026-06-12

---

## 1. 为什么要切

历史上 `harness/task-system/` 混了四件本质不同的事。剥离后命名才干净：

| 旧模块 | 真实本质 | 新归属 |
|--------|----------|--------|
| `tasks/`（Tracker/Manager/Decision） | 会话任务列表 | **Session 聚合**（`Session.tasks`），见 task-system.md |
| `async-task` + `TaskStore` | 异步执行单元 | **runtime-primitives**（Core） |
| `supervisor/` | 过程监督（防跑飞） | **run-guard** |
| `workflow/` `scheduler/` `planner/` `strategy/` `quality/` `reflector/` | 编排与策略 | **orchestration**（experimental） |

原则：

1. 按失败模式分域，不按历史目录分域。  
2. 「task」不再作伞形领域名；会话侧用 **SessionTask**，原语侧用 **AsyncTask**。  
3. 跨域只走显式适配器。  
4. 未进默认路径的不占领域导出面。

---

## 2. 总览图

```text
                         SessionAwareRunner
                                 │
                    ┌────────────┴────────────┐
                    │       Session 聚合       │
                    │  messages[]  tasks[]     │◄── task_* 工具（主 LLM）
                    │  meta / lifecycle        │◄── 只读事件 → UI
                    └────────────┬────────────┘
                                 │ 注入 active tasks
                                 ▼
                           主 Agent Loop
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
       ┌────────────┐    ┌────────────┐    ┌──────────────┐
       │ Run Guard  │    │ Orchestration│   │ Runtime      │
       │ 过程监督    │    │ 编排(experimental)│ Primitives  │
       │ continue/  │    │ Workflow/Cron │   │ AsyncTask    │
       │ recover/   │    └──────┬─────┘    └──────────────┘
       │ stop       │           │ 可选适配
       └────────────┘           ▼ 写 Session.tasks（单向）
                         （经 SessionTaskService）
```

| 名称 | 中文 | 职责一句话 |
|------|------|------------|
| **Session.tasks** | 会话任务 | 未闭合工作项（goal/step 两级）；**不是独立 harness 领域** |
| **run-guard** | 过程监督 | 单次 run 是否跑飞 |
| **orchestration** | 编排 | 确定性多步骤作业 |
| **runtime-primitives** | 运行时原语 | AsyncTask 等；无用户语义 |

---

## 3. Session.tasks（会话任务）

| 项 | 内容 |
|----|------|
| 设计 | [task-system.md](./task-system.md) |
| 数据 | `SessionData.tasks: SessionTask[]`（goal / step，depth=1） |
| 写入 | 仅主 LLM `task_*` 工具 → `SessionTaskService`；系统生命周期钩子（窄） |
| 读取 | 每轮注入 goal + step rollup；UI 只读事件/API（可展开步骤树） |
| 持久化 | SessionStore（禁止独立 task JSONL） |
| 目录建议 | `src/harness/session-tasks/`（Service + 渲染 + 工具） |

**不做**：UI 直写、侧车每条消息分类、与 Workflow 共用状态机、depth>1 树、全量 step 注入 system prompt。

领域边界：本设计属于 **Session 模型**，在 domain 图上不要画成与 run-guard 平行的「工作记忆域」。

---

## 4. run-guard（过程监督）

| 项 | 内容 |
|----|------|
| 现状 | `task-system/supervisor/*` + `core/interfaces/task-supervisor.ts` |
| 建议目录 | `src/harness/run-guard/` |
| Core 接口 | `TaskSupervisor` → **`RunGuard`** |
| 默认路径 | 可选（builder config） |

**做**：CheckpointMetrics、规则层 + 可选 LLM 审查、`continue|recover|stop`、恢复动作（截断 / hint / 清最近轮次）。

**不做**：读写 `Session.tasks`；编排 Workflow。

**与 Session.tasks**：并列消费 Runner。`stop` 时由 Runner 通知用户；是否 drop/pause 某任务由主 LLM 或系统钩子决定，Guard 不 import SessionTaskService。

| 旧 | 新 |
|----|----|
| `TaskSupervisor` | `RunGuard` |
| `DefaultTaskSupervisor` | `DefaultRunGuard` |

---

## 5. orchestration（编排）

| 项 | 内容 |
|----|------|
| 现状 | `workflow/` `scheduler/` `planner/` `strategy/` `quality/` `reflector/` |
| 建议目录 | `src/harness/orchestration/` |
| 默认路径 | **否**（experimental，直至有 e2e） |

```text
orchestration/
├── workflow/     # 保留 experimental
├── scheduler/    # 保留 experimental
├── planner/      # 默认不导出或 archive
├── strategy/     # 默认不导出或 archive
├── quality/      # 默认不导出或 archive
└── reflector/    # 默认不导出或 archive
```

**与 Session.tasks 的唯一合法耦合（单向，可选；规范先行，仓库内暂无内置适配）**：

长流水线启动时经 `SessionTaskService.create` 登记一条对用户可见的任务；结束时 `complete`/`drop`。  
禁止 working-memory/session-tasks 反向 import orchestration；禁止 Workflow 状态机充当 SessionTask 状态机。

---

## 6. runtime-primitives（运行时原语）

| 项 | 内容 |
|----|------|
| 现状 | `core/primitives/async-task.ts`，`core/interfaces/task-store.ts` |
| 位置 | 保持 Core |

**做**：生命周期、超时、取消、重试、父子、EventBus、可选持久化。  
**不做**：用户意图、会话语义、注入。

| 旧 | 新 |
|----|----|
| `AsyncTask` | 可保留 |
| `TaskStore` / `TaskRecord` | **`AsyncTaskStore` / `AsyncTaskRecord`** |
| 裸 `TaskStatus`（原语侧） | **`AsyncTaskStatus`** |

无 concrete store 实现时：文档声明默认内存；或以后在 `integration/storage/` 补。  
禁止依赖 `Session.tasks`。

---

## 7. 命名规范

| 禁止 | 原因 |
|------|------|
| 新代码裸 `Task` / `TaskStatus` / `TaskTracker` / `task-system` 目录 | 历史歧义 |
| 会话侧与原语侧共用无前缀类型 | 撞名 |
| UI 直写任务的业务 API（v1） | 与对话上下文分叉 |

| 允许 | 含义 |
|------|------|
| `SessionTask` / `SessionTaskStatus` / `SessionTaskService` | 会话任务 |
| `task_*` 工具名 | 会话任务工具 |
| `RunGuard` / `Checkpoint*` | 过程监督 |
| `AsyncTask` / `AsyncTaskStore` | 运行时原语 |
| `Workflow*` / `Scheduled*` | 编排 |

状态机对照：

| 域 | 状态 |
|----|------|
| SessionTask | `open \| paused \| done \| dropped` |
| RunGuard | 裁决 `continue \| recover \| stop` |
| AsyncTask | `pending \| running \| completed \| failed \| cancelled` |
| Workflow | `pending \| running \| paused \| completed \| failed \| cancelled` |

---

## 8. 目标目录

```text
src/
├── core/
│   ├── interfaces/
│   │   ├── run-guard.ts            # 由 task-supervisor.ts 重命名
│   │   └── async-task-store.ts     # 由 task-store.ts 重命名
│   └── primitives/
│       └── async-task.ts
│
├── harness/
│   ├── session-types.ts            # SessionData.tasks: SessionTask[]
│   ├── session-tasks/              # Service、渲染、task_* 工具
│   ├── run-guard/                  # 由 task-system/supervisor 迁出
│   ├── orchestration/              # experimental 子树
│   └── context/knowledge/          # Knowledge 实现（契约在 Core）
│
└── integration/
    └── web/                        # 只读任务 API / 事件到 UI
```

---

## 9. 依赖规则

```text
session-tasks  → core/types, SessionStore（经 harness session）
run-guard      → core/interfaces + 可选 ModelProvider
orchestration  → core/*；→ SessionTaskService 仅单向可选适配
async-task     → core/* only

禁止：
  core → harness
  session-tasks → orchestration / run-guard / async-task
  run-guard → session-tasks / orchestration
  orchestration → run-guard / session-tasks
```

Plan/Planner/Reflector 与 KnowledgeStore 契约位于 Core，以避免 run-guard ↔ orchestration 互相依赖。

---

## 10. 导出面（`harness/index.ts`）

| 符号 | 迁移后 |
|------|--------|
| `SessionTask` / `SessionTaskService` / task 工具 | **导出** |
| `RunGuard*` | **导出** |
| `AsyncTask` / `spawnTask` | **导出** |
| Workflow / Scheduler | 子路径 experimental |
| Planner / Strategy / Quality / Reflector | 默认不导出或 archive |
| 旧 TaskTracker / TaskManager / DefaultTaskDecisionProvider | deprecated → 删除 |

---

## 11. 迁移映射

| 现文件 | 目标 |
|--------|------|
| `session-types.ts` | 增加 `tasks: SessionTask[]` |
| `task-system/tasks/*` | `session-tasks/`（Service + tools + render） |
| `plugin-ecosystem/tools/task-tools.ts` | 改接 SessionTaskService |
| `core/interfaces/task-decision.ts` | 删除或收成渲染钩子 |
| `core/interfaces/task-supervisor.ts` | `run-guard.ts` |
| `task-system/supervisor/*` | `harness/run-guard/` |
| `task-system/workflow/*` 等 | `harness/orchestration/` |
| `task-system/knowledge/*` | `harness/context/knowledge/`（契约上收 `core/interfaces/knowledge-store.ts`） |
| `core/interfaces/task-store.ts` | `async-task-store.ts` |
| Plan/Planner/Reflector 类型 | `core/interfaces/cognitive-loop.ts`（run-guard 与 orchestration 共享契约） |
| `daemon.ts` TaskTracker | 删除；任务随 Session |
| `docs/task-system.md` | 已替换为 SessionTask 基准 |
| `arch/overview.md` 领域七 | 按本文改写 |

---

## 12. 测试归属

| 域 | 最低要求 |
|----|----------|
| SessionTask | task-system.md §15 |
| run-guard | 迁移现有 supervisor 测试 |
| orchestration | 至少 1 个 e2e + 可选 WM 适配 |
| async-task | 保留现有 |

禁止跨域断言内部状态。

---

## 13. 相关文档

| 文档 | 关系 |
|------|------|
| [task-system.md](./task-system.md) | SessionTask 唯一基准 |
| [arch/layer-rules.md](layer-rules.md) | 分层 |
| [arch/overview.md](overview.md) | 总览待按本文修订 |
