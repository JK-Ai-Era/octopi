# Run Guard — 过程监督

> Layer: Layer 2

判断单次 run 是否跑飞，给出 `continue | recover | stop` 裁决。

**核心理念**：并列消费 Runner 的检查点；不读写 `Session.tasks`，不编排 Workflow。

## 两条路径

| 组件 | 形态 | 用途 |
|------|------|------|
| **DefaultRunGuard** | 检查点审查（默认路径） | 规则检测 + 可选 LLM 审查；Builder `.runGuard()` / config `runGuard` |
| **AgentSupervisor** | 持续认知循环（ProcessModel） | 感知→规划→执行→反思；experimental，不在默认路径 |

二者都属于「过程监督」：关注单次 run / 进程是否跑飞，不承担多步业务编排（那是 orchestration）。

## 职责

- DefaultRunGuard — 规则检测 + 可选 LLM 审查
- AgentSupervisor — 持续运行认知循环
- EventCollector — 事件收集
- Checkpoint* / RecoveryAction — Core 契约见 `core/interfaces/run-guard.ts`
- Plan / Planner / Reflector — 跨域契约见 `core/interfaces/cognitive-loop.ts`（实现可在 orchestration）

## 不做什么

- 不读写 Session.tasks
- 不编排 Workflow / Cron

## 依赖

- Core: interfaces/run-guard、interfaces/cognitive-loop、types、primitives
- 可选: ModelProvider（LLM 审查）、reliability（AgentSupervisor）

## 文件说明

- default-run-guard.ts — DefaultRunGuard + createRunGuard
- agent-supervisor.ts — AgentSupervisor + startSupervisor
- event-collector.ts — EventCollector
- types.ts — SupervisorConfig + re-export cognitive-loop
- index.ts — 统一导出
