# Knowledge — 知识

> 产品域（Agent & Substrate 平面）｜问题：**世界上写着什么？**  
> 概念权威：[`docs/north-star.md`](../../../docs/north-star.md) ｜ 产品文档：[`docs/knowledge.md`](../../../docs/knowledge.md)

## 拥有概念

Knowledge · Source · KnowledgeScope（Global / Project / Session）

## 职责

外生语料：源登记、同步/摄取、解析、embedding、索引（可重建）、检索、溯源。

- **源锚定**：每条命中必须能回答「来自哪个 source」
- **Index 非权威**：权威是源本身
- **无 Agent 级源**：「独享」= 只挂给它的 Project

## 与 Memory 的对偶（禁止合并）

| | Knowledge | Memory |
|---|---|---|
| 问句 | 世界上写着什么 | 我学到过什么 |
| 来源 | 外部世界 | 交互提炼 |
| Scope | Global / Project / Session | 仅 per-agent（E3） |

## 契约

`catalog-types.ts` / `catalog-index.ts`：Tier 0 catalog（system 只注入「有哪些源」）。  
实现依赖本目录 `types.ts`；**不**再拆到 `context/knowledge/`。

## 边界

- **不做**：命题记忆；活系统当前态（Tool 实时查）
- **失败模式**：无源/错源、检索错语料、索引当权威
