# Distributed Agents — 分布式智能体

> Layer: Layer 2

多 Agent 协作、分布式运行时、Agent 注册与发现。

**核心理念**：分布式智能体不是"另一个 Agent"，是"扩展主 Agent Loop 能力边界"的框架机制。

## 职责

- AgentRuntime — 分布式核心运行时
- DistributedAgentSpec — 智能体规格（Trigger + InputPolicy + Execution + OutputPolicy）
- TriggerEngine — 触发规则引擎
- AgentSwarm — 多 Agent 编排器（hierarchical/pipeline/broadcast/peer-to-peer）
- DefaultAgentRegistry — Agent 注册与发现

## 不做什么

- 不做工具执行（那是 plugin-ecosystem 的事）
- 不做任务管理（那是 task-system 的事）

## 依赖

- Core: loop/、primitives/、types/、interfaces/
- Harness: reliability、security

## 文件说明

- distributed/ — 分布式运行时（runtime, spec, trigger, input-policy, output-policy, execution, audit-trail）
- multi-agent/ — 多 Agent（registry, swarm, process）
- index.ts — 统一导出
