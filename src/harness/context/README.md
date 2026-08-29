# Context Management — 上下文管理

> Layer: Layer 2

消息选择、压缩、Token 估算、七层智能组装。

**核心理念**：Agent 的智能水平取决于 system prompt 的质量。Context Intelligence 负责七层组装。

## 职责

- DefaultContextEngine — 统一入口（assemble → 预算分配 → 选择 → 路由 → 压缩）
- SmartRouter — 路由决策（fits / truncate / compact）
- DefaultMessageSelector — 四区域消息选择
- HybridCompressor — 混合压缩（工具截断 + LLM 摘要 + 截断兜底）
- HeuristicTokenEstimator — 启发式 Token 估算
- ContextIntelligence — 七层智能组装（memory/ 模块提供）

## 不做什么

- 不做安全检查
- 不做工具执行
- 不做可靠性包装

## 依赖

- Core: interfaces/context-engine、types/messages

## 文件说明

- default-context-engine.ts — 统一入口
- smart-router.ts — 智能路由
- message-selector.ts — 四区域选择
- hybrid-compressor.ts — 混合压缩
- llm-summarizer.ts — LLM 摘要
- truncate-compressor.ts — 截断兜底
- budget-allocator.ts — Token 预算分配
- token-estimator.ts — Token 估算
- core-token-estimator.ts — 底层估算工具
- index.ts — 统一导出
