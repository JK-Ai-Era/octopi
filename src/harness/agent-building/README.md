# Agent Building — Agent 构建

> Layer: Layer 2

组装 Agent 运行时，加载人格配置，桥接配置文件。

**核心理念**：Builder 是组装点，把所有组件拼装成可运行的 Agent。

## 职责

- AgentBuilder — Fluent API，一行启动 Agent
- PersonaLoader — 文件式人格加载（根目录 AGENTS.md + persona/ 下补充人格）
- ConfigBridge — 配置文件 → 新架构桥接

## 不做什么

- 不做业务逻辑（那是各领域的事）
- 不直接执行 Agent（那是 runner 的事）

## 依赖

- Core: types/、interfaces/
- Loop: AgentTool 等协议类型
- Harness: **agent/**（门面）、reliability、context、security、concurrency、plugin-ecosystem、multi-agent、autonomous-subsystem、session-tasks、run-guard

## 文件说明

- builder.ts — AgentBuilder（组装组件；build 后 `agent.setHarness(harness)`）
- persona.ts — 人格加载（AGENTS.md + persona/*.md）
- config-bridge.ts — JSON 配置 → Agent 组件
- index.ts — 统一导出
