# Interfaces — 接口契约

> Layer: Layer 1

## Kernel ports（thin run 必需）

- ModelProvider — LLM 调用
- ErrorStrategy — 错误处理
- SecurityGuard — 安全检查
- RunGuard — 过程监督
- ReliabilityHarness — reliability 装配

## Product ports（类型可暂留 Core）

| 端口 | 角色 | 备注 |
|------|------|------|
| ToolBus | 装配/注册 | 非 thin-run |
| SessionStore | Session 聚合 | Runner/Gateway |
| Observer | 可选遥测 | 专题再议；Loop 用 LoopObserver |

## 已迁 Harness 的契约

| 契约 | 位置 |
|------|------|
| ContextEngine 及组件 | `harness/context/types.ts` |
| Memory / Wisdom / Cognition | `harness/memory/types.ts` |
| KnowledgeCatalogProvider | `harness/context/knowledge/types.ts` |
| Planner / Reflector | `harness/orchestration/cognitive-loop.ts` |
| AsyncTask + Store | `harness/orchestration/async-task*.ts` |
| Skill / AgentDefinition | harness plugin / types |
| Registry / MCP / HITL / WebSearch / Sandbox / EventSource / MessageChannel | harness 各域 |
