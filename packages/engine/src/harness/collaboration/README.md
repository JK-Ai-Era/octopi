# Collaboration — 多智能体协作

> 产品域（Collaboration）｜问题：**多 Agent / 子系统如何协同？**  
> 概念权威：[`docs/north-star.md`](../../../docs/north-star.md) ｜ 域地图：[`docs/domains.md`](../../../docs/domains.md)  
> 状态：**产品完整性必有域**；实现可分期（`status: incomplete` 不取消域地位）

## 拥有概念

Swarm · Subsystem · Signal · Workflow · AgentProcess · Discovery

## 模块

| 模块 | 职责 |
|------|------|
| `multi-agent/` | Agent 注册发现、Swarm 编排、AgentProcess |
| `orchestration/` | experimental：workflow / scheduler / planner（子路径 `octopi/harness/orchestration`） |
| `autonomous-subsystem/` | Sense/Think/Act/Signal/Boundary 五维子系统框架 |

## 边界

- **不做**：人级 IAM；垂直业务流程
- **失败模式**：协同死锁、信号丢失、自治体越界
- 与 Multi-Agent 正交：多实例如何协作 vs 子系统如何感知并回写主系统
- 子系统 `security` 字段当前为声明契约，运行时未做沙箱隔离（见子模块 README）
