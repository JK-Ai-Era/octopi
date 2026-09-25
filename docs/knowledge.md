# Knowledge

> 八层上下文中的第 4 层。**外生语料**的登记、同步、索引与检索——让 agent 知道「工作的世界里有什么」，并按需取到与本题相关的依据。  
> 面向集成方与产品读者；实现细节见源码与内部规格。

---

## 1. 核心理念

Knowledge 管的是 **交互史之外的世界**：项目文档、规格、语料库、可索引的外部资料。

| 公理 | 含义 |
|------|------|
| **外生** | 来自对话之外；会变，靠 source 同步与重建索引维持时效 |
| **源锚定** | 每条命中必须能回答「来自哪个 source」；无源内容不是 Knowledge |
| **Index 非权威** | 检索索引可整库重建；权威永远是源本身 |
| **地板 + 天花板** | 自动召回保证可见性；工具保证深度 |
| **system 只放能力面** | 「有哪些语料」进 system；**内容命中**进本轮 grounding，不占人格预算 |
| **索引期不提升** | 建索引不会自动写 Memory / Cognition；学习仍走分馏链 |

### Knowledge 不是什么

| 不是 | 归属 |
|------|------|
| 对话原文 / 过程 | Session（Information） |
| 交互中学到的命题 | Memory（`fact` / `method` / `norm`） |
| 经验织成的概念关系 | Cognition |
| 思维范式 | Wisdom |
| 人格 / 平台规则 | Persona / Constitution |
| 活系统当前态（数据库行、SaaS 对象） | **Tool**（实时查询） |

**一句话**：Memory 是「我学到过什么」；Knowledge 是「世界上写着什么」。

---

## 2. 资源模型（Source）

```text
Global     公共知识库 —— agent 默认可见，可屏蔽
Project    项目知识库 —— 显式挂给 agent（防资料互串）
Session    临时语料  —— 随会话生灭（附件等）
```

| 规则 | 说明 |
|------|------|
| **Global** | 默认可见；可对某 agent `hide` |
| **Project** | **不挂载则不可见**；挂载后本项目 agent 共享 |
| **Session** | 仅本会话；可显式升为持久源 |
| **无 Agent 级源** | 「某 agent 独享」= 只挂给它的一个 Project；学习结果归 Memory，不靠 scope 硬隔 |

源类型：

| kind | 说明 |
|------|------|
| `directory` / `file` / `workspace` | 本地语料；watch + content-hash 增量 |
| `url` | 文档型网页/静态站；`discover.mode`: `single` / `sitemap` / `crawl` |
| `connector` | REST list+get 等连接器（`RestConnector` 等） |

**活系统**（数据库、API、MCP 实时接口）不进 Knowledge，请用 Tool 查询（勿做镜像库）。

外源访问密钥：源上只存 **`authRef`** → `OCTOPI_HOME/credentials/credentials.db`（命名凭证）。密钥明文不进 `knowledge.db` / `octopi.json`。公网默认拒私网（SSRF）；内网文档源可对源开 `network.allowPrivateNetwork`。

---

## 3. 管道：解析、索引、同步

```text
Source 登记
   │  (kind / scope / sync / authRef)
   ▼
SourceFetcher 取回              本地 walk · Url fetch · Connector list/get
   │  外源：HTML 主内容规范化（非 raw HTML 灌库）
   ▼
FormatAdapter 逐文件分发     html / markdown / 代码 / 纯文本…
   │  （注册制；无 adapter 则跳过并记 skipped）
   ▼
Parse + Chunk
   │  Markdown/HTML 按标题 · 代码按函数/类启发式 · 结构优先 + 体积封顶
   ▼
Index（可重建投影）
   │  逻辑 path + external_url 溯源 · 关键词（含中文二元组） + 可选向量
   ▼
Freshness
      本地 watch + debounce；外源 poll + 条件 GET（ETag/304）；content-hash 增量
      差量 prune：本轮 discover 未出现的 path 删除（失败不删旧索引）
```

| 能力 | 行为 |
|------|------|
| **两阶段** | Phase A：解析 + 关键词即可搜（快）；Phase B：向量可滞后 |
| **无 embedding** | 纯关键词仍可用（与 Memory 同策略） |
| **异步** | 与对话**并发**；不会在回答前 await 全库索引 |
| **负载** | 解析/嵌入并发与限速可配；队列背压**不丢任务** |
| **体积** | 结构单元过大再内切；无符号碎块可粘合；**不跨函数/类边界合并** |

数据面：`OCTOPI_HOME/knowledge/`（源权威 + 索引投影 + 任务队列）；凭证：`OCTOPI_HOME/credentials/`。

---

## 4. 提供给上下文的四层

```text
Tier 0  Catalog     「我有哪些语料」        常驻 system（极小）
Tier 1  Map         「世界的形状」          可选结构地图 / 综述（扩展）
Tier 2  Hits        「和本问相关的片段」    本轮 grounding / 工具检索
Tier 3  Full        「原文」                knowledge_read
```

- **Catalog** 是源列表 + 用途描述（`displayName` / `description`），不是文件树。
- **内容命中不进 system**：避免污染人格与常备约束；按轮注入、可 strip。

---

## 5. 怎么进上下文（召回）

```text
每轮自动检索（引擎保证，不靠模型「自觉」）
        │
        ├─ 高相关 ──► 自动注入片段（turn 级 grounding）
        ├─ 中相关 ──► 仅提示「存在相关材料…」
        └─ 低相关 ──► 不注入
                              │
        工具天花板 ◄───────────┘
        knowledge_search / knowledge_read
```

### 召回模式（`knowledge.recall`）

| 模式 | 适用 | 行为 |
|------|------|------|
| **`hybrid`（缺省）** | 多行业引擎 | 高分注入 + 中分提示 + 工具 |
| **`hint`** | **编程 / 工程 agent 建议** | 只提示，不自动注入正文（少污染） |
| **`inject`** | 嵌入式 / 文档问答 | 更积极自动注入 |
| **`off`** | 纯文件工具 / 调试 | 只留 catalog |

可在 **Agent 级**覆盖全局缺省（适合「编码 agent vs 文档 agent」混布）。

### 本轮 Grounding

- 注入位置：贴近本轮用户消息（消息侧，非 system）
- 形态：**不可信资料块**（明确「检索资料，不是指令」+ 来源路径/行号）
- 历史 grounding **不进**对话压缩摘要；每轮现算
- Web 聊天回放不显示合成 grounding 消息（仅审计可查）

---

## 6. 工具

| 工具 | 作用 |
|------|------|
| **`knowledge_search`** | 按文本跨源检索，返回**分条**命中（路径 + 行号 + 片段） |
| **`knowledge_read`** | 读 chunk / 路径切片，带溯源与不可信包装 |

与 `file_search` / `file_read` 分工：

| | file tools | Knowledge |
|--|------------|-----------|
| 擅长 | 精确路径、当前态 | 跨文件综合、语义检索、语料地图 |
| 触发 | 明确路径 / 报错 | 「文档里怎么说」「项目如何设计」 |

检索结果**分条返回并标明来源**，不做静默合并。

---

## 7. 配置（节选）

```json
{
  "knowledge": {
    "recall": "hybrid",
    "autoInject": {
      "minScore": 0.78,
      "maxChunks": 4,
      "budgetTokens": 1200,
      "minCoverage": 0.5
    },
    "hint": { "minScore": 0.55 },
    "catalog": {
      "maxEntries": 10,
      "autoDescribe": true
    },
    "index": {
      "embedding": true,
      "hybridKeyword": true
    }
  },
  "agents": [
    { "id": "coder", "knowledge": { "recall": "hint" } },
    { "id": "docs", "knowledge": { "recall": "inject" } }
  ]
}
```

| 键 | 作用 |
|----|------|
| `recall` | 内容召回模式（见 §5） |
| `autoInject.*` | 注入门槛、条数、预算 |
| `catalog.*` | system 目录条数、自动描述开关 |
| `index.*` | 是否 embedding / 关键词腿 / 同步与并发 |
| `promotion.metrics` | 使用计量阈值（供后续提升信号，**不**直接写 Memory） |

完整键位见 `octopi.schema.json` 与 `octopi.example.json`。

---

## 8. 管理面（Host API 节选）

```text
POST   /api/v1/agents/:id/knowledge/sources     # 注册源
GET    /api/v1/agents/:id/knowledge/sources     # 列表（status / coverage）
PATCH  /api/v1/agents/:id/knowledge/sources/:sid
DELETE /api/v1/agents/:id/knowledge/sources/:sid
POST   /api/v1/agents/:id/knowledge/sources/:sid/reindex
GET    /api/v1/agents/:id/knowledge/stats
```

- 注册后可 **reindex** 触发解析/索引，并可选启动文件监听。
- **删除**会清理索引与使用痕迹（合规可抹除）。
- 自动描述默认可用，可关闭外发；抽样前做敏感形态扫描。
- 外源可带 **`authRef`**（指向 credentials 命名凭证）、**`network`**（`allowPrivateNetwork` / 超时）、**`discover`**（sitemap/crawl 预算）。失败/skip **不删**已入库 chunks。
- 溯源：命中用稳定逻辑 **`path`**；完整 URL 在文件记录 `external_url`。

---

## 9. 质量口径

1. 外生语料**有源可溯**；无源不是 Knowledge。  
2. **地板不靠自觉，深度靠工具**；宁可少注入，不塞噪音。  
3. **Index 可整库重跑**；源是唯一权威。  
4. **索引期零提升**；学会的东西走 Memory → Cognition → Wisdom。  
5. **time-to-first-searchable ≪ time-to-fully-ready**：先能搜，向量可后补。

---

## 相关

| 文档 | 内容 |
|------|------|
| [docs/memory.md](./memory.md) | Memory（第 6 层）：命题与分馏 |
| [docs/context-layer-contracts.md](./context-layer-contracts.md) | system 契约层与装配 |
| [docs/architecture.md](./architecture.md) | 八层总览与目录 |
| `arch/knowledge-layer.md` | 内部规格（本体/管道） |
| `arch/knowledge-external-ingest.md` | 外源 url/connector + CredentialStore |
