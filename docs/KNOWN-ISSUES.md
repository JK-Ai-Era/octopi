# 已知问题

> 最后更新：2026-09-20

## 同 Agent 多 Session 抢占共享 Agent 上下文（未解决）

**状态：** 待专题处理 → `arch/open-problems.md` **OP-AR-3**

Gateway 对同一 `agentId` 只保留一个 Agent 实例；`SessionAwareRunner` 的锁按 `sessionId` 而非 `agentId`。同一 Agent 下多个 session 并行 `handle()` 时会互相覆盖 `agent.context.messages`，可能导致会话历史串味、落盘污染。与模型切换/ResolvedModel 无关（ALS 安全）。方案与研究清单见 OP-AR-3。

## KnowledgeStage（已关闭）

**状态：** 已解决

旧 `harness/knowledge/stage.ts` 的 `KnowledgeStage` 依赖已删除的 ContextPipeline Stage 接口。现已由 `harness/context/knowledge/` 的 `KnowledgeContextEngine`（实现 `ContextEngine.assemble()`）取代；契约见 `harness/context/knowledge/types.ts`。

## 旧配置字段 `supervisor`

**状态：** 有意不兼容 + 已告警 + 可 doctor 修复

`octopi.json` 中的 `supervisor` 字段在 v0.20.0 起改名为 `runGuard`。旧字段会被 Zod 静默剥离；`loadConfig()` 检测到旧字段时会打印 warning。

**修复：** `octopi doctor --fix` 会将其改写为 `runGuard`（备份原文件）。同类旧字段/布局问题见 `octopi doctor`。
