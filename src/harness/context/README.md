# Context Management — 上下文管理

> Layer: Layer 2

消息选择、压缩、Token 估算，以及七层 **system prompt 内容契约与装配**。

**核心理念**：
- **内容层**（ContextLayer / Assembler）决定 system prompt 里有什么
- **窗口层**（ContextEngine）决定历史消息怎么压
- **算法委托**：结构压缩算法在 **`harness/capabilities/compact`**；本域维护 **E4 状态**与会话窗口语义

## 职责

### 内容契约（七层）
- `layer-types.ts` — ContextLayer / AssembleManifest 契约
- `assembler.ts` — DefaultContextAssembler（份额归一化 + priority 纳入）
- `layers.ts` — 薄适配层（persona/skill/knowledge/memory/cognition/wisdom/runtime）
- `system-prompt-assembler.ts` — Runner 每轮 system 装配（persona + runtime，已接线）
- `summarize.ts` — 摘要 provider 挑选（`models.level.summary` → mini → standard → 主模型）；Builder/config 自动挂 `createProviderSummarize`

### 窗口管理
- DefaultContextEngine — 消息窗口入口（预算 → 选择 → 路由 → 压缩）；内部状态键默认含 **agentId**（E4）；`structuralCompact` **委托** `capabilities/compact`
- SmartRouter — 路由决策（fits / truncate / compact）
- DefaultMessageSelector — 四区域消息选择
- HybridCompressor — 混合压缩（工具截断 + LLM 摘要 + 截断兜底）；proactive 路径仍可用
- HeuristicTokenEstimator — 启发式 Token 估算
- **compact-key.ts** — `compactStateKey(sessionId, agentId)`（宪法 E4）

设计说明见 [docs/context-layer-contracts.md](../../../docs/context-layer-contracts.md)。公用能力见 `src/harness/capabilities/`（SummaryPort / CompactEngine）。

## 不做什么

- 不做安全检查
- 不做工具执行
- 不做可靠性包装
- **不**持有 tools 端 L1/L2 硬顶（在 capabilities + plugin tools）
- **不**把 E4 会话 compact 持久化放进 capabilities

## 依赖

- Core: types/messages
- Memory 契约：KnowledgeStore / MemoryStore / ConceptGraphStore（薄适配）
- Harness 同层：`capabilities/compact`（结构压缩算法；类型/端口，非 tools）

## 文件说明

- layer-types.ts — 七层契约（优先于各层实现）
- assembler.ts — system prompt 装配器
- layers.ts — 薄层适配 + createDefaultLayers
- default-context-engine.ts — 消息窗口引擎（E4 状态；结构压缩委托 capabilities）
- smart-router.ts — 智能路由
- message-selector.ts — 四区域选择
- hybrid-compressor.ts / llm-summarizer.ts / truncate-compressor.ts — 会话路径压缩组件
- budget-allocator.ts — 消息侧 Token 预算分配
- token-estimator.ts / token-estimate-fns.ts / token-constants.ts — 估算（跨域经 `context/index.ts` 门面；浏览器可直连 token 模块）
- knowledge/ — KnowledgeStore + KnowledgeContextEngine
- compact-key.ts — E4 compact 键 `(sessionId, agentId)`

> 导出：`src/harness/context/index.ts` 与 `src/harness/index.ts`。
> 七层内容组装以本目录 `ContextLayer` 契约为准；旧 `ContextIntelligence` 已删除。
> Token 估算是本域策略，不是 Core Kernel 能力；Budget 计量吃真实 `usage`，不走启发式。
> Summary/Compact **公用能力**（工具 L2、旁路可调用）在 `harness/capabilities/`，不在本目录重复实现算法。
