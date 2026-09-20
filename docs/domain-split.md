# 领域切分（历史附录）

> **地位**：2026-06 任务域迁移的设计记录，**不是当前目录权威**。  
> **现行权威**：[architecture.md](./architecture.md)、`src/core/README.md`、`src/harness/**/README.md`。  
> **语义对齐**：2026-09 Core Kernel 收敛后，本文中「原语/契约在 Core」等归属已大量失效。  
> 会话任务（SessionTask）的设计仍以 [task-system.md](./task-system.md) 为准。

---

## 0. 现行对照（2026-09，以此为准）

| 概念 | 现行位置 | 本文旧说法 |
|------|----------|------------|
| **Core 定位** | 仅 Kernel ports + 词汇表 + EventBus/StateMachine | 「Domain 可暂住 Core」 |
| `octopi/core` 入口 | 只出 Kernel | — |
| `octopi/core/domain` | **已删除** | 曾作为 Domain 入口 |
| AsyncTask | `harness/orchestration/async-task.ts` | Core primitives |
| AsyncTaskStore | `harness/orchestration/async-task-store.ts` | Core interfaces |
| RunGuard | `core/interfaces/run-guard.ts`（**Kernel**） | 由 task-supervisor 重命名（仍成立） |
| Session.tasks / SessionTask | `harness/session-tasks/` | 一致 |
| orchestration | `harness/orchestration/` | 一致 |
| Planner / Reflector 契约 | `harness/orchestration/cognitive-loop.ts` | 曾在 Core |
| KnowledgeStore 契约 | `harness/context/knowledge/types.ts` | 曾在 Core |
| Memory / Wisdom / Cognition | `harness/memory/types.ts` | 曾在 Core |
| AgentRegistry / MessageChannel | `harness/multi-agent/*-types.ts` | 曾在 Core |
| MCP | `harness/plugin-ecosystem/mcp/types.ts` | 曾在 Core |
| SkillManager | `harness/plugin-ecosystem/skills/types.ts` | 曾在 Core types |
| AgentDefinition / Persona | `harness/types/agent-definition.ts` | 曾在 Core types |
| ProcessModel | **已删除** | — |

**Kernel ports（现行，仍在 Core）**：ModelProvider、ErrorStrategy、SecurityGuard、RunGuard、ReliabilityHarness。

**Product ports（类型可留 Core，非 thin-run）**：ToolBus、SessionStore、`Observer`（**Telemetry** metrics/span/log）。ContextEngine 在 `harness/context/types.ts`。

**Run Observatory（勿与 Core Observer 混淆）**：产品调试观测在 `harness/observer/`（`ObserverHub`），配置键 `observer`，缺省 `level=off`。与 Telemetry（`observability` + Core `Observer`）同属 Observer Domain、实现分离。见 [observer-domain.md](./observer-domain.md)。

**依赖规则（现行）**：

```text
Integration → Harness → Loop → Core(Kernel)
Harness 领域间：只 import 对方 types，不 import 实现
禁止：core → harness / integration / loop
```

---

## 1. 为什么要切（2026-06 原文要点）

历史上 `harness/task-system/` 混了四件本质不同的事：

| 旧模块 | 真实本质 | 2026-06 归属 | 2026-09 现行 |
|--------|----------|--------------|--------------|
| `tasks/`（Tracker/Manager/Decision） | 会话任务列表 | Session 聚合 | 同左（session-tasks） |
| `async-task` + `TaskStore` | 异步执行单元 | **Core** runtime-primitives | **harness/orchestration** |
| `supervisor/` | 过程监督 | run-guard | 同左（Core 契约 RunGuard） |
| workflow / scheduler / planner… | 编排 | orchestration | 同左 |

原则（仍然有效）：

1. 按失败模式分域，不按历史目录分域。  
2. 「task」不再作伞形领域名；会话侧 **SessionTask**，异步单元 **AsyncTask**。  
3. 跨域只走显式适配器。  
4. 未进默认路径的不占领域导出面。

---

## 2. 总览（2026-06，结构仍大体有效）

```text
                         SessionAwareRunner
                                 │
                    ┌────────────┴────────────┐
                    │       Session 聚合       │
                    │  messages[]  tasks[]     │◄── task_* 工具（主 LLM）
                    └────────────┬────────────┘
                                 ▼
                           主 Agent Loop
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
       ┌────────────┐    ┌────────────┐    ┌──────────────────┐
       │ Run Guard  │    │Orchestration│   │ orchestration/   │
       │ 过程监督    │    │ 编排        │   │ async-task 单元  │
       └────────────┘    └────────────┘    └──────────────────┘
```

| 名称 | 职责 | 现行位置 |
|------|------|----------|
| Session.tasks | 未闭合工作项（goal/step） | harness/session-tasks + Session 聚合 |
| run-guard | 单次 run 是否跑飞 | harness/run-guard；契约 Core Kernel |
| orchestration | 确定性多步骤作业 | harness/orchestration |
| AsyncTask | 异步工作单元（无用户语义） | harness/orchestration |

---

## 3. Session.tasks（仍有效）

| 项 | 内容 |
|----|------|
| 设计 | [task-system.md](./task-system.md) |
| 数据 | `SessionData.tasks: SessionTask[]` |
| 写入 | 主 LLM `task_*` → `SessionTaskService` |
| 目录 | `src/harness/session-tasks/` |

---

## 4. run-guard（仍有效；契约在 Core Kernel）

| 项 | 内容 |
|----|------|
| 实现 | `src/harness/run-guard/` |
| 契约 | `core/interfaces/run-guard.ts`（Kernel port） |
| 裁决 | `continue \| recover \| stop` |

不做：读写 Session.tasks；编排 Workflow。

---

## 5. orchestration（仍有效）

目录 `src/harness/orchestration/`：workflow / scheduler / planner / strategy / quality / reflector，以及 **async-task**、**cognitive-loop 契约**。

与 Session.tasks 仅允许单向可选适配（规范见本域 README）。

---

## 6. AsyncTask（**归属已变更**）

| 项 | 2026-06 | **现行（2026-09）** |
|----|---------|---------------------|
| 位置 | Core primitives | `harness/orchestration/async-task.ts` |
| Store 契约 | Core | `harness/orchestration/async-task-store.ts` |
| 理由 | 「通用原语」 | Loop/裸 run 不依赖；唯一生产消费方 TaskScheduler |

命名仍禁止：裸 `Task` / 会话侧与原语侧共用无前缀类型。

状态机：`pending \| running \| completed \| failed \| cancelled`（不变）。

---

## 7. 2026-06 目标目录（史料；树已过时）

原文曾规划：

```text
src/core/primitives/async-task.ts   # 现已不在 Core
src/core/interfaces/async-task-store.ts
src/harness/session-tasks/
src/harness/run-guard/
src/harness/orchestration/
```

现行树见 [architecture.md](./architecture.md) §Core / §Harness。

---

## 8. 2026-06 迁移映射（史料）

| 当时现文件 | 当时目标 | 2026-09 现行 |
|------------|----------|--------------|
| task-supervisor.ts | run-guard.ts | 已完成；RunGuard 为 Kernel |
| task-store.ts | async-task-store.ts | 已迁出 Core → orchestration |
| task-system/workflow/* | harness/orchestration/ | 已完成 |
| task-system/knowledge/* | harness/context/knowledge/ | 契约已迁本域 types.ts |
| Plan/Planner/Reflector | Core cognitive-loop | **已迁** harness/orchestration/cognitive-loop.ts |

---

## 9. agent-runtime（激活宿主，仍有效）

Guard 管「这次跑得健不健康」，Runtime 管「要不要开始跑」。二者正交；调度与激活语义见 [架构宪法](./north-star.md) 控制面/Activation 与 `docs/architecture.md` §3.12b。

---

## 10. 相关文档

| 文档 | 关系 |
|------|------|
| [architecture.md](./architecture.md) | **当前架构权威** |
| `src/core/README.md` | Kernel 定位与 I/O 门禁 |
| [task-system.md](./task-system.md) | SessionTask 唯一基准 |
| `src/harness/orchestration/README.md` | AsyncTask / 编排现行说明 |
