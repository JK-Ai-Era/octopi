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

### 概念模型 vs 契约层（纠偏说明）

| 口径 | 七层列表 | 含义 |
|------|----------|------|
| **产品概念模型** | Wisdom → Persona → Skill → Knowledge → Cognition → Memory → **Information** | Information = **session 消息**；整条分馏链 |
| **ContextLayer 契约（system）** | wisdom → persona → skill → knowledge → cognition → memory → **runtime** | 只描述 **system prompt 片段**；**runtime ≠ Information** |

- **Runtime**：契约附加层，收编 `injectedContext`（会话任务 / guidance），仍属 system 侧，不进消息窗口。
- **Information**：session / 消息历史；**禁止**作为 ContextLayer 塞进 `DefaultContextAssembler`。
- 装配不变量：Assembler 只产 systemPrompt + manifest；消息窗口永远走 ContextEngine。

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

- **order ≠ priority**：order 决定在 system prompt 中的先后；priority 决定总预算不够时谁先留下。
- **defaultShare**：历史参考值，**不再**驱动 Assembler 配额；需要单层限制时配置 `contextAssembler.layerShares`（硬顶）。
- **runtime** 是契约附加层（**不是**产品七层里的 Information），收编现有 Runner 的 `injectedContext`（会话任务 / 子系统 guidance），靠近对话侧。

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

**预算语义：**

1. **默认只控总预算**：`systemBudget`（扣 `structureReserve` → `contentBudget`）
2. 各层按实际内容 `assemble`；**不**按 `defaultShare` 做全局配额
3. 按 **priority 从高到低**占用总预算；装不下则 droppable 截到剩余或丢弃
4. **可选硬顶**：`layerShares[id]` 配置了才生效 —— `maxTokens = floor(contentBudget × share)`，超出先截到硬顶再竞争总量；未配置层无单层上限
5. 按 `order` 用 `\n\n---\n\n` 拼接
6. 返回 `{ systemPrompt, manifest }`

**托管 systemPrompt 与会话落盘：**

- Loop 每轮将 `context.systemPrompt` 以 `role=system` + `metadata.source='systemPrompt'` 注入 messages
- **Session 持久化保留该消息**（审计：可事后还原「本轮 system 是什么」）
- **Web 聊天历史不回放**：`buildHistoryItems` 跳过 `source==='systemPrompt'` 与特征明显的人格长 system
- 运行时可观测仍走 `context.layers.assembled` / 上下文面板，不依赖聊天气泡

**可观测通道：**

- Assembler 可将层正文写入 `manifest.layers[].content`（本地缓存 / REST 点选用）
- **WS 广播 `context.layers.assembled` 会剥离 `content`**（preview 保留）；UI 点选层时经 `GET /sessions/:id/context/layers` 拉取全文
- Gateway `lastContextLayers` FIFO 上限 256 session

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
       system 契约层: Persona + Skill + Knowledge + Memory + Cognition + Wisdom + Runtime
  → agent.context.systemPrompt
  → convertToLlm → DefaultContextEngine（**Information**：消息窗口 + 主动摘要）
  → AssembleResult.compactState → Agent → Session.contextCompact（save 前）
```

- Builder `build()` 默认挂 Assembler；装配失败回退旧字符串拼接  
- 未显式 `.summarize()` 时，Builder 用主模型自动挂 `createProviderSummarize`  
- `config-bridge` 在存在 `models.level.mini` 时改用 mini provider 做摘要  
- 可用 `.disableAutoSummarize()` 关闭自动摘要  
- **Skill**：`skillDirectory` 或 `home/skills` 在 build 时 discover，每轮注入 `<available_skills>`  
- **Memory/Knowledge 召回**：`builder.memoryStore` / `knowledgeStore`；config-bridge 与 Gateway 从 `home/agent.db` 建 `SqliteMemoryStore`，Knowledge 暂用进程内 `MemoryKnowledgeStore`
- **MemoryStore 单实例**：`AgentBuilder.build()` 在 `buildCore` 前用 `builder.memoryStore` 注册 `memory_store`/`memory_search`；MemoryLayer 召回与 `memory.extractor` 入库同一实例。Gateway **不再**用进程级 `InMemoryMemoryStore` 挂全局 memory 工具
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

**已接线（含 P1/P2 层扩展）：**

- Builder 可注入 `wisdomStore` / `cognitionStore`；`config-bridge` 与 **Gateway.buildAgent** 在 agent home 的 `AgentDatabase` 上挂 Memory/Wisdom/Cognition/Knowledge，并 discover `skills/`
- Gateway 为 agent 设置 `builder.agentHome(home)` + `builder.agentId(id)`，extract 落盘与 Memory SQLite 同属 agent home
- 默认 `createDefaultSystemPromptAssembler` 在依赖存在时注册 Wisdom / Cognition 层
- `octopi.json` → `contextAssembler.includeLayerPreview` 可在 manifest 写入层 preview（Web 上下文面板）
- `GET /api/v1/agents/:id/context/health` 暴露 store 计数（数据面健康）
- Knowledge 的 SQLite 持久化仍缺（进程内 `MemoryKnowledgeStore`）

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
