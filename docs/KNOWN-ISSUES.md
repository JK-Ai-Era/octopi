# 已知问题

> 最后更新：2026-06-10

## KnowledgeStage 需要适配新架构

**状态：** 待处理

**描述：**

`harness/knowledge/stage.ts` 中的 `KnowledgeStage` 仍然依赖已删除的 `ContextPipeline` Stage 接口（`ContextStage`, `StageContext`）。这些接口在 ContextEngine 重构中被移除。

**影响：**

- `KnowledgeStage` 编译时会报类型错误（但运行时不受影响，因为 TypeScript 类型擦除）
- 该模块当前没有被核心流程引用，不影响正常使用

**需要的工作：**

将 `KnowledgeStage` 迁移到 ContextEngine 体系。可能的方案：
1. 作为 `AssembleParams` 的可选注入点（类似 `TaskDecisionProvider`）
2. 在 `beforeAssemble` 回调中处理
3. 作为 `DefaultContextEngine` 的可选组件

**相关文件：**
- `src/harness/knowledge/stage.ts`
- `src/harness/knowledge/index.ts`
- `src/harness/index.ts`（导出 `KnowledgeStage`）
