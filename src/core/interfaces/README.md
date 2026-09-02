# Interfaces — 接口契约

> Layer: Layer 1

框架的所有接口定义。这是 Core 层和 Harness 层之间的契约。

**核心理念**：接口是框架最有价值的资产。好的接口让外层可以自由替换实现。

## 职责

- ModelProvider — LLM 调用接口
- ContextEngine — 上下文管理接口
- SecurityGuard — 安全守卫接口
- SessionStore — Session 持久化接口
- Observer — 可观测性接口
- ErrorStrategy — 错误处理接口
- TaskSupervisor — 任务监督接口
- AgentRegistry — Agent 注册接口
- McpClient — MCP 客户端接口
- ReliabilityHarness — 可靠性装备接口
- TaskDecisionProvider — 任务决策接口
- SandboxProvider — 沙箱接口
- Workspace — 工作区接口
- ApprovalProvider — 审批接口
- MemoryStore — 记忆存储接口
- WisdomStore — 智慧存储接口
- ConceptGraphStore — 认知图谱接口

## 不做什么

- 不包含任何实现
- 不 import 实现文件
- 只 import 其他 interface 文件或 types.ts

## 依赖

- Core: types/（类型定义）

## 文件说明

每个 interface 文件定义一个接口。所有接口从 index.ts 统一导出。
