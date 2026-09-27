# Session — 会话连续性

> 产品域（Continuity 平面）｜问题：**连续性如何维持、旧账如何查？**  
> 概念权威：[`docs/north-star.md`](../../../docs/north-star.md) ｜ 域地图：[`docs/domains.md`](../../../docs/domains.md)

## 拥有概念

Session 聚合 · Discourse · Projection · Compact 状态 · SessionTask

## 模块

| 位置 | 职责 |
|------|------|
| `types.ts` | `SessionData` 聚合根（lifecycle、participants、primary/preferred…） |
| `state-machine.ts` | 会话生命周期状态机 |
| `compact.ts` | E4 compact 状态 I/O（键 `(sessionId, agentId)`） |
| `tasks/` | SessionTask goal/step；`task_*` 工具 |
| `history/` | 会话历史检索 port + score（投影，非权威） |

## 边界

- **不做**：基质内容质量（Memory）；本轮是否跑对（Run）
- **失败模式**：连续性丢失/污染、任务丢失、compact 串键
- I2：Discourse **追加权威**；status/tasks/检索索引等为 **Projection**，可失效重建
- ACL 裁决语言属 **Governance**，本域只消费结果

## 依赖

只 import 其它域 **types**；跨域不共享内部状态。
