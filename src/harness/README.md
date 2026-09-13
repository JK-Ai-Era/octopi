# Harness — Layer 2: 领域实现

15 个自包含领域，每个领域有自己的类型、实现、入口文件。

## 领域列表

| 领域 | 目录 | 职责 |
|------|------|------|
| Agent Building | `agent-building/` | Builder、人格加载、配置桥接 |
| Context Management | `context/` | 消息选择、压缩、Token 估算、智能组装、Knowledge |
| Security | `security/` | 风险评估、Shell 解析、降级策略 |
| Reliability | `reliability/` | 可靠性包装、断路器、重试 |
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
| Memory | `memory/` | 记忆、认知、智慧、七层智能组装 |

## 其他文件

- `runner.ts` — SessionAwareRunner（编排器，不属于任何领域）
- `index.ts` — Harness 层统一导出
- `types/` — Harness 层共享类型
- `budget/` — IterationBudget 资源约束
- `process/` — 进程管理
- `resources/` — 资源管理器

## 依赖规则

- 只依赖 Core 和 Loop
- 不依赖 Integration
- 领域间通过 Core 接口通信，不共享内部状态
