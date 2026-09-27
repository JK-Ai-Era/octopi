# Run — 运行物理

> 产品域（Execution 平面）｜问题：**这一轮如何安全、正确地跑完？**  
> 概念权威：[`docs/north-star.md`](../../../docs/north-star.md) ｜ 域地图：[`docs/domains.md`](../../../docs/domains.md)

## 拥有概念

Run · RunScope · SessionLease · Effect 执行 · Reliability · RunGuard · Budget 阀

## 模块

| 位置 | 职责 |
|------|------|
| `runner.ts` | SessionAwareRunner：session 锁/lease、toolIsolation cwd、compactSession、可选 ACL |
| `run-scope.ts` | RunScope ALS（I1）；`runId` / toolRuntime / agentRevision |
| `agent/` | **`Agent.run()` 门面**（E5 唯一推荐生产入口） |
| `reliability/` | 可靠性包装、HarnessLoopEvent、断路器、重试 |
| `run-guard/` | 过程监督（continue / recover / stop） |
| `budget/` | BudgetPolicyEngine 预算安全阀（per-run） |
| `concurrency/` | SessionLease（E2/E7）、SessionGate、ProviderPool、限流 |
| `model/` | 模型解析 resolver + ResolvedModel ALS |

## 边界

- **不做**：会话 UI；模板内容（Agent 域）
- **失败模式**：串会话、跑飞、效应失控、烧预算
- **I1**：可变上下文 **只活在 RunScope**；禁止挂 Agent 单例
- **E5**：Loop 无状态；生产路径 = `Agent.run` / `runAgentWithReliability` + per-run context

## 依赖

可 import 各域 types；运行时编排 Session × Agent × Tool。
