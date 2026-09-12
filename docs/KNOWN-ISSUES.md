# 已知问题

> 最后更新：2026-06-12

## KnowledgeStage（已关闭）

**状态：** 已解决

旧 `harness/knowledge/stage.ts` 的 `KnowledgeStage` 依赖已删除的 ContextPipeline Stage 接口。现已由 `harness/context/knowledge/` 的 `KnowledgeContextEngine`（实现 `ContextEngine.assemble()`）取代；契约见 `core/interfaces/knowledge-store.ts`。

## 旧配置字段 `supervisor`

**状态：** 有意不兼容 + 已告警

`octopi.json` 中的 `supervisor` 字段在 v0.20.0 起改名为 `runGuard`。旧字段会被 Zod 静默剥离；`loadConfig()` 检测到旧字段时会打印 warning，避免无声失去过程监督。
