# Context Layer 契约设计

> 状态：契约已落地（`src/harness/context/layer-types.ts` / `assembler.ts` / `layers.ts`）  
> 范围：**只定契约与最小装配闭环**；各层业务实现后续逐个打磨。  
> 日期：与 v0.26 契约化阶段对齐

---

## 1. 分工：谁管 system，谁管窗口

| 组件 | 职责 | 不负责 |
|------|------|--------|
| **ContextLayer** | 单层内容如何产生（取数 + 格式化 + 层内截断） | 全局预算、拼接顺序 |
| **DefaultContextAssembler** | 多层预算竞争、纳入/丢弃、拼 system prompt、产出 manifest | 检索打分、消息压缩 |
| **ContextEngine**（现有） | 消息窗口选择 / 路由 / 压缩（Information 层） | system prompt 里有什么 |

```
Layer Providers ──► ContextAssembler ──► systemPrompt ──► ContextEngine.assemble ──► LLM
     │                                      │                      │
     └── 检索/格式化                      manifest              消息窗口压缩
```

**Information（历史消息）不是 ContextLayer**，继续由 `DefaultContextEngine` 管理。

---

## 2. 七层标识与默认参数

| id | order（位置） | priority（保序） | share（份额） | droppable | 当前 provider 来源 |
|----|---------------|------------------|---------------|-----------|-------------------|
| wisdom | 10 | 70 | 0.12 | yes | `WisdomStore.getAll()`（薄） |
| persona | 20 | **100** | 0.35 | **no** | `PersonaSource` / Runner resolve |
| skill | 30 | 60 | 0.15 | yes | `SkillManager.formatForPrompt()` |
| knowledge | 40 | 40 | 0.12 | yes | `KnowledgeStore.retrieve` |
| cognition | 50 | 20 | 0.06 | yes | `ConceptGraphStore.queryRelated` |
| memory | 60 | 30 | 0.10 | yes | `MemoryStore.retrieve` |
| runtime | 70 | 80 | 0.10 | yes | session tasks + injectedContext |

说明：

- **order ≠ priority**：order 决定在 system prompt 中的先后；priority 决定预算不够时谁先留下。
- **runtime** 是契约层，收编现有 Runner 的 `injectedContext`（会话任务 / 子系统 guidance），靠近对话侧。
- 默认顺序沿用架构文档的七层模型；注意力位置策略（是否把 wisdom 挪后）可通过改 `order` 调整，不动契约。

---

## 3. 契约要点（`ContextLayer`）

```ts
interface ContextLayer {
  id: ContextLayerId;
  priority: number;      // 预算竞争，越大越先保留
  defaultShare: number;  // 启用层之间归一化后的份额
  droppable: boolean;    // 超预算能否整层丢弃（persona=false）
  order: number;         // system prompt 位置

  fingerprint?(ctx): Promise<string | null> | string | null;
  assemble(ctx: LayerAssembleContext): Promise<LayerContent | null>;
}
```

设计不变量：

1. 层只产出自己的片段，**不得**改写其他层。
2. `assemble` 抛错 **不拖垮** 整体装配（Assembler 隔离并在 manifest 记录）。
3. 返回 `null` / 空文本 = 本层无内容（manifest 标 `empty`）。
4. 层 **不得假设** 自己一定被纳入最终 system。
5. 层自报 `tokens` 会被 Assembler 用统一 `TokenEstimator` 覆写。

---

## 4. 装配算法（DefaultContextAssembler）

1. 按 `order` 排序启用层  
2. `defaultShare` 在启用层之间归一化  
3. `contentBudget = systemBudget - structureReserve`  
4. 按份额得到每层 `tokenBudget`，**并行** `assemble`  
5. 按 `priority` 从高到低纳入：  
   - 空 / 失败 → 跳过  
   - 超份额且 `droppable` → 丢弃  
   - 超份额且 `!droppable` → 仍纳入，manifest 记 `over budget but kept`  
   - 总预算耗尽且 `droppable` → 丢弃  
6. 按 `order` 用 `\n\n---\n\n` 拼接  
7. 返回 `{ systemPrompt, manifest }`

`AssembleManifest` 含每层 `included / tokens / reason / dropped / sources`，供调试「agent 为什么变笨」。

---

## 5. 薄适配层（本阶段实现范围）

| 类 | 做什么 | 刻意不做 |
|----|--------|----------|
| `PersonaLayer` | 包装已加载人格文本 | 文件监听（仍归 PersonaSource） |
| `SkillLayer` | 包装 `formatForPrompt()` | 按任务匹配加载全文 |
| `RuntimeLayer` | 包装每轮动态注入 | — |
| `KnowledgeLayer` | `retrieve(query, top-k)` + 列表格式化 | embedding / 重排 |
| `MemoryLayer` | `retrieve({text, limit})` | 衰减策略调参 |
| `CognitionLayer` | `queryRelated` + 边列表格式化 | 深度遍历策略 |
| `WisdomLayer` | 全量按 priority 排序后截断 | 场景匹配 |
| `createDefaultLayers` | 只注册有依赖的层 | 自动发现 |

后续打磨任一层时：**只换 `assemble` 实现或替换类，不改契约。**

---

## 6. 与现有生产路径的关系

**已接线（P0）：**

```
Runner.handle
  → persona resolve（PersonaSource 热更新，不变）
  → session.contextCompact → Agent 播种
  → session tasks / guidance → injectedContext
  → createDefaultSystemPromptAssembler
       layers: PersonaLayer + SkillLayer + KnowledgeLayer + MemoryLayer + RuntimeLayer
  → agent.context.systemPrompt
  → convertToLlm → DefaultContextEngine（消息窗口 + 主动摘要）
  → AssembleResult.compactState → Agent → Session.contextCompact（save 前）
```

- Builder `build()` 默认挂 Assembler；装配失败回退旧字符串拼接  
- 未显式 `.summarize()` 时，Builder 用主模型自动挂 `createProviderSummarize`  
- `config-bridge` 在存在 `models.level.mini` 时改用 mini provider 做摘要  
- 可用 `.disableAutoSummarize()` 关闭自动摘要  
- **Skill**：`skillDirectory` 或 `home/skills` 在 build 时 discover，每轮注入 `<available_skills>`  
- **Memory/Knowledge 召回**：`builder.memoryStore` / `knowledgeStore`；config-bridge 从 `home/agent.db` 建 `SqliteMemoryStore`（better-sqlite3 可用时），Knowledge 暂用进程内 `MemoryKnowledgeStore`  
- **压缩状态落盘**：`SessionData.contextCompact`（`summary` + `lastProactiveMessageCount` + `lastProactiveTokens`）；重启后 `loadCompactState` 恢复，增量小则缓存重建、不再立刻打 LLM  

**主动摘要（防长会话失忆）：**

- `DefaultContextEngine.proactiveCompactRatio`（默认 `0.6`，`0` 关闭）
- 消息 token 超过 `messagesBudget × ratio` 时，在硬溢出前压缩中间段
- 增量很小时用 `previousSummary + head/tail` 重建视图，不重复打 LLM
- 配置：`octopi.json` → `contextEngine.proactiveCompactRatio`

**主动 LLM 摘要冷却（`proactiveCooldownMs`，默认 30s，`0` 关闭）：**

- 冷却期内即使增量达到再摘要阈值，也**优先缓存重建**，避免单 turn 主动摘要 + 硬溢出摘要双打 LLM
- **已知边界**：`protectLastN = 20` 时，若冷却窗口内新增消息数 > `protectLastN`，则中间新增消息既不在旧摘要覆盖范围、也不在当前 tail 中，需等冷却结束后的下一轮 assemble 才会进入 LLM 视图  
  - 30s 内刷 20+ 条不常见；自动化/子系统高频写会话时可把 `proactiveCooldownMs` 调小或设为 `0`
- 配置：`octopi.json` → `contextEngine.proactiveCooldownMs`

**压缩可观测事件（UI 防「假卡死」）：**

- `AssembleParams.emit` → Builder 桥到 EventBus
- `context.compact.start` / `end` / `error`（`reason: proactive|overflow`，`cached` 标记缓存重建）
- 失败不中断本轮（回退截断）；UI 订阅后可显示「正在压缩上下文…」

**LLM 消息契约（P1 修复）：**

- 托管 system（`metadata.source === 'systemPrompt'`）在 `buildLlmMessages` 中跳过，避免与 `systemPrompt` 参数重复注入
- 压缩摘要 / 截断说明使用 **`role: 'user'`** + `metadata.source === 'contextSummary'`，不产生中段 system
- 无 metadata 的外部 system 消息仍原样保留

**尚未接线：**

- Wisdom / Cognition 层（契约与薄适配已有，默认路径未注册）  
- Knowledge 的 SQLite 持久化（当前进程内 store）  

---

## 7. 本阶段不做

- 不实现 embedding 检索 / 相关性重排  
- 不改 `DefaultContextEngine` 窗口算法本身  

---

## 8. 相关文件

| 文件 | 说明 |
|------|------|
| `src/harness/context/layer-types.ts` | 契约 + 默认 order/priority/share |
| `src/harness/context/assembler.ts` | `DefaultContextAssembler` |
| `src/harness/context/layers.ts` | 薄适配层 + `createDefaultLayers` |
| `src/harness/context/system-prompt-assembler.ts` | Runner 每轮 system 装配端口 |
| `src/harness/context/summarize.ts` | 默认 LLM 摘要函数 + mini 挑选 |
| `tests/harness/context-layer-contracts.test.ts` | 契约行为测试 |
| `tests/harness/context-wiring-p0.test.ts` | 接线回归 |
