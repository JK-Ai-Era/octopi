# 已知问题

> 最后更新：2026-09-26

## 同 Agent 多 Session 抢占共享 Agent 上下文（I1 已落地）

**状态：** Run 物理 **I1 已实现**（v0.35.0，worktree `feat/run-scope-i1`）→ 宪法 `arch/north-star.md` · 专题 OP-AR-3

`SessionAwareRunner` 不再把共享 `Agent.context` 当会话工作区；每 Run 使用私有 `AgentContext` + `RunScope` ALS。锁仍按 `sessionId`。同 Agent 多 Session 并发的 **消息串味** 已由回归测试覆盖。

**仍开放（宪法预留，非本 OP 阻塞）：** 工具效应面/同 workspace 并发（I5）、多进程 Session Lease、ACL/角色目录、Session 一等存储演进。见 `arch/north-star.md`。

## KnowledgeStage（已关闭）

**状态：** 已解决

旧 `harness/knowledge/stage.ts` 的 `KnowledgeStage` 依赖已删除的 ContextPipeline Stage 接口。现已由 `harness/context/knowledge/` 的 `KnowledgeContextEngine`（实现 `ContextEngine.assemble()`）取代；契约见 `harness/context/knowledge/types.ts`。

## 旧配置字段 `supervisor`

**状态：** 有意不兼容 + 已告警 + 可 doctor 修复

`octopi.json` 中的 `supervisor` 字段在 v0.20.0 起改名为 `runGuard`。旧字段会被 Zod 静默剥离；`loadConfig()` 检测到旧字段时会打印 warning。

**修复：** `octopi doctor --fix` 会将其改写为 `runGuard`（备份原文件）。同类旧字段/布局问题见 `octopi doctor`。
