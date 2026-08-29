# Plugin Ecosystem — 插件生态

> Layer: Layer 2

Plugin 系统、Skill 管理、工具注册、MCP 集成、斜杠命令。

**核心理念**：Skill 是 Tool 和 Agent 之间的桥梁。两阶段加载控制 Token 开销。

## 职责

- PluginManager — 顶层管理器 + HookRegistry
- ToolRegistry — 工具注册中心
- SkillManager — 两阶段加载（启动时元数据 + LLM 按需加载）
- McpManager — MCP Client 管理
- CommandPlugin — 斜杠命令系统

## 不做什么

- 不做安全检查（那是 security 领域的事）
- 不做任务管理

## 依赖

- Core: types/、interfaces/

## 文件说明

- plugins/ — Plugin 系统（manager, hooks, loader, api, entry, capability, lifecycle, manifest）
- tools/ — 工具系统（registry, builtin, streaming, versioning）
- skills/ — Skill 系统（manager）
- mcp/ — MCP 集成（manager, bridge, discovery）
- commands/ — 斜杠命令
- index.ts — 统一导出
