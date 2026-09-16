# Core — Kernel 契约 + 机制原语

> Layer: Layer 1

**产品定位**：Agent Runtime Kernel Contract — 一次 agent run 的稳定合同。

## 入口

| 包路径 | 内容 |
|--------|------|
| `octopi/core` | **仅 Kernel** + 可选 Product port 类型（见下） |

Domain / 产品契约主体在 **harness 领域**。

## Kernel ports（thin run 必需）

剥掉 Harness 后，薄 runner（`Agent.run` → reliability → `agentLoop`）仍需要：

- **ModelProvider** — 调模型
- **ErrorStrategy** — 错误决策
- **SecurityGuard** — 安全检查
- **RunGuard** — 过程监督
- **ReliabilityHarness** — reliability 装配

机制：EventBus、StateMachine；词汇表：Message / ToolCall / ModelInfo / ToolPolicy…

## Product ports（可留 Core 类型，但不是 thin-run 判据）

| 端口 | 真实角色 | 现位置 |
|------|----------|--------|
| **ToolBus** | 装配/注册期（Builder、MCP） | `core/interfaces/tool-bus.ts` |
| **SessionStore** | Session 聚合（Runner / Gateway） | `core/interfaces/session-store.ts` |
| **Observer** | 可选 Integration 遥测（专题再议） | `core/interfaces/observer.ts` |
| **ContextEngine** | 窗口装配；经 `convertToLlm` 接入 | **harness/context/types.ts** |
| **ContextLayer / ContextAssembler** | system prompt 七层内容装配 | **harness/context/layer-types.ts** |

## 可嵌入门禁（I/O 准则）

**合同可谈 I/O，内核不做 I/O，更不内置生产 I/O。**

| 允许 | 禁止 |
|------|------|
| 定义 ModelProvider / SessionStore 等端口 | 直接 fs / net / http / child_process |
| 纯内存默认实现 | 默认生产 Provider / 默认落盘 Store |

## 职责

- Kernel ports + 词汇表 + EventBus/StateMachine/Cron **机制**
- 安全纯函数（severityToAction / isValidSecurityGuard）
- **不包含**产品事件词表（AgentEventMap 在 harness/events）

## 不做什么

- 不实现策略；不 import Harness / Integration / Loop
- 不持有 Domain 产品契约（Memory、MCP、ContextEngine 实现…）
- 不做中心 Scheduler；点火策略在 Harness 各域

## 文件说明

- interfaces/ — Kernel + Product port 类型
- primitives/ — EventBus、StateMachine、Cron
- types/ — Kernel 词汇表
- index.ts — `octopi/core`
