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
| **Session** | 仅本会话；要持久化需管理面改 `scopeRef`（非自动提升） |
| **无 Agent 级源** | 「某 agent 独享」= 只挂给它的一个 Project；学习结果归 Memory，不靠 scope 硬隔 |

源类型：

| kind | 说明 |
|------|------|
| `directory` / `file` / `workspace` | 本地语料；watch + content-hash 增量 |
| `url` | 文档型网页/静态站；`discover.mode`: `single` / `sitemap` / `crawl` |
| `connector` | REST list+get 等连接器（`RestConnector` 等） |

**活系统**（数据库、API、MCP 实时接口）不进 Knowledge，请用 Tool 查询（勿做镜像库）。

外源访问密钥：源上只存 **`authRef`** → `OCTOPI_HOME/credentials/credentials.db`（命名凭证）。密钥明文不进 `knowledge.db` / `octopi.json`。公网默认拒私网（SSRF）；内网文档源可对源开 `network.allowPrivateNetwork`。

### 2.1 Knowledge Service（独立服务）

Knowledge 数据面是 **独立 HTTP Service**（唯一写者），不是 Gateway 进程内模块：

| 角色 | 职责 |
|------|------|
| **Knowledge Service** | 唯一写 `knowledge.db`；ingest / 索引 / 检索 / SSE 进度 |
| **Gateway** | **不打开** `knowledge.db`；Host API 与 `knowledge_search`/`read` 经 `KnowledgeClient` |
| **多 Gateway** | 同一 Service（或共享远程 baseUrl）可挂多 Gateway；写路径不双开 |

- **契约**：`arch/knowledge-service-http.md`（token → `(tenantId, gatewayId)`；业务键不从 body 伪造）
- **装配**：`knowledge.service.manageLocal`（默认 `true`）→ 本机 **fork 子进程**拉起 Service，缺省端口 **18280**；`manageLocal: false` + `baseUrl` → 只连远程；二者皆无 → 知识面 `disabled`
- **单写者**：`knowledge.db.writer.lock`（由 **Service 进程**持有，不是 Gateway）
- **状态**：`ready` / `degraded` / `disabled`（Service 起不来时可感知；`knowledge.required` 可 fail-closed）

#### 2.1.1 进程内线程边界（勿把重活塞回主线程）

```text
Knowledge Service 进程
├── 主线程：listen · /health · token 鉴权 · 纯读直达 Meta/Search · SSE 泵出
├── Meta Worker：projects / sources / detail / jobs / ready     ← 只读连接
├── Search Worker：search / catalog / files / chunks            ← 只读连接
├── Engine/API Worker：写路由编排 · SSE 转发                     ← 禁止可写 SQLite
├── Writer Worker：knowledge.db 唯一写者 + ingest                ← 允许阻塞
└── 嵌套 Parse Worker：Document 抽取 · 切块 · FTS token           ← CPU
```

| 层 | 可否阻塞 | 放什么 |
|----|----------|--------|
| 主线程 | **否** | HTTP accept、存活探测、token 鉴权、**纯读 RPC 分发**、SSE 写出 |
| Meta Worker | 是 | 列表/控制面只读 SQL（projects / sources / getSourceDetail / jobs） |
| Search Worker | 是 | 检索只读 SQL（search / catalog / listFiles / chunks）；**禁止写** |
| Engine/API Worker | 是 | 写 HTTP 编排 → Writer RPC；残留短读走 **只读连接** |
| Writer Worker | 是 | **唯一写连接** + ingest + FTS/写库 + walk/对账 |
| Parse Worker | 是 | SheetJS/Office 抽取、chunk、CJK 分词、原件流式 hash |

**工程纪律**（踩坑总结）：

- `/health` 必须主线程应答，否则引擎忙时探活假死。
- token 鉴权在主线程（`matchKnowledgeToken`）。**纯读路由不得进 Engine**（`read-http.ts` / `isPureReadRoute`）。
- **API 不得打开可写 knowledge.db**；一切变更走 `KnowledgeWriteService`（`writer-service.ts` → Writer Worker RPC）。
- **Meta / Search 分角色 Query Worker**：重 search 不得堵住 `listProjects`/`listSources`。boot 握手允许 `dbStats`。
- Query Worker **必须在 Writer 建库之后**再 `readOnly` 打开（缺文件时 open 会炸）。
- Writer 长同步段必须让出，否则 abort 等控制 RPC 会排队（`upsertFile` 旧索引清理 `dropChunksAsync` 等）。
- **源详情/jobControl 纯 SQL**（`job-control-state.ts`），禁止依赖 ingest 内存态。
- `listProjects` 一次拉齐 project→agents，禁止每项目 N+1。
- 大库 COUNT 走 `KnowledgeIndexStore` 1s TTL 缓存；写路径 `invalidateStatsCache()`。
- 禁止假数据桩：禁止 `void arg; return []`、写死 `canAbort: true`、忽略 `scopeLevel` 过滤等（见 `AGENTS.md`）。
- embedding 与 parse **分槽并行**；勿写成「全部 parse 结束才 embed」。文档抽取单独限流（`documentParseConcurrency`）。
- Electron 宿主 fork 子进程：用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`，**不要**换捆绑 `node.exe` 当 `execPath`（会切断 IPC）。

### 2.2 File 本位防重（identity + Membership）

**Corpus 概念已废弃。** 去重键是 **File**，不是路径：

```text
File        identity_key = inode / win fileId / url+authRef   ← 本体
            version = size + mtime
Membership  (source_id, file_id, logical_path)                ← 认领
```

| 规则 | 含义 |
|------|------|
| 同物理文件多 Source / 嵌套路径 | 只 **parse 一次**；召回去重 + `sourceIds[]` |
| **不同 authRef** 的同 URL | **不同 File**（凭证变体） |
| URL **保留 query** | `?id=1` ≠ `?id=2`（契约修订） |
| 解绑 | 扫 remaining；**零认领才 purge** File + chunks |
| 中止 | 只杀**该源独占**任务；共享 File 的 parse 继续 |

---

## 3. 管道：解析、索引、同步

```text
Source 登记  ──注册即自动 ingest（pending → discovering）──
   │  (kind / scope / sync / authRef)
   ▼
SourceFetcher 取回              本地 walk · Url fetch · Connector list/get
   │  外源：HTML 主内容规范化（非 raw HTML 灌库）
   ▼
FormatAdapter 逐文件分发     html / markdown / 代码 / 纯文本…
   │  （注册制）
   │  PDF/Office/xlsx… → DocumentPort worker 抽取 → Markdown（createDocumentPortFromConfig）
   │  无 adapter 且非文档 → skipped
   ▼
Parse + Chunk
   │  Markdown/HTML 按标题 · 代码按函数/类启发式 · 结构优先 + 体积封顶
   ▼
Index（可重建投影）
   │  File + Membership · 逻辑 path + external_url 溯源 · 关键词（含中文二元组） + 可选向量
   ▼
Freshness
   本地 watch + debounce；外源 poll + 条件 GET（ETag/304）；content-hash 增量
   本地全量 walk：size/mtime 未变且已 indexed 则不入队（强制重做走 reprocess）
   差量 prune：本轮 discover 未出现的 path 删除（失败不删旧索引）
```

| 能力 | 行为 |
|------|------|
| **两阶段** | Phase A：解析 + 关键词即可搜（快）；Phase B：向量可滞后 |
| **无 embedding** | 纯关键词仍可用（与 Memory 同策略） |
| **异步** | 与对话**并发**；不会在回答前 await 全库索引 |
| **负载** | 解析/嵌入并发与限速可配；队列背压**不丢任务** |
| **体积** | 结构单元过大再内切；无符号碎块可粘合；**不跨函数/类边界合并** |

数据面：`OCTOPI_HOME/knowledge/`（`knowledge.db` = Service 唯一写；含源权威 + 索引投影 + 任务队列）；凭证：`OCTOPI_HOME/credentials/`。**Gateway 不直接 open knowledge.db。**

### 3.1 百万级向量检索（生产）

| 规模 | 向量后端 | 行为 |
|------|----------|------|
| **&lt; 5 万**向量 | JS 桶裁剪可兜底 | 邻桶优先，不足可全扫 |
| **≥ 5 万** 且无 sqlite-vec | **禁止 JS 全扫** | 仅邻桶 + **强制关键词腿**（hybrid） |
| **任意规模生产** | **sqlite-vec 必开** | KNN；`stats.sqliteVec=1` |

- **hybrid 默认**：FTS/关键词先收候选 → 向量 rerank；纯向量全库检索不作默认路径。
- **健康检查**：`GET …/knowledge/stats` 含 `sqliteVec`（0/1）、`embeddings` 数量。
- **真 ANN（HNSW）**：可选后端（`VectorIndex` 抽象）；百万级无扩展时再引入，勿在 JS 全扫上硬扛。

---

## 4. 提供给上下文的四层

```text
Tier 0  Catalog     「我有哪些语料」        常驻 system（极小）
Tier 1  Map         「世界的形状」          可选结构地图 / 综述（扩展）
Tier 2  Hits        「和本问相关的片段」    本轮 grounding / 工具检索
Tier 3  Full        「原文」                knowledge_read
```

- **Catalog** 是标签化能力面（`id/name/type/status/scale/location` + `purpose`/`topics`），不是文件树。规格见 `arch/knowledge-catalog-redesign.md`。
- **内容命中不进 system**：避免污染人格与常备约束；按轮注入、可 strip。
- **定向检索**：`knowledge_search` 可用 `source_id` / `source`（catalog 句柄）限定单一语料；可见性仍由服务端裁剪。
- **代码 vs 文档**：代码（`code-tree`）只做路径/符号/关键词（Phase A），**默认不 embedding**——原文用 `file_read`，检索用 `file_search` / 关键词；文档/规格/正文才进向量（Phase B），避免片段逻辑失真并降低 embed 成本。

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
    "required": false,
    "service": {
      "manageLocal": true,
      "port": 18280
    },
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
| `service.baseUrl` / `token` | 远程 Knowledge Service（`manageLocal: false` 时必填 baseUrl） |
| `service.manageLocal` | 默认 `true`：本机拉起 Service；`false` 只连 `baseUrl` |
| `service.port` | manageLocal 监听端口（缺省 **18280**；测试可用 `0`） |
| `required` | `true` 时 Knowledge Service 不可用则 fail-closed |
| `recall` | 内容召回模式（见 §5） |
| `autoInject.*` | 注入门槛、条数、预算 |
| `catalog.*` | system 目录条数、自动描述开关 |
| `index.*` | 是否 embedding / 关键词腿 / 同步与并发 |
| `promotion.metrics` | 使用计量阈值（供后续提升信号，**不**直接写 Memory） |
| `attachments.*` | 会话附件限额与注入（`inject.intent` / `fullTextMaxChars`）；见 OP-15 规格 |

文档抽取配置在 **`documents.*`**（与 Knowledge worker / Gateway **同源** `createDocumentPortFromConfig`）：`extract.timeoutMs/maxFileBytes`、`legacy.converter=soffice` + `sofficePath/cacheDir/cacheMaxBytes/maxInputBytes`。

完整键位见 `octopi.schema.json` 与 `octopi.example.json`。

---

## 8. 管理面（Host API 节选）

```text
GET    /api/v1/agents/:id/knowledge/sources?scopeLevel=&projectKey=&sessionId=
POST   /api/v1/agents/:id/knowledge/sources
GET    /api/v1/agents/:id/knowledge/sources/:sid
PATCH  /api/v1/agents/:id/knowledge/sources/:sid
DELETE /api/v1/agents/:id/knowledge/sources/:sid
POST   /api/v1/agents/:id/knowledge/sources/:sid/reindex
GET    /api/v1/agents/:id/knowledge/sources/:sid/files
GET    /api/v1/agents/:id/knowledge/chunks?sourceId=&path=
GET    /api/v1/agents/:id/knowledge/projects
POST   /api/v1/agents/:id/knowledge/projects
DELETE /api/v1/agents/:id/knowledge/projects/:projectKey   # 非空拒绝
GET    /api/v1/agents/:id/knowledge/search?q=&sessionId=&limit=
GET    /api/v1/agents/:id/knowledge/visibility
POST   /api/v1/agents/:id/knowledge/visibility             # assignProject|unassignProject|hide|unhide
GET    /api/v1/agents/:id/knowledge/session-visibility?sessionId=
POST   /api/v1/agents/:id/knowledge/session-visibility     # 会话 overlay（仅本场）
PUT    /api/v1/agents/:id/knowledge/session-visibility     # 全量替换
DELETE /api/v1/agents/:id/knowledge/session-visibility?sessionId=[&targetType=&targetId=]
GET    /api/v1/agents/:id/knowledge/stats
GET    /api/v1/agents/:id/knowledge/promotion-candidates
POST   /api/v1/agents/:id/knowledge/sources/:sid/abort      # 中止该源
POST   /api/v1/agents/:id/knowledge/abort                   # 中止全部
POST   /api/v1/agents/:id/knowledge/sources/:sid/resume     # 继续/恢复（非全量 reindex）
POST   /api/v1/agents/:id/knowledge/resume
```

- **两级注册**：公共知识库（global）/ 项目（project，先建项目再挂源；删项目须先卸源）。
- **会话视图**：`session-visibility` overlay 只改本场 effective view，不改源归属；`scopeLevel=session` 必须带 `sessionId`。行按 **(tenant, gateway, sessionId)** 隔离，禁止跨 Gateway 读写他方 overlay。
- `sources` 的 `scopeLevel=global|project` 为管理面全量列表（不过滤可见性）。
- **注册即自动 ingest**（`POST …/sources` → Service 内 `ingestSource`）；`reindex` = 显式全量重建（supersede）。注册后无需再点「重建」才解析。
- **reindex = supersede**：先作废本源 queued/running，再按磁盘全量重扫（勿与「继续」混淆：继续=清中止态接着跑）。
- **删除**会清理索引与使用痕迹（合规可抹除）；目录移出用 `removePathTree` 清子路径；零认领 File 才 purge。
- 自动描述默认可用，可关闭外发；抽样前做敏感形态扫描；**源稳定后**由 reconcile 触发（勿挂 `idle` 短超时）。
- **会话附件（临时上传）**：落 `sessions/<sid>/attachments/`，仅本 session；消息侧为 `FileBlock` 指针 + turn 侧不可信资料块（正文）。可选 **升为可检索**（注册 `scopeRef: session` 源）或 **归入项目**（promote=move，非自动提升）。API：`/api/v1/sessions/:id/attachments`。详见 `arch/knowledge-session-attachments.md`。
- 外源可带 **`authRef`**（指向 credentials 命名凭证）、**`network`**（`allowPrivateNetwork` / 超时）、**`discover`**（sitemap/crawl 预算）。失败/skip **不删**已入库 chunks。
- 溯源：命中用稳定逻辑 **`path`**；完整 URL 在文件记录 `external_url`。
- Host API 经 **KnowledgeClient** → Service；Gateway 进程内**无** ingest 写路径。

### 8.1 索引任务语义（实现口径，防踩坑）

| 主题 | 约定 |
|------|------|
| **Phase A / B** | 解析+分块+关键词 **优先**；embedding **不得**抢 parse 槽（parse 有积压时不认领 embed） |
| **time-to-search** | 解析完即可关键词搜；向量后台补（`embeddable` 才计向量进度） |
| **代码** | `adapter_id=code-tree` **不 embedding**（file_search / file_read）；**`.html` 归 `htmlAdapter`**（可进向量），勿再声明进 code-tree |
| **向量存** | `knowledge_chunk_embeddings.embedding` = **Float32 BLOB** + `bucket`（ANN-lite）；`dimensions=0` = secret-skip 墓碑（不重试） |
| **向量检索** | 优先 sqlite-vec KNN；**闸门看 KNN 是否返回**（非 flag）；无 KNN 且 >5 万向量 **禁止 JS 全扫** |
| **关键词** | FTS5 倒排（CJK 二元组 token）优先，退 SQL LIKE；与 Memory 分词对齐 |
| **embed 外发** | 默认 `embedSecretPolicy=redact`；审计 `knowledge_embed_secret_log` |
| **Office/大文件** | 文档抽取走 **worker**（`createDocumentPortFromConfig` 与 Gateway 同源）+ **可取消**超时 + **流式 hash**；禁止同步 xlsx / 整文件 `readFile` 堵事件循环；`documentParseConcurrency` 限流 |
| **File identity** | `identity_key`（inode/win fileId/url+authRef）+ Membership；同文件多源只 parse 一次；零认领才 purge |
| **Service** | **唯一写者** `knowledge.db`；Gateway 只走 Client；`writer.lock`（`wx`）；默认端口 18280 |
| **启动恢复** | `startIngestRuntime`：恢复 watch、补跑 pending、启动 reconciler/poll |
| **watch** | 目录增量；漏事件由 reconcile **parse 缺口扫描**（磁盘有、索引无，或 `status='indexing'` 半写入 → parse）兜底 |
| **入队增量** | 本地 discover 带 `size`/`mtime`；`status='indexed' && chunk_count>0 && content_hash` 且版本未变则 **不入队** `parse_file`；强制重做走 `reprocessFiles`（失效 hash） |
| **半写入** | `upsertFile` 分批写；失败/中止清 partial 并停在 `indexing`（`chunk_count=0`，检索不认）；**不得**把 partial 标成 `error` 让其可搜 |
| **删除文件** | watch → `drop_file` → `removePathTree`（含子路径 + FTS/vec）；`(source_id,path)` 须有索引 |
| **看门狗** | `startReconciler`：回收孤儿 running、补 embed、补 parse 缺口（含 indexing）、清 `path:` 零认领、终态 job 清理、稳定后 auto-describe（**纯关键词部署也触发**） |
| **中止** | **跨重启**：`knowledge_source_control` 为权威；claim 跳过 aborted；resume 只复活 `aborted` 取消；**共享 File parse 不杀** |
| **poll vs reindex** | reindex=supersede；**poll=`incremental`**：有 active 则跳过；`walk_source`=`fromQueue` 不作废队列 |
| **模块** | `job-control` / `job-queue` / `embed-runner` / `fts` / `vector-ann` / `http-app` / `serve` / `client` 已拆出；`ingest.ts` 只做编排 |
| **路径归属** | `sourceOwnsPath`：本地只读 `location` 内；外源只接受已登记逻辑键（`reprocess`/`parse`/`fetch` 三处执法） |

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
| `arch/knowledge-service-http.md` | **Knowledge Service HTTP 契约**（鉴权 / File identity / 多 Gateway） |
| `arch/knowledge-layer.md` | 内部规格（本体/管道） |
| `arch/knowledge-external-ingest.md` | 外源 url/connector + CredentialStore |
| `harness/capabilities/document/` | Document 抽取 Port（`createDocumentPortFromConfig` + `documents.*`） |
