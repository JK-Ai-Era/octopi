# 上下文 Runtime UI 设计（System 契约层 + Information）

> 状态：P0–P2 已实现；已纠偏「产品七层 ≠ ContextLayer」  
> 范围：Web UI 实时呈现；System 装配层可观测 + Information 一等面板  
> 关联：`docs/context-layer-contracts.md` · `docs/web-runtime-design.md` · `web/DESIGN.md`  
> **概念约定**：产品七层第 7 层 = Information（session）；ContextLayer 契约第 7 位 = Runtime（附加，非 Information）

---

## Identity

**Product UI Designer × Information Designer**  
先问：开发者 90% 时间看到的状态是什么？再问：读者要做的那一个比较是什么？

---

## Grounding

已有信号足够，不走 5 向选择：

- 工作台已是 chat-first 三栏（`web/src/components/ChatWorkspace.tsx`）
- 右栏检查器目前是 KV + `JSON.stringify(inspector)`，**没有层语义**
- `docs/web-runtime-design.md` 已定位 Inspector / ContextPanel，但未定义七层呈现
- 后端 **`AssembleManifest` 已计算完毕**，却在 `runner.ts` 被丢弃

**假设：** 本功能是 Octopi Web Runtime 的「Context 检查器」，参考 Linear/Figma 检查器密度 + 分馏柱隐喻，而不是通用后台。  
**刻意延后：** 真实 store 的 embedding/检索打分 UI（等层实现打磨后再加）。

---

## 问题定义

两个使用场景共用同一数据面：

| 场景 | 用户问题 | UI 任务 |
|------|----------|---------|
| 开发打磨 | 「我改了 Memory 层，本轮有没有进 system？被截断了吗？」 | 逐层状态 + reason + tokens 必须一眼可读 |
| 对外 Demo | 「Octopi 的核心价值是什么？」 | 让「信息分馏」变成可看见的结构，而不是口号 |

**不是**要做：通用 APM、全量 prompt 编辑器、多用户权限后台。

---

## 现状与缺口（代码事实）

### 已有

| 能力 | 位置 |
|------|------|
| 层契约 + order/priority/share | `src/harness/context/layer-types.ts` |
| 装配算法 + manifest | `src/harness/context/assembler.ts:242-267` |
| 薄层 + `createDefaultLayers` | `src/harness/context/layers.ts` |
| 生产装配（Persona/Skill/Knowledge/Memory/Runtime） | `src/harness/context/system-prompt-assembler.ts:75-104` |
| 压缩可观测事件 | `context.compact.*` → Web store inspector |
| WS + REST 骨架 | `src/integration/protocols/http.ts` · `src/integration/web/api/router.ts` |
| Web Runtime store | `src/integration/web/runtime/store.ts` |

### 最高杠杆缺口

`AssembleManifest` 在装配成功后 **没有进入任何生产消费路径**：

```
assembler 返回 { systemPrompt, manifest }
  → system-prompt-assembler.ts:127 仍返回 manifest
  → runner.ts:207-215 类型收窄为 Promise<{ systemPrompt }>
  → runner.ts:456-467 只赋值 systemPrompt
  → manifest 丢弃
```

没有事件、没有 REST、没有 SQLite 快照 → Web UI **不可能**真实呈现层状态。

### 其它缺口

1. Wisdom / Cognition 契约层存在，但默认装配 **未注册**（demo 若展示「七层」会缺两层）
2. Gateway `getMemoryStats` / `queryMemory` 仍是 stub
3. Web store `InspectorState` 无 layer 字段
4. 右栏无 Context 组件

---

## 信息架构（用户要按什么顺序知道）

1. **本轮 system 预算怎么花的**（总额 / 已用 / 预留）
2. **七层各自的命运**（纳入 / 空 / 丢弃 / 失败 / 未注册）
3. **为什么**（manifest.reason / dropped，原文）
4. **带来什么**（sources 数量与 id；preview 可选）
5. **Information 消息窗口**（与七层分离：compact / tokens / window）
6. **与上一轮差异**（二期：turn timeline）

主比较（Information Designer 的第一问）：  
**「同一轮里，哪些层真正占用了 token，哪些层被预算竞争挤掉了？」**  
所有编码都为这个比较服务。

---

## 视觉方向

### Style anchor

**科学仪器读数 × Linear 检查器**  
不是「agent 大脑插画」，不是 SaaS 卡片墙。七层 = 分馏柱上的刻度段。

### Palette

- 仪器底：`#0b1220` / surface `#111827`（Context Runtime 区域）
- 工作台沿用现有 light neutral（chat 不抢戏）
- 层固定色：见 `web/DESIGN.md` §3a（禁止彩虹 pie）
- 状态色：included teal / warn amber / error red / empty·unregistered muted

### Typography

UI sans + mono 读数。层名 13–14px/600；tokens/reason mono 12px。

### Layout system

```
┌──────────┬────────────────────┬──────────────────────────┐
│ Left     │ Chat               │ Context Runtime (right)  │
│ sessions │ 主对话             │ 预算条                    │
│ agents   │                    │ ┌──────────────────────┐ │
│          │                    │ │ 七层分馏栈（主区）    │ │
│          │                    │ └──────────────────────┘ │
│          │                    │ Information 窗口 strip   │
│          │                    │ 选中层详情               │
└──────────┴────────────────────┴──────────────────────────┘
```

- **桌面右栏页签（已确认）：** `上下文 | 任务 | 工具 | 帮助`
  - **上下文**：默认 Tab，七层分馏栈 + 预算条 + Information strip + 层详情
  - **任务 / 工具**：保持现有一等页签，内容与交互不变
  - **帮助**：保留
  - **原「检查」**：不再是顶层页签；KV/运行状态并入「上下文」顶部摘要，`JSON.stringify(inspector)` 降为上下文面板底部「原始数据」折叠
- **Focus / Demo：** 右栏扩到 ~50% 宽或全屏 overlay；chat 压缩为窄条；**同一数据路径**
- **移动：** 上下文为独立 tab，层栈纵向全宽

### 签名时刻（memorable）

1. **分馏栈亮起**：一轮 assemble 完成时，七条 band 按 order 依次获得 status/token 填充（短、可关）
2. **预算条塌缩**：dropped 层在 budget bar 中以空槽 + 理由标注出现，与 included 层形成对比

---

## 组件与布局（Structure）

### ContextRuntimePanel

| 区块 | 内容 | 主次 |
|------|------|------|
| BudgetHeader | systemBudget · usedTokens · reserve · query 摘要 | 次 |
| BudgetBar | stacked tokens by layer + unused | 主（比较） |
| LayerStack | 7 × LayerBand，按 order | **主** |
| InformationStrip | compact 状态、contextTokens/window | 次（刻意非层） |
| LayerDetail | 选中层：share/budget/tokens/reason/sources/preview | 钻取 |
| StoreHealth（二期） | 各 store 计数（memory entries, skills…） | 周边 |

### LayerBand（单层）

```
│▌ Persona          纳入    1.2k / 3.5k  ▓▓▓▓░░░░  prio 100
│  persona · droppable=false · sources: persona
```

状态徽章文案（固定词表，与 manifest 对齐）：

| status | 徽章 | 含义 |
|--------|------|------|
| `included` | 纳入 | 进入 systemPrompt |
| `included` + warn reason | 纳入·告警 | 如 over budget but kept |
| `empty` | 空 | assemble 无内容 |
| `dropped` | 丢弃 | 预算竞争失败（显示 reason） |
| `error` | 失败 | assemble 抛错 |
| `unregistered` | 未注册 | 本轮 layers 列表中不存在（≠ empty） |
| `idle` | 待装配 | 尚无本轮 manifest |

### 数据流（必须）

```
DefaultContextAssembler.manifest
    ↓  (gap-closing)
SessionAwareRunner 捕获 assembled.manifest
    ↓
EventBus: context.layers.assembled
    ↓
Gateway 缓存 lastContextLayers[sessionId]
    ↓                    ↓
WS broadcast         GET /api/v1/sessions/:id/context/layers
    ↓
OctopiRuntimeStore → inspector.contextLayers
    ↓
ContextRuntimePanel
```

**原则：** UI 不二次模拟装配；只消费快照。开发验证时改层实现 → 下一轮 manifest 变化 → UI 变化。

---

## 后端契约（最小）

### 事件

`src/harness/events/agent-event-map.ts` 增：

```ts
'context.layers.assembled': {
  sessionId: string;
  agentId?: string;
  manifest: AssembleManifest;
  /** 检索查询（可选，便于 UI 显示 memory/knowledge 为何 empty） */
  query?: string;
  /** 本轮启用的层 id（用于区分 unregistered） */
  enabledLayerIds: ContextLayerId[];
};
```

装配失败回退 concat 时可选发：

```ts
'context.layers.assembled': { ..., fallback: true, error?: string, manifest?: empty }
```

### REST

```
GET /api/v1/sessions/:id/context/layers
→ { ok, data: ContextLayersSnapshot | { configured: false } }
```

### Snapshot DTO（Web）

```ts
type LayerUiStatus =
  | 'idle' | 'included' | 'empty' | 'dropped' | 'error' | 'unregistered';

interface LayerRuntimeView {
  id: ContextLayerId;
  status: LayerUiStatus;
  included: boolean;
  tokens: number;
  budgetTokens: number;   // contentBudget * normalizedShare
  priority: number;
  order: number;
  droppable: boolean;
  reason?: string;
  dropped?: string;
  sources?: string[];
  contentPreview?: string; // ≤400 chars，debug 开关控制
}

interface InformationWindowView {
  contextTokens?: number;
  contextWindow?: number;
  compact?: InspectorState['compact'];
}

interface ContextLayersSnapshot {
  sessionId: string;
  assembledAt?: number;
  systemBudget: number;
  usedTokens: number;
  shares: Partial<Record<ContextLayerId, number>>;
  query?: string;
  layers: LayerRuntimeView[]; // 含 unregistered 占位，保证 UI 始终 7 行
  information?: InformationWindowView;
  fallback?: boolean;
}
```

### 最小后端改动清单

| 优先级 | 改动 | 文件 |
|--------|------|------|
| P0 | assembler 返回类型保留 `manifest` | `runner.ts:207-215,261-270` |
| P0 | 捕获 manifest，emit `context.layers.assembled` | `runner.ts:456-467` |
| P0 | 事件类型注册 | `agent-event-map.ts` |
| P0 | Gateway 缓存 + 转发 WS | `gateway.ts` |
| P0 | REST last snapshot | `web/api/router.ts` |
| P0 | store 映射 + `contextLayers` | `web/runtime/store.ts` |
| P0 | UI：Context tab + LayerStack | `web/.../ChatWorkspace` 或拆分组件 |
| P1 | Builder 接线 Wisdom/Cognition（可选依赖） | `system-prompt-assembler.ts` / `builder.ts` |
| P1 | contentPreview 开关（config） | assembler 或 runner 侧 enrich |
| P2 | Store health REST（补 memory stub） | gateway + router |
| P2 | 近 N 轮 layer timeline | store 环形缓冲 + UI |

---

## 前端集成

- `InspectorState` 扩展：`contextLayers?: ContextLayersSnapshot`
- `store.ts` applyEvent：处理 `context.layers.assembled`
- SDK：`getSessionContextLayers(sessionId)`
- Tab：`上下文` | `任务` | `工具` | `帮助`（无独立「检查」/「原始」顶层页签）
- 打开 session / 连接成功：`GET` 一次 last snapshot，避免空白
- 无 snapshot：显示 **教学型空状态**（说明装配后出现什么，而非 “No data”）

---

## Demo 叙事（同一 UI）

1. 打开会话 → 右栏出现七层栈（可能 idle / 未全注册）
2. 发一条消息 → 分馏栈刷新：persona/skill/runtime 纳入，memory 视 query
3. 故意塞长 runtime / 弱 memory store → 看到 dropped + reason
4. Focus 模式放大栈，对照 budget bar 讲「priority 与 share」
5. 指出 Information strip：消息窗口压缩与 system 层是两套机制

价值句（可用）：  
**「Octopi 把 agent 的上下文当成可装配、可竞争预算、可观测的分馏系统——而不是一整块黑盒 prompt。」**

---

## Decision Trace

```json
[
  {
    "decision": "以 AssembleManifest 为唯一 UI 真源，不在前端重算层状态",
    "reason": "契约文档明确 manifest 用于解释 agent 行为；双真源会在打磨期立刻漂移",
    "alternatives": ["前端按 share 模拟", "每层独立 REST 轮询再拼装"],
    "tradeoff": "后端必须先把 manifest 接到事件；UI 在接线完成前只能显示 idle/教学空态"
  },
  {
    "decision": "签名视觉 = 纵向七层分馏栈 + 单条 stacked budget bar",
    "reason": "七层模型本质是 order/priority/share 竞争；纵向栈同时编码顺序与状态，直接服务「谁占了预算」这一主比较",
    "alternatives": ["7 张 KPI 卡", "饼图份额", "径向 sunburst"],
    "tradeoff": "横向对比多轮历史时不如 timeline 紧凑（放到二期）"
  },
  {
    "decision": "右栏改为 上下文|任务|工具|帮助；上下文替换原「检查」，任务/工具保留，JSON 降为上下文内折叠",
    "reason": "七层验证是主线，但任务/工具仍是运行时刚需；替换检查页签可在不增加页签拥挤的前提下把最强结构放到默认位",
    "alternatives": ["五页签并存", "七层改中栏侧滑", "删除任务/工具腾位置"],
    "tradeoff": "原检查页签肌肉记忆要改；原始 JSON 多一次折叠展开"
  },
  {
    "decision": "Information 显示为独立 strip，不伪装成第 8 个 ContextLayer",
    "reason": "契约写明 Information 由 ContextEngine 管窗口；UI 与架构同构才能当 demo 真源",
    "alternatives": ["UI 合成 8 层模型"],
    "tradeoff": "对外讲解时要多一句「为什么是 7+1」"
  },
  {
    "decision": "unregistered / empty / dropped 三态强制区分",
    "reason": "当前 Wisdom/Cognition 默认未注册；若 UI 全画成 empty，开发会误判「层实现返回空」",
    "alternatives": ["未注册不渲染该层"],
    "tradeoff": "栈上永远 7 行，未接线层会略「空」——这是诚实，也是 roadmap 可视化"
  },
  {
    "decision": "Context Runtime 区域用深色仪器底，chat 保持现有浅色工作台",
    "reason": "demo 需要一眼区分「对话」与「运行时观测」；全站改深会提高打磨期 UI 成本",
    "alternatives": ["全站 dark", "全部保持浅色"],
    "tradeoff": "双色域切换要做清晰边界与对比，避免像两套产品"
  },
  {
    "decision": "contentPreview 默认截断，全文不进默认 UI",
    "reason": "system prompt 片段可能含 persona/记忆细节；开发验证用 preview+sources 通常足够",
    "alternatives": ["默认展示完整 systemPrompt"],
    "tradeoff": "深度调试需点开原始/后续加 debug 开关"
  },
  {
    "decision": "P1 才接线 Wisdom/Cognition，UI 先诚实显示未注册",
    "reason": "本次主目标是可观测闭环；层业务打磨在契约稳定后逐个替换 assemble，不应被 UI 进度阻塞",
    "alternatives": ["UI 项目内先假注册两层"],
    "tradeoff": "完整七层 demo 需等 P1；短期 demo 用「未注册」讲架构现状也成立"
  }
]
```

---

## Anti-slop self-check

**flagged + corrected:**

| Pattern | Correction |
|---------|------------|
| D1 KPI 卡片行 | 改为 LayerStack + BudgetBar，一屏一个主比较 |
| C5 七段饼图 | 禁用；stacked bar + 层色 |
| D3 空状态 “No data” | 教学型空态：说明装配后将显示什么、当前缺哪条事件 |
| U3 emoji 层图标 | 仅文字状态徽章 |
| U7 空洞 demo 文案 | 使用「分馏 / 预算竞争 / 未注册」等契约词汇 |

---

## 分期交付

| Phase | 目标 | 完成定义 |
|-------|------|----------|
| **P0 Truth** | manifest → 事件 → WS/REST → store | 一轮对话后 UI 层状态与 manifest 一致 |
| **P0 UI** | Context tab + 栈 + budget + detail + information | 开发者可指出某层 reason |
| **P1 Layers** | Wisdom/Cognition 注册 + preview 开关 | 七层均有真实数据路径 |
| **P2 Depth** | store health、turn timeline、focus demo 模式打磨 | 对外 demo 一条完整路径稳定可讲 |

> 进度：P0 + P1 + P2 已实现（runner→事件→右栏；wisdom/cognition；preview；Gateway serve 接线 stores/skills；store health REST；近轮 timeline；Focus 模式）。

---

## 相关文件（实现时）

| 文件 | 动作 |
|------|------|
| `src/harness/runner.ts` | 捕获 manifest + emit |
| `src/harness/events/agent-event-map.ts` | 新事件 |
| `src/integration/gateway/gateway.ts` | 缓存 + REST/WS |
| `src/integration/web/api/router.ts` | `GET .../context/layers` |
| `src/integration/web/sdk/client.ts` | fetch 方法 |
| `src/integration/web/runtime/store.ts` | inspector.contextLayers |
| `web/src/components/ContextRuntimePanel.tsx` | 新组件 |
| `web/src/components/ChatWorkspace.tsx` | 挂载 tab |
| `web/src/styles.css` | layer tokens + band 样式 |
| `index.html`（仓库根原型） | 设计验证用静态原型，非生产入口 |
