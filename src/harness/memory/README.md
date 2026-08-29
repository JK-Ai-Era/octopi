# Memory — 记忆系统

> Layer: Layer 2

记忆存储/检索、认知图谱、智慧生成、项目记忆、七层智能组装。

**核心理念**：信息分馏系统 — 信息 → 记忆 → 认知 → 智慧，逐层提炼。

## 职责

- InMemoryMemoryStore — 记忆存储（关键词匹配，可替换为向量后端）
- FileWisdomStore — 智慧存储（WISDOM.md 文件驱动）
- InMemoryConceptGraph — 认知图谱（概念+关系网络）
- FileProjectMemory — 项目记忆（MEMORY.md）
- ContextIntelligence — 七层智能组装

## 不做什么

- 不做上下文压缩（那是 context 的事）
- 不做安全检查

## 依赖

- Core: interfaces/memory、types/messages

## 文件说明

- store.ts — InMemoryMemoryStore
- wisdom.ts — FileWisdomStore（WISDOM.md 驱动）
- cognition.ts — InMemoryConceptGraph（概念图谱）
- project-memory.ts — FileProjectMemory（MEMORY.md）
- context-intelligence.ts — ContextIntelligence（七层组装）
- index.ts — 统一导出
