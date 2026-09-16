# Harness — Layer 2: 领域实现

15 个自包含领域，每个领域有自己的类型、实现、入口文件。

## 领域列表

| 领域 | 目录 | 职责 |
|------|------|------|
| Agent | `agent/` | **可运行门面**：`Agent.run()` = reliability 包装 |
| Agent Building | `agent-building/` | Builder、人格加载、配置桥接 |
| Context Management | `context/` | 消息窗口压缩、Token 估算、七层 ContextLayer 装配、Knowledge |
| Security | `security/` | 风险评估、Shell 解析、降级策略 |
| Reliability | `reliability/` | 可靠性包装、HarnessLoopEvent、断路器、重试 |
| Plugin Ecosystem | `plugin-ecosystem/` | Plugin、Tool、Skill、MCP、命令 |
| Multi-Agent | `multi-agent/` | Agent 注册发现、Swarm 编排、AgentProcess |
| Autonomous Subsystem | `autonomous-subsystem/` | Sense/Think/Act/Signal/Boundary 五维子系统框架 |
| Session Tasks | `session-tasks/` | 会话任务 SessionTask（goal/step，默认路径） |
| Run Guard | `run-guard/` | 过程监督（continue/recover/stop） |
| Agent Runtime | `agent-runtime/` | 激活宿主：Trigger → 受监督 Run（arch/agent-runtime.md） |
| Orchestration | `orchestration/` | experimental 编排（workflow/scheduler/planner） |
| Concurrency | `concurrency/` | 多 Key 负载均衡、限流 |
| Execution Environment | `execution-environment/` | 沙箱、工作区 |
| Human-in-the-Loop | `human-in-the-loop/` | 审批流程 |
| Memory | `memory/` | 记忆、认知、智慧、会话提取（七层组装在 `context/`） |

## 其他文件

- `runner.ts` — SessionAwareRunner（编排器，不属于任何领域；通过 `agent.run()` 驱动）
- `index.ts` — Harness 层统一导出
- `types/` — Harness 层共享类型
- `budget/` — IterationBudget 资源约束
- `process/` — 进程管理
- `resources/` — 资源管理器

## 依赖规则

- 只依赖 Core（Kernel）和 Loop
- 不依赖 Integration
- 领域间通过对方 **types** 通信，不共享内部状态；Domain 契约定义在本层领域内
- **推荐运行入口是 `harness/agent` 的 `Agent.run()`**，不要在业务路径手拼 `runAgentWithReliability`
