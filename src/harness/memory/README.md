# Memory — 记忆系统

> Layer: Layer 2

记忆存储/检索、认知图谱、七层智能组装。

**核心理念**：信息分馏系统 — 信息 → 记忆 → 认知 → 智慧，逐层提炼。

## 职责

- InMemoryMemoryStore — 记忆存储（关键词匹配，可替换为向量后端）
- InMemoryConceptGraph — 认知图谱（概念+关系网络）
- ContextIntelligence — 七层智能组装
- SqliteMemoryStore / SqliteWisdomStore / SqliteConceptGraph / KnowledgeRegistry — 持久化实现，统一挂在 per-agent `AgentDatabase`（`agent.db`）

## 已移除

- `FileWisdomStore` / `FileProjectMemory` 已删除，相关文件不再存在。
- `ProjectMemory` 接口已从 `cognition-types.ts` 移除，不再由 Core 导出。
- 文件目录形式的 `memory/`、`wisdom/` 落盘约定已废弃；持久化走 SQLite 单库。

## 不做什么

- 不做上下文压缩（那是 context 的事）
- 不做安全检查

## 依赖

- Core: types/messages（Kernel 词汇表）
- 契约（MemoryStore 等）定义在本目录 `types.ts`

## 文件说明

- store.ts — InMemoryMemoryStore
- cognition.ts — InMemoryConceptGraph（概念图谱）
- context-intelligence.ts — ContextIntelligence（七层组装）
- index.ts — 统一导出
