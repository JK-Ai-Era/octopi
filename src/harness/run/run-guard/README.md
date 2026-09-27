# Run Guard — 过程监督

> Layer: Layer 2

判断单次 run 是否跑飞，给出 `continue | recover | stop` 裁决。

**核心理念**：并列消费 Runner 的检查点；不读写 `Session.tasks`，不编排 Workflow。

**AgentSupervisor 已归档**（arch/agent-runtime.md §10）：长驻激活归 `harness/agent-runtime/`。

## 路径

| 组件 | 形态 | 用途 |
|------|------|------|
| **DefaultRunGuard** | 检查点审查（默认路径） | 规则检测 + 可选 LLM 审查；Builder `.runGuard()` / config `runGuard` |

## 职责

- DefaultRunGuard — 规则检测 + 可选 LLM 审查
- Checkpoint* / RecoveryAction — Core 契约见 `core/interfaces/run-guard.ts`

## 不做什么

- 不读写 Session.tasks
- 不编排 Workflow / Cron
- 不做长驻激活（agent-runtime）

## 依赖

- Core: interfaces/run-guard、types
- 可选: ModelProvider（LLM 审查）

## 文件说明

- default-run-guard.ts — DefaultRunGuard + createRunGuard
- index.ts — 统一导出
