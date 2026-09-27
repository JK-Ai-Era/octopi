# Plugin Ecosystem — 插件生态（扩展点 + 调用面）

> Layer: Layer 2

Plugin 系统、Skill 管理、工具注册、MCP 集成、对话斜杠命令。

**核心理念**：Skill 是 Tool 和 Agent 之间的桥梁。两阶段加载控制 Token 开销。  
**调用面**：`tools/` 供 Agent（function call）；`commands/` 供 Principal（对话 `/xxx`）。Command 不是顶层能力域，也不是 HITL。

## 职责

- PluginManager — 顶层管理器 + HookRegistry
- ToolRegistry — 工具注册中心（Agent 调用面）
- SkillManager — 两阶段加载（启动时元数据 + LLM 按需加载）；`command` 字段可桥接 `/name`
- McpManager — MCP Client 管理
- CommandRouter — 会话内 `/xxx`：parse / 注册 / 冲突裁决 / execute；`sessionOps` 由 Host 落地

## 不做什么

- 不做安全检查（那是 security 领域的事）
- 不做审批策略（HITL；命令只在 risk 时借用）
- 不做任务管理
- 不直接改 session/model 状态（回 `sessionOps`）

## 依赖

- Core: types/（Kernel 词汇表）
- Product port: ToolBus（装配期，非 thin-run Kernel）
- 本域契约：skills/types.ts、mcp/types.ts、tools/web-search-types.ts、commands/types.ts
- 横切：`harness/diagnostics`（命令冲突上报 System Issues）

## 文件说明

- plugins/ — Plugin 系统（manager, hooks, loader, api, entry, capability, lifecycle, manifest）
- tools/ — 工具系统（registry, builtin, streaming, versioning）
- skills/ — Skill 系统（manager；frontmatter `command`）
- mcp/ — MCP 集成（manager, bridge, discovery）
- commands/ — 斜杠命令（router, parse, builtin, skill-bridge, user-source, plugin-bridge）
- index.ts — 统一导出
