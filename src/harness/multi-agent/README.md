# Multi-Agent — 多 Agent 编排

> Layer: Layer 2

Agent 注册与发现、多 Agent 协作编排、可追踪的 Agent 进程。

**与 Autonomous Subsystem 的边界**：Multi-Agent 是 Worker/编排能力，管理「多个 Agent 实例如何协作」；Autonomous Subsystem 是主 Loop 外的 Sense/Think/Act 闭环，管理「子系统如何感知并回写」。二者正交，不互相替代。

## 职责

- DefaultAgentRegistry — Agent 注册与发现（实现本域 `agent-registry-types.ts` 的 `AgentRegistry`）
- AgentSwarm — 多 Agent 编排（hierarchical / pipeline / broadcast / peer-to-peer）
- OrchestrationStrategy — RoundRobin / Capability / Pipeline 三种可替换编排策略
- AgentProcess — Agent 进程运行时（父子关系、announce、context fork）

## 不做什么

- 不做自主子系统（那是 autonomous-subsystem 的事）
- 不做工具执行（那是 plugin-ecosystem 的事）
- 不做会话任务管理（那是 session-tasks / orchestration 的事）

## 依赖

- Core: loop/、primitives/、types/、interfaces/（AgentRegistry）
- Harness: reliability

## 文件说明

- registry.ts — DefaultAgentRegistry
- swarm.ts — AgentSwarm + 编排策略
- process.ts — AgentProcess / spawnAgentProcess / forkAgentProcess
- types.ts — Swarm 类型
- index.ts — 统一导出
