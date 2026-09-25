## v0.51.19

### docs: 同步 Knowledge 外源 / CredentialStore 口径，避免后续踩坑

- **AGENTS.md**：`OCTOPI_HOME` 树补 `knowledge/`、`credentials/`；明确 **Knowledge 不在 agent.db**、密钥不进 octopi.json/knowledge.db
- **docs/knowledge.md**：源 kind（url/connector）、Fetcher 管道、HTML 规范化、poll/条件 GET、authRef、path 逻辑键
- **arch/knowledge-layer.md**：状态改为「主线已落地」，指向 external-ingest 稿
- **docs/KNOWN-ISSUES.md**：外源出站已知限制（DNS TOCTOU、binding 不强制、http_request 无 SSRF、OAuth）
- 清理 credentials / connectors 过期 U1/U2/U4 注释

## v0.51.18

### test: 删除遗留 skill-command-bridge 测试

- `tests/skill-command-bridge.test.ts` 依赖本机 `~/.octopi/.../summarize-text` fixture，为旧测试遗留，删除

## v0.51.17

### fix(knowledge): 数据正确性 — path 防碰撞 / 差量 prune / tunables

- **path**：query 进短 hash 后缀；跨 origin 加 host 前缀；REST 无稳定键时用内容 hash（不随下标漂移）
- **差量 prune**：`pruneMissing`（keep 空集 no-op）；`full` 不再 `clearSource`；磁盘/远端消失的 path 本轮清除
- **tunables**：`network.timeoutMs/maxRedirects`、`discover.sitemapMaxDepth`；`docCache` 每轮 discover 清空
- **Patch**：`description`/`displayName` 支持 `null` 清除（displayName 回退 location 推导）

## v0.51.16

### fix(knowledge): 审查修复 — 失败不删索引 / 凭证防泄漏 / fail-closed

- **索引保全**：`markFileError`/`markFileSkipped` **不再删除**已有 chunks（仅元数据）；瞬时失败/poll 抖动不丢库
- **凭证防泄漏**：sitemap `<loc>` **限同源**；`guardedFetch` 跨域重定向剥离 `Authorization` 等敏感头
- **fail-closed**：`authRef` 解析失败中止本轮（不降级匿名抓取）；`CredentialStore.resolve` 拒绝过期凭证
- 回归：`tests/harness/knowledge-review-fixes.test.ts`

## v0.51.15

### feat(knowledge): 外部源 U4 — Connector 插件 + REST + http credential

- **`KnowledgeConnector` / `ConnectorRegistry`**：插件面；内置 **`RestConnector`**（list + `contentField`/`urlField`）
- **`ConnectorFetcher`**：`kind: 'connector'` 接入 ingest；`authRef` 注入 Authorization
- **http_request**：`credential` 参数 — CredentialStore 按名注入 header，密钥不回显
- **adapter 回退**：无扩展名逻辑键按 MIME/内容形态落到 html/markdown/text
- OP-14 U1–U4 闭环（poll/条件 GET/多页/connector）

## v0.51.14

### feat(knowledge): 外部源 U3 — sitemap / 同域有限 crawl

- **`KnowledgeSourceDiscover`**：`mode: single | sitemap | crawl`；`maxPages` / `maxDepth` / `maxBytes` 预算
- **sitemap**：解析 `urlset` / `sitemapindex`（`<loc>`）；子 sitemap 深度上限
- **crawl**：同 origin BFS；`extractLinks` 去外域/mailto；发现阶段 `docCache` 避免 discover+fetch 双下载
- **Schema**：`knowledge_sources.discover_json`
- 预算耗尽只停在 partial/ready，不抛整库失败

## v0.51.13

### feat(knowledge): 外部源 U2 — poll 调度 + 条件 GET + encrypted 凭证

- **Poll**：`KnowledgeIngest.startPolling` / `pollDueSources`；`sync.strategy=poll` + `intervalMs`；`pollMinIntervalMs` / `maxPollPerTick` 成本上限；`last_polled_at` 落库
- **条件 GET**：`If-None-Match` / `If-Modified-Since`；304 短路不重 parse；`etag`/`last_modified` 随 `knowledge_files` 持久
- **修复**：`guardedFetch` 勿把 **304** 当重定向（否则 markFileError 会清索引）
- **CredentialStore encrypted**：AES-256-GCM；主密钥 `OCTOPI_CREDENTIALS_KEY` / `_FILE`；无主密钥拒绝写入不降级明文

## v0.51.12

### feat(knowledge): 外部源 ingest U1 + CredentialStore（OP-14）

- **设计**：`arch/knowledge-external-ingest.md`（Fetcher 缝、入站可用、path 逻辑键、SSRF、凭证分层）
- **CredentialStore**：`OCTOPI_HOME/credentials/credentials.db`；`env`/`file` 密钥引用；`authRef` 绑定源；list/get **不回密文**
- **SourceFetcher**：`LocalFsFetcher` / `UrlFetcher`（U1 单页）；`VirtualDocument`（`path` + `externalUrl` + 规范化文本）
- **入站规范化**：`htmlToStructuredText`（去 script/nav 壳，保留 title/标题/正文）；`htmlAdapter` + `match(path, mime?)`
- **网络门禁**：`network-guard` 默认拒私网/metadata；源级 `network.allowPrivateNetwork`；重定向每跳复验
- **Schema**：`knowledge_files.external_url/etag/last_modified`；`knowledge_sources.auth_ref/network_json`
- **Ingest**：`kind: 'url'` 不再 error；命中片段为可读正文（非 raw HTML）；CJK 可搜

## v0.51.11

### fix(web): TokenUsage cache-aware 字段与 SDK DTO 对齐权威类型

- **根因**：Core `TokenUsage` 已改为 cache-aware 七字段，Web UI 仍读旧 `promptTokens`/`completionTokens`/`totalTokens`；SDK `guardMetrics` 手写残缺 DTO 漏掉 Observer `RunGuardMetricsView` 的 wrap-up 字段；`fallbackCommands` 无 `usage` 导致联合类型收窄
- **对齐**：`guardMetrics` → `Partial<RunGuardMetricsView>`（防再漂移）；usage 展示走 `nominalTotalTokens()` / `reportedPromptTokens()` / `outputTokens`
- **真 bug**：`guardMetrics.totalTokens` 从来不存在，tokensΣ 兜底改为 `nominalTotalTokens`
- `CommandCatalogItemDto` 抽出共用；补 `.status-info` 样式
- `web`：`tsc && vite build` 通过

### feat(webui): 顶栏统一 Focus、Playground 文案、八层检查器

- **Focus**：右栏页签条上的 Focus 按钮统一到顶栏（原「Chat-first workspace」位置），全页签共用
- **文案**：「交互工作台 / Chat-first workspace」→ **Playground**；帮助页精简
- **八层**：产品八层 = System ContextLayer L1–L7（含 Runtime）+ Information L8；层号徽章 L1–L8；Runtime 标注改为「Run 活态」（不再「契约附加」）；Information 标为第 8 层
- `layer-types.ts` 契约注释纠偏到八层口径

### docs: WebUI 设计稿 as-built 归档至 arch/

- `docs/web-runtime-design.md` / `web-conversation-model-design.md` / `context-layers-ui-design.md` → `arch/`（实现交接稿，gitignored）
- 同步状态头（as-built）、Playground 文案、八层口径；去掉 `/Users/jk/` 绝对路径
- 对外只留 `web/DESIGN.md` + `docs/context-layer-contracts.md`；交叉引用更新

## v0.51.10

### chore(test): 清理 fixture 残留并防止再产生

- `commands-router.test.ts` 补 `afterEach` 删除 `tmp-skill-cmd`（原先只在 beforeEach 清）
- `.gitignore` 增加 `tests/fixtures/tmp-*/`

## v0.51.9

### docs(knowledge): 对外 Knowledge 层文档

- 新增 **`docs/knowledge.md`**：理念（外生语料）、资源模型、管道、四层披露、召回模式、工具/配置/管理面、质量口径
- README / architecture / memory 文档互链

## v0.51.8

### test(knowledge): 端到端验收

- `tests/harness/knowledge-e2e.test.ts`：挂目录 → 索引（中英）→ catalog 可见性/挂载/hide → grounding 不可信块 + hit log → recall hint/off → search/read 可见性 → purge 后不可命中
- 覆盖 §9 P1–P5 主要验收项（不依赖真实 LLM/外网）

## v0.51.7

### fix(knowledge): Phase A coverage 比例 + Branded id 边界收口；OP-14–16

- **coverage**：`discovered / processed`（walk 发现数为分母）；有 embedding 再混向量覆盖；busy 看 queued+running
- **Branded**：`ChunkHit` / `IndexedFileRecord` / hit-log / retriever `sourceIds` 等输出侧 branded；入参边界 `asSourceId`/`asChunkId`
- **OP-14/15/16**：url·connector ingest、会话附件管道、Tier 1 Map/Wiki — 记入 `arch/open-problems.md`，后续专题

## v0.51.6

### fix(knowledge): 二审真实缺口

- **catalog overflow**：provider 返回可见全集，截断/折叠只在 `KnowledgeLayer` 算一次（`…and N more` 恢复生效）
- **resolveBudget**：ratio 路径 `clamp(×ratio, 400, maxBudgetTokens)`；无 ratio 用 `budgetTokens`
- **inject 来源**：只记真正纳入的 hit（不再引用未入选路径）
- **hitLog**：`knowledge_search` / `knowledge_read` 计入（`mode: search|read`）
- **skipIfUserTokensBelow**：只看**最近一条 user**（短「继续」不再误触发）
- **embed job 去重**：queued+running，防并发重复 embed
- promotion REST：`{strict, all}`；密钥扫描放宽未引号 password；showProgress 去重文案

## v0.51.5

### feat(knowledge): 剩余配置细项全量贯通

- **`autoInject.budgetRatio` / `maxBudgetTokens`**：`resolveBudget` 按 messagesBudget×ratio 夹取
- **`catalog.maxEntries` / `groupByScope` / `showProgress`**：传入 `KnowledgeLayer`（分组 / 状态显隐）
- **`catalog.autoDescribe`**：false 时 reindex 不外发 describe
- **`index.hybridKeyword`** / **`keywordWeight`**：可关关键词腿、可调融合权重
- **`index.phaseB.concurrency`**：embed 独立并发槽
- **`load.diskWatermarkAlert`**：statfs 告警（不丢任务）
- **`promotion.stewardOnConverge`**：`KnowledgeHitLog.collectOnConverge` 尊重开关
- catalog `maxEntries` 缺省统一为 10

## v0.51.4

### feat(knowledge): 配置面收全 + 双注册表收口 + Branded id

- **`knowledge.*` 配置**（schema / example / config-bridge）：`autoInject` / `hint` / `catalog` / `query` / `index` / `load` / `promotion` 全量可配；Gateway 组装 retriever / ingest / grounding
- **双注册表收口**：`KnowledgeRegistry` 移出公共导出与测试（legacy 文件保留）；产品路径唯一 `OCTOPI_HOME/knowledge`
- **Branded id**：`KnowledgeSourceId` / `KnowledgeChunkId` + `asSourceId` 边界收窄
- REST：`GET …/knowledge/promotion-candidates`；`knowledge_read` 已无 raw 双份（此前审查项）

## v0.51.3

### fix(knowledge): 审查 P0/P1 修复 — hybrid 标度 / 事务 / 可见性 / 注入面 / 卸载

- **hybrid 融合**：keyword 相对分 + **向量用原始 cosine**（勿 min-max）；单列表可达 1.0，与 `injectMinScore` 同标度；双命中加成
- **`upsertFile` 事务** + `isFresh` 要求 `chunk_count>0`（防半写入后永不再索引）
- **`knowledge_read` 可见性**；工具 **忽略伪造 `session_id`**（只用 Run context）
- **不可信块剥离**语料内 `</knowledge-grounding>` 标签
- **卸载**：`removeKnowledgeSource` = stopWatch + purge index/hits + 删注册
- **watch `rename`**：按文件存在性分支（create ≠ drop）
- **grounding 按轮**：先剥历史 grounding 再注入；`mode=none` 不留旧块；Web 历史跳过 `knowledgeGrounding`
- **hitLog** 接入 GroundingAssembler；reindex 后 auto-describe（启发式/LLM 端口）
- REST：kind/scopeRef 枚举校验；**`.env`/密钥扩展**不进索引；`claimJob` 状态条件；scaleLabel 粗标
- 旧 `KnowledgeRegistry` 标 `@deprecated`

## v0.51.2

### feat(knowledge): Agent 级 `knowledge.recall` 召回模式

- **`off | hint | hybrid | inject`**：`agents[].knowledge.recall` 覆盖全局 `knowledge.recall`（缺省 hybrid）
- `hint` **压制自动 inject**（工程/编程 agent 建议）；`inject` 门槛更积极；`off` 仅 catalog
- 接线：`AgentDefinition` / `toGatewayConfig` / `Gateway.buildAgent` → `KnowledgeRetriever.recall`
- Schema / example / `arch/knowledge-layer.md` 对齐

## v0.51.1

### feat(knowledge): code-tree 函数/类启发式分块 + OP-13

- `chunkCodeBySymbols`：按函数/class/interface/def/fn 等**符号边界**切分；`chunk.symbol` 带符号名
- 体积平衡：**结构优先**；> maxChars 内切；无符号碎块可粘合（**不跨符号**）
- 无符号文件仍回退行窗；Markdown 填充 `symbol`=标题
- `arch/open-problems.md` **OP-13**：精确符号边界 / AST（tree-sitter）专题，启发式为 fallback

## v0.51.0

### feat(knowledge): P5 提升痕迹 + 合规 purge — Knowledge 路线图闭环

- **`KnowledgeHitLog`**：inject 使用痕迹（path/source/session）；`promotionCandidates`（默认 ≥3 会话 或 ≥10 次）— **只产信号，不直接写 Cognition/Memory**
- **`KnowledgePurger`**：单文件 / 源级 purge（chunks + embeddings + hits）；`generatedDescription` 标脏（人工 description 不动）
- GroundingAssembler 注入 hit log；**索引期零提升**
- Knowledge P0–P5 主线交付齐：catalog → Source → Ingest → Hybrid → Grounding/工具 → 提升/合规

## v0.50.12

### feat(knowledge): P4 消费闭环 — Grounding 槽 / 不可信包装 / 工具

- **`GroundingAssembler`** + `resolveGroundingQuery`（最近 user + 可选前序）；`RunScope.grounding`
- **消息插槽** `metadata.source='knowledgeGrounding'`（紧贴本轮 user 前）；**只保留最近一条**，旧 grounding 不回放
- **§4.6 不可信包装**：`<knowledge-grounding trust="untrusted">` + 「非指令」声明 + 来源
- **compact**：`semanticHistory` 排除 grounding；摘要不吞旧题
- **工具**：`knowledge_search` / `knowledge_read`（对标 session_search/read）；Builder `knowledgeRetriever()` 接线
- Gateway 自动挂 retriever；极短 user 可跳过检索（`skipIfUserTokensBelow`）

## v0.50.11

### feat(knowledge): P3 Embedding + Hybrid 检索 + auto-ground 降级

- **Phase B**：`knowledge_chunk_embeddings`；Ingest 在 parse 后排队 `embed_source`（批 + 可限速）；无 provider **纯关键词**（对齐 Memory）
- **`KnowledgeRetriever`**：keyword + vector 融合（`keywordWeight`）；`coverage`（文件 × 向量）；可见集过滤
- **`autoGround`**：高分 `inject` / 中分 `hint` / 低分 `none`；**coverage &lt; minCoverage 时抬高 inject 地板**（防半库高分误导）
- Gateway ingest 自动挂 `models.embedding`（与 memory 共用）
- 测试：假向量 embed / vectorSearch / hybrid / 可见性 / 降级

## v0.50.10

### feat(knowledge): P2 Ingest 基础 — Adapter / 切块 / 关键词索引 / 队列 / watch

- **FormatAdapter 注册制**：`text` / `markdown` / `code-tree`；逐文件扩展名分发；无 adapter / 二进制记 `skipped` 不挡整库；ignore 对齐 file-search
- **Phase A 索引**：`knowledge_files` / `knowledge_chunks` / `knowledge_jobs`；content-hash 增量；`KnowledgeIndexStore.search`（Memory 同款 **CJK 二元组**）
- **`KnowledgeIngest`**：walk → 队列（去重、背压不丢）→ parse；**source 级锁**；`fs.watch` + debounce；`ingestFileNow` 快车道；`knowledge.index.progress` 事件
- 状态：discovering → partial → ready；coverage 回写 Source
- REST：`POST /agents/:id/knowledge/sources/:sid/reindex`；Gateway 懒加载 ingest
- 测试：目录挂载/中文检索/增量/skip/可见集过滤

## v0.50.9

### feat(knowledge): P1 Source 注册 + 可见性 + catalog 服务落点

- 新增 **`harness/knowledge/`**：`KnowledgeDatabase`（`OCTOPI_HOME/knowledge/knowledge.db`）+ `KnowledgeSourceStore`
- Scope **Global / Project / Session**（无 Agent 级）：Global 默认可见可 `hide`；Project **显式 assign**；Session 仅本会话
- `catalogFor` / `catalogFingerprint`（粗桶）→ `KnowledgeLayer` Tier 0；`hiddenFromCatalog` 参与可见但不进 system
- **auto-describe**：`generateKnowledgeDescription` + 密钥形态扫描（命中禁外发）+ 启发式 fallback；可关
- Gateway 懒加载 store 并挂 `builder.knowledgeCatalog`；Host REST：`GET/POST /agents/:id/knowledge/sources`、`PATCH/DELETE …/sources/:id`、`POST …/visibility`、`GET …/stats`
- `init` 预建 `knowledge/` 目录

## v0.50.8

### refactor(knowledge): P0 本体清场 — 拆除命题式 Knowledge，收窄为 Tier 0 catalog

- **拆除** `KnowledgeStore` / `KnowledgeEntry` / `MemoryKnowledgeStore` / `KnowledgeContextEngine`（无兼容层；见 `arch/knowledge-layer.md` §8.1）
- **`KnowledgeLayer`** 改为 **Tier 0 catalog**（`KnowledgeCatalogProvider`）：system 只注入「有哪些源」，不做 query 内容召回
- **`LLMReflector`** 高置信模式改写 **Memory `method`**（`channel: model_inference`），不再写 Knowledge
- Builder `knowledgeStore()` → `knowledgeCatalog()`；config-bridge / Gateway 去掉进程内 Knowledge 接线（索引服务 P1）
- 测试重写：catalog 渲染 / Reflector→Memory；docs 对齐（contracts / architecture / KNOWN-ISSUES / domain-split）

## v0.50.7

### docs(agents): Phase A–H 已关闭 — 开放项入口对齐

- `AGENTS.md` 不再把 `arch/IMPLEMENTATION-PLAN.md` / `arch/NEXT-STEPS.md` 当作 current implementation phases
- 指向：`arch/open-problems.md`（研究开放项）、`docs/KNOWN-ISSUES.md`（能力层缺口）、`arch/NEXT-STEPS.md`（短开放项列表）
- `arch/IMPLEMENTATION-PLAN.md` 仅作归档摘要；勿再按旧 Phase 清单开工

## v0.50.6

### fix(file_search): pattern 自动识别 + 路径感知 glob + 零结果自纠

- **pattern_mode** `auto|literal|regex`（默认 `auto`）：仅强信号编译正则（`^…$`、`\d` 类转义、`.*`、`{n}`、词式 `a|b`）；`arr[0]` / `useState()` / `C++` / `foo.bar` 等代码字面量保持 literal。`regex` 布尔保留为兼容别名
- **patterns[]**：多词任一命中（OR），替代模型误写的 `a|b` 字面量拼接
- **glob 路径感知**：匹配 root 相对路径（统一 `/`，兼容 Windows）；`**` 跨目录、`*`/`?` 不跨；无 `/` 模式任意深度；`{a,b}` 多组花括号；`\*` 等转义为字面量
- **diagnostics + hints**：零结果时返回编译结果与 filesSeen/Matched/Searched/Skipped；auto 正则 0 命中时提示 `pattern_mode=literal`；全 skip 时有专门提示
- **case_sensitive 默认 false**；逐行流式扫描，`max_file_bytes` 安全阀默认 50MB 可配（不再 1MB 硬跳）；`.svg` 不再当二进制跳过；匹配器去掉多余 `g` flag
- 工具描述补全 glob/pattern 示例；`tests/harness/builtin-tools.test.ts` 增补回归（含三组真实误匹配用例 + 代码字面量/hints）

## v0.50.5

### docs(memory): 同步残留文档/注释，避免后续踩坑

- `docs/architecture.md` Memory 目录树补齐 decay / backfill 脉搏 / similarity / health-probe
- `docs/context-layer-contracts.md`：去掉 extract 落盘表述；衰减归 `decay-policy` + govern
- `docs/autonomous-subsystem.md`：示例 `emits` 改为 `memory.steward.backfilled`（勿再用 `memory.extracted`）
- `arch/memory-system-redesign.md`：Steward 措辞、无 `memory_get`、shared=`policy.ts`、govern 监听 health 事件、旧 ETL 文档指针
- `README` / `README_CN`：产品 **8 层**上下文（补 Runtime）；Memory 表链到 `docs/memory.md`
- harness/memory README、index 注释：ContextLayer 1–7 与产品 8 层区分

## v0.50.4

### docs(memory): 对外 Memory 文档 + redesign 迁入 arch

- 新增 **`docs/memory.md`**：八层中 Memory 层的理念、价值模型、写入/读取/治理、配置与边界（对外）
- `docs/memory-system-redesign.md` 收成指针；完整规格迁至 **`arch/memory-system-redesign.md`** 并标 as-built（含 v0.48–0.50 增量与有意偏离）
- 引用路径同步（AGENTS / architecture / harness/memory 等）

## v0.50.3

### fix(memory)!: Sqlite update 全字段对齐；废除关键词极性语义冲突

- **Sqlite `update`**：补齐 `source/accessCount/lastAccessedAt/createdAt/anchors/evidence/deleted*`，与 InMemory `Partial<MemoryEntry>` 语义一致
- **删除** `claimPolarity` / `findSemanticConflict`（正则猜「是否」违反 redesign「意图不进正则」）
- 纠正改为**结构规则**：近重复 + 强通道（user_directive/decision/fail_fix）→ supersede；全等/弱通道 → `duplicate`；`memory_store` 仍走显式 `supersedes_id`
- 字面不近似的语义对立回归 **OP-2**（LLM，不在写路径猜）

## v0.50.2

### fix(memory): 硬收敛 sessionText 指纹/预筛 + 补录 conflict supersede + schema.gates

- **硬收敛**：`sessionText` 快照优先参与密度/指纹（`parseEvidenceLines`）；store.messages 已清空时不再丢快照、不再恒定空指纹导致 `already_covered`
- **补录纠正**：`admitCandidates` 对 `user_directive|decision|fail_fix` 的语义冲突 **supersede** 旧条（先写新再软删）；`model_inference` 仍拒
- **`octopi.schema.json`**：补 `memory.gates`（与 Zod 对齐）

## v0.50.1

### refactor(memory): health 阈值可配 + Runner 持有 timer 生命周期；撤回 cognition/knowledge 工具

- `memory.health.{intervalMs,shadowBacklogLimit,limits.*}` → `MemoryHealthProbe`
- `SessionAwareRunner.dispose()`：释放 BackfillTrigger / HealthProbe / SubsystemRuntime；Gateway `stop()` 调用（防热重建 timer 泄漏、重复 emit）
- **删除** `cognition_explore` / `knowledge_lookup` 及 tool-set/builder/gateway 注入（Cognition/Knowledge 将大改，避免工具面锁死接口）；存储层保留

## v0.50.0

### feat(memory): 语义冲突 / 类型衰减 / health 双脉搏 / cognition·knowledge 工具

**语义冲突（OP-2 残留收窄）**
- `claimPolarity` + `anchorJaccard` + `findSemanticConflict`：同 type + 锚点重叠 + 极性相反
- 写路径（`admitCandidates` / `memory_store`）拒 `semantic_conflict`（提示 `supersedes_id`）；govern 低分者 `superseded`

**类型衰减（OP-6）**
- `decay-policy.ts`：method 更快、norm 更稳、fact 居中；`MemoryStore.decay({ typeParams })`
- 配置 `memory.decay.typeParams.{fact,method,norm}` → govern

**补录证据切片 + 契约**
- 只切实质 user/assistant，丢 tool/命令回显；超长 head+tail
- contract `ExtractionResult` → `BackfillResult`

**health 双脉搏**
- `MemoryHealthProbe` emit `memory.health.high_count` / `shadow_backlog`
- SenseEngine：schedule 子系统可并听 `filter.events`；govern 增补 health / `govern.request`

**OP-12 工具**
- `cognition_explore`（概念邻域）/ `knowledge_lookup`（知识源 + 文件片段）；Gateway 注入 `KnowledgeRegistry`

**测试**：`tests/memory/backfill-trigger.test.ts` 扩展

## v0.49.2

### feat(memory): 补录脉搏参数可配

- `memory.backfill.idleDelayMs`（默认 20min）/ `gapScanMs`（默认 6h）/ `minUserTurns`（默认 2）/ `minTotalChars`（默认 200）
- 经 `MemoryConfigSchema` → `AgentBuilder.memoryConfig` → `BackfillTrigger`（prefilter / idle / gap）
- 同步 `octopi.schema.json` / `octopi.example.json`

## v0.49.1

### feat(memory): `memory.backfill.enabled` 自动补录开关

- 默认 **开启**；`false` 时 **不启动** `BackfillTrigger`（硬收敛 / idle / 覆盖差均不 emit），省 Steward LLM 成本
- **不影响** `memory.steward.govern`（衰减/软删/boost 无 LLM）与手动 `runtime.trigger`
- 与 `subsystems.denylist` 分工：本键是产品成本开关；denylist 是子系统装配边界
- 同步：`config-schema.ts` / `octopi.schema.json` / `octopi.example.json`

## v0.49.0

### feat(memory): 补录触发脉搏 — 硬收敛 + idle 漂移 + 覆盖表

**时机（`BackfillTrigger`）**
- **硬收敛**：`session.lifecycle.updated` → `recent`（含 idle reset / `/new`）立即评估并 emit `memory.steward.backfill.request`
- **空闲漂移**：默认 20min 无活动后软收敛（可配 `idleDelayMs`）
- **覆盖差兜底**：默认 6h 扫描 active/recent 且未成功覆盖的会话
- emit 不阻塞 run 收尾；`/new` 先固化 `sessionText` 快照再开新会话

**覆盖表（`memory_backfill` @ agent.db）**
- `fingerprint` + `status(pending|skipped|success|failed)`；同指纹 success 不重跑，pending 防重入，failed 到期重试
- 结构密度预筛（user turns / 字符量）——**不做意图判断**
- `SqliteMemoryStore.database` 可取 `AgentDatabase`；builder 自动挂 `SqliteBackfillCoverageStore` / InMemory

**其它**
- Sense `eventData` 通用透传到 `SubsystemInput.payload`（`sessionIds` / `sessionText` / `reason` / `fingerprint`）
- Runner：`markSessionRecent` 在清空 messages 前写入 `sessionText`；handle 前后 `noteActivity`

**测试**：`tests/memory/backfill-trigger.test.ts`

## v0.48.3

### fix(memory): Steward 补录失败语义 + 写路径去重 + 治理挣得

**P0**
- `memory.steward.backfill`：缺 `llmPort` / LLM 错误 / 空响应 / JSON 解析失败 → `act.status=failed` + `alert`（不再洗成 success+accepted=0）；合法 `[]` 仍为 success
- 写路径 G5：`admitCandidates` 与 `memory_store` 用 `findDuplicate`（归一化全等 / trigram ≥0.92）拒绝 `duplicate`（`memory_store` 提示 `supersedes_id`）；同 source 超 `MAX_ENTRIES_PER_SOURCE` → `session_rate_limit`

**P1**
- 补录显式绑定 `SUBSYSTEM.md`（`__subsystem_prompt__` → `llmPort.cognitivePrompt` → 同目录文件）+ 宪法进 `systemPrompt`，evidence 只进 user
- `memory.steward.govern`：幸存条目弱 boost / shadow 检索晋升 active；method/norm 出 `promotionCandidates`（**不写 Wisdom**）；ops 含 `boost`
- 共享公式下沉 `harness/memory/similarity.ts`（govern supersede 与写路径去重同源）

**测试**：`tests/memory/steward-writepath.test.ts`

## v0.48.2

### fix(memory): govern 每轮接线 `MemoryStore.decay()`

- `memory.steward.govern` 在 softDelete 规划前调用 `memoryStore.decay()`（idle > 30d → `decay_factor *= 0.95`，下限 0.1），使 `score = importance * confidence * decayFactor` 真实参与 `decay_unused` 等规则
- `dryRun` 时 decay 与 softDelete 均不落库
- 审计 message / signal 增加 `decayed` 计数
- 测试：`tests/memory/steward-and-loader.test.ts`（govern decay 接线 + dryRun 不写）
- 文档：`src/subsystems/memory-steward/govern/SUBSYSTEM.md`、`arch/open-problems.md` OP-6 收束

## v0.48.1

### feat(commands): 对话内 `/xxx` 命令调用面 + System Issues 问题通道

**命令（plugin-ecosystem/commands）**

- `CommandRouter`：parse / 注册 / 冲突裁决（保留名硬保护 + 同源/跨源默认 **reject-all**）/ execute
- `sessionOps` 结构化落地（`abort_run` / `new_session` / `set_model` / `compact`）；handler 不直接改 session 引用
- Builtin：`/help` `/stop` `/new` `/model` `/status` `/issues`；client 目录项 `/clear`
- **`/stop`**：多渠道对话中止（飞书/微信/Telegram）；唯一默认 `preempt` control，Run 在途立刻 `AgentRuntime.abort`
- Skill 桥接：SKILL.md frontmatter `command` 注册 `/name`，`$ARGUMENTS` expand 进 Loop
- `//literal` 转义为普通消息

**System Issues（harness/diagnostics）**

- `IssueRegistry`：幂等 `report` / `resolve` / `dismiss`；WS `system.issue(s)` + `GET /api/v1/issues`
- 命令冲突/保留名拒绝必进 UI 通道（非仅日志）

**接入**

- Gateway `handleInboundMessage` 先裁决命令再 dispatch；Discourse 留 command 行
- REST：`GET /api/v1/commands`、`GET /api/v1/issues`、`POST /api/v1/issues/:id/dismiss`
- WS welcome 附带 `commands` + open `issues`；TUI 补全改数据源，去掉 `/help` `/new` 硬编码
- Web composer：行首 `/` 弹出命令 + 简介下拉（↑↓ / Tab / Enter）；issue 角标；`/stop` 可抢占
- 用户命令：`agents/<id>/commands/*.md`（frontmatter `name`/`description`/`kind` + `$ARGUMENTS`）
- Plugin `registerCommand` 合入 Router（source=plugin）
- fix(commands): control 命令不进 Loop 时合成 `turn.end` 终态，修复 `/model` 等后 UI 卡 streaming
- fix(commands): 审查加固 — 合成 turn.end 不带 error（避免 waiting）；applySessionOps 吞错仍出终态；冲突候选粘性 upsert；reject-all 不删 builtin；Run 在途仅 preempt；Issue 复现重开
- fix(commands): user/skill 命令在 Gateway start 时装载（原先仅 buildAgent，`/help` 进 Loop 前看不到）
- docs: README / architecture / plugin-ecosystem 同步 Command 调用面归属与用法

## v0.48.0

### feat(network): WebUI / Gateway 可配置本机或局域网访问

**配置**

- `web.host` / `channels[].host`：`local`（默认，仅本机）| `lan`（局域网）| 具体 IP/主机名
- 未设置 `channels[].host` 时 Gateway HTTP 继承 `web.host`；两者都需放开才能局域网联调
- `HttpChannelAdapter` 接受 `host`；Vite 经 `--host` 启动（`resolveViteHostArg`）

**行为**

- HTTP channel **默认改为仅本机** `127.0.0.1`（原先未绑 host、等价全网卡）。需要局域网访问时设 `host: "lan"`
- WebUI 默认 Gateway URL 改为 `window.location.hostname:3000`（局域网打开页面时回源宿主机，而非访问者 localhost）
- `webui start/status` 展示 Access（local/LAN）与局域网 URL 提示

**辅助**

- `resolveListenHost` / `resolveViteHostArg` / `isLanHost` / `NetworkHostConfig`
- schema / example / init scaffold 同步 `host`

### refactor(security)!: 安全不可绕过 — 无总开关，硬边界 + 始终接线 RiskPolicy

**Breaking**

- 删除 `SecurityPresets` / `getSecurityPolicy` / `security.preset` / `security/policy.ts`
- `SecurityGuardConfig` 删除 `checkInput` / `checkOutput` / `checkToolOutput` / `allowShellMeta`（检查始终开启）
- 删除 `checkToolCallLegacy` 与 `SHELL_META_PATTERNS`（含 Markdown 反引号误杀来源）

**分层**

1. **硬边界**（永远执行，不受 `enforce` 影响）— 只拦确定有害：
   - 未注册工具、路径遍历、`allowedPaths` 越界
   - 下载并执行（管道链下载源 × 任意解释器，含 `/bin/bash`、`env bash`、`tee|bash`）
   - PowerShell IEX/WebClient/`irm`/`| iex` 摇篮
   - 反弹 shell（`/dev/tcp/`、`nc -e/-c/--exec`）
   - 格式化/清盘（`mkfs*`、`Format-Volume`、`Clear-Disk`、`diskutil erase*`、`format X:`，命令位判定）
   - 递归删根/盘符根/系统保护路径（含根通配 `/*`；Windows `rd`/`del`/`Remove-Item` 及 `powershell -Command`/`cmd /c` 内联）；`file_delete` 删保护路径
2. **ToolCallRiskPolicy**（永远接线）— 模糊/有争议操作分档；Builder 注入 workspace cwd 实例
3. **可配置只有**：`enforce: block|audit`、`allowedPaths`、`injectionSensitivity`

**误杀修复**

- `file_write`/`file_edit` 的 `content` 等不透明载荷不扫 shell 元字符（Markdown 反引号 / 代码块 / 文档里的 `$(...)` 合法）
- path 含 `$(...)` 不再当 `command_injection`
- `enforce: audit` 时 RiskPolicy high/critical 降为 medium 告警；硬边界 severity 原样

**实现要点**

- 新增 `destructive_operation`；`detectCatastrophicRecursiveDelete` / `detectDownloadToInterpreter` / `detectDiskWipe` / `isProtectedPath`
- 路径折叠重复分隔符（`//etc`）；根级通配归 protected；shell 单 `&` 拆段；`cmdKey` 取 basename
- Builder 接线 `setRegisteredTools`；`delete_file` 进 FILE_TOOLS；`http_request` 进 HTTP 分类
- `checkModelOutput` 强制 `g` 正则，避免自定义 sensitivePatterns 死循环
- schema / example / init 同步为 `enforce` / `allowedPaths` / `injectionSensitivity`

## v0.47.0 (2026-09-27)

### feat(history)!: session_search/read + Session 存储收敛

**Breaking**

- 删除 `SqliteSessionStore`（无兼容过渡）；runtime Session 后端唯一 `JsonlSessionStore` @ `OCTOPI_HOME/sessions/`
- `SessionLifecycleStatus` 去掉 `extracted`；`memoryExtraction` 写路径清除（进度归 memory.steward）
- 设计规格：`arch/session-history-search.md`

**历史检索（Information，只读）**

- `harness/session-history/`：`SessionHistoryPort` + 字段分权打分 / snippet / 两阶段 `ref` → 窗口
- 工具 `session_search` / `session_read`；`ToolSetConfig.sessionHistory`；daemon 全局注册
- 范围：participated × `filterHistory(readScope)` × agent.max（E6）；`author` 仅相关性
- 默认 `roles=user+assistant`，不含 tool I/O / archive（`include_archived` opt-in）；输出 L1 硬顶
- 与 `memory_search` 分工：命题 vs 原文（宪法 `default-agents.md`）

**存储 / Lifecycle / Archive**

- `SessionMeta.lifecycle/endedAt/archivedAt` 进 `sessions.json`；`JsonlSessionStore.listByLifecycle`
- Archive 改 `SessionStore` 底座；缺 `endedAt` 不归档；gz temp+rename；导出打 `archived`
- `sessions.json` parse 失败拒绝写回；写 meta temp+rename

**P2 `sessions.index.db`（可重建投影，非权威）**

- `createSqliteSessionIndex` + save/delete 旁路 upsert（事务）；`ensureSessionIndexFresh` 启动对齐
- `prefilter`：FTS5 trigram（≥3 码点）+ 短词 LIKE；`null`=可能漏检→回退扫描，`[]`=确信无命中
- 消息级 embedding **暂缓**（P2.e）；Memory 检索仍无 FTS5（分轨）

### fix(history): 审查修复（索引新鲜度 / E6 fail-closed / 归档安全）

- 目录叙事统一：Session 在 `OCTOPI_HOME/sessions/`（**不在** agent home）；补 `sessions.index.db` / `archives/`
- 明确：**禁止复活 SqliteSessionStore**；index 非权威；`session_search` ≠ `memory_search`
- Memory README：FTS5 仅 session index 用，Memory 检索仍无 FTS5（**分轨**）
- 生命周期文档去掉 `extracted`；归档不依赖提炼；jsonl header 注明「整聚合快照写回」
- `markSessionRecentForExtraction` 更名 `markSessionRecent`；AGENTS.md / CONTRIBUTING / architecture / arch/* 同步

### fix(history): 审查下批 — E6 agentMax / meta 原子写 / 预筛会话截断 / 清 memoryExtraction

- **E6**：`resolveHistoryAccess` / `SessionHistoryOptions.resolveAgentMax` 交 `agent.max`（与 Runner `agentMaxSessionRights` 同源）；primary 缺省 owner 也走 `computeEffectiveRights`
- **sessions.json**：parse 失败 **拒绝写回**（不再 `{}` 清空）；`writeMetaIndex` temp+rename
- **预筛**：按 session 首次出现序截断 `limitSessions`，热会话消息行不再挤掉其它会话
- **memoryExtraction**：Runner/Archive 写路径清除（事件 `extractionStatus` 仍供 Sense/steward）；`SessionLifecycleStatus` 去掉 `extracted`
- 测试：agentMax `readScope=none`、corrupt `sessions.json` 拒写

### fix(history): 审查修复 — 索引新鲜度 / from_grant fail-closed / 归档安全

- **索引**：`ensureSessionIndexFresh` 启动对齐（投影数 ≠ 权威则 rebuild）；`prefilter` 可返回 `null` 表示可能漏检 → **回退扫描**（空数组仍=确信无命中）；upsert/remove 事务化；超长 query 词回退扫描
- **E6**：`from_grant` 在缺 `grantedAt` 时 fail-closed（port + `SessionAclService.filterHistory`）
- **roles**：Port/工具缺省 `user+assistant`（与工具描述一致）
- **Archive**：缺 `endedAt` 不归档；导出条目打 `lifecycle: archived`；gz 改 **temp+rename** 原子写
- 测试：fresh rebuild、default roles、from_grant 缺 at、无 endedAt 不归档

### docs(history): P2.e embedding 决策为暂缓

- 消息级 embedding **不做**；检索保持 FTS5 trigram + LIKE
- 将来若做仅限会话级向量门面；触发条件见 `arch/session-history-search.md`

### feat(history): P2.d FTS5 trigram 接入 session index

- `node:sqlite` **可用 FTS5**（含 `trigram`）；`messages_fts` 投影 + upsert/remove 同步
- 混合检索：≥3 码点词条进 FTS `MATCH`；二字中文等短词 **LIKE 回落**（trigram 最少 3 字符）
- phrase 同规则；FTS 查询词统一 `""` 转义；`fts:false` 可强制纯 LIKE
- 无 FTS5 时自动降级 LIKE-only（`ftsEnabled` 可观测）
- 更新 `arch/session-history-search.md`（记忆库曾写「暂不 FTS5」—— **session index 现已启用**，与 Memory 检索策略仍分轨）

### feat(history): P2 sessions.index.db 可重建投影索引

- `createSqliteSessionIndex`：`sessions` + `messages`（可搜字段）投影表；**非权威**（I2 可 rebuild）
- `JsonlSessionStore` 可选 `index` 钩子：save/delete 旁路 upsert/remove（失败不阻断权威写）
- `session_search`：有索引时 SQL 预筛候选，再走原打分/ACL；无索引或异常回退 P1 扫描；regex 不下推
- `rebuildSessionIndexFromStore` 全量重建；daemon 使用 `OCTOPI_HOME/sessions.index.db`
- 验收：index/scan 命中一致；delete 同步；rebuild 恢复；participated 粗筛正确

### feat(history): session_search / session_read — Information 历史检索

- `harness/session-history/`：`SessionHistoryPort` + Jsonl/Archive Source + 字段分权打分/片段
- 工具 `session_search` / `session_read`（两阶段 ref → 窗口）；`ToolSetConfig.sessionHistory` 注入
- 权限：participated × `filterHistory(readScope)`；`author=self|others` 仅相关性过滤
- 默认不搜 tool I/O、不搜 archive（`include_archived` opt-in）；输出 L1 硬顶
- 宪法 `default-agents.md` 补 session history 工具契约（与 memory_search 分工）
- daemon 与 Gateway 共享 `JsonlSessionStore` 并注册全局历史工具

### refactor(storage)!: 删除 SqliteSessionStore；Lifecycle 投影；Archive 改 SessionStore

**Breaking**

- **删除** `SqliteSessionStore` / `SqliteSessionStoreOptions`（无兼容过渡；`session.store` 配置面早已移除，生产仅 Jsonl）
- 运行时 Session 后端唯一：`JsonlSessionStore` @ `OCTOPI_HOME/sessions/`
- 设计规格：`arch/session-history-search.md`（含历史检索 S2 方向）

**Lifecycle（I2 投影，非第二权威）**

- `SessionMeta` 增加 `lifecycle` / `endedAt` / `archivedAt`；`JsonlSessionStore.save` 写入 `sessions.json` 索引
- `JsonlSessionStore.listByLifecycle`（索引过滤，供归档扫描）
- Runner 去掉 `store.updateLifecycle` 鸭子类型；结束只改 `SessionData.lifecycle` 并走 `save`
- `SessionLifecycleMeta.memoryExtraction` 改为可选；归档/Runner **不再依赖**（进度归 memory.steward）

**Archive**

- `SessionArchiveManager` 依赖 `SessionStore<SessionData>`（不再绑 Sqlite）
- 归档条件：`lifecycle==='recent'` 且超过 `recentRetentionDays` 或 `forceArchiveDays`（不再看 `memoryExtraction`）
- 顺序：先追加 `*.sessions.jsonl.gz` 再删热库

## v0.46.0 (2026-09-23)

### feat(storage)!: Session 目录解耦 — sessionId 一等存储

**Breaking: SessionStore 不再双键**

- 接口改为 `load(sessionId)` / `save(sessionId, data)` / `delete(sessionId)` / `exists(sessionId)` / `list({ agentId? })`
- 同 `sessionId` 即同一 Session；多 agent 参与在 `SessionData`（`primaryAgentId` / `preferredAgentId` / `participants`）
- `list({ agentId })` 按 `meta.agentId` / `primary` / `preferred` / `participantAgentIds` 任一命中过滤

**目录**

- 权威落盘：`OCTOPI_HOME/sessions/`（`sessions.json` 索引 + `<id>.jsonl` + `<id>.state.json`）
- **无** `agents/<id>/sessions/` 回退 / 旧文件名兼容（内部研发阶段，避免踩坑）
- `init` / `doctor --fix` 预建 `OCTOPI_HOME/sessions/`，不再预建 agent home 下 `sessions/`

**审查修复**

- `JsonlSessionStore.save()` 写入顺序：先写 `.jsonl` + `.state.json`，再更新 `sessions.json` 索引（crash 安全）
- `archive-manager.ts`：`listArchived` 改用 `sessionMatchesAgent`（支持 primary/preferred/participants 查询）；移除 `updateLifecycle!` 非空断言；清理孤立 JSDoc
- `Runner.handle()` finally 补 `detachSession` 调用（释放 SessionTaskService live 缓存，避免内存泄漏）
- `eslint.config.js`：注册 `@typescript-eslint` 插件（规则默认 `off`），修复 disable 注释报错
- `doctor/data.ts`：`liveFiles` 改为从 `OCTOPI_HOME/sessions/` 计数；移除未用 import

**实现**

- `JsonlSessionStore`：`{ sessionsDir }` 构造
- `InMemorySessionStore` / `SqliteSessionStore` 主键 `sessionId`
- Gateway 默认 store → `OCTOPI_HOME/sessions`（无 legacy 回退）
- Runner / SessionTaskService / ArchiveManager / memory.steward.backfill 同步改签名

## v0.45.1 (2026-09-22)

### fix(tools): file_list pattern 支持 glob

- 模型常写 `*.md`，原先按正则会抛 `Nothing to repeat`；现含 `*`/`?` 且不像正则时按 glob 编译（**整串锚定**），否则按正则
- **recursive + pattern**：目录始终下钻（仍跳过噪音目录），pattern 只滤文件/目录名——此前 `*.md` 进不了子目录
- L1/L2 截断后按预算保留 entries 前缀，不再 `entries: []` 或旁路回灌全量；`truncatedReason` 可组合（`max_entries+max_depth+l1_cap`）
- description 同步说明 glob 或 regex

### fix(tools): shell 提示层降权 + 注册顺序靠后

- **shell description**：LAST RESORT；兜底条件「无专用工具覆盖 / 专用工具不可用 / 正确重试后仍失败」；不写死 git/npm
- **getBuiltinTools**：shell 移到注册列表末尾
- **默认 systemPrompt / 宪法**：参数用错先改调用并重试专用工具；shell 为最后兜底而非禁用
- 后续若仍滥用，再评估 shell 默认审批 / 命令白名单

### refactor(summary): applyToolSummary → applyToolOutputGate

- 名称纠偏：入口是 **L1 硬顶（永远）+ 可选 L2 摘要**，不是 “summary only”。`mode: 'never'` 只关 L2，L1 仍截断
- 类型：`ApplyToolSummaryInput/Output` → `ApplyToolOutputGateInput/Output`
- 公开导出同步：`src/index.ts` / `harness/index.ts` / `capabilities/summary`
- shell/file_list 的 catch 注释改为「summary 模块不可用时的 L1 替代」

### fix(tools): file_list/shell L1 硬顶 + file_list 递归条目上限

- **file_list**：默认跳过 `node_modules`/`.git`/build 缓存目录；`maxEntries`（默认 500，上限 2000）；`maxDepth`（默认 4，硬顶 8，仅 recursive）；`pattern` 支持 glob（`*.md`）或正则；结果经 `applyToolOutputGate` L1 硬顶（缺省 8000 chars）。此前 recursive 可把整仓（含 node_modules）数 MB 清单灌进主会话，诱发后续模型空响应/流超时
- **shell**：stdout/stderr 接入 L1（8000/4000），保留 `stdout/stderr/exitCode` 结构
- **registry**：新增 `file_list` / `shell` 缺省 binding（`mode: never`，只 L1）
- **web adapter**：`turn.end` final 且无正文无工具时展示「模型未返回内容」系统提示（与 TUI 对齐）；**按 session 去重**（adapter 跨会话复用不互吞）；`content:''` 会回落到 streaming 缓冲

### fix(memory): ollama 单条 embedding 回包解析与 hybrid 降级

- **extractOne/extractMany**：先识别扁平数字数组为单条向量（ollama `/api/embeddings` 的 `{embedding:[...]}`），不再误判为批量列表导致 `missing vector at path "embedding"`
- **supportsBatch**：`type: ollama` 默认 `false`（`/api/embeddings` 的 `prompt` 仅接受 string）
- **hybridRetrieve**：embed 失败时退回关键词检索（与 `vecRetrieve` / store 写入路径对称），MemoryLayer 不再因 embedding 服务异常整层 `assemble failed`

## v0.45.0 (2026-09-22)

### feat(budget-redesign)!: P0-P5 预算体系重设计完成（arch/budget-redesign.md）

**Breaking（内部研发，无 BC）**

#### P0 拆除错误死刑

| 变更 | 说明 |
|------|------|
| **默认不再因 Σ tokens 停止 Run** | 删除 `maxTokens` hard 与 soft 续租；出厂仅 wall-clock 安全阀（默认 6h） |
| **配置键** | 顶层 `budget` → **`budgetPolicy`** |
| **迁移** | legacy `budget.maxTokens`/`soft*` 在 loadConfig 时丢弃 |

#### P1 真账本

| 变更 | 说明 |
|------|------|
| **Core `TokenUsage`** | 重定义为 cache-aware 七字段形状 |
| **Provider 解析** | OpenAI/Anthropic 正确读取 cache 分项 |
| **UsageLedger** | run 级分项账本，只记账不 kill |
| **Summary 归因** | 工具 LLM 调用 usage 通过 `summaryUsage` 传回 ledger |

#### P2 控制梯

| 变更 | 说明 |
|------|------|
| **BudgetControlEvent** | 新事件形状：`usage.advisory` / `budget.wrap_up` / `budget.exceeded` |
| **wrap-up** | context 轴和 wall-clock 轴触发 wrap-up，先总结再 stop |
| **onPolicyHit** | 配置 `'wrap_up_then_stop'`（默认）或 `'stop'` |
| **Session 终态** | 区分 `context_stopped` / `policy_stopped` / `behavior_stopped` / `security_stopped` |

#### P3 Policy

| 变更 | 说明 |
|------|------|
| **units 配置** | `maxCost` / `maxUncachedInputTokens` / `maxOutputTokens` / `maxLlmCalls` |
| **pricing 配置** | 模型定价（币种自定义） |
| **advisory 配置** | 接近阈值告警 |
| **单位评估** | 仅显式配置才 stop，事件含 unit/used/hard |

#### P4 Session 账本

| 变更 | 说明 |
|------|------|
| **SessionLedger** | session 级账本，累计同一 session 多 run 用量 |
| **Run→Session 合并** | 每次 run 结束时自动合并到 session ledger |

#### P5 叙事收敛

| 变更 | 说明 |
|------|------|
| **BudgetPolicyEngine** | `IterationBudget` 重命名，旧名称已删除 |
| **ResourceManager** | 已删除（无生产代码使用） |
| **EventBus 死代码** | 已删除（BudgetPolicyEngine 不再持有 EventBus） |
| **文档同步** | `docs/architecture.md`、`arch/open-problems.md`、`harness/README.md` 已更新 |

行为语义：跑飞 → RunGuard；上下文压力 → capabilities summary/compact；成本策略 → budgetPolicy.units。

测试：`tests/resource-budget.test.ts`、`tests/harness/accounting/` 等已按新语义重写。

## v0.44.1 (2026-09-21)

### fix(capabilities): Summary 接线与 oversized 契约 — 按审查根因修复

| 根因 | 修复 |
|------|------|
| **配置与 tools 双入口** | `ToolSummarySupport` 增加 `toolBindings` / `maxReturnCharsDefault`；`resolveSupportBinding` 为唯一 binding 解析入口；daemon 经 `createToolSummarySupport` 注入（不再 `binding: undefined`） |
| **死配置** | `createSummaryPort` 读取 `oversizedStrategy`（resolve 后套用）；daemon 传入 `policyOverrides` / `cache`（`cache.enabled` 时挂 memory LRU） |
| **预算未吃 catalog 窗口** | `port.extract` 调用 `provider.getModelInfo(model).contextWindow` → `executeSummary` |
| **coverage 说谎 / fail 语义** | `planChunks.complete`；`coverageFromOversized` 在未切完或未处理完时 **partial**；`strategy=fail` 与 `onPartial=reject` **抛错**（工具层仍 L1 兜底，不掩盖能力层失败） |
| **L1 硬顶被 hint 击穿** | `applyL1Truncate` 在 `maxChars` 内预留截断说明与续读提示 |
| **kind_sensitive + auto** | `auto`/`opaque` **不**走 L2（仅 informationalKinds；force 除外） |
| **其它** | `SummaryPort.extract` 支持 `previousSummary`；`findBalanced` 失败后扫描后续括号；清理死代码；工具工厂补 JSDoc |

测试：`tests/harness/capabilities/*` 覆盖 binding 配置接线、fail 抛错、L1 总长、contextWindow 优先。

**范围说明**：P2 自主子系统包装**暂缓**（当前仅 tools 净化 + 会话压缩）；`context/README`、CONTRIBUTING 文档同步表已与 capabilities 口径对齐。

## v0.44.0 (2026-09-21)

### feat(capabilities): Summary / Compact 公用能力域（Harness 横切）

新增 Harness 横切模块 **`harness/capabilities/`**（中文「公用能力」；**不计入**业务领域 14/16 口径）。设计规格见内部 `arch/summary-compact.md`；对外契约摘要见 `docs/context-layer-contracts.md`。

| 模块 | 变更 |
|------|------|
| **summary** | `ContentUnit`（`channel` ⊥ `kind`，无 `tool_output` kind）、Policy 数据化（include/exclude/preserve/budget）、`createSummaryPort`、解析链（policy → 参数 → kind → MIME/扩展名 → tool 缺省 → `opaque_generic`） |
| **模型档** | `pickSummarizeProvider` / `resolveSummaryModel` 优先 **`models.level.summary`** → legacy `contextEngine.summaryModel` → mini → standard → primary |
| **oversized** | 预算先行；`map_reduce` / `window` / `truncate_fallback` / `fail`；结果 `coverage` |
| **structured_json** | L0 宽松 JSON + **L1 轻量契约**（`fields`/`fieldTypes`，失败写 `structuredError`）；完整 Schema 可选 `StructuredValidator` 端口（核心不绑 ajv） |
| **tools L1/L2** | **决策在 tools 端**：L1 `maxReturnChars` 硬顶始终生效；L2 SummaryPort 软净化。`summarize=off` 仍 L1。`file_read`+`code` 默认不 L2（保护可编辑原文） |
| **compact** | `createCompactEngine`：`structure_only` / `summary_only` / `head_tail_only` / `auto`；调用方指定头尾/目标/失败策略；中间段可走 SummaryPort 或 `summarizeFn` |
| **ContextEngine 委托** | `DefaultContextEngine.structuralCompact` 委托 `capabilities/compact`；**E4 状态与 Session 持久化仍留在原路径** |
| **缓存** | 可选 `createMemorySummaryCache`（进程内 LRU）；**无 Redis 硬依赖**；默认关闭 |
| **配置** | `summary` / `compact` 进 Zod + `octopi.schema.json` + `octopi.example.json`；`models.level.summary` 示例 |
| **工具** | `http_request` / `file_read` 接入 L1/L2；可选 `summarize` / `summary_task` / `summary_policy`（file 另有 `summary_kind`）；daemon `createToolSet({ summary })` 注入 port |
| **导出** | `harness/index.ts` / `src/index.ts`：`createSummaryPort` / `createCompactEngine` / `applyToolSummary` 等 |
| **测试** | `tests/harness/capabilities/summary-p0.test.ts`（18）+ `compact-p1.test.ts`（8）；proactive/context-compact/session-lock 回归通过 |
| **文档** | `docs/architecture.md`、`docs/context-layer-contracts.md`、`src/harness/README.md`、README 树、`AGENTS.md` knobs、`docs/CONTRIBUTING.md` |

**边界（实现约定）**：capabilities ≠ `plugin-ecosystem/tools`（tools 只消费 port，不写 prompt/算法）；自主子系统仅可作异步包装（P2 未做）；Observer **不做** summary.extract 一等采集。

## v0.43.7 (2026-09-21)

### fix: 修正 package.json description 乱码

- `package.json`：`description` 由错误编码的乱码恢复为 **「可嵌入的 Agent 引擎」**，与 `docs/north-star.md` 产品定位一致

## v0.43.6 (2026-09-21)

### docs: 修正文档日期与 architecture 版本头

- 仓库文档与 CHANGELOG 日期已全部统一为 **2026-09-21**（以本机时钟为准）
- `docs/architecture.md`：版本头 **v0.36.0 | 2026-09-21**（新 Observer 领域按文档 semver 记 minor；并链到 observer-domain）
- `docs/north-star.md` / `docs/KNOWN-ISSUES.md`：同步日期
- `CHANGELOG.md`：全文件条目日期与系统时钟一致

## v0.43.5 (2026-09-21)

### docs: README_CN Layer1 补充 Observer=Telemetry 与 Run Observatory 链接

## v0.43.4 (2026-09-21)

### docs: 补齐 Observer Domain 外部文档

- **新增** `docs/observer-domain.md`：Telemetry vs Run Observatory 边界、`observer.level` 缺省 off、`/debug/run/*`、采样路径（Runner `emitObserved` / Builder emit；Gateway 不双计）、通道投影与 E3/I5 注意点
- `docs/architecture.md`：Harness 15→16 领域；§3.15 Observer；接口清单区分 Core `Observer` 与 `ObserverHub`
- `src/harness/README.md`：Observer 领域行 + runId / emitObserved
- `AGENTS.md`：Shipped knobs 增加 `observer` 与采样归属
- `docs/CONTRIBUTING.md`：测试覆盖行 + Observer 文档同步检查项
- `docs/domain-split.md` / `README.md` / `README_CN.md`：标明 Core Observer（Telemetry）≠ Run Observatory

## v0.43.3 (2026-09-21)

### feat(harness): Observer / Run Observatory — 设计决策落地与接线修复

| 项 | 变更 |
|----|------|
| **缺省** | `observer.level` 缺省 **`off`**；`webPanel` 跟 level（off 强制关） |
| **调试 REST** | 迁移 **`GET /debug/run/:sessionId/scope\|messages`**（根路径；SDK `getDebugJson`） |
| **runId** | `RunScope.runId` + `createRunId`；Hub 优先使用 scope 身份，不另造权威 ID |
| **收口** | Runner `finally` 统一 `recordRunEnd`（含 error）；no_turn_end 回补后再采 final |
| **LLM 真源** | `recordLlmMessages` 优先；`run.scope.llm` 事件不再覆盖已有全文快照 |
| **payload** | `systemPromptPreview` / layer content·preview 受 payload 门控；full 另采 `systemPromptFull` |
| **事件采样** | Runner `emitObserved`：emit 前直采 Hub（Gateway 不再二次 ingest，避免双计） |
| **lifecycle** | `recordRunEnd` / 投影从 Guard metrics 回填 turns/tools/duration |
| **UI** | 修复 `ctx-band` 嵌套导致条目空白；systemPrompt 预览/全文切换；tokensΣ 口径说明 |
| **review 修复** | Builder compact 事件直采 Hub；store 会话守卫 + final 优先；`lastLlmBySession` 随 run 淘汰；注释对齐 |
| **三通道** | `security` / `memory` / `tool.effect` 实现：Guard 事件带 Run 身份；reliability `security_blocked`；memory 工具只读投影；I5 cwd/工具统计；summary/full 预设开启；Run 面板分区 |
| **layers 所有权** | Gateway Map = Context 面板（始终写）；Hub = Observer（开启时 ingest） |
| **通道预设** | summary/full：已实现通道（含 security/memory/tool.effect/context.compact）默认开；`level=off` 全关 |
| **schema** | `octopi.schema.json` / `octopi.example.json` 同步 `observer` |
| **设计** | `arch/observer-domain.md`：Observer Domain = Telemetry ∪ Run Observatory（不合并类；内部文档，不入库） |

## v0.43.2 (2026-09-21)

### docs: 同步 B–H 实现后的文档与注释，降低后续踩坑

- `docs/context-layer-contracts.md`：compact 播种/写回改为 E4 键 `(sessionId, agentId)` + `contextCompacts`
- `docs/web-runtime-design.md`：compact API 说明改为与 run **共 SessionLease 排队**（非仅 status 拒绝）
- `AGENTS.md`：补充 E2/E4/E6/I5 约束与已落地配置旋钮摘要
- `src/harness/README.md` / `context` / `concurrency` / `agent-building` README：session-acl、tool-effect、SessionLease、runner 注入
- `docs/CONTRIBUTING.md`：开发注意（toolIsolation / compact 键 / Lease / ACL / 双键 store）
- `src/core/interfaces/session-store.ts` 与 `src/core/README.md`：标明双键 API 与模型 2 字段位置
- `README.md` / `README_CN.md` / `docs/architecture.md`：模块树与目录布局说明
- `arch/NEXT-STEPS.md`（内部）：评审修复状态与 Gateway 默认 ACL 兼容性

## v0.43.1 (2026-09-21)

### docs: Phase B–H 验收与已知问题对齐

- `docs/KNOWN-ISSUES.md`：I5 / 模型2 / ACL / Lease 状态与开放项；Gateway 默认 ACL 兼容性说明
- `docs/architecture.md`：并发 / toolIsolation / SessionLease / 模型 2 / ACL
- `docs/north-star.md`：变更记录注明 B–G 实现状态（不变量未改）

## v0.43.0 (2026-09-21)

### fix(harness): 二轮评审跟进 — E6 agent 天花板、handoff 降级旧 primary

| 项 | 变更 |
|----|------|
| **E6 L1** | `AgentDefinition.maxSessionRights` / 配置 `agents[].maxSessionRights`；Gateway→Runner `agentMaxSessionRights`；`handle` authorize 时传入交集 |
| **I3 handoff** | 主责移交后，旧 primary 的 active `owner` **降级为 `specialist`**；新 primary 绑定/提升为 `owner`；**不**改写 `session.agentId` |
| **测试** | from_grant fail-closed；overlay 向 max 抬升；handoff 降级 + agentId 不变；agentMax 钳制；compact 桶清理 |
| **文档** | **兼容性**：Gateway 默认注入 `sessionAcl` + 共享 lease（非 opt-in）；多 agent 无 grant 的 guest 会在 handle 收到 `engine.error`；`preferredOnly` 下 handoff 需 `intent=admin_handoff` |

## v0.42.0 (2026-09-21)

### fix(harness): 评审修复 — Jsonl model-2 持久化、共享 Lease、I5 路径消毒、E6 canHandoff、ACL handle 接线

| 项 | 修复 |
|----|------|
| **B1** | `JsonlSessionStore` 持久化 `preferredAgentId` / `switchAudit` / `participants` / `contextCompact(s)` / `lifecycle` |
| **S1** | Gateway 创建**一把** `InProcessSessionLock`，注入全部 Runner（`sessionLease`） |
| **S3** | `session-subdir`：sessionId 经 `toSessionFileName` 消毒；解析结果必须仍在 base 下 |
| **S2** | `canHandoff`：L0 不再永久 false 交集；effective = 策略 `allowAgentInitiatedHandoff` ∧ role.max ∧ agent.max ∧ binding |
| **S4/S5/S8** | compact API 用调用方 `agentId`；reset 清空全部 compact 桶；handoff **不**改写 `session.agentId` |
| **S7/S6/S10** | rights overlay 可向 max 提升后钳制；非法 boolean grant 拒绝；`from_grant` fail-closed；`preferredOnly` 要求 `intent=admin_handoff` |
| **B2** | Runner 可注入 `sessionAcl`；Gateway 接线；`handle` 前 `authorizeRun`（primary 自动 owner，否则拒绝） |

## v0.41.0 (2026-09-21)

### feat(harness) + docs: Phase G 预留位硬化 + Phase H 文档验收

| 项 | 选定 |
|----|------|
| **Session Lease (E2/E7)** | `SessionLease` 接口；v1 默认 `InProcessSessionLock`；Runner 可注入；`DistributedSessionLease` 仅契约 |
| **AgentRevision** | `RunConfig.agentRevision?` → `RunScope.agentRevision?` + Run 审计字段位 |
| **Quota** | Budget per-run 已有；Principal/Session/Agent/Role 维经济层 **文档预留** |

- **新增** `src/harness/concurrency/session-lease.ts`
- **Runner**：私有锁改为注入 `SessionLease`（行为不变，FIFO in-process）
- **Phase H**：`docs/KNOWN-ISSUES.md` / `docs/architecture.md` / `docs/north-star.md` 对齐

## v0.40.0 (2026-09-21)

### feat(harness): Phase F preferred / handoff / Principal — I3 + I6 字段位

| 项 | 选定 |
|----|------|
| **preferred** | `SessionData.preferredAgentId?`；`switch(preferred)` **不改** `primaryAgentId`；无绑定时自动 grant `specialist` |
| **handoff** | 改 `primaryAgentId` + 绑定 `owner`；**默认仅宿主/控制面** |
| **agent handoff** | 缺省 **拒绝**（`allowAgentInitiatedHandoff=false`，I3） |
| **审计** | `SessionData.switchAudit[]`：mode / from→to / actor / tenant / intent |
| **Principal 字段位** | `RunRequest.actorId/actorType/tenantId/intent`；`RunAuditRecord`；`appendRunAudit` |

## v0.39.0 (2026-09-21)

### feat(harness): Phase E Session ACL / 角色目录 — E6 最小集

| 项 | 选定 |
|----|------|
| **目录形态** | 引擎内置五角色种子 + `octopi.json` 顶层 `sessionAcl.roles` 覆盖/新增 |
| **出厂角色** | `owner` / `specialist` / `reviewer` / `operator` / `steward` |
| **specialist / reviewer** | `readScope=full`；specialist `writeMemory` + `canManageTasks=true` |
| **canHandoff** | 出厂全 false；`allowAgentInitiatedHandoff` 缺省 **false**（I3） |
| **authorizeRun** | primary 无绑定 → 自动 grant `owner`；非 primary 无绑定 → **拒绝** |
| **非法 grant** | 未知 roleId / handoff / readScope 超 max → **grant 时拒绝** |

- **新增** `src/harness/session-acl/`：`types` / `seed-roles` / `rights` / `service` / `index`
- **`SessionData.participants?`**：最小 Participant 绑定
- **配置**：Zod `sessionAcl` + `octopi.schema.json` + `octopi.example.json`

## v0.38.0 (2026-09-21)

### feat(harness): Phase D Compact 互斥与键位 — E4 `(sessionId, agentId)`

| 项 | 选定 |
|----|------|
| **互斥权威** | Runner **session 锁**（与 handle 同 FIFO 队列）；**禁止**仅靠 `status==='processing'` |
| **compact 入口** | 新增 `SessionAwareRunner.compactSession(sessionId, agentId, …)`；Gateway 变薄封装 |
| **交错语义** | 同 sessionId：compact **排队**等 run 结束（不静默拒绝覆盖） |
| **键位** | 内存/引擎 Map 键 = `sessionId::agentId`；`SessionData.contextCompacts[agentId]` 分桶 |
| **兼容视图** | `contextCompact` 仍写 primary/单 agent；guest 不借用 primary 桶 |

- **新增** `compactStateKey`（`harness/context/compact-key.ts`）+ **`read/writeSessionCompact`**（`harness/session-compact.ts`）
- **Agent** `set/getSessionCompactState(sessionId, agentId, …)`（内部 API breaking）
- **DefaultContextEngine**：assemble / compactStructural / afterTurn 状态键带 agentId

## v0.37.0 (2026-09-21)

### feat(harness): Phase C Session 一等数据形态 — `primaryAgentId` + 消息归因（模型 2 最小集）

| 项 | 选定 |
|----|------|
| **Store API** | **保持双键** `load(agentId, sessionId)` / `save`；本阶段**不**引入 `loadSession(sessionId)` |
| **primary** | create 写入 `SessionData.primaryAgentId = 创建 agentId`；历史缺省 Runner / Jsonl **回填** `agentId` |
| **归因** | `Message.agentId?`；写回时对本 Run 的 **assistant / tool** 消息补齐 |
| **目录** | **先字段后迁路径**：仍 `agents/<id>/sessions/` |

- **`SessionData.primaryAgentId?`**（Accountability；preferred/guest 不自动改写，对齐 I3）
- **JsonlSessionStore**：`*.state.json` 持久化 `primaryAgentId`

## v0.36.0 (2026-09-21)

### feat(harness): I5 工具效应面最小集 — `toolIsolation`（宪法 north-star I5）

| 项 | 选定 |
|----|------|
| **配置字段** | 顶层 `toolIsolation`（`octopi.json`） |
| **枚举** | `'none' \| 'session-subdir' \| 'session-lock'` |
| **默认值** | **`'none'`**（向后兼容：多 Session 共享 `agent.workspace`） |
| session-subdir | `cwd = join(RunConfig.cwd ?? agent.workspace, sessionId)`；默认 init 下 ≈ `OCTOPI_HOME/workspace/<agentId>/<sessionId>/`；run 开始时 `mkdir -p` |
| session-lock | **路径仍共享**；并发安全依赖 Runner 的 **sessionId 锁**（E1/E2）；**不**提供跨 Session 路径隔离 |
| 无 base cwd | `session-subdir` **不**发明路径；工具回退 `process.cwd()` |

- **新增** `src/harness/tool-effect/isolation.ts`：`ToolIsolationMode` / `DEFAULT_TOOL_ISOLATION` / `resolveToolIsolationCwd`
- **`SessionAwareRunnerConfig`**：`toolIsolation?` / `agentWorkspace?`；**`RunConfig`**：`toolIsolation?`
- **`RunScope.toolRuntime`**：`cwd` / `isolation` 由隔离策略解析后写入
- **配置同步**：Zod + `octopi.schema.json` + `octopi.example.json`

**多 Session 写文件的宿主建议：** 配置 `"toolIsolation": "session-subdir"`。

---
## v0.35.6 (2026-09-21)

### docs: 新 Session 开发入口与八层存储稿

- **`AGENTS.md`**：增加架构宪法路径 `docs/north-star.md` 与开发约束（I1/E1/E5/E3 等）；上下文模型改为**八层**口径；**不**写具体 Phase 步骤
- **`arch/NEXT-STEPS.md`**（内部）：新 Session 开工入口（阅读顺序、基线、Phase B/C 领任务话术）
- **`arch/context-model-storage.md`**：按八层结构调整（Runtime 一等、Information 第 8 层、compact 键、Session 一等演进提示）
- **`arch/open-problems.md` OP-AR-3**：状态改为 I1 已实现；后续见实施规划 Phase B+

## v0.35.5 (2026-09-21)

### docs: 实施规划回归内部 arch

- **`docs/IMPLEMENTATION-PLAN.md` 移出仓库**；实施规划回到 **`arch/IMPLEMENTATION-PLAN.md`**（内部、含 arch 专题引用与阶段验收）
- 对外 `docs/` 仅保留架构宪法、architecture、KNOWN-ISSUES 等；不再要求外部读者依赖内部专题稿
- 开发交接：读 `arch/IMPLEMENTATION-PLAN.md` + `docs/north-star.md` + 本阶段 `arch/*` 专题

## v0.35.4 (2026-09-21)

### docs: 对外文档去除 arch/ 引用

- `docs/` 下不再引用或解释 `arch/`（内部目录不入库、不对外）
- 架构相关交叉引用统一为 `docs/north-star.md`、`docs/architecture.md`、`docs/IMPLEMENTATION-PLAN.md` 等
- `CONTRIBUTING` 文档同步规范改为以 `docs/` + `CHANGELOG` 为准
- `architecture` 并发注意改为指向宪法 I1（I1 已实现）

## v0.35.3 (2026-09-21)

### docs: 架构宪法文首与正文表述收口

- `docs/north-star.md` 文首定位改为 **「架构宪法」**
- 正文去除关于 `docs/` / `arch/` 目录分工与内部指针的说明；关联文档仅列 `docs/` 对外文档
- `IMPLEMENTATION-PLAN` / `architecture` / `KNOWN-ISSUES` 中的宪法表述同步

## v0.35.2 (2026-09-21)

### docs: 宪法迁入 docs/north-star.md（对外）

文档定位：**`docs/` 对外，`arch/` 内部**。架构宪法作为对外文档入库，避免仅存在于 gitignore 的 `arch/`。

- **新增** `docs/north-star.md`：宪法权威副本（本体、I1–I6 / E1–E7、Reserved 位）
- **`arch/north-star.md`**：改为指针，指向 `docs/north-star.md`，防止双源
- **交叉引用**：`docs/IMPLEMENTATION-PLAN.md`、`docs/architecture.md`、`docs/KNOWN-ISSUES.md` 统一指向对外宪法路径

## v0.35.1 (2026-09-21)

### docs: 实施规划入库（跨 Session 交接）

`arch/` 为 gitignore 内部设计目录，无法仅靠该路径进入 main。新增 tracked 交接文档，并与 arch 侧同步。

- **新增** `docs/IMPLEMENTATION-PLAN.md`：Phase A–H 实施规划、宪法不变量摘要、worktree/测试约定、验收与非目标
- **说明**：宪法与专题设计仍以本机 `arch/north-star.md` 等为准；规划以 `docs/IMPLEMENTATION-PLAN.md` 随仓库分发
- **Phase A**：I1 已在 v0.35.0 合并 main（`ff75fd0`）

## v0.35.0 (2026-09-21)

### feat(harness): Run 物理 I1 — RunScope 隔离（宪法 north-star I1）

同 Agent 多 Session 并发时，共享 `Agent` 实例不再充当会话工作区。可变运行上下文只活在 **RunScope / per-run `AgentContext`**。

- **新增** `harness/run-scope.ts`：`RunScope` ALS（`sessionId` / `agentId` / `systemPrompt` / `toolRuntime`）；`withRunScope` / `getRunScope`
- **`Agent.run`**：支持 `options.context`（本 Run 的 `AgentContext`）与 `options.runScope`；缺省仍用实例 `_context`（单测/旧 multi-agent）
- **`SessionAwareRunner.handle`**：不再 `agent.context.messages = session.messages`；组装 `runContext` + `runScope` 传入 `agent.run`；system 装配结果只写 Run 工作区
- **`convertToLlm` / `afterTurn`**：身份与 systemPrompt 优先读 RunScope ALS，compact 回写键取 ALS `sessionId`
- **ToolContextProvider**：`get()` 优先 RunScope 的 `toolRuntime`；`setRuntime` 降级为无 ALS 时的回退
- **RunGuard checkpoint**：`sessionId`/`agentId` 优先 RunScope ALS
- **宪法**：对外权威路径 **`docs/north-star.md`**；八层×Scope 等内部专题见 `arch/context-model.md` / `arch/session-agent-run.md`
- **测试**：`tests/harness/run-scope-isolation.test.ts`（并发 ALS + 双 Session 交错不串味）；persona/skill 测试改为断言 LLM 所见 system（Run 产物），不再断言共享 `agent.context.systemPrompt`
- **遗留（宪法预留）**：工具效应面 I5、Session Lease、ACL/角色目录、Session 一等存储 — 不阻塞本版 I1

## v0.34.0 (2026-09-20)

### feat(web): 会话级模型切换 + contextWindow 未知不猜测

WebUI 模型切换与「未配置窗口 = 未知」策略；ResolvedModel 每 run 解析一次，下游只读快照。

- **ResolvedModel**：`harness/model/` 唯一解析入口；Runner 在 system assembler **之前** resolve；ALS 只传快照
- **引用优先级**：消息级 `RunConfig.model` > `session.metadata.model` > agent 默认；`runConfigDefaults` **不**预填 model
- **contextWindow 仅认显式配置**；未配置 = 未知；**不**用 builtin / 200k 猜测（provider 不 merge builtin）
- **未知时跳过**：自动/proactive 压缩、assemble 按 token 截消息、七层 system 窗口比例预算
- **未知时仍可用**：LLM 调用；手动**结构压缩**（`POST /api/v1/sessions/:id/compact` + WebUI「压缩」）；可选 `contextAssembler.systemBudgetTokens` / `compactTargetTokens`
- **REST**：`GET /models`（含无能力字段模型；agent explicit 可覆盖 catalog）；`GET|POST /sessions/:id/model`；`POST /sessions/:id/compact`
- **WebUI**：模型下拉 / 窗口「未知」展示 / 压缩按钮；session model 进入发送链路
- **修复**：agent 配置模型绑定到 provider（原先用列表第一个）；catalog 不丢纯字符串模型；UI 未知≠0
- **文档**：`docs/architecture.md` 模型解析收口；`docs/web-runtime-design.md` REST（models / session model / compact）；`docs/KNOWN-ISSUES.md` → OP-AR-3（同 Agent 多 session 抢占共享 messages，待专题）
- **测试**：`tests/model-resolver.test.ts`、`tests/runner-session-model.test.ts`、`tests/context-window-unknown.test.ts` 等

## v0.33.0 (2026-09-19)

### refactor(storage): 持久层 SQLite 驱动迁移到内置 node:sqlite

`better-sqlite3` 原生扩展反复出现 Node ABI 不兼容（`NODE_MODULE_VERSION` / `ERR_DLOPEN`），迁移为 Node 内置 `node:sqlite`，从根上去掉 native rebuild。

- **引擎要求**：`engines.node` 提升为 `>=24`（`node:sqlite` 在本机 v24.15.0 验证可用）
- **驱动入口**：`AgentDatabase` / `SqliteSessionStore` 改为 `DatabaseSync`；`busy_timeout` 改用构造参数 `timeout`（默认 **5000**，与 journal mode 无关，可用 `busyTimeoutMs` 覆盖）；`journal_mode=WAL` 改为 `db.exec('PRAGMA ...')`
- **行为对齐**：显式 `enableForeignKeyConstraints: false`，与 better-sqlite3 默认一致，避免 `concept_edges` 旧数据在 FK 打开时失败
- **sqlite-vec**：不再走 `sqliteVec.load(db)`（better-sqlite3 约定）；统一 `getLoadablePath()` + `db.loadExtension`；仅在 `sqliteVec` 选项打开时构造 `allowExtension: true`（Node 构造后无法补开）；加载失败仍回退 JS 余弦
- **类型**：`raw` / session store 连接类型为 `DatabaseSync`；依赖移除 `better-sqlite3` / `@types/better-sqlite3`
- **诊断文案**：gateway / config-bridge / doctor 提示改为检查 Node >= 24 与 `node:sqlite`，不再提示 rebuild native module
- **文档**：`AGENTS.md` 记录 SQLite 驱动与 Node 版本约束；`docs/architecture.md`、`docs/CONTRIBUTING.md`、`harness/memory/README.md` 同步 Node >= 24 / `node:sqlite`；记忆检索明确暂不引入 FTS5
- **审查修复**：session store 补 `timeout`（默认 5000）；AgentDatabase busy timeout 不再与 WAL 绑定；sqlite-vec 显式路径在无 `loadExtension` 时返回 false；`sqlite-vec.d.ts` 去掉 better-sqlite3 风格 `load()`

## v0.32.0 (2026-09-19)

### feat(cli): octopi doctor — 旧部署配置/布局/数据层诊断与安全修复

多轮破坏性配置重构后，旧实例常带着被 Zod 静默剥离的字段、过时目录布局和手改坏掉的 JSON。新增本地确定性 doctor，**不调用 LLM**，报告脱敏。

- **命令**：`octopi doctor` / `--fix` / `--yes` / `--dry-run` / `--json` / `--only` / `--restore [path]` / `--allow-delete-legacy-dirs`
- **共享迁移** `src/config-migrations.ts`：`loadConfig` 告警与 doctor 写回同一规则表；运行时仍只对 `budget.maxTimeMs` 做内存迁移
- **配置规则**：`supervisor`→`runGuard`、`distributedIntelligence` 迁 `_legacy`、`budget.maxTimeMs`→`maxWallClockMs`、`persona` 字符串→`home`、顶层 `providers[]`→`models.providers`（apiKey/占位符原样搬迁）、手改标量类型纠正、JSON 注释/尾逗号恢复
- **布局规则**：home/agent 目录、平铺 persona → `persona/*.md`、废弃 `memory|wisdom|extract/` 报告（删除需显式开关）
- **数据层（Phase 2）**：打开 `agent.db` 触发既有 schema migrate；旧冒号 session 文件名改安全名；sqlite 原生模块失败时只报告不拖垮 doctor
- **交互式 fix**：TTY 下 `--fix` 按 config/layout/data 分组勾选；`--yes` 非交互全量；注入 `selectFixGroups` 便于测试
- **`--restore`**：从最新（或指定）备份恢复 `octopi.json`；恢复前另存当前文件；拒绝非法 JSON 备份
- **安全**：修复前备份；`${ENV}` 不展开写回；报告脱敏；修复后复检 Zod + apiKey 语义
- **审查修复**：data 分组可达（DB001/002 带 `group:'data'`）；非 TTY `--fix` 必须 `--yes` 才写盘；CFG009 遮蔽时无 `-c` 拒绝 fix；`stripTrailingCommas` 字符串感知；FS001/FS005 不再误标 fixable；DB003/FIX002 文案；修复后重列 backups
- **CFG010 session.store**：检测废弃 `session.store`/`dataDir`，对照 legacy 目录与 `agents/<id>/sessions` 落点；`--fix config` 迁入 `_legacy.session.store`（不搬数据）；`octopi.example.json` / schema 去掉误导性 dataDir
- **测试**：`tests/doctor.test.ts`（密钥保留、占位符、脱敏、分组交互、restore、数据层、非 TTY 拒绝、尾逗号字符串安全、session.store）

## v0.31.0 (2026-09-19)

### feat(memory): models.embedding + sqlite-vec + 关键词检索优化

- **配置**：`models.embedding`（model/type/provider/baseUrl/apiKey/dimensions/vectorEngine/sqliteVecExtensionPath 等）；schema/example 同步
- **通用远程 embedding**：`apiKey` 可省略/`""`（不发 Authorization）；`provider` 仅在未写出 apiKey 时继承；`type: openai|ollama|http`；`path`/`headers`/`request`（inputField/embeddingsPath/itemEmbeddingPath/extraBody）/`supportsBatch`/`timeoutMs`
- **向量路径**：配置 embedding 后写入时生成向量（content+tags+future_use+anchors+evidence）；`sqlite-vec` optionalDependency，成功则 `memory_vec` KNN，否则 JS 余弦 hybrid；历史行 `backfillEmbeddings`
- **接线**：`toGatewayConfig` / Gateway / ConfigBridge 按 `models.embedding` 注入 store
- **关键词路径（无 embedding）**：多字段 LIKE（content/tags/future_use/evidence/anchors）+ CJK 二元组 + 字段权重排序
- **测试**：`tests/memory/keyword-and-embedding.test.ts`

## v0.30.2 (2026-09-19)

### fix(context): datetime 注入只保留时间锚点

- `formatRuntimeDatetimeInjection` 去掉第二句用法提示（`Use this as the reference time...`），避免限制 LLM 对时间敏感查询的处理方式
- system prompt 仅注入 `Current datetime: YYYY-MM-DD HH:mm (timezone)`
- 测试同步：断言注入文本不再含 `time-sensitive`

## v0.30.1 (2026-09-19)

### feat(memory): memory_store.supersedes_id 最小纠错闭环

- `memory_store` 可选 `supersedes_id`（须来自 `memory_search` 返回的 id）：写入新命题后软删旧条（reason=`superseded`）；id 不存在/已删则拒绝且不写入
- `memory_search` 描述标明结果含 `id`，供 supersede 使用
- 产品宪法补充：写结论前 search；冲突结论 search → store+supersedes_id；禁止臆造 id；默认不依赖 MemoryLayer 无 id 注入
- MemoryLayer 正文仍不暴露 id（减少幻觉引用）；纠错走主动 search 路径
- 测试：`tests/memory/memory-supersede.test.ts`

## v0.30.0 (2026-09-19)

### feat(memory)!: 系统 redesign — fact/method/norm + 宪法 + Steward

按 `docs/memory-system-redesign.md` 一次落地，取代 session ETL 提取主路径。

- **价值模型**：`MemoryType = fact | method | norm`；开放回路不入库
- **全局宪法**：产品资产 `src/harness/context/constitution/default-agents.md`（**English 指令正文**，无产品元说明）；`context.constitution.mode = product|custom|off`；装配为 system preamble（最前、不参与层预算竞争）
- **写入面**：`memory_store` 槽位（proposition/evidence/future_use/anchors/channel）；`confidence.ts` + `gates.ts`（reason code）；禁止统计句
- **置信度**：channel → 暂定 band（shadow/active）；search 含 shadow；MemoryLayer 不含 shadow
- **软删除**：`MemoryEntry.deleted*`；retrieve/search 默认排除；stats 分列
- **Memory Steward**：`src/subsystems/memory-steward/{backfill,govern,shared}` 双 spec + 策略包
- **Subsystem Loader**：多 spec 包（嵌套目录）+ `shared/` 静默跳过 + `packageId/packageRoot`
- **拆除**：`memory-extractor` 子系统与 Bridge/Pending ETL 主路径、统计句规则提取
- **构建资源**：`scripts/copy-build-assets.mjs`（原 `copy-subsystem-assets.mjs`）— 拷贝 subsystem 非 TS 资源 + 宪法 `default-agents.md` 到 dist，并清理已删除的一级包
- **审查修复**：`model_inference` 无引语证据一律 shadow；统计句门控改为强模板+显式锚点/future_use；`mapLegacyType` 迁移旧库 type；Sqlite tags 过滤对齐 InMemory；`memory.*` 配置接到 tools；backfill 注入 constitution/sessionStore；govern 补 junk_recheck/supersede；allowlist 支持 packageId/`memory.steward.*`；Assembler 无层时仍返回 preamble
- **P2 收尾**：Sqlite hybrid 检索 SQL 候选上限（默认 500）；loader 单包 `packageId=目录名`；DESIGN 验收测试矩阵补强（constitution/gates/legacy/allowlist/shadow）
- **第二轮审查修复**：allowlist 预滤带 packageId；hybrid 补 channel 过滤；supersede 改为 trigram 近重复（去掉前缀启发式）；`memory.profile` 映射到 confidence；tool-set 透传 memory options；InMemory shadow 与 deleted 独立；`subsystems.allowlist/denylist` 进 schema/config-bridge；SQLite `busy_timeout`；G4 要求引语证据；META/引号启发式收紧
- **ETL 残留清理**：删除 `MemoryExtractionWiring` / `AgentBuildResult.memoryExtraction` / `extractionScanIntervalMs` / Gateway extraction dispose 链；公开 barrel 不再导出；init 不再预建 `extract/`；文档改为 Steward 口径
- **文档/注释同步**：architecture/README/harness README/memory README/AGENTS/arch/* 去掉 ETL 与旧 MemoryType 口径；`memory-extraction-design.md` **收成 tombstone**（对照表 + 指向 redesign；正文移除，见 git history）

## v0.29.1 (2026-09-18)

### chore: 移除仓库根目录 Web 设计原型

- 删除根目录 `index.html`（静态设计验证稿，非生产入口）
- 生产 Web 入口仍为 `web/index.html`
- `docs/context-layers-ui-design.md` 去掉对该原型的引用

## v0.29.0 (2026-09-18)

### feat(builder)!: 单公开 build() + memory extraction 生产接线

Gateway / config-bridge 此前装配分叉：serve 路径从不注册 `memory.extractor`，Sense 条件编译还会把字符串字面量误当成 metrics key，导致提取永不触发。

**MemoryStore 统一**
- serve 不再在 Gateway 全局挂 `InMemoryMemoryStore` 的 memory 工具
- `AgentBuilder.build()`：若已注入 `memoryStore`，在 `buildCore` 前用**同一实例**注册 `memory_store` / `memory_search`
- Gateway `buildAgent` 跳过全局遗留的 memory_* 工具，避免与 agent SQLite store 双轨
- 七层 MemoryLayer、extractor `runtimeInject`、memory tools 共用 `builder.memoryStore`（serve 路径为 `SqliteMemoryStore(agent.db)`）

**提取接账与 trigger 语义（审查第一档）**
- `SubsystemRuntime.trigger` 返回 `{ triggered, status }`；仅 `success|degraded` 视为业务成功
- Bridge 成功后 `updateMeta(extractionStatus: 'completed')`，避免 Pending 重复提取
- PendingExtractor：`failed|timeout` 走退避，不标 completed；错误 meta 使用 `effectiveAgentId`
- `memory-extractor` handler：未注入 memoryStore 时抛错（failed），不再静默 success
- `builder.agentHome` / `agentId`：extract 落盘与 Pending 扫描用 agent home + 逻辑 id（与 persona 解耦）
- Gateway：`memoryExtractionByAgent`，`stop()` 时 dispose Bridge/Pending 定时器
- 根包导出 `isSubsystemAllowed` / `discoverSubsystemSpecs` 及 build 相关类型

**AgentBuilder**
- 公开入口收敛为 `build(options?)`：默认 `mode: 'full'`；`mode: 'core'` 仅产出 Agent 门面
- `buildAgent()` 标记 `@deprecated`，内部转调 core 构建（兼容旧测试）
- `build()`：`autoLoadSubsystems`（full 默认 true）控制子系统自动发现；`registerDependency('memoryStore')`；注册成功后按需挂接附属装配
- 子系统开关：`subsystemAllowlist` / `subsystemDenylist`（fluent 同名方法；deny 优先）
- `memory.extractor` 注册成功且存在 memoryStore 时挂 `MemoryExtractorBridge` + `PendingExtractor`（返回 `memoryExtraction` 句柄）
- `subsystemDirs` / `extractionScanIntervalMs` 可覆盖
- 导出 `isSubsystemAllowed` / `discoverSubsystemSpecs`
- 启动日志：serve 打印 `subsystems discovered`；Agent `build()` 打印实际 `subsystems registered`（及 memory extraction 是否接线）
- `build` 链增加 `scripts/copy-subsystem-assets.mjs`：把 `src/subsystems/**` 的 yaml/md 拷入 `dist/subsystems`；发现路径跳过无 `config.yaml`/`SUBSYSTEM.md` 的目录

**Sense / Trigger**
- `rewriteConditionExpression`：字符串字面量不再替换；`sessionLifecycle` / `eventData.x` 映射到 SenseContext
- SenseEngine 从 `eventData` 提升 `lifecycle` / `extractionStatus` 到 SenseContext
- `SubsystemRuntime.trigger(id, senseCtx?)` 可携带 `eventData.bundle`，返回是否真正执行
- Bridge / PendingExtractor 触发时注入 bundle；trigger 未执行时不再误标 `completed`

**Lifecycle**
- Runner idle reset 时 `updateLifecycle(recent, pending)` 并 emit `session.lifecycle.updated`

**测试**
- `sense-condition-rewrite.test.ts` · `builder-memory-extraction.test.ts`

## v0.28.17 (2026-09-18)

### fix(web): 历史不回放托管 system prompt；落盘保留审计

Loop 每轮将 system prompt 以 `metadata.source='systemPrompt'` 注入 messages；切走再切回时 `buildHistoryItems` 把其画成 info 系统气泡。

- **Session 落盘不删**该消息（审计可还原本轮 system）
- Web 历史映射跳过 `source==='systemPrompt'`，以及无 metadata 的长人格 system（AGENTS.md / Session Startup 等）
- 短 system 通知仍显示；契约文档写明「落盘保留 · UI 不回放」

## v0.28.16 (2026-09-17)

### feat(context): 七层可观测 Runtime + 装配预算语义纠偏

Web 右栏「上下文」可实时查看 System 契约层装配与 Information 消息窗口；装配预算改为「总预算 + priority 竞争，layerShares 可选硬顶」。

**装配预算**
- 默认只控 `systemBudget`（约 `0.22 × contextWindow`），按 priority 竞争纳入/截断/丢弃
- `contextAssembler.layerShares[id]`：仅配置的层生效，为 contentBudget 比例硬顶；默认不配额
- `defaultShare` 不再驱动 Assembler；manifest `shares` 只记录显式硬顶

**可观测接线**
- Runner 捕获 `AssembleManifest`，发出 `context.layers.assembled`
- Gateway 缓存会话快照（FIFO 256）；REST `GET /sessions/:id/context/layers`
- **WS 广播剥离层正文 `content`**（preview 保留）；UI 点选层经 REST 拉取全文
- Gateway serve 路径接线 skills / memory / wisdom / cognition / knowledge（agent.home）
- REST `GET /agents/:id/context/health`；build probe 优先，回退 `probeAgentHomeHealth(home)`
- manifest 含 `droppable` / `budgetTokens` / 可选 `content`+`preview`

**Web UI**
- 右栏页签：`上下文 | 任务 | 工具 | 帮助`（原「检查」并入上下文，JSON 降为折叠）
- System 装配层栈 + 预算条 + 层详情/正文 + Information 面板 + 数据面健康 + 近轮 timeline
- Focus 模式；卡片浅色与工作台统一
- 概念纠偏：产品七层第 7 层 Information=session；契约层第 7 位 Runtime≠Information

**文档**
- `docs/context-layer-contracts.md` / `architecture.md` 对齐概念模型与预算语义
- `docs/context-layers-ui-design.md` · `web/DESIGN.md` · 根目录设计原型 `index.html`

## v0.28.15 (2026-09-17)

### fix(cli): serve restart / webui start 失败根因（目录探测 + 进程树误杀 + CLI 挂住）

全局 `octopi serve restart` 报「No Web UI instance」「Web UI directory not found」；在 agent/工具 shell 里执行 start/restart 还会话被杀（ChildProcess.kill）。

**代码根因**
- `findWebDir` 只搜配置旁 `web/` 与 cwd，搜不到 CLI 包根（npm junction 到仓库）下的 `web/`
- `isProcessAlive` 把 Windows `EPERM`（进程存在但无权限）当成已退出 → stop 假成功
- `serve start` 在 Gateway 已占用端口时直接 return，跳过 Web UI
- `webui start` spawn vite 后父进程不退出：Windows Job/残留句柄拖住 CLI，外层工具超时杀掉整棵 shell
- `taskkill /T` 无祖先保护，误杀工具 shell 时会话直接消失
- pid 文件缺失时无法认领已在 5173 上跑的 vite；stop 后仍删 gateway.pid 导致状态混乱

**修复**
- `findWebDir`：`OCTOPI_WEB_DIR` → `web.dir` → 配置旁 → `~/.octopi/web` → CLI 包根 `web/` → cwd
- `isProcessAlive`：`EPERM` 视为存活；`killProcess` 拒绝杀 self/ancestor
- `webui.pid` JSON（pid/dir/startedAt）；端口 5173/5174/4173 探测认领未托管实例
- `webui` 子命令 / Gateway 已在跑时的 `serve start` 结束后 `process.exit(0)`
- stop 失败时保留 gateway.pid 并提示提权 `taskkill`
- Schema：`web.dir`

## v0.28.14 (2026-09-17)

### feat(context): 每轮 system prompt 注入 runtime datetime

LLM 不感知墙上时钟，时间敏感任务（搜新闻、算截止日）会锚到训练截止日附近的错误年份。

- 新增 `formatRuntimeDatetimeInjection` / `withRuntimeDatetimeInjection`（分钟精度 + IANA 时区）
- `SessionAwareRunner` 在 tasks/guidance 注入后、Assembler/concat 之前写入 `injectedContext`
- 精度到分钟，避免秒级抖动；persona 热更新测试同步为「无旧人格 + 仍含 datetime」

## v0.28.13 (2026-09-17)

### fix(web): subscribe 注入假 idle，切回 running 会话被覆盖

设计问题：WS `subscribe` 无条件回 `state: idle`。`openSession` 刚从缓存恢复 tools/streaming，`sendSubscribe` 的响应立刻把 UI 打回 idle——items 里工具仍是 running，状态却是 idle。

- `subscribe` 只登记订阅，改回 `subscribed` 回执，不再改 run 状态
- Store：当前会话存在 running 工具时忽略外部 `idle`

## v0.28.12 (2026-09-17)

### fix(web): 切走后后台 waiting 状态丢失，切回显示 idle

`applyEventToCachedSession` 只更新 conversation items，不跑 runStatus 状态机。工具结束后的 `iteration.start`（waiting）在后台被丢弃；切回时只从 items 推导（无 running 工具、无 streaming）→ idle。

- `SessionCacheEntry` 增加 `runStatus`
- 抽出 `nextRunStatus` 状态机，live 与后台缓存共用
- 后台事件同步更新缓存 `runStatus`；切回时优先恢复缓存中的 active 状态（含 waiting）

## v0.28.11 (2026-09-17)

### fix(web): 切走再切回时 running 会话被显示为 idle

`openSession` 恢复会话时用「缓存条目数 > 历史条目数」决定是否采用缓存。历史可能更长（含旧轮次已落盘消息），缓存里的 running 工具（本轮尚未写入 store）被丢弃，`runStatus` 被推导成 idle。

- 缓存含 running 工具 / 流式 / 未完成 assistant 时，无条件优先于历史
- 切回时恢复 `engineActive`，保证后续 tools/streaming 状态能继续更新

## v0.28.10 (2026-09-17)

### fix(web): 任务结束后状态卡在 streaming 的真正根因

WS `chat` 处理器在 `await this.handler!(channelMsg)` **之后**才发送 `accepted` + `state:running`。而 handler 会阻塞到整轮 Agent run 结束，因此这两条消息是在 `engine.end` 之后到达的，把已经 idle 的 UI 重新打回 streaming。

- `HttpChannelAdapter`：`accepted` / 初始 `running` 改为在 `await handler` **之前**发送；run 结束后不再注入 running

## v0.28.9 (2026-09-17)

### fix(web): runStatus 状态机对齐 Loop 事件契约

根因：工具结束后 Loop 只发 `iteration.start`（`turn_start`），Store 完全忽略该事件，状态停在 `tools` 直到首个 `llm_stream_delta`——模型慢/同步回退时可卡数分钟。另外 `onError` 重试会 yield `turn.end(final, error:true)` 后 continue，被误判为终态清掉 `engineActive`。

- Store 状态机：
  - `iteration.start` / `engine.start` → `waiting`（离开 tools）
  - `llm_stream_delta` → `streaming`
  - `stream.fallback_*` → `waiting`
  - `turn.end(pre_tools)` → `tools`
  - `turn.end(final, error)` → `waiting`（重试，非终态）
  - `turn.end(final)` / `engine.end` → `idle` + `engineActive=false`
- Adapter：`stream.fallback_to_sync` 显示系统提示

## v0.28.8 (2026-09-17)

### fix(web): 最终回复后 runStatus 仍卡 streaming

终态 `turn.end` / `engine.end` 原先只靠 `gatewayBus` + `event.sessionId` 广播，匹配失败时 WebUI 收不到回落事件；迟到的 `state=running` 还会把 idle 打回 streaming。

- Gateway：终态事件改由 `processMessage.onEvent` 用闭包 `sessionKey` 广播（与流式 delta 同路径）；`gatewayBus.onAll` 跳过终态，避免双投
- RuntimeStore：`engineActive` 标记；`turn.end(final)` / `engine.end` 置 inactive；迟到的 `running`/`tools` 状态在 inactive 时忽略

## v0.28.7 (2026-09-17)

### fix(web): 最终回复后状态卡在 streaming

`runStatus` 更新原先把 `streaming.active` 放在最前，`turn.end(final)` / `engine.end` 在异常情况下无法回落 idle；思考占位在末尾已是完整 assistant 时仍会显示。

- RuntimeStore：终态事件（`turn.end` final / `engine.end` / `aborted` / error）优先于 `streaming.active`；final 强制清空 stream 并 dispatch
- WebUI：末尾已有带内容的 completed assistant 时不再显示「思考中」占位

## v0.28.6 (2026-09-17)

### fix(web): 并行工具阶段状态卡在 streaming、长等待无反馈

并行工具部分失败时，UI 长时间显示 streaming 且对话区无任何中间反馈。

- Gateway WS `deriveSessionState`：`tool.exec.*` / `turn.end(pre_tools)` 改为 `tools`，不再标成 `running`（→ streaming）
- RuntimeStore `applyExternalState`：识别 `tools` 状态
- RuntimeStore `applyEvent`：`runStatus` 更新移出 `convResult.changed` 门控——「仅 tool_calls、无文本」时 conversation 可能不变，但状态必须切到 tools
- `tool.exec.start` 强制进入 tools
- WebUI：streaming/waiting 且尚无内容时显示「思考中 / 等待响应」占位，避免长等待黑盒

## v0.28.5 (2026-09-17)

### fix(review): 事件 sessionId / 空串 error 契约 / adapter 去重

对 v0.28.3–0.28.4 未提交修复的审查跟进。

- `adaptLoopEvent`：`iteration.start`、`stream.fallback_*` 补上 `agentId`/`sessionId`，恢复 `gatewayBus.onAll` 的 WS 投递
- `turn.end` 桥接透传 `truncated` / `error`
- OpenAI / Anthropic flatten：`error != null` 即视为失败（含空串），与 Loop / ContextEngine 契约对齐；Anthropic `is_error` 同步
- Adapter `turn.end` 去重改为 run 内 content 指纹（`engine.start` / `llm_stream_delta` 重置），避免只比 last item 的假阳性；纯重复投递不再置 `changed`
- `SmartRouter` 可压缩量计入 error 载荷

## v0.28.4 (2026-09-17)

### fix(web): agent 回复重复显示两条

Runner 的非流式事件既 yield 给 Runtime `onEvent`，又 emit 到 `gatewayBus`；Gateway 两条路径都向 WebSocket 广播，同一 `turn.end` 到达 WebUI 两次。Adapter 在无 streaming item 时会新建 assistant 条目，于是出现两条一模一样的回复。

- Gateway `processMessage.onEvent`：只补广播 `llm_stream_delta`（该事件不进 bus）；其余事件交由 `gatewayBus.onAll` 单次投递
- Adapter `turn.end` 兜底分支：上一条已是同内容 completed assistant 时不再新建（防事件重放）
- 补充 adapter 重复 turn.end 回归测试

## v0.28.3 (2026-09-17)

### fix(context): 工具执行错误未回传 LLM

WebUI 主路径经 `AgentBuilder` → `DefaultContextEngine.convertMessage` 转换消息。该转换只读取 `toolResults[].result`，忽略 `error` 字段；而 Loop 写入历史时失败结果为 `result: null` + `error: 文案`，导致 LLM 只收到 `"null"`，看不到失败原因，无法纠错重试。

- `DefaultContextEngine.convertMessage`：tool 结果存在 `error` 时写入 `JSON.stringify({ error })`，与 Loop / OpenAI / Anthropic 防御路径契约对齐
- `LLMSummaryCompressor`：摘要文本同样包含 error，避免压缩后丢失败信息
- `HybridCompressor.preprocessToolResults`：截断判定与截断字段改为同时覆盖 error 结果
- `HeuristicTokenEstimator`：估算 tool 结果时计入 error 文案长度
- `AnthropicProvider.toAnthropicMessage`：tool_result 设置 `is_error`，便于 Anthropic 侧识别失败
- 补充 context-engine / anthropic-provider 回归测试

## v0.28.2 (2026-09-17)

### fix(web): 工具执行重复显示两条信息

`tool.exec.start` 无条件创建新条目，同 `toolCallId` 的历史条目或事件重放会导致重复。

- adapter `tool.exec.start` 按 `toolCallId` 去重：已有条目时只更新 toolIndex，不追加新条目
- `openSession` 缓存/历史合并后按 `toolCallId` 兜底去重

## v0.28.1 (2026-09-17)

### fix(web): 会话切换保留工具/流式状态；工具完成即时 yield tool_end

修复 WebUI 两个核心问题：切换 session 后工具执行状态卡在 running；复杂请求下工具结果批量滞后显示。

#### Loop — 工具执行实时化

- 并行模式改用 `Promise.race` 收割：每个工具完成后立即 yield `tool_end`，不再等全部跑完
- `afterToolCall`（SecurityGuard 出口检查）在 yield **之前**执行，事件面拿到脱敏后结果，与串行路径契约一致
- `observer.onToolEnd` 统一挪到 afterToolCall 之后；immediate 结果（工具不存在/参数失败/block）不触发 observer，保持 start/end 配对
- `afterToolCall` / `observer` 抛异常时降级为错误结果，不中断收割循环（保证 `agent_end` 契约）
- 删除已内联的 `executeToolCalls` / `executeSequential` / `executeParallel`

#### Web Runtime — 会话状态持久化

- `SessionCacheEntry` 扩展为 `{ items, viewMode, adapterState, inspector }`
- 切走时缓存 adapter 追踪状态（toolIndex / currentAssistantId / streamingContent）与 inspector
- 切回时恢复：有 running 工具 → `runStatus='tools'`，有流式 → `streaming`；UI 从 `getState()` 读取而非硬编码 idle
- 同会话重开：live 为权威，只刷新 tasks/approvals，不 cache/restore/reset
- 切走 await 窗口内源会话事件写回 cache（替换 chat 前二次 `cacheCurrentSession`）
- 目标会话预建空 cache 条目，窗口内事件不丢；用完即删
- 后台会话事件通过 `applyEventToCachedSession` 更新缓存，切回时可见终态
- 事件按 sessionId 路由：其他会话事件不污染当前对话流
- `tool.exec.end` 增加 toolCallId 反查兜底；孤儿 end 不再置 `changed=true`
- `deriveTools` 读取真实 `endedAt`（adapter 在 tool.exec.end 时打戳）
- `createSession` 补 dispatch `runStatus`/`stream`；指定 sessionId 时预建 cache

#### Runner / Protocol

- `tool.exec.start/end`、`turn.end`、`llm_stream_delta` 事件补 `agentId`/`sessionId`
- `deriveSessionState`：`turn.end` phase=pre_tools 下发 `running` 而非 `idle`
- `applyAccepted` 按 sessionId 过滤，避免跨会话误改状态栏

#### UI

- 新增 `runStatus` 事件监听，状态变更实时反映
- 中止按钮在 `tools`/`sending` 状态下也可用

#### 测试

- 新增并行契约：afterToolCall 脱敏先于 yield、快工具先 yield、immediate 不触发 observer
- 新增 store：切回恢复 tools/streaming、同会话保活、后台事件更新缓存
- 新增 adapter：toolIndex 兜底反查、getState/restoreState 持久化

## v0.28.0 (2026-09-17)

### feat(core): Cron 时间数学原语；两域改调统一 nextFire

按 `arch/schedule.md` §3.2 收敛时间数学：Core 只做 parse / nextFire / interval 展示，**不做**中心 Scheduler。点火策略仍分域。

#### Core

- 新增 `core/primitives/cron.ts`：`parseCron` / `nextFireTime` / `intervalNext` / `formatHuman`
- 语法子集 v1：五字段，`*` `*/N` 单值 `a-b` 逗号列表（及 `a-b/N`）；无秒/时区/L/W/#
- 非法表达式显式返回错误；`TaskScheduler.scheduleCron` 抛错；`ScheduleSource` warn 后 skip
- day-of-week：`7`≡周日；dom/dow 双侧受限时按 Vixie OR

#### Harness 接线

- `ScheduleSource`：cron 改为 `nextFireTime` + `setTimeout` 链（原先 `*`/`*/N` 才能用的 setInterval 近似废弃）
- `TaskScheduler`：删除本地 `_parseCronNextRun`；非法 cron 不再静默「1 分钟后再跑」

#### 文档 / 注释

- `loop/error-classifier.ts`：类型在 Core、实现在 Loop、策略在 Harness
- `arch/layer-rules.md` / `arch/overview.md` / `src/core/README`：去掉 async-task / process-model / budget / token-estimator 在 Core 的过时描述；补 Cron
- `arch/schedule.md` 状态勾选

### test(core)

- 新增 `tests/core/cron.test.ts`（解析、下次点火、工作日跨周末、interval、formatHuman）

## v0.27.1 (2026-09-17)

### refactor(context): Token 估算跨域门面 + 去 Core 误注

Token 估算明确归属 Context 域策略（非 Core Kernel）。跨域调用统一走 `harness/context/index.ts` 门面，避免深路径漂移。

- 修正 `token-estimator.ts` 头注：实现的是本域 `TokenEstimator`，不是 Core 接口
- `context/index.ts` 导出 `HeuristicTokenEstimator` / `estimateTextTokens` / `estimateLLMMessages` 与估算常量
- `runner` / `autonomous-subsystem` 改走 domain barrel；`harness/index` 与包入口同步
- Web `ChatWorkspace` 保持直连 token 模块（浏览器不拉 harness/context barrel）
- `context/README` 标明：Budget 计量吃真实 usage，不走启发式估算

### test(context)

- 既有估算/引擎测试路径不变（单元测试允许深测内部模块）

## v0.27.0 (2026-09-17)

### feat(context): 七层 ContextLayer 契约、默认装配接线、主动摘要与可观测

将「system prompt 里有什么」与「消息窗口怎么压」正式拆开：内容层契约 + Assembler 管 system；`DefaultContextEngine` 管 Information 窗口。删除未接线的 `ContextIntelligence`。

#### 契约与装配

- 新增 `ContextLayer` / `LayerContent` / `AssembleManifest`（`harness/context/layer-types.ts`）
- `DefaultContextAssembler`：份额归一化、并行 assemble、priority 纳入、统一 estimator 截断
- `createDefaultSystemPromptAssembler`：persona + skill 索引 + knowledge/memory 召回 + runtime
- Builder/Runner 每轮走 Assembler；失败回退旧字符串拼接
- 删除 `harness/memory/context-intelligence.ts`（七层组装唯一实现落点为 `harness/context/`）

#### 默认路径能力

- **Skill**：`skillDirectory` / `skills()`；config-bridge 从 `home/skills` discover，注入 `<available_skills>`
- **Memory/Knowledge**：`memoryStore` / `knowledgeStore`；config-bridge 挂 `home/agent.db` → `SqliteMemoryStore`（SQLite 可用时）
- **summarize**：未显式设置时 Builder 自动挂主模型；config-bridge 优先 `models.level.mini`
- **主动摘要**：`proactiveCompactRatio`（默认 0.6）；`proactiveCooldownMs`（默认 30s，冷却内优先缓存重建）
- **压缩状态落盘**：`SessionData.contextCompact`（summary + lastProactiveMessageCount + tokens）；daily/idle 重置时清理

#### 可观测与 WebUI

- `context.compact.start/end/error` 事件；Builder 桥到 EventBus
- WebUI 状态栏「压缩上下文…」、检查器摘要、会话系统条

#### 修复（代码审查）

- P0：`layers.ts` 导入路径、`ctx.query` 可空、`layers` 数组类型（`tsc` 通过）
- P1：`buildLlmMessages` 跳过托管 system，避免双注入；压缩摘要改为 `role: 'user'` + `contextSummary`
- P2：`buildAgent` 确保 bus、emit 惰性读；Assembler 统一截断；fingerprint 上限 + `clearSession` 接线
- 层间分隔由 `\n\n` 变为 `\n\n---\n\n`（多层 system prompt 拼接）

#### 配置

```json
{
  "contextEngine": {
    "proactiveCompactRatio": 0.6,
    "proactiveCooldownMs": 30000,
    "protectLastN": 20
  }
}
```

设计说明：`docs/context-layer-contracts.md`。

## v0.26.0 (2026-09-16)

### refactor(core): Kernel 收敛 + Domain 契约归域 + ContextEngine 接线

Core 定位收口为 **Agent Runtime Kernel Contract**：词汇表 + 少数 Kernel ports + EventBus/StateMachine 机制。产品契约与策略迁入 Harness 各领域。

#### 分层与入口

- `octopi/core` **仅 Kernel**；删除 `octopi/core/domain`
- Kernel ports：ModelProvider、ErrorStrategy、SecurityGuard、RunGuard、ReliabilityHarness
- Product ports（类型可留 Core）：ToolBus、SessionStore、Observer
- 增加架构边界执法：eslint `no-restricted-imports` + `tests/architecture/boundaries.test.ts`

#### Domain 契约迁出 Core

| 原 Core | 现位置 |
|---------|--------|
| memory / knowledge / cognitive-loop | harness memory / context/knowledge / orchestration |
| AsyncTask + Store | harness/orchestration |
| AgentRegistry / MessageChannel | harness/multi-agent |
| MCP / WebSearch / HITL / Sandbox / EventSource | harness 各域 |
| SkillManager / AgentDefinition / Persona | harness plugin / types |
| ContextEngine | harness/context/types.ts |
| AgentEventMap / AgentEvents / scenario events | harness/events |
| createSessionStateMachine | harness/session-state-machine.ts |

#### 删除

- `ProcessModel`（Erlang 式进程壳；multi-agent 走消息语义）
- Core 死目录事件常量与 `budget.checkAndEmit`

#### ContextEngine 接线（修复死接线）

- Builder `convertToLlm` → `assemble`；未配置时默认 `DefaultContextEngine`
- `sessionId` 经 `Agent.contextSessionId`，Runner 每 handle 注入（多 Session 不串味）
- `droppedSummary` 并入 system；`afterTurn` 传本轮增量 + usage 校准
- 统一 security/budget 共用同一 EventBus 实例

#### 事件

- Core `EventBus` 仅开放信封；产品词表在 `harness/events`
- `llm_stream_delta` 有意不进 bus（防拥塞）；`persona.resolve.failed` 入 Map
- `ThrottledEventBus` 改为 trailing-edge 合并

#### 工具类型

- Provider 侧 `ToolDefinition` → `LLMToolDefinition`；包入口 `ToolDefinition` = 领域富模型
- `ToolBus.toLLMDefinitions` 返回类型收紧

#### 其它

- `session.ended` 由 SessionArchiveManager 归档时 emit
- 文档：core/README、interfaces README、architecture、domain-split（历史附录+现行对照）、根 README 分层对齐
- 测试：StateMachine / EventBus / 桥接映射 / Memory 契约 / ContextEngine wiring / AgentEvents↔Map 同步

## v0.25.6 (2026-09-15)

### fix: 审查加固项

- `Agent.config` 返回浅拷贝快照（注释不再夸大为 deep freeze）
- `callModel` 在 `LLMRequest` 显式带 `model: defaultModel`
- SecurityGuard 输出扫描覆盖结构化 content（JSON 序列化后扫，100k 截断）
- e2e mock 补齐 `getModelInfos`

## v0.25.5 (2026-09-15)

### fix: 代码审查修复（P0/P1 + P2）

- **SecurityGuard 输出拦截**：`content: null` → 可读 `Blocked by SecurityGuard: …`（避免 `String(null)==="null"`）
- **tool.exec.end**：补上 `args`（与 v0.24.9 CHANGELOG 对齐；encoding 修复时曾丢失）
- **ThinkExecutor fallback**：每次尝试重置 `messages` 为干净 user 输入；`bindModelName` 真正切换 model 名（原先只是对同一模型重试）
- **三份测试乱码**：从 HEAD 恢复 UTF-8 正文，仅保留 harness Agent import
- **package-lock**：版本同步至 0.25.5
- **architecture.md** 分层图去掉 Layer 0 中的 `Agent`
- **callModel**：`return?.(…)?.catch` 自洽 optional 链
- **Agent.config**：`Readonly<AgentLoopConfig>` 快照
- 文档：`web-runtime-design` 去掉 `loop_detected`；`AgentLoopConfig` 消息队列注释对齐
- **test**：新增 `agent-run-e2e.test.ts`（Agent.run 全配置路径）

## v0.25.4 (2026-09-15)

### fix(loop/harness): 消息边界规范化 + 契约小补丁

#### #1 LLM 消息边界

- `normalizeMessagesForLlm` 完整规范化：`toolResults[N]` → N 条 `role:tool`；assistant tool_calls 字符串化
- `LLMMessage` 写明 Provider 入参契约；Provider flatten 仅作防御兼容

#### #5 ErrorStrategy

- 删除 `ErrorAction.fallback`（模型灾备用 `FallbackProvider` / `ProviderPool`，不走 ErrorStrategy）

#### 其它契约

- **system 托管**：仅管理 `metadata.source === 'systemPrompt'`；无 metadata 的 system **不再**当作旧注入静默删除
- **prepareNextTurn**：禁止替换 context 引用，新对象只合并字段回写（保护 `Agent` 持有）
- **已 aborted**：不 yield `agent_start`，直接 `agent_end(aborted)`
- **非法 tool arguments**：`ToolCall.argumentsParseError` + Loop 拒绝执行（不再静默空参）
- UI 删除永不产出的 `loop_detected` 适配分支

### observer / yield 双通道

已记为独立 OP（`arch/open-problems.md` **OP-LOOP-1**），本轮不改：yield=协议，observer=测量。

## v0.25.3 (2026-09-15)

### docs: 同步 Loop/Harness 结构调整后的文档与注释

避免后续开发按旧叙事改代码：

- 分层图与数据流：Loop 无 `Agent`；入口为 `Agent.run()`；事件为 `HarnessLoopEvent`
- 各层 README（loop / core / harness / reliability / agent / agent-building）对齐
- `AgentContext` 去掉「不可变快照」误导；`agentLoop` JSDoc 去掉错误的 `@returns`
- `AGENTS.md` / `CONTRIBUTING.md` / `architecture.md` / 根 README 更新

## v0.25.2 (2026-09-15)

### refactor(core): 对齐 Loop/Harness 结构调整

- `types/events.ts`：删除与 `model-provider` 冲突的 `LLMStreamChunk`；标明 `AgentEventDetail` 为测试编排词表（非 Loop 协议）；`turn_end` 增加可选 `phase`
- `core/index` 不再 re-export `agentLoop` / Loop 类型（公共入口：`loop/` 与 `harness/agent/`）
- `ReliabilityHarness` / `SessionStore` / `ErrorStrategy` / EventBus 注释对齐 `Agent.run()` 门面叙事

## v0.25.1 (2026-09-15)

### refactor(harness): 收口 agent.run + UI 消费 turn_end.phase

- multi-agent `process` / `swarm`、think `executor` 改为 `agent.run(signal, harness?)`，不再手拼 `runAgentWithReliability`
- Web `RunStatus` 新增 `'tools'`：`turn.end` 在 `phase=pre_tools` 时保持进行中，`final` 才置 idle
- TUI：`pre_tools` 不清 `isProcessing`，状态显示 running tools；`final` 才收尾
- `docs/architecture.md` 补充 `turn_end.phase` UI 消费约定

## v0.25.0 (2026-09-15)

### refactor(loop/harness): 事件分型 + turn_end 显式时序 + Agent 门面上移

Loop 层「纯协议」与 Harness「策略语义」的边界收紧；可运行门面落在 Harness。

#### 事件分型

- `AgentLoopEvent` **移除** `budget_exceeded` / `run_guard_recovered` / `run_guard_stopped` / 从未产出的 `loop_detected`
- 新增 `harness/reliability/harness-events.ts`：`HarnessLoopEvent = AgentLoopEvent | HarnessLoopExtension`
- `runAgentWithReliability` / `Agent.run` 产出 `HarnessLoopEvent`；Runner 同步

#### turn_end 显式时序

- `turn_end` 增加 `phase: 'pre_tools' | 'final'`
- 工具路径：`pre_tools`（LLM 结束、工具即将执行）；文本/截断/错误重试：`final`
- 不变量：工具路径下不会在工具执行后再补 final turn_end

#### Agent 上移 Harness

- 删除 `src/loop/agent.ts`；新增 `src/harness/agent/`（`Agent` + `run()`)
- `Agent.run()` = `runAgentWithReliability`：**唯一推荐入口**，构造或 `setHarness` 绑定 reliability
- Builder 构建后 `agent.setHarness(harness)`；Runner 改为 `this.agent.run(signal)`
- Loop 只导出 `agentLoop` / `callModel` / `classifyError` 与协议类型
- 依赖方向保持外→内：Harness → Loop

### BREAKING

- `import { Agent } from '.../loop/agent'` → `from '.../harness/agent'`
- 消费 `turn_end` 时需处理 `phase`
- 消费 reliability 事件流请使用 `HarnessLoopEvent` 而非 `AgentLoopEvent`

## v0.24.9 (2026-09-15)

### fix(loop): P0 契约闭环 — terminate / finishReason / 中止占位 / tool_end 参数

审查发现的几条「只写了一半」的 Loop 契约现已实现，并补纯 `agentLoop` 单测（`tests/loop-p0-contracts.test.ts`）。

- **terminate**：工具批次内**所有**结果 `terminate=true` 时，`agentLoop` 以 `agent_end(reason='should_stop')` 干净结束（覆盖 `beforeToolCall.block+terminate` 与工具自身 terminate）
- **finishReason**：`LLMStreamChunk.done` 增加可选 `finishReason`；OpenAI 解析 `choices[0].finish_reason`、Anthropic 解析 `message_delta.stop_reason`，`callModel` 优先透传而非按 tool_calls 合成。流式截断（`length`）路径因此可真正触发
- **串行中止**：`executeSequential` 为未执行调用补 `isError` 占位，保证 `tool_results` 与 `tool_calls` 一一对应（避免 OpenAI 协议 400）
- **tool_end**：携带原始 `toolCall`（含 `arguments`）；Runner `tool.exec.end` 同步附带 `args`
- **ErrorStrategy attempt**：Reliability 传入真实递增 attempt（从 0 起），成功一轮后重置；默认策略也走同一计数并尊重 `delayMs`
- **callModel**：watchdog 结束时 `providerStream.return()`，降低超时后连接悬挂

### docs

- `LoopToolResult.terminate` / `OnErrorFn` / stream done chunk 契约注释对齐实现

## v0.24.8 (2026-09-15)

### fix(loop): onError 去掉悬空的 `throw`，业务错误永不向消费方抛出

`OnErrorFn` 曾声明可返回 `'throw'`，但 `agentLoop` 实际并不抛——只是 yield `agent_end`。注释与实现不一致，且若将来真抛，会在无终端事件时打断 `for await`，UI 静默断流。

- `OnErrorFn` 收窄为 `'retry' | 'abort'`；`agentLoop` 文档化不变量：LLM 业务失败终止前必 yield `agent_end(reason='error')`
- `runAgentWithReliability`：ErrorStrategy 的 `fallback`/`skip`/`abort` 统一映射为 `abort`（Loop 层无对应动作）
- 默认 onError 路径增加连续重试上限（3 次），避免持续 5xx / rate_limit 无界 retry；成功一轮后在 `onTurnComplete` 重置计数
- 需要异常控制流的 embedder 应根据 `agent_end` 在包装层自行 throw

### test

- `engine-advanced`：abort 干净结束、无 onError 不抛、默认策略重试有界

## v0.24.7 (2026-09-15)

### fix(skills): SKILL.md frontmatter 兼容 Windows CRLF

Windows 下 `core.autocrlf=true` 检出的 SKILL.md 带 `\r\n`，原先 frontmatter 正则与逐行 `key: value` 解析都只认 `\n`，导致 `discover()` 发现 0 个 skill，`get`/`load`/`formatForPrompt` 级联为空。

- `parseFrontmatter` / `FileSystemSkillSource.load`：读盘后统一 `replace(/\r\n/g, '\n')`，再按原 LF 语义解析

### fix(platform): Windows 默认 shell 优先 Git Bash，跳过 WSL bash

`findExecutable('bash')` 会先命中 `%SystemRoot%\System32\bash.exe`（WSL），冷启动可达数秒，撞穿工具默认超时与 vitest 5s 上限。

- 新增 `findWindowsBash()`：优先 `Program Files\Git` 等常见 Git Bash 路径，PATH 扫描跳过 `System32`
- 选择顺序：Git Bash → `pwsh` → `powershell` → WSL bash（仅作兜底）→ `cmd`

### test: 放宽 Windows 下过紧的定时用例

- `planner` `scheduleInterval`：间隔 20→40ms、等待 80→250ms，适配 ~15ms 定时器粒度
- `pending-extractor-backoff`：`baseRetryMs` 1→50ms，等待同步拉长，避免退避窗口小于 `Date.now()` 粒度导致「该跳过却重试」

全量 `npm test`：1383 passed / 0 failed。

## v0.24.6 (2026-09-15)

### feat(persona): 文件式 persona 热更新，改盘后下一轮 run 生效

原先 persona 在 `AgentBuilder.buildAgent()` / Gateway 首次消息时读盘并烤死进 `Agent.systemPrompt`，Gateway 还有一层永不失效的 `personaCache`——改 `AGENTS.md` / `persona/*.md` 必须重启服务。

将文件式 persona 从 **build 产物** 改为 **run 时解析资源**：

- 新增 `PersonaSource`（`src/harness/agent-building/persona.ts`）：按目录指纹（`path:mtimeMs:size`）缓存；指纹不变复用，变则重读。`loadPersona` 保持无缓存语义。
- `AgentBuilder`：文件式 persona 生成 resolver 挂到 `SessionAwareRunner`；每次 `handle` 且 `RunConfig.systemPrompt` 为空时解析，并同步到 `Agent` 与 `SecurityGuard`（泄露检测基线）。
- resolver **成功返回空串**（文件删空）会清空 systemPrompt 与 security 基线；仅磁盘读失败时回退到「最后一次成功的纯 persona」（`lastCleanPersonaPrompt`），避免吃到上一轮 `injectedContext` 拼接结果。失败时 `console.warn` 并 emit `persona.resolve.failed`（含 agentId/sessionId/error）。
- `Gateway`：删除模块级 `personaCache`；文件式 persona 走 `builder.persona(home)`，不再烤死；`runConfigDefaults.systemPrompt` 仅保留内联 persona。
- `agent-loop`：引擎托管的 system 消息**至多一条且固定在 index 0**；`systemPrompt` 变化时刷新，空则摘除；历史脏数据中的多余 managed 会被清掉。仅管理 `metadata.source === 'systemPrompt'` 或无 metadata 的历史注入；外部手工 system **必须带 `metadata.source ≠ 'systemPrompt'`**，否则会被当作旧版引擎注入覆盖。
- 导出 `PersonaSource`。

内联 persona（`persona.systemPrompt`）仍为固定内容，行为不变。

**空 persona vs 热删除**：build 时磁盘无 `AGENTS.md` / `persona/*.md`（且有工具）→ 使用默认 tools prompt，resolver 仍挂着；首轮及后续 run 只要磁盘仍为空，保留该默认 prompt。曾有 persona 文件后被删空 → 视为热删除，清空 systemPrompt 与 security 基线。

**行为说明**：改盘后，该 agent **所有仍活跃的 session** 在下一轮都会使用当前磁盘 persona（不再保留会话创建时的版本）。session 落盘的 system 消息会随之更新。

### BREAKING

- 删除 `clearPersonaCache()`（曾从 `src/integration/gateway/gateway.ts` 导出；主入口未 re-export）。指纹缓存自动失效，不再需要手动清空；deep import 该符号的代码需去掉调用。

### test

- `tests/persona-hot-reload.test.ts`：指纹缓存（同 mtime/size 改写不重读）、改盘/增文件/删空热更新、空目录保留默认 tools prompt、写盘后切换、security 基线同步、resolver 失败回退且不叠 injectedContext、多轮仅一条 system、外部首位 system 不挡 persona、compose 多目录、显式 systemPrompt 不挂 resolver、`loadPersona` 无缓存。

## v0.24.5 (2026-09-15)

### fix(init): 目录骨架对齐 loadPersona / AgentDatabase 约定

PersonaLoader（v0.9 起）只加载根目录 `AGENTS.md` + `persona/*.md`，但 init 仍按旧约定把 SOUL/IDENTITY/USER/TOOLS 平铺在 agent home 根目录，导致这些文件从未进入 system prompt。

Memory / Wisdom 已改为 per-agent SQLite（`AgentDatabase` / `agent.db`），`FileWisdomStore` 等文件目录实现已删除——init 不再预建空的 `memory/`、`wisdom/` 目录。

- Agent home 生成：`AGENTS.md` + `persona/{10-soul,20-identity,30-user,40-tools}.md` + `sessions/` `skills/` `extract/{events,bundles,meta}/`
- 系统级补充 `audit/`（与默认配置 `subsystems.auditDir` 对齐）
- 默认配置新增 `skillDirectory` 指向 `agents/{id}/skills`
- 旧布局自动迁移：根目录 SOUL/IDENTITY/USER/TOOLS 在目标不存在时 rename 进 `persona/`
- 类型注释 / schema：`AgentDefinition.home` 去掉 memory、wisdom 目录表述
- 文档清理：`architecture.md`（agent-building / memory 领域树）、`agent-building` README、`config-bridge`、`agent-db` 路径约定、v0.10.0 CHANGELOG 加注，避免 home 含 memory/wisdom 目录的误读
- 测试：新骨架断言 + 旧文件迁移 + Windows 路径分隔符兼容

## v0.24.4 (2026-09-15)

### fix(storage,cli): Windows 保留文件名 + kill 优雅退出

- `toSessionFileName`：前缀 `_` 处理 `CON`/`PRN`/`AUX`/`NUL`/`COM1–9`/`LPT1–9`（含带扩展名形式）；去掉尾部 `.`/` `；空名回退 `_`
- `killProcess`（win32）：先 `taskkill /T`（WM_CLOSE）等待软退，超时再 `/F` 强杀进程树

### test

- `session-filename.test.ts` 覆盖保留名、尾部点空格、空名回退

## v0.24.3 (2026-09-15)

### fix(storage): Session 文件名跨平台 + macOS 旧数据兼容

Windows 新建会话报 `ENOENT ... default:web:<ts>.jsonl`：逻辑 session id 含 `:`，不能直接当文件名。

- 新增 `toSessionFileName()` / `legacySessionFileName()`（`src/integration/storage/session-filename.ts`）
- `JsonlSessionStore` 与 memory extractor store：读写统一走安全文件名
- **兼容 macOS 旧数据**：load/exists/delete 回退原始 id 文件名，命中后 rename 迁移
- Gateway 默认 session id 改为 `default-web-<ts>`（不含冒号）
- 新增 `tests/session-filename.test.ts`、`tests/jsonl-session-legacy.test.ts`

### fix(cli): serve 系列以端口探测真实 Gateway PID

Windows 上 `fork()` 的 pid 与子进程 `process.pid` 可能不一致，pid 文件双写导致 status/stop 认错进程、旧 Gateway 变孤儿。

- 新增 `resolveGatewayPid()`：优先端口 LISTENING PID，其次存活 pid 文件
- `serve start`：等待 `/health`/端口就绪后写入真实 PID
- `serve status`：展示 `Source: port|pidfile`，不一致时提示
- `serve stop`：清理解析 PID + pid 文件 PID + 端口占用者
- `serve fg`：先解析配置端口再清占用

## v0.24.2 (2026-09-15)

### fix(web): WebUI 白屏 — 去掉 harness barrel 浏览器导入 + Vite host

- `ChatWorkspace` 此前从 `src/harness/index` 导入 `estimateTextTokens`，barrel 会把 `node:fs` / `node:child_process` 等 Node 专用模块拖进浏览器模块图，页面空白
- 改为直接引用 `context/token-estimator` 与 `context/token-constants`
- `vite.config.ts` 设置 `server.host: 'localhost'`，避免 Windows 上默认只绑 IPv6 `[::1]` 导致 `127.0.0.1` 连不上

## v0.24.1 (2026-09-15)

### feat(cli): Gateway + WebUI 自托管跨平台（Windows / macOS / Linux）

研发期自托管此前偏 macOS：`lsof`、`sleep`、直接 spawn 无扩展名 `vite` shim，在 Windows 上会失败；且 `serve start` 会因 WebUI 失败而整体退出。

#### 新增 `src/cli/process-utils.ts`

- `delay()` — 替代 Unix `sleep` 命令
- `findPidOnPort()` — win32 用 `netstat -ano`，unix 保留 `lsof`
- `killProcess()` — Windows 用 `taskkill /T /F` 杀进程树
- `spawnDetached()` — 统一 `detached` + `windowsHide`
- `resolveViteLaunch()` — 优先 `node .../vite/bin/vite.js`，避开 Windows `.cmd` shim

#### serve 生命周期

- `start`：WebUI 改为 soft 启动，失败只警告，Gateway 照常后台运行
- `stop` / `restart`：跨平台杀进程；restart 后 PID/port 一致
- `fg`：端口占用清理改为真正 `await killProcessOnPort`
- 子进程写 PID 时携带配置中的真实 HTTP port（原先只认 `--port`，会被覆盖丢失）

#### 其它

- `npm test` / `test:coverage` 改为直接执行 `node_modules/vitest/vitest.mjs`（Windows 上 `.bin/vitest` 是 bash 脚本会语法错误）
- 根目录脚本：`install:all`、`build:web`、`serve`、`web`
- Web 前端支持 `VITE_OCTOPI_BASE` 覆盖 Gateway 地址
- 新增 `tests/cli-process-utils.test.ts`

### fix(deps): typescript-eslint 升至 ^8.70.0 以兼容 TypeScript 6

`typescript-eslint@8.34.1` peer 上限为 `<5.9.0`，与 `typescript@^6.0.3` 冲突导致 `npm install` ERESOLVE 失败。8.70.0 peer 扩展至 `<6.1.0`。

## v0.24.0 (2026-09-15)

### fix(security): 二轮审查 — TEMP 顺序 / 文件工具覆盖 / 写入目标评估

#### P1

- **TEMP 优先于 PROTECTED**：`C:\Windows\Temp\` 原先被 `C:\Windows\` 吞掉判 critical；现 TEMP 先匹配 → safe
- **AppData Temp 回退**：无 `TEMP`/`TMP` 时用 `USERPROFILE\AppData\Local\Temp` 等
- **FILE_TOOLS 补全**：`file_edit` / `file_list` / `file_search` 纳入评估；读写分档（写保护路径 critical，读 high）
- **写入命令评目标**：`set-content` / `mkdir` / `touch` / `copy` 等对 protected→critical、sensitive→high（与删除同构）

#### P2

- **空格路径合并**：`del C:\Program Files\App\x.exe` 不再切成 `C:\Program` + `Files\...`
- `getProtectedPaths` / `getTempPrefixes` 进程内缓存；导出 `resetSecurityPathCache`
- 去掉 READ_ONLY 中重复的 `type`

### fix(security): Windows 路径/命令安全判定闭环（审查 P0/P1）

审查发现工具层已跨平台，但安全层对 Windows 路径会「解析坏掉 → 掉进 safe」。本条补齐确定性防护。

#### P0

- **tokenizer**：`\` 仅在 bash 元字符前作转义；`C:\Windows`、`\\server\share` 原样保留
- **路径段边界**：`startsWithPathPrefix` / `allowedPaths` / `pathContainsSegment` 拒绝 `project` 绕过 `project-evil`；`.sshrc` 不再误报 `.ssh`
- **盘符根**：`C:\`、`D:\` 判 `protected`
- **绝对路径**：跨平台识别 POSIX + 盘符 + UNC，避免 Windows 路径被 resolve 进 cwd 变成 safe

#### P1

- **cmd/start** 不再进 WRAPPER（避免 `/c`、`/b` 被当成命令名）
- **INLINE_CODE_FLAGS**：`powershell/pwsh -Command|-c|-EncodedCommand`，`cmd /c|/k`
- **删除/写入命令**：`del`/`erase`/`rd`/`Remove-Item` 及 PS 写入别名；命令名大小写不敏感；`-Recurse`/`/s` 计入递归
- **TEMP**：动态读取 `TEMP`/`TMP` 与 `SystemRoot\Temp`
- **SystemRoot**：动态加入保护前缀（非 C 盘 Windows）

#### 其他

- `default-security-guard` allowedPaths 段边界
- `degradation` 覆盖 Windows 重定向目标
- 新增 `tests/harness/windows-security.test.ts`（24 项，真实单反斜杠路径）

### feat(tools): 文件 / Shell 工具完整跨平台支持（自动识别 OS）

内置文件与 shell 工具此前实质按 Unix 设计：路径用 `startsWith('/')` 判断绝对路径，shell 硬编码 bash，`env_info` 用 `which`。纯 Windows 或无 Git Bash 环境不可靠。

#### 新增 `platform.ts`

- `resolveToolPath` — 基于 `path.isAbsolute`，覆盖 POSIX `/`、Windows 盘符与 UNC
- `resolvePlatformShell` — 自动选择 shell 并缓存：
  - 非 Windows：`/bin/bash` → PATH `bash` → `/bin/sh` → PATH `sh`
  - Windows：PATH `bash`（Git Bash）→ `pwsh` → `powershell` → `cmd.exe`
- `findExecutable` / `commandExists` — 按 PATH（Windows 含 `PATHEXT`）探测可执行文件
- `defaultPathEnv` — 平台安全的 PATH 回退

#### 工具行为

- **shell**：按探测结果 spawn；description 标明 Detected shell 与语法提示；返回值增加 `shell.{kind,executable}`；`windowsHide: true`
- **file_read / file_write / file_list / file_edit / file_search**：路径统一走 `resolveToolPath`
- **env_info**：包管理器探测改用 `findExecutable`；新增 `platformShell`

#### 安全层

- `default-security-guard` allowedPaths 判断改 `path.isAbsolute`
- `shell-parser` 解释器/wrapper 识别加入 `powershell`/`pwsh`/`cmd`/`start`
- `risk-evaluator` 路径分类支持 Windows 保护路径、Temp、Users home；Windows 路径前缀大小写不敏感

### test(tools)

- 新增 `platform-tools.test.ts`（路径解析、shell 探测、findExecutable、shell 执行、env_info.platformShell）

## v0.23.1 (2026-09-15)

### refactor(context): Token 估算器去 core 误名 + 收敛重复实现

清理 v0.8.0 架构迁移遗留：`core-token-estimator` 实际在 Harness 层，注释却写「供 Core 和 Harness 层使用」；三套消息列表估算逻辑并行，存在漂移与死导出。

- 重命名 `core-token-estimator.ts` → `token-estimate-fns.ts`，修正文件头定位（Harness 内部纯函数原语）
- 抽出共用 `estimateContentBlock` / 接回 `estimateToolCallTokens`；`HeuristicTokenEstimator` 与 `estimateLLMMessages` 不再手写三份 block 循环
- `estimateMessage` 对 string 型 `toolCalls.arguments` 不再二次 `JSON.stringify`；`estimateLLMMessages` 的 audio/video 与 domain 口径对齐（不再落入 10）
- `harness/index` 导出估算常量；web `ChatWorkspace` 改走领域门面，不再深路径引用内部文件
- 文档：`context/README`、`ARCHITECTURE` 目录树对齐（`ContextIntelligence` 在 `memory/`，无 `context/index.ts`）
- 补 `estimateContentBlock` / `estimateToolCallTokens` / `estimateLLMMessages` 单测

### test(context)

- `context-engine.test.ts` +13：content block 分类型、tool call 字符串参数、tool-result 密比率、LLM audio/video

## v0.23.0 (2026-09-14)

### feat(autonomous-subsystem): 收口 + 统一 LLM 端口 + 审查修复

补齐领域正确性与完整度，统一 code/llm 路径的模型解析与认知指令注入。内部阶段不做向后兼容 shim。

#### Sense / 注册

- `detectCycles` 接入 `register`：新子系统落在环上则拒绝；Builder warn 拒绝原因
- 自环 = `listen ∩` 具体 emit；`emits: ['*']` 只参与多节点环，**不再**因自环拒注册
- `sense.source=schedule`：interval≥1000ms；timer 随 unregister/dispose 拆除
- 修 eventBus 监听泄漏（按 entry 持有 disposables）
- condition 评估 `inFlight` 互斥 + 默认 30s 超时，防 await 永久占用；无 condition 保持同步触发

#### Signal / Runner

- `SubsystemRuntime.consumePendingGuidance()`：消费 steering/escalate（escalate 优先）
- Runner 在当前轮写入 `injectedContext`

#### Think / llmPort

- 新增 `SubsystemLLMPort`：`chat()` + primary/fallback 链 + 认知 prompt
- **始终注入** `llmPort`、`__subsystem_prompt__`、`__resolved_model__`、`__resolved_models__`
- `request.model` 经 `ModelResolver.resolve`，禁止钉死级别名导致 fallback 失效
- `finishReason=error` 与 catch 同走 `shouldFallbackModel`；匹配收紧（429/rate limit/timeout/5xx/网络瞬断）
- `maxTokens` 预检与 `inferTokenUsage` 改用 `estimateTextTokens`（非字符数）

#### Boundary / 安全

- `boundary.security` 文档与类型标明为**声明契约**，运行时未做沙箱；硬约束仍是 authority + visibility

#### Loader

- `js-yaml` 解析 config.yaml / frontmatter（惰性 require；非法 YAML 进 LoadResult.errors）
- 依赖写入 `package.json` / `package-lock.json`

### refactor(memory-extractor)!: 对齐 llmPort，拆认知指令与作者文档

- `SUBSYSTEM.md` 仅保留 LLM 认知指令；流程/依赖/观测迁至 `README.md`
- `implementation: code`；handler 经 `llmPort.chat` 做语义增强，不再硬编码 SYSTEM_PROMPT
- **删除** `DEP_MODEL_PROVIDER`、`MemoryExtractorDeps`；`enrichWithLLM` 签名改为 `EnrichmentChat`
- `callHandler` 去掉 `modelProvider` 选项；`runtimeInject` 仅 `memoryStore`
- `llmEnrichment` 不再声明 `model`（由 `think.model` → llmPort 解析）

### docs

- `docs/autonomous-subsystem.md`：schedule 感知、四通道时序、llmPort §7.4、SUBSYSTEM.md 角色、§6.3 通配符语义

## v0.22.0 (2026-09-14)

### feat(agent-runtime): 激活宿主落地 + Gateway 接线 + Supervisor 归档

按 `arch/agent-runtime.md` 落地 long-lived 激活层：非用户刺激 → 受监督 Run。内部研发，无向后兼容 shim。

#### Harness `agent-runtime`（新领域）

- `AgentRuntime`：注册 RuntimeAgent/TriggerSource，`dispatch`（模型 A：await 至 Run 结束）
- `ExplicitRouter` / `Compiler` / `CoalesceBuffer` / `SessionRunnerDispatcher`
- Sources：`ScheduleSource`（自有 timer，不依赖 orchestration）、`EscalateBridge`（仅 EventBus）、`AgentSignalSource`
- 同 session 串行归 `SessionAwareRunner` 锁；不建第二执行队列；emit 契约非阻塞
- 主导出：`harness/index.ts`

#### Integration

- `channel-message-source.ts`：ChannelMessage → Trigger
- `WebhookSource` / `FileWatchSource`
- Gateway：消息路径经 `runtime.dispatch` + `onEvent` 流式广播；`abortSession` 转调 `runtime.abort`

#### run-guard 纯度

- **删除** `AgentSupervisor` / `EventCollector`（归档决策见 arch §10；内部阶段不留 shim）
- `cognitive-loop` 头注释改为 orchestration 契约说明

#### 文档

- `arch/agent-runtime.md`、`arch/open-problems.md` OP-AR-1/2
- ARCHITECTURE §3.12b、run-guard README

#### 审查修复（同版本）

- AbortController 按 `requestId` 登记；`abort(agentId, sessionId)` 杀掉该 session 下全部活跃 Run
- **Runner**：`acquireLock` 成功后若 `signal.aborted` 立即释放并 return，不 push 幽灵消息
- 合批路径回传真实 `DispatchResult`；窗口内 `onEvent` 以最后一次 push 为准
- fan-out 返回 `FanoutDispatchResult`（含 aborted 明细；部分失败不静默）
- `SessionRunnerDispatcher`：defaults 在前、request 字段最后写入
- 通道消息透传 `msg.timestamp`；`type=message` 不打 `metadata.source=runtime`
- 删除空 `run-guard/types.ts`；knowledge 测试改从 cognitive-loop 导入
- Gateway 注入 EventBus；`configureAgentRuntime` 按 `agentRuntime` 配置挂 Schedule/Escalate
- Webhook body 上限；FileWatch 防抖；非法 cron 不静默 60s
- `dispatchMany`；`on(listener)` / `on(type, listener)`；`RUN_SCHEDULED` / `AGENT_SIGNAL_EMITTED`
- `package.json` → 0.22.0；schema/example 增加 `agentRuntime`；README 导入路径改 `octopi/harness`
- `coalesceWindowMs` / `expectedMaxConcurrentRuns` 经 GatewayConfig 注入构造；**移除 `agentRuntime.enabled`**（Source 靠配置块存在与否挂载）
- Escalate 默认订 `subsystem.signal.escalate` + `subsystem.escalate`；`builder.events(gatewayBus)` 同源
- SessionGate.enter 支持 AbortSignal；**gate 排队 abort → 空 generator → skipped(aborted)**（非 failed）
- `coalesceBufferLimit` 全链路接线（TS/zod/json schema/daemon/toGatewayConfig）
- `agentSignal` 仅显式 true 或 escalate.defaultAgentId 时挂载
- Webhook 测试用 port=0；删除 CHANGELOG 重复 v0.21.2 标题

### fix(config,test): budget.maxTimeMs 迁移告警 + Guard 生命周期真 e2e

- `loadConfig`：`budget.maxTimeMs` 告警并迁移到 `maxWallClockMs`（与 supervisor→runGuard 同策略）
- 新增 `tests/run-guard-lifecycle.e2e.test.ts`：连续失败工具 → recover → `run_guard_stopped` 全链路
- 工具路径 turn_end 仅 `checkHardOnly`，soft 留给 onTurnComplete（避免陈旧 hasProgress 续租）

## v0.21.1 (2026-09-13)

### feat(run-guard,budget): ResourceBudget soft/hard 接线 + Checkpoint 真实指标 + P1 监督升级

按 `arch/run-guard-refactor.md` 落地 P0/P1：Budget ⊥ Guard 组合，资源主轴 token/time，用户可见事件走 AgentLoopEvent。

#### Budget（harness 非领域模块）

- `IterationBudget` 演进 soft/hard：主轴 `maxTokens` + `maxWallClockMs`；`maxIterations`/`maxToolCalls` 仅显式配置时硬停
- soft 触达：`hasProgress` → 静默续租（`budget.renewed`）；否则 `soft` 状态交 Guard
- **soft 无 Guard 时升为 hard 停止**（禁止静默空转）
- Builder `.budget()` 注入 `ReliabilityHarness.budget`
- 配置：`BudgetJsonConfig` + Zod + `octopi.schema.json`；默认 2M tokens / 6h，无模式 profile

#### RunGuard / Reliability

- 新增 `RunMetricsCollector`（reliability）：真实 iteration / tokens / summaries / hasProgress
- `runAgentWithReliability` 拦截 turn_end：token 计量 + 每轮 Budget 评估 + yield `budget_exceeded` / `run_guard_stopped` / `run_guard_recovered`
- **即时检查点**：tool-loop critical / noop 超限 → `forceCheckpoint`（不等固定 interval）
- **恢复升级阶梯**：`recoveryHistory` + 同 `failureKind` 连续 3 次 recover → stop；第 3 次前建议 `clear_recent_turns`
- `CheckpointVerdict.failureKind`（loop/thrash/drift/stall/blowup/burn）
- DefaultRunGuard **默认不再启用 hardLimit/hardWallClockMs**（资源总闸归 Budget）
- `checkpointInterval` 从 `runGuard` JSON → reliability 初始间隔
- 实现 `clear_recent_turns`；stop 时携带 `userMessage`
- Core：`ReliabilityHarness.budget?: ResourceBudgetLike`；`CheckpointContext.recoveryHistory` / `metrics.noopStreak` / `externalSignals`

#### 导出面

- `harness/index.ts` **不再导出** `AgentSupervisor` / `startSupervisor` / `SupervisorEvents` / `EventCollector`（仍从 `run-guard/index.ts` 具名导入）
- 注释纠错：删除「RunGuard 替代 IterationBudget」表述

#### Security 边界

- `checkBehavior` 主路径本就未调用；**去掉** loop/error/发散 与 Guard 重复的 security 裁决，只保留高危工具组合等攻击形态
- 接口/README 写明：跑飞归 RunGuard

#### 测试

- `tests/resource-budget.test.ts`：soft 续租、hard 停止、collector、e2e budget_exceeded
- `tests/run-guard.test.ts`：升级阶梯、external critical、默认无 hardLimit
- `tests/run-guard-escalation.e2e.test.ts`：recover×3 → stop；LLM prompt 含 recoveryHistory

#### 审查修复（同版本）

- soft + Guard：`forceCheckpoint` + `budget_soft` external signal；无 Guard 才升 hard
- Builder **始终**挂默认 `IterationBudget`（可覆盖），主路径硬停默认生效
- **per-run 克隆 Budget**：`runAgentWithReliability` 从 harness 模板 `getConfig()` 新建实例，避免长驻/并发共享计数
- **beforeToolCall hard 闸**：budgetStop / `checkHardOnly` 时 `block+terminate`，hard 后不执行本批工具
- Guard 规则消费 `budget_soft`（failureKind=burn）
- `tool_end` 计量 `recordToolCall`；`checkHardOnly` 避免 soft 误续租
- soft 评估挪到 `onTurnComplete`（hasProgress 已更新）；hard 在 `turn_end` 用 `checkHardOnly`
- 错误 `turn_end` 跳过 token 计量（防重试双计）
- 一次 checkpoint 只记 1 条 recovery（防多 action 放大升级）
- `adaptLoopEvent` 映射 `budget.exceeded` / `run_guard.stopped` / `run_guard.recovered`
- Builder `_checkpointInterval` 接入 reliability config；Gateway 去掉死 import；example.json 补 budget/runGuard
- Schema 补 `renewGrantTokens` / `renewGrantMs`；删除死状态 `pendingBudgetSoft`

- soft 无 Guard：`pendingBudgetHardYield` → `budget_exceeded`；文本路径 soft 在 turn_end 入账后判定
- per-run Budget 克隆 + beforeToolCall hard 闸回归测试

## v0.21.0 (2026-09-13)

### refactor(harness): Multi-Agent 独立领域 + Autonomous Subsystem 入域

完成 v0.11.0「分布式智能体 → 自主子系统」重构后的领域收尾：拆除空壳 `distributed-agents`，领域口径从 13 统一为 14。

#### 变更

- **目录**：`src/harness/distributed-agents/multi-agent/` → `src/harness/multi-agent/`（提升为独立领域；删除空壳 `distributed-agents/`）
- **领域口径**：13 → **14**（Multi-Agent 独立 + Autonomous Subsystem 正式入域）
- **导出**：`harness/index.ts` / `src/index.ts` 改为从 `multi-agent/` 导出
- **文档**：README / README_CN / harness README / ARCHITECTURE / CONTRIBUTING / AGENTS.md 同步；新增 `multi-agent/README.md`、`autonomous-subsystem/README.md`
- **注释清理**：去掉 builder/runner/reliability/security/config 中「分布式智能体」过时表述
- **配置体系收口**：删除顶层 `distributedIntelligence` 与系统级 `subsystems.safetyGuard`；子系统自身参数只写在各自 `config.yaml`，系统级 `subsystems` 仅保留框架项（`auditDir`）
- **删除死代码** `AgentBuilder.withSafetyGuard()`（只存配置、从未生效）
- **配置桥接**：在 `security` 启用时自动注入 `DefaultToolCallRiskPolicy`，与目录加载的 safety-guard 子系统形成「规则引擎 → risk_unknown → LLM 兜底」单链路
- **配置告警**：`loadConfig` 检测到旧字段 `distributedIntelligence` 时打印 warning（与 `supervisor` 同策略）
- **文档**：ARCHITECTURE 安全章节修正 safety-guard 路径（`subsystems/safety-guard/`，不再误列在 `harness/security/`）

#### 不变

- Multi-Agent 与 Autonomous Subsystem 正交：前者管多 Agent 协作，后者管主 Loop 外 Sense/Think/Act 闭环
- 公开 API 符号名不变（`AgentSwarm` / `AgentProcess` / `DefaultAgentRegistry` 等）

## v0.20.0 (2026-06-12)

### refactor(domain-split): 拆分 task-system，落地 run-guard / orchestration / AsyncTask

按 `docs/domain-split.md` 完成领域切分。内部研发阶段，**不保留向后兼容**。

#### Core

- `TaskSupervisor` → **`RunGuard`**（`core/interfaces/run-guard.ts`）
- `TaskStore` / `TaskRecord` / `TaskStatus` / `TaskPriority` / `TaskFilter` → **`AsyncTaskStore` / `AsyncTaskRecord` / `AsyncTaskStatus` / `AsyncTaskPriority` / `AsyncTaskFilter`**
- 删除 `task-decision.ts`（TaskDecisionProvider）
- `ReliabilityHarness.taskSupervisor` → `runGuard`
- 上收跨域契约：`core/interfaces/cognitive-loop.ts`（Plan/Planner/Reflector）、`core/interfaces/knowledge-store.ts`（KnowledgeStore）

#### Harness 目录

| 旧 | 新 |
|----|----|
| `task-system/supervisor/*` | `run-guard/` |
| `task-system/workflow\|scheduler\|planner\|strategy\|quality\|reflector` | `orchestration/`（experimental，子路径 `octopi/harness/orchestration`） |
| `task-system/knowledge/*` | `context/knowledge/` |
| `task-system/tasks/*` | 已由 `session-tasks/` 取代后删除 |
| `task-system/` | **删除** |

#### 命名

- `DefaultTaskSupervisor` → `DefaultRunGuard`；`createTaskSupervisor` → `createRunGuard`
- `TaskSupervisorConfig` → `RunGuardConfig`
- Builder `.taskSupervisor()` → `.runGuard()`
- `resolveSupervisor` → `resolveRunGuard`
- 配置字段 `supervisor` → `runGuard`（JSON schema / Zod 同步）
- 删除 `createTaskTools` 兼容壳

#### 导出面

- 主路径导出：`SessionTask*`、`RunGuard*`、`AsyncTask` / `spawnTask`
- orchestration 不再占用 `harness/index.ts` 默认导出面

#### 文档

- README / README_CN / ARCHITECTURE / domain-split / CONTRIBUTING / 各领域 README 同步
- 领域数量口径统一为 **13**（session-tasks / run-guard / orchestration 进，task-system 出）

#### 审查修复（同版本）

- 补齐 untracked 关键文件（cognitive-loop、orchestration 入口、run-guard 测试等）
- 配置类型改名：`config.RunGuardConfig` → **`RunGuardJsonConfig`**，避免与实现配置撞名
- `loadConfig` 检测旧字段 `supervisor` 时打印 warning（不再静默失去监督）
- Builder `.runGuard()` 用 `typeof checkpoint === 'function'` 判别实例 vs 配置
- 清除文档中 TaskDecisionProvider / TaskTracker / task-system 残留指向

## v0.19.0 (2026-06-12)

### feat(session-tasks): 会话任务 SessionTask（goal/step 两级）

按 `docs/task-system.md` 落地会话任务，取代旧 TaskTracker / 每条消息侧车 TaskManager 主路径。

#### 架构

- **Session 聚合**：`SessionData.tasks?: SessionTask[]`，随 SessionStore 持久化
- **两级结构**：goal（`parentId` 空）+ step（depth=1）；状态 `open|paused|done|dropped`
- **唯一写入口** `SessionTaskService`：状态机、goal 级联 drop、`session.task.*` 事件
- **写入方**：仅主 LLM `task_*` 工具；UI 只读（本版未暴露 HTTP PATCH）
- **注入**：Runner 每轮渲染 goal + step rollup（`<session_tasks>`），不罗列全部 step
- **接线**：`AgentBuilder.build()` 自动创建 Service、注册 `task_*`、注入 Runner；daemon 不再单独建 TaskTracker

#### UI 只读穿透

- `GET /api/v1/sessions/:id/tasks` — 任务列表 snapshot
- `SessionView.taskCount`；SDK `getSessionTasks()` / `SessionTaskView`
- Gateway 将 `session.task.*`（EventBus）转发至 WebSocket `broadcastEvent`
- **Runtime Store**：`chat.tasks` + `TasksEvent`；打开会话拉取，WS 增量合并
- **WebUI**：右栏「任务」页签（goal 树 + 步骤 rollup，只读）

#### 修复

- **task_* 工具未进入 Agent**：此前在 `buildAgent()` 之后才 `toolBus.register`，Agent 工具快照不含 task 工具。现改为在 `buildAgent()` 前注册（回归测试 `builder-session-task-tools`）
- **切换会话丢失任务**：`JsonlSessionStore` 原先只写 messages JSONL，不保存 `tasks`。现增加 `<sessionId>.state.json` 持久化 tasks/turns/metadata
- **切换会话丢失最后回复**：`openSession` 改为优先拉取服务端 messages（权威历史），仅当缓存更长时用缓存补全未落盘流式内容；打开后同步 React 对话状态

#### 工具

`task_list` / `task_create` / `task_plan` / `task_complete` / `task_pause` / `task_resume` / `task_drop` / `task_note`

#### 兼容

- 旧 `TaskTracker` / `TaskManager` / `DefaultTaskDecisionProvider` 保留导出并标 `@deprecated`
- `task_update` 工具已由上述拆分工具取代

#### 文档

- `docs/task-system.md` — SessionTask 唯一设计基准
- `docs/domain-split.md` — run-guard / orchestration / AsyncTask 领域切分
- `README.md` / `README_CN.md` / `arch/overview.md` — 领域说明同步

## v0.18.2 (2026-09-13)

### chore(docs): 删除已完成的技术债文档

`docs/TECH_DEBT_REPAIR_ISSUES.md` 中 8 项技术债均已修复并验证，文档不再需要。

## v0.18.1 (2026-09-13)

### chore(docs): 删除过期 TECH_DEBT_REPAIR_PLAN.md

根目录技术债修复计划已过时，相关问题清单保留在 `docs/TECH_DEBT_REPAIR_ISSUES.md`。

## v0.18.0 (2026-09-12)

### feat(tools): web_search 多 provider 网络搜索工具

#### 架构

按依赖倒置落地，与 LLM `models.providers` 同构：

- **Core**：`WebSearchProvider` 契约（`core/interfaces/web-search.ts`）
- **Harness**：`createWebSearchTool` 只依赖 Core 接口，通过 DI 接收实现
- **Integration**：DuckDuckGo / Tavily / Brave / Serper / MiMo 适配器 + factory + fallback 链
- **Config**：顶层 `webSearch` 段（Zod 校验 + `${ENV}` 展开）

#### 配置示例

```json
{
  "webSearch": {
    "provider": "tavily",
    "fallbacks": ["duckduckgo"],
    "defaultLimit": 5,
    "timeoutMs": 15000,
    "providers": {
      "tavily":     { "api": "tavily",     "apiKey": "${TAVILY_API_KEY}" },
      "brave":      { "api": "brave",      "apiKey": "${BRAVE_API_KEY}" },
      "serper":     { "api": "serper",     "apiKey": "${SERPER_API_KEY}" },
      "mimo":       { "api": "mimo",       "apiKey": "${MIMO_API_KEY}", "model": "mimo-v2.5-pro", "maxKeyword": 3, "forceSearch": true },
      "duckduckgo": { "api": "duckduckgo" }
    }
  }
}
```

未配置 `fallbacks` 且主 provider 非 DuckDuckGo 时，自动追加免费 DuckDuckGo 兜底。

#### 行为

- Agent 工具参数：`query` / `limit` / `region` / `safe_search` / `time_range`
- 主 provider 失败后依次尝试 fallbacks，全部失败抛出聚合错误
- 未配置 `webSearch.providers` 时不注册 `web_search`（避免无 key 暴露工具）
- `PluginApi.registerWebSearchProvider` 类型从 `unknown` 收紧为 `WebSearchProvider`
- MiMo provider 走 Chat Completions 内置 `web_search` tool（官方字段：`max_keyword` / `force_search` / `limit` / `user_location`），解析 `url_citation` annotations 为结果，可选返回 `answer` 正文
- fallback 链：空结果与抛错同样触发降级（修复主 provider 失败后被 DDG 空响应挡住的问题）
- DuckDuckGo 解析 0 条时显式抛错，便于切换到 mimo 等主 provider
- `loadConfig` 回退路径改为 `getOctopiHome()`（`~/.octopi`，原先误写为 `~/octopi`），并打印实际加载的配置文件路径
- 移除仓库根 `octopi.json` 本地实例；CLI 优先使用 `~/.octopi/octopi.json`，避免 cwd 配置遮蔽工作空间配置；`AGENTS.md` 补充配置文件约定
- MiMo 默认超时提升至 90s，并对可重试错误（timeout/network）自动重试 1 次；主 provider 为 mimo 时工具级 timeout 不低于 90s

#### 变更文件

- Core：`core/interfaces/web-search.ts`（新）
- Harness：`tools/web-search.ts`（新）、`tools/tool-set.ts`
- Integration：`web-search/{http,duckduckgo,tavily,brave,serper,mimo,factory,index}.ts`（新）
- Config：`config.ts`、`config-schema.ts`
- CLI：`daemon.ts` 装配
- 测试：`tests/harness/web-search.test.ts`（新）

## v0.17.0 (2026-09-12)

### refactor: 工具体系架构重构 — 引入 ToolBus 统一工具管理

#### 问题

工具系统的注册、发现、策略过滤、格式转换逻辑散落在 ToolRegistry / ToolSet / AgentBuilder / agentLoop 四处，形成双轨制。版本管理和流式执行是死代码。ToolPolicy 的 allow/deny 配置从未在运行时强制执行。

#### 架构变更

**Core 层（Layer 1）**
- 新增 `ToolBus` 接口（`core/interfaces/tool-bus.ts`）：统一的工具注册、发现、策略过滤、格式转换契约
- 新增 `ToolSource` 类型：工具来源标准化（builtin / plugin / mcp / subsystem / custom）+ 信任级别
- 扩展 `ToolDefinition`：新增 `version`、`deprecated`、`deprecatedMessage` 字段
- 扩展 `RegisteredTool`：新增 `source?: ToolSource` 字段

**Harness 层（Layer 2）**
- 新增 `DefaultToolBus` 实现（`harness/plugin-ecosystem/tools/tool-bus.ts`）：整合 ToolRegistry + 参数校验 + ToolPolicy 过滤 + LLM 格式转换
- `AgentBuilder` 改用 `DefaultToolBus` 替代原有的 `Map<string, RegisteredTool>`
- `SubsystemRuntime.SharedDeps.mainTools` 类型从 `Map<string, RegisteredTool>` 改为 `ToolBus`
- MCP Manager 回调桥接到 ToolBus

#### 删除

- `ToolRegistry`（被 DefaultToolBus 替代）
- `VersionedToolRegistry`（版本信息已内建到 ToolDefinition）
- `createProgressReporter`（流式回调已内建到 AgentTool.execute 的 onUpdate 参数）
- 相关测试文件：`tool-versioning.test.ts`、`streaming-tools.test.ts`

#### 影响范围

- `ToolRegistry` 的所有消费方需迁移到 `DefaultToolBus`
- `SubsystemRuntime` 的 `mainTools` 字段类型从 `Map<string, RegisteredTool>` 改为 `ToolBus`
- `ToolBus.listForAgent()` 返回 `RegisteredTool[]`（旧 `ToolRegistry.listForAgent()` 返回 `ToolDefinition[]`），消费方需从 `t.name` 改为 `t.definition.name`
- `AgentBuilder` 内部实现变更，外部 API 不变

## v0.16.3 (2026-09-12)

### feat(web): 历史会话列表按时间倒序排列，默认显示 5 条并支持展开

左侧 session 列表现在按 `lastInteractionAt` 降序排列，最新活跃的会话排在最前面。默认只展示前 5 条，超出部分通过底部按钮展开/收起。


### fix: Gateway 重启后 session 丢失（统一 session 持久化机制）

之前存在两套 session 持久化路径：per-agent 目录和 config-based dataDir，且 Gateway 在未显式配置 `session.store` 时直接 fallback 到 `InMemorySessionStore`，导致重启后 session 丢失。

#### 修复
- Gateway 未传入 store 时，自动从 `agent.home` 目录推断创建 `JsonlSessionStore`（持久化），而非 fallback 到内存存储
- 删除 Gateway 和 Builder 中重复的 `InMemorySessionStore` 实现，统一使用 `integration/storage/memory.ts` 的导出
- `JsonlSessionStore` 构造函数移除已废弃的 `legacyDataDir` 参数，只保留 `agentHomeResolver`

#### 影响范围
- `session.store` 配置不再是持久化的必要条件（Gateway 自动推断）
- `JsonlSessionStore` API 变更（移除第二个参数），外部集成方需更新调用方式


## v0.16.0 (2026-09-12)

### refactor: 工具模块架构重构（breaking change）

彻底理清工具模块的分层架构，消除 `services` 类型黑洞，建立可靠的工具扩展机制。

#### 架构变更

- **builtin/extension 分离** — `getBuiltinTools()` 只返回 8 个零依赖纯工具，有状态工具（memory/task/ask_user）全部移入 extension。
- **闭包注入取代 services** — memory/task/ask_user 工具通过工厂函数接收依赖参数，消除 `ToolExecutionContext.services` 类型黑洞。
- **RuntimeToolContextProvider** — 工具 handler 通过 provider 在运行时获取真实 sessionId/agentId/messages，不再收到空值。
- **createToolSet()** — 一站式注册 builtin + extension 工具，集成方一次调用完成全部注册。

#### Breaking Changes

- `getBuiltinTools()` 返回值从 14 个变为 8 个（移除 memory/task/ask_user）
- `ToolExecutionContext.services` 字段已移除
- `AgentBuilder.services()` 方法已移除
- `Gateway.registerServices()` 方法已移除
- `createMemoryStoreTool(store)` 现在需要传入 store 参数
- `createTaskCreateTool(tracker)` 现在需要传入 tracker 参数
- `createAskUserTool(callback)` 现在需要传入 callback 参数

#### 新增

- `createToolSet(config?)` — 一站式工具注册
- `createMemoryTools(store)` — 创建记忆工具集
- `createTaskTools(tracker)` — 创建任务工具集
- `ToolContextProvider` — 工具运行时上下文提供者接口

#### 迁移指南

```ts
// 改前
for (const tool of getBuiltinTools()) gateway.registerTool(tool);
gateway.registerServices({ memoryStore, taskTracker });

// 改后
const { all } = createToolSet({ memoryStore, taskTracker });
for (const tool of all) gateway.registerTool(tool);
```

---

## v0.15.3 (2026-09-12)

### refactor: 工具自给自足，消除外部依赖注入

memory/task 工具改为模块级默认实例 + context.services 可选覆盖模式，
不再需要 Gateway/Builder/Daemon 层面的特殊注入。

#### 变更

- **refactor(memory): 默认 InMemoryMemoryStore** — memory.ts 内部创建模块级默认 store 实例，运行时优先从 context.services.memoryStore 取，取不到自动用默认实例。
- **refactor(task): 默认 TaskTracker** — task-tools.ts 内部创建模块级默认 tracker 实例，策略同上。
- **refactor(daemon): 清理** — 移除 InMemoryMemoryStore/TaskTracker import 和 registerServices 调用，daemon.ts 只需 getBuiltinTools() + registerTool() 即可。
- **refactor(gateway): registerServices 保留** — Gateway.registerServices() 保留供需要覆盖默认实例的场景使用，但不再必须调用。


## v0.15.2 (2026-09-12)

### refactor: 工具注册统一化

消除 memory/task 工具的特殊注册路径，全部 14 个工具统一通过 getBuiltinTools() 获取。

#### 变更

- **refactor(builtin): getBuiltinTools 统一** — getBuiltinTools() 现在返回全部 14 个工具（含 memory_store/memory_search/task_create/task_list/task_update），移除 getExtendedBuiltinTools()。memory/task 工具的依赖通过 ToolExecutionContext.services 在运行时获取，注册时无需特殊处理。
- **refactor(daemon): 简化注册逻辑** — daemon.ts 移除 getExtendedBuiltinTools 调用，改为 getBuiltinTools() + registerServices() 两步。
- **refactor(exports): 清理** — src/index.ts、src/harness/index.ts、tools/index.ts 移除 getExtendedBuiltinTools 导出。
- **test: 更新测试** — 移除 getExtendedBuiltinTools 相关用例，getBuiltinTools 测试验证全部 14 个工具。


## v0.15.1 (2026-09-12)

### fix: 扩展工具注册与服务注入链路打通

修复 memory/task 工具未被注册到运行时的问题。

#### 变更

- **fix(daemon): 扩展工具注册** — daemon.ts 创建 InMemoryMemoryStore 和 TaskTracker 实例，调用 getExtendedBuiltinTools() 注册 memory_store/memory_search/task_create/task_list/task_update 五个工具，并通过 gateway.registerServices() 注入依赖。
- **feat(gateway): registerServices()** — Gateway 新增 registerServices() 方法，将工具服务传递给 AgentBuilder.services()，工具可通过 context.services 访问。
- **feat(builder): services() API** — AgentBuilder 新增 .services() fluent 方法，接受 Record<string, unknown> 注入到所有工具的执行上下文中。
- **fix(builder): convertToAgentTool 上下文补全** — 工具执行上下文现在包含 sessionId/agentId/messages/services 字段，memory/task 工具可正常读取注入的服务。
- **feat(exports): getExtendedBuiltinTools 导出** — src/index.ts 和 src/harness/index.ts 新增 getExtendedBuiltinTools 导出。


## v0.15.0 (2026-09-12)

### feat: 内置工具集扩展（9 个新工具）

将 Agent 基础工具从 4 个扩展到 13 个，覆盖文件编辑、搜索、HTTP、记忆、任务管理、用户交互、环境感知七大能力域。

#### 新增工具

- **file_edit** — 结构化文件编辑：old_text/new_text 局部替换，支持 occurrence 选择（first/last/all/N）和 dry-run 预览
- **file_search** — 跨文件内容搜索：文本/正则模式，glob 过滤，上下文行，二进制文件自动跳过
- **http_request** — HTTP 请求：支持 GET/POST/PUT/PATCH/DELETE，响应体大小限制，超时保护
- **env_info** — 运行环境信息：操作系统、Node 版本、工作目录、可用包管理器检测
- **ask_user** — 请求用户输入：通过 services.askUser 回调与 UI 层解耦
- **memory_store** — 存储记忆：将偏好/决策/经验/发现持久化到 MemoryStore
- **memory_search** — 搜索记忆：按文本/类型/重要性检索历史记忆
- **task_create** — 创建任务：追踪多步骤工作进度
- **task_list** — 列出任务：按状态过滤，查看活跃任务数
- **task_update** — 更新任务状态：complete/cancel/interrupt/resume/start

#### 架构设计

- **ToolExecutionContext.services** — Core 层新增通用服务注入点，Record<string, unknown> 类型避免 Core→Harness 耦合
- **getBuiltinTools()** — 返回 9 个零依赖基础工具
- **getExtendedBuiltinTools({memoryStore?, taskTracker?})** — 按需注入依赖的扩展工具，未注入则自动跳过
- 所有新工具遵循 RegisteredTool 工厂函数模式，与既有 shell/file_read/file_write/file_list 风格一致

#### 测试

- **test: harness/builtin-tools.test.ts** — 20 个新测试覆盖 file_edit（替换/occurrence/dry-run/错误）、file_search（搜索/glob/正则/上下文/截断）、env_info、ask_user、工具注册


## v0.14.4 (2026-09-10)

### refactor: 技术债务修复（TECH_DEBT_REPAIR_PLAN）

针对内部研发阶段的技术债进行系统清理，移除遗留兼容层并补齐质量工程基座。

#### 变更

- **refactor(registry): 工具参数校验补齐** — `ToolRegistry.execute()` 增加类型、必填、枚举、范围、长度、正则、嵌套对象校验；补齐 `ToolParameter` 字段。
- **feat(concurrency): ProviderPool 主动探活** — 新增 `healthCheck` 配置、自动探活机制与 `runHealthCheck()`；不健康 slot 可自动恢复。
- **refactor(context): KnowledgeStage 对齐 ContextEngine** — 删除旧 `ContextStage/StageContext` 体系，新增 `KnowledgeContextEngine`，知识注入通过 `ContextEngine.assemble()` 完成。
- **refactor(cli): CLI 拆分** — `src/cli.ts` 拆分为 `src/cli/*` 多模块，CLI 入口改为 `dist/cli/index.js`。
- **refactor(web/store): 移除 legacy messages** — Web Runtime Store 删除遗留 `messages` 双模型，统一 `conversation` 为唯一 source of truth。
- **refactor(memory): deprecated/re-export 清理** — 删除旧 extraction 封装模块、concurrency/process deprecated re-export；导入路径改为规范定义模块。
- **build(quality): 测试覆盖体系** — 引入 `@vitest/coverage-v8`，新增 `npm run test:coverage`，配置覆盖率报告输出。
- **build(quality): Lint 配置补齐** — 新增 `eslint.config.js` 与 ESLint 相关依赖，`npm run lint` 可稳定运行。

#### 测试

- **test: tool-registry-args** — 补充参数校验正负向测试。
- **test: provider-pool-healthcheck** — 补充探活恢复测试。
- **test: harness/knowledge** — 补充 `KnowledgeContextEngine` 知识注入测试。
- **test: web-runtime** — 补充统一 `conversation` 状态测试。
## v0.14.3 (2026-09-09)

### docs: 自主子系统开发者指南

- **docs: autonomous-subsystem.md** — 面向子系统作者的完整使用说明，覆盖显式必填字段、信号通道、生命周期约束、条件触发（condition/conditionRef）、循环防护（emits）、自定义工具（tools.definitions）、npm 分发、会话隔离与销毁、审计记录。

## v0.14.2 (2026-09-08)

### feat: 自主子系统实现对齐设计（生命周期/信号/条件/循环检测/npm发现/审计）

围绕 `arch/autonomous-subsystem.md` 的关键行为矩阵进行落地修复，补齐运行时契约与可验证测试，确保设计语义可执行。

#### 变更

- **feat(runtime): 生命周期执行约束** — `maxDurationMs` 可中断执行并记录 `timeout` 审计状态；`degradeOn` 决定是否发送中断信号。
- **feat(runtime): Act 闭环** — `processAct` 覆盖 `block/modify/inject/none`，成功/失败均有 Act 结果。
- **feat(signal): 通道按 spec 投递** — `SignalBus.deliver` 优先使用 `spec.signal.channel`，不再仅按 action 推断。
- **feat(think): 模型 fallback** — primary 失败后按 `resolved.fallback` 顺序重试（rate/timeout/server 触发）。
- **feat(sense): conditionRef 支持** — 动态导入并缓存执行函数；`condition` 多变量替换修正。
- **feat(sense): 静态循环检测** — 注册阶段基于 `emits`（含 `*`）做循环检测，存在循环拒绝注册。
- **feat(session): session.ended 联动** — 订阅 `session.ended` 清理 scoped 子系统会话（`session.scope=session`）。
- **feat(loader): npm 子系统发现** — 支持 `@octopi/subsystem-*` / `octopi-subsystem-*` 在 `node_modules` 中自动发现。
- **feat(loader): 显式字段策略** — `boundary/signal/act` 为显式必要字段；缺失直接报错，避免隐式默认。
- **feat(audit): 审计字段增强** — 成功/失败场景保持关键字段，成功路径带 `tokenUsage`（输入输出体积估算）。

#### 修复

- **fix(build): 类型导入修正** — 恢复 `RegisteredTool/Message` 从 `core/types` 导入；`AgentTool` 保留从 `loop/types` 导入，避免 TS2305/TS2459。
- **fix(executor): ensureWithinBudget 方法回归** — 补回类体方法，修复 TS2339。
- **fix(signal/runtime): 信号投递路由一致** — 运行时调用 `deliver` 传入 `spec.signal`，确保通道配置生效。

#### 测试

- **test: lifecycle-enforcement.test.ts** — 超时/降级行为验证。
- **test: runtime-timeout.test.ts** — handler 超时产生 timeout 审计。
- **test: executor-fallback.test.ts** — `TokenBudgetExceededError` 基本语义验证。
- **test: session-end-cleanup.test.ts** — `session.ended` 清理路径验证。
- **test: loader-npm.test.ts** — npm 子系统发现（scoped/plain/无关包）。
- **test: custom-tool-definitions.test.ts** — `tools.definitions` 注册路径验证。
- **test: audit-fields.test.ts** — 审计字段与 tokenUsage 校验。

## v0.14.1 (2026-09-07)

### fix: WebUI 对话区 Markdown 渲染优化

- feat(web): MarkdownMessage — 引入 react-markdown + remark-gfm + rehype-highlight，替换原有纯文本渲染，支持标题、列表、表格、引用、行内代码、代码块与链接等 Markdown 内容。
- refactor(web): 对话气泡 — 将助手消息区与流式输出改为结构化 Markdown 渲染容器，用户消息保持原始文本展示但优化换行与断词表现。
- style(web): Markdown 样式 — 增加段落、列表、表格、引用、行内代码、代码块、语言标签、复制按钮与高亮色板样式，提升中栏可读性。
- build(web): 前端依赖 — octopi-web 新增 react-markdown、remark-gfm、rehype-highlight 依赖；前端生产构建通过。

## v0.14.0 (2026-09-07)

### feat: 子系统定义标准扩展 + memory-extractor 迁移 + hybrid 模式 + models.level 配置

一次性完成四件事：扩展自主子系统定义标准、将 memory-extractor 迁移为定义文件驱动子系统、实现 hybrid（规则+LLM）提取模式、接通 models.level 配置到运行时。

#### 子系统定义标准扩展

- **feat(types): SubsystemHandler / SubsystemContract** — 定义文件驱动子系统的标准导出契约（handler + contract + dependencies）
- **feat(types): RuntimeInjectConfig** — 依赖注入声明，handler 运行时通过 `deps` 参数接收
- **feat(types): LifecycleResumeConfig** — 断点续提恢复配置（扫描间隔、退避策略）
- **feat(types): ObservabilityConfig** — 观测性事件前缀
- **feat(types): SubsystemSpec.metadata** — 子系统特定配置扩展点
- **feat(loader): 标准契约模式** — handler.ts 支持 `export default {handler, contract, dependencies}` 导出
- **feat(loader): metadata 解析** — config.yaml 的 metadata 字段解析到 SubsystemSpec
- **feat(runtime): 自动注入** — 从 spec.metadata.config 注入子系统配置、从 ModelResolver 注入已解析模型名
- **feat(runtime): registerDependency** — 运行时依赖注册表 API
- **feat(validator): 新字段校验** — runtimeInject / resume / observability 一致性校验

#### memory-extractor 定义文件驱动迁移

- **feat(subsystems): subsystems/memory-extractor/** — 完整子系统目录结构
  - `config.yaml` — 定义文件（Sense/Think/Act/Inject/Resume/Observability/Metadata）
  - `handler.ts` — 核心处理器（规则提取 + LLM 增强 + 去重 + 阈值 + 入库），无模块级状态
  - `contracts/bundle.ts` — 输入输出契约类型（SessionExtractBundle / MemoryCandidate / ExtractionResult）
  - `policies/threshold.ts` — 动态阈值策略（含修复奖励机制）
  - `policies/dedup.ts` — 记忆去重与升级策略
  - `policies/profile-threshold.ts` — Agent Profile 阈值策略
  - `llm-enrichment.ts` — LLM 语义增强（事件压缩 → prompt → LLM → 解析）
  - `types.ts` — 注入依赖常量和配置接口
- **feat(handler): callHandler** — 便捷调用入口（绕过 SubsystemRuntime，供测试和嵌入式使用）
- **refactor: 移除工厂模式** — 删除 `createMemoryExtractorSubsystem()`，统一为定义文件驱动
- **refactor: harness re-export** — session-extractor / threshold-policy / memory-deduplicator 改为 deprecated re-export
- **fix(P1): 移除模块级 _config** — handler 配置通过 `deps.__subsystem_config__` 注入，多实例隔离
- **fix(P4): 移除 DEP_EXTRACTOR_STORE** — 未使用的依赖常量

#### Hybrid 模式（规则+LLM）

- **feat(llm-enrichment): 事件压缩** — `condenseEvents()` 将 bundle 事件压缩为人类可读文本
- **feat(llm-enrichment): 语义提取** — `enrichWithLLM()` 调 LLM 提取隐式偏好/决策/经验
- **feat(llm-enrichment): 容错设计** — JSON 解析失败返回空数组，LLM 调用失败不阻断流程
- **feat(handler): 自动降级** — 无 modelProvider 时自动降级为 code 模式
- **fix(P3): 模型名解析** — LLM model 字段通过 `__resolved_model__` 注入已解析的实际模型名

#### 阈值策略改进

- **feat(threshold): 修复奖励机制** — 当 session 有修复记录（resolvedErrors），部分对冲失败惩罚
- **refactor(threshold): 未修复错误惩罚** — majorError 惩罚只针对未修复的错误

#### models.level 配置

- **feat(schema): models.level** — octopi.schema.json 新增 level 节点定义
- **feat(config): LevelConfig / LevelMap** — config.ts 新增类型，ModelsConfig 加 level 字段
- **feat(config-bridge): levelMap 传递** — config → builder → runtime → ModelResolver 完整链路

#### 子系统启动链路接通

- **feat(config): SubsystemsConfig** — octopi.json 新增 `subsystems.auditDir`
- **feat(config-schema): Zod 校验** — models.level + subsystems 的 schema 校验
- **feat(config-bridge): resolveSubsystemSpecs** — 按架构文档4.9三级搜索路径加载子系统（项目级 → 用户级 → 框架级，同名覆盖）
- **feat(config-bridge): 自动注入** — modelLevels + modelProvider 自动注册到 SubsystemRuntime
- **fix(P2): 定义文件 hybrid 模式** — SubsystemRuntime 自动从 spec.metadata.config 注入子系统配置

#### 测试

- **test: hybrid-mode.test.ts** — 3 个测试（成功路径 + LLM 失败降级 + 无 provider 降级）
- **test: model-levels-config.test.ts** — 5 个测试（级别解析 + fallback 链 + 运行时更新）
- **test: 迁移适配** — 11 个测试文件从工厂模式迁移到 callHandler / 内联 SubsystemSpec
- **fix: memory-extractor-subsystem.test.ts** — 修复阈值策略变化导致的测试数据不匹配

## v0.13.0 (2026-09-06)

### feat: 指标接入、SLO 告警、pending 回压限流

补齐生产运行三件套：Metrics 接入、告警规则、回压控制。

#### 新增

- **feat(memory/extraction): ExtractionMetricsBridge** — 将 `memory.extractor.*` 观测事件聚合到 MetricsStore（trigger.success/error、bundle.eventCount、pending.count、accepted.count）
- **feat(memory/extraction): AlertEvaluator** — 最小可用 SLO 告警：`memory.extractor.alert.high_error_rate` / `memory.extractor.alert.high_pending`
- **feat(memory/extraction): BackpressureController** — pending 回压控制（阈值降速 + 并发触发上限）
- **refactor(memory/extraction/pending-extractor): 接入 backpressure** — 按 `maxConcurrentTriggers` 限制并发触发
- **test: extraction-metrics-bridge.test.ts** — 指标聚合与告警触发
- **test: backpressure.test.ts** — 回压并发控制与间隔策略

#### 变更

- **refactor(memory/index): 导出新增模块**
- **docs: memory-extraction-design** — 补充指标、告警、回压设计说明

## v0.12.0 (2026-09-06)

### refactor: 记忆提取系统收敛（一致性、观测统一、兜底恢复、回归测试）

一次性完成记忆提取链路的系统性收敛，解决“打点式修补”带来的不一致与边界缺失。

#### 新增

- **test: e2e-memory-extraction.test.ts** — 端到端回归：同一 bundle 重复触发不翻倍
- **test: bridge-miss-fallback.test.ts** — bridge miss 时写入 pending 记录，恢复链路兜底

#### 变更（Breaking-ish 内部事件名统一）

- **统一观测事件命名**：全部收敛到 `memory.extractor.*`
  - bridge: `memory.extractor.bridge.*`
  - pending: `memory.extractor.pending.*`
- **runner: turn.end 增加 userText**，collector 优先基于用户文本做 confirm/reject 语义检测
- **bridge: bundle miss → 自动写入 pending meta**，保证 pending extractor 可恢复
- **bridge: trigger complete/error → reset 对应 session 采集态**，避免内存累积
- **subsystem: 删除 `__senseEventBundle` 占位**，走正式 eventData→payload 透传
- **bridge.attach() 支持 attachCollector 选项**，便于按需挂载采集器

#### 测试

- 更新 pending/bridge 事件测试，适配 `memory.extractor.*` 命名
- 新增 e2e 与 bridge-miss 回归测试

#### 文档

- 更新 `docs/memory-extraction-design.md`：补充运行约束、统一事件名、兜底恢复说明

## v0.11.9 (2026-09-06)

### feat: bridge 可观测事件与 agent profile 阈值策略

补齐实时链路观测能力，并支持按 agent profile 复用阈值策略。

#### 新增

- **feat(memory/extraction): ProfileThresholdPolicy** — `createProfileThresholdPolicy` 支持不同 profile 使用不同基线阈值，并叠加动态修正
- **feat(memory/extraction): bridge 可观测事件** — 新增 `memory.bridge.lifecycle.matched / bundle.hit / bundle.miss / bundle.loaded / trigger.start / trigger.complete / trigger.error`
- **test: profile-threshold-policy.test.ts** — 验证 profile 阈值策略
- **test: memory-extractor-bridge-events.test.ts** — 验证 bridge 观测事件

#### 变更

- **refactor(memory/extraction/memory-extractor-subsystem): 增加 agentProfile 传入**，阈值策略可基于 profile 计算
- **refactor(memory/extraction/memory-extractor-bridge): 增加事件发射点**
- **refactor(memory/index): 导出 profile-threshold-policy**
- **docs: memory-extraction-design** — 补充 profile 策略与 bridge 观测事件说明

## v0.11.8 (2026-09-06)

### feat: 动态阈值策略与 pending extractor 可观测事件

进一步提升记忆提取的质量控制与运行可观测性。

#### 新增

- **feat(memory/extraction): ThresholdPolicy（动态阈值策略）** — 根据 `failureRate / majorErrors / eventCount` 自适应调整 `minConfidence / minImportance`
- **feat(memory/extraction): PendingExtractor 可观测事件** — 新增 `pending.extractor.scan.start / session.triggered / session.error / complete` 事件
- **test: threshold-policy.test.ts** — 验证动态阈值调整
- **test: pending-extractor-events.test.ts** — 验证可观测事件发射

#### 变更

- **refactor(memory/extraction/memory-extractor-subsystem): 使用 ThresholdPolicy** — 入库前通过策略计算阈值（支持自定义覆盖）
- **refactor(memory/extraction/pending-extractor): scan/scanAgent 发射观测事件**
- **refactor(memory/index): 导出 threshold-policy**
- **docs: memory-extraction-design** — 补充动态阈值与观测事件说明

## v0.11.7 (2026-09-06)

### feat: 置信度门控与多租户 pending 扫描策略

为记忆提取增加质量门控，并支持按 agent 维度配置独立的扫描与重试策略。

#### 新增

- **feat(memory/extraction): 置信度/重要性门控** — `createMemoryExtractorSubsystem` 新增 `minConfidence / minImportance`，低于阈值不入库
- **feat(memory/extraction): PendingExtractor 多租户配置** — 新增 `agentConfigs`，支持为不同 agent 设置独立 `scanIntervalMs / baseRetryMs / maxRetryMs / maxRetries / subsystemId`
- **test: memory-extractor-gate.test.ts** — 验置信度门控
- **test: pending-extractor-multiagent.test.ts** — 验证多 agent 扫描

#### 变更

- **refactor(memory/extraction/pending-extractor): start/stop 支持 agentConfigs**，并暴露 `scanAgent()` 便于测试
- **refactor(memory/extraction/memory-extractor-subsystem): 入库前执行阈值过滤**
- **docs: memory-extraction-design** — 补充门控与多租户扫描策略

## v0.11.6 (2026-09-06)

### feat: 去重集成与 pending extractor 退避重试

将去重/升级策略接入 memory-extractor 子系统入库流程，并为 pending extractor 增加失败退避与最大重试限制。

#### 新增

- **feat(memory/extraction): 去重集成到子系统** — `createMemoryExtractorSubsystem` 新增 `deduplicator` 配置，入库前先执行 `filterAndUpgrade`
- **feat(memory/extraction): PendingExtractor 退避重试** — 支持 `baseRetryMs / maxRetryMs / maxRetries`，超过阈值标记 `extractionStatus=error`
- **test: pending-extractor-backoff.test.ts** — 验证退避与 error 标记
- **test: memory-extractor-subsystem.test.ts** — 验证去重后重复 bundle 不会重复入库

#### 变更

- **refactor(memory/extraction/pending-extractor): 退避逻辑与失败处理**
- **refactor(memory/extraction/memory-extractor-subsystem): 入库链路改为 accepted candidates**

#### 文档

- 更新 `docs/memory-extraction-design.md`：补充去重集成与退避重试说明

## v0.11.5 (2026-09-06)

### feat: 记忆去重/升级 + 断点续提（pending scan）

补齐记忆提取的两个关键能力：
- 去重与升级策略（避免重复记忆膨胀）
- pending session 定时扫描与恢复触发（断点续提）

#### 新增

- **feat(memory/extraction): MemoryDeduplicator** — 同源去重（source tag）+ 类型/标签容量控制 + 升级策略（confidence/importance 提升时 update）
- **feat(memory/extraction): PendingExtractor** — 定时扫描 `ExtractorStore.listPending()`，构建 bundle 并触发 memory extractor 子系统
- **test: memory-deduplicator.test.ts** — 验证去重与升级
- **test: pending-extractor.test.ts** — 验证 pending 扫描触发链路

#### 变更

- **refactor(memory/index): 导出 deduplicator/pending extractor**
- **docs: memory-extraction-design** — 补充去重与断点续提设计说明

## v0.11.4 (2026-09-06)

### feat: 提取素材可回放落盘（JSONL）与恢复链路

为避免重启丢失采集态，新增 ExtractorStore 接口与 JSONL 持久化实现，并将采集器、桥接层接入 store。

#### 新增

- **feat(memory/extraction): ExtractorStore 接口 + InMemoryExtractorStore** — `appendEvents / loadEvents / saveBundle / loadBundle / updateMeta / listPending`
- **feat(memory/extraction): JsonlExtractorStore** — 按 `agentHome/extract/{events,bundles,meta}` 落盘，支持 append 与覆盖快照
- **test: extractor-store.test.ts** — 覆盖内存与 JSONL 两种 store 的核心链路

#### 变更

- **refactor(memory/extraction/collector): 接入 store** — 每次 pushEvent 异步 append；每次 buildBundle 异步 saveBundle 快照
- **refactor(memory/extraction/bridge): 支持 store 兜底恢复** — 当内存采集器无 bundle 时，尝试从 store 加载历史 bundle 并触发
- **refactor(memory/index): 导出 store 相关模块**

## v0.11.3 (2026-09-06)

### feat: 接入真实素材采集链路（session→memory 提取可运行）

在前置架构改造基础上，接入真实的事件采集、语义信号、子系统触发链路，使“session→memory 提取”从骨架进入可运行状态。

#### 新增

- **feat(memory/extraction): SemanticSignals（语言无关）** — 基于结构化文本特征（长度/否定前缀/标点极性）给出 confirm/reject 弱信号
- **feat(memory/extraction): SessionExtractCollector** — 监听 EventBus 的 turn.end / tool.exec.start|end / session.lifecycle.updated / engine.end，聚合为 `SessionExtractBundle`
- **feat(memory/extraction): MemoryExtractorBridge** — 在 lifecycle 更新为 `recent + pending` 时自动生成 bundle 并触发 `memory.extractor` 子系统
- **feat(autonomous-subsystem/runtime): SenseContext.eventData → SubsystemInput.payload.sessionExtractBundle** — 通用透传机制，子系统可直接读取结构化 bundle
- **test: memory-extractor-bridge.test.ts** — 验证 bundle.ready 事件发射与子系统触发链路

#### 变更

- **refactor(memory/extraction/memory-extractor-subsystem): 注册事件扩展** — 监听 `memory.extractor.bundle.ready`，并允许 `eventData?.bundle` 作为触发条件
- **fix(memory/extraction): boundary.authority 修正** — 从 `suggest` 改为 `act`，匹配 `act.mode=inject`
- **refactor(memory/index): 导出提取/采集模块**

#### 文档

- 更新 `docs/memory-extraction-design.md`：补充采集链路与触发说明

## v0.11.2 (2026-09-06)

### refactor: 自主子系统架构前置改造（支持 session→memory 提取）

为让自治子系统可直接承载“session→memory 提取”，先对自主子系统进行通用能力补齐：生命周期感知、结构化 payload 扩展、动作目标语义。

#### 新增

- **feat(autonomous-subsystem/types): 生命周期与抽取状态态** — `SenseContext` 增加 `sessionLifecycle / lastInteractionAt / idleMs / extractionStatus`；新增 `SessionLifecycleStatus / ProcessExtractionStatus`
- **feat(autonomous-subsystem/types): 结构化任务上下文扩展点** — `SubsystemInput` 增加 `payload?: Record<string, unknown>`；`sessionMetadata` 支持扩展字段
- **feat(autonomous-subsystem/types): Act 动作目标语义** — `ActResult` 增加 `target?: string`（如 `context / memory-store / knowledge`）
- **feat(autonomous-subsystem/sense): SessionLifecycleBridge** — 将主会话生命周期状态转为子系统可感知事件/指标（支持 `session.lifecycle.updated` 与 idle 计算）
- **feat(memory/extraction): SessionExtractor 骨架** — rule-first、语言无关的提取器骨架（preference/decision/lesson/discovery）
- **feat(memory/extraction): memory-extractor 子系统规格** — `createMemoryExtractorSubsystem()`（Sense → Think(code) → Act(inject memory-store) → Signal）

#### 变更

- **refactor(autonomous-subsystem/index): 导出新类型与桥接模块** — 导出 `SessionLifecycleStatus / ProcessExtractionStatus / SessionLifecycleBridge`
- **refactor(sense/input-builder): 注入生命周期上下文** — 将 lifecycle/idle/extractionStatus 注入 `sessionMetadata` 与 `payload.sessionLifecycle`
- **refactor(runner): 发射通用 session 生命周期事件** — 在消息到达、处理完成、异常路径发射 `session.lifecycle.updated`

#### 测试

- 新增 `tests/autonomous-subsystem/session-lifecycle-bridge.test.ts`（2 tests）
- 新增 `tests/memory/extraction/session-extractor.test.ts`（3 tests）

#### 文档

- 新增 `docs/memory-extraction-design.md`：完整“session→memory 提取方案”与“前置架构改造”说明

## v0.11.1 (2026-09-06)

### fix: 文档一致性更新

#### 修复

- **docs: CONTRIBUTING.md** — 分布式智能体描述更新为自主子系统
- **docs: arch/overview.md** — safety-agent-spec.ts 引用更新为 safety-guard 子系统目录
- **docs: arch/invariants.md** — 第 13 节从"分布式智能体设计原则"重写为"自主子系统设计原则"，反映五维模型

## v0.11.1 (2026-09-05)

### fix: 自主子系统代码审计修复

修复代码审计发现的 5 个问题。

#### 修复

- **fix(session): TTL 语义修复** — cleanupExpired() 从硬编码 30 分钟改为按每个 persistent session 的配置 TTL 判断，避免长 TTL 会话被错误回收
- **fix(signal): applyPendingContext 排序生效** — 排序后的 sorted 数组替代原 contextQueue 遍历，replace 类型（compressed 标记）优先于 inject
- **fix(think): block 解析失败改为 escalate** — 安全守卫 LLM 输出不可解析时从默认 allow 改为 escalate（交给主系统决定），更安全
- **fix(loader/think): 移除 as any** — loader 的 strategy/isolation/fields 和 executor 的 tool handler 上下文均改为正确类型
- **fix(docs): architecture.md 安全目录描述** — safety-agent-spec.ts 引用更新为 safety-guard 子系统目录

#### 已知限制

- YAML/Frontmatter 解析仍为手写正则，仅支持浅层 key:value 结构。复杂嵌套 YAML 需引入轻量解析库（待后续迭代）

## v0.11.0 (2026-09-05)

### refactor: 自主子系统架构重构

将"分布式智能体"体系重构为"自主子系统"框架。五维模型：Sense + Think + Act + Signal + Boundary。

#### 新增

- **feat(harness): autonomous-subsystem 模块** — 完整的自主子系统框架，包含 20 个源文件
  - types.ts — 五维模型完整类型定义（SignalAction 枚举、Sense/Think/Act/Signal/Boundary 配置、SubsystemSpec、SubsystemRun 审计结构）
  - sense/ — SenseEngine（condition 表达式编译、冷却期、深度限制）+ MetricsStore + InputBuilder
  - think/ — ThinkExecutor（code/llm/hybrid 三种执行模式，工具执行真正可用）+ ModelResolver（models.level 解析 + primary/fallback 降级链）
  - signal/ — SignalBus（context/steering/event/escalate 四通道投递，信号优先级排序）
  - session/ — SubsystemSessionManager（ephemeral/persistent × global/agent/session 三级隔离）
  - audit/ — AuditWriter（JSONL 持久化）+ AuditReader（过滤查询）
  - boundary/ — BoundaryValidator（act.mode 与 authority 交叉校验、condition/conditionRef 互斥）
  - loader.ts — 子系统目录加载器（三级搜索路径、config.yaml + SUBSYSTEM.md 解析、handler.ts 动态 import）
  - runtime.ts — SubsystemRuntime 核心运行时
- **feat: subsystems/safety-guard/** — 安全守卫子系统目录定义（SUBSYSTEM.md + config.yaml），从代码定义迁移为声明式配置
- **test: 12 个新测试文件** — 覆盖 MetricsStore、SenseEngine、ModelResolver、SignalBus、SessionManager、AuditWriter/Reader、BoundaryValidator、SubsystemLoader、SubsystemRuntime、安全守卫加载

#### 变更

- **refactor(builder): withDistributedAgent → withSubsystem** — Builder 使用 SubsystemRuntime 替代 AgentRuntime，支持 withSubsystem()、withSubsystemDir()、withSubsystemAuditDir()
- **refactor(runner): setDistributedRuntime → setSubsystemRuntime** — Runner 使用 SubsystemRuntime，自动注入 turn.count 指标
- **refactor(harness/index): 更新导出** — 添加 autonomous-subsystem 模块导出

#### 移除

- **删除 distributed-agents/distributed/** — 旧的 10 个分布式智能体源文件（AgentRuntime、DistributedAgentSpec、TriggerEngine、InputPolicy、OutputPolicy 等）
- **删除 safety-agent-spec.ts** — 旧的安全守卫代码定义
- **删除 14 个旧测试文件** — tests/distributed/（6 个）、tests/harness/distributed/（6 个）、安全集成测试（2 个）
- **保留 distributed-agents/multi-agent/** — Worker/编排模块不属于本次重构范畴

## v0.10.5 (2026-09-04)

### refactor: Sense 引擎实现

实现自主子系统的感知引擎，替代旧的 TriggerEngine。支持 condition 表达式评估、冷却期机制、三层循环防护。

#### 新增

- **feat(harness): MetricsStore** — 指标存储，供 condition 表达式引用。支持 update / increment / snapshot / reset
- **feat(harness): SenseEngine** — 感知引擎，替代旧 TriggerEngine。支持事件驱动触发、condition 声明式表达式编译与评估（如 `turn.count % 10 === 0`）、冷却期机制（EventBus 触发不可穿透，API 触发可穿透）、三层循环防护（静态分析 + 深度限制 + 冷却期）
- **test: MetricsStore 单元测试** — 8 个测试
- **test: SenseEngine 单元测试** — 14 个测试覆盖事件触发、condition 评估、冷却期、深度限制、多子系统

## v0.10.4 (2026-09-04)

### refactor: 自主子系统类型与接口层

新增 `autonomous-subsystem` 模块的类型定义和校验层，为从"分布式智能体"到"自主子系统"的架构重构奠定基础。

#### 新增

- **feat(harness): SubsystemSpec 五维模型类型定义** — Sense / Think / Act / Signal / Boundary 的完整 TypeScript 类型，包含 SignalAction 严格枚举、SenseConfig、ThinkConfig、ActConfig、SignalConfig、BoundaryConfig、ToolConfig、SessionConfig、LifecycleConfig、SubsystemInput/Output、SubsystemRun 审计结构、ModelLevelMap
- **feat(harness): BoundaryValidator 规格校验器** — 校验 act.mode 与 boundary.authority 一致性、condition/conditionRef 互斥、think.implementation 与必填字段关系、tools 配置完整性
- **test: BoundaryValidator 单元测试** — 15 个测试覆盖所有校验规则

## v0.10.3 (2026-09-04)

### fix: Web UI 时间显示补充日期

会话列表和对话消息的时间戳从仅显示时刻（`HH:MM:SS`）改为同时显示日期与时刻，当天消息只显示时刻，跨天消息显示 `MM/DD HH:MM`，跨年消息显示完整日期。

#### 修复

- **fix(web): formatTimestamp 替换 formatTime** — 会话列表、助手消息、系统通知的时间戳统一使用新的 `formatTimestamp`，根据是否当天、是否同年智能省略日期部分

## v0.10.2 (2026-09-03)

### fix: serve 命令工具 cwd 不应依赖进程工作目录

修复 `octopi serve start/restart` 时内置工具（shell、file_read、file_write、file_list）的 cwd 回退到 `process.cwd()`（即执行 CLI 命令的目录），而非 agent 配置中声明的 workspace。

#### 修复

- **fix(builder): convertToAgentTool 注入 agent workspace 作为 cwd** — AgentBuilder 新增 `workspace(dir)` 方法，工具转换时将 workspace 透传到 ToolExecutionContext.cwd，消除对 process.cwd() 的隐式依赖
- **fix(gateway): buildAgent 调用 builder.workspace(agent.workspace)** — Gateway 构建 Agent 时显式注入配置中的 workspace 路径
- **fix(config-bridge): buildAgent 调用 builder.workspace(agentConfig.workspace)** — ConfigBridge 路径同步修复，确保 config 驱动的初始化也注入 workspace

#### 影响范围

- 内置工具（shell / file_read / file_write / file_list）：相对路径解析从 agent workspace 而非 CLI 执行目录
- ProcessSandbox：cwd 回退路径不变（sandbox 本身不修改）
- 分布式智能体安全守卫：cwd 已独立设置，不受影响

## v0.10.1 (2026-09-03)

### fix: 多处数据正确性与一致性修复

代码审查后的修复批次，涵盖数据隔离、异步 I/O、SQL 安全、熔断器覆盖、类型安全等方面。

#### 修复

- **fix(storage): InMemorySessionStore agentId 隔离** — 使用 `${agentId}:${sessionId}` 复合 key，修复多 agent 场景下 session 数据串扰（memory.ts + gateway.ts）
- **fix(init): 默认配置 dataDir 路径修正** — 从 `data/sessions` 改为 `agents`，与实际 `~/.octopi/agents/{id}/sessions/` 目录结构一致
- **fix(storage): JsonlSessionStore 同步 I/O 改异步** — 全部替换为 `node:fs/promises`，save() 中 JSONL 写入从循环 appendFile 优化为单次 writeFile
- **fix(storage): SqliteSessionStore.updateLifecycle / markEnded 补充 agentId 过滤** — WHERE 子句加 `AND agent_id = ?`，方法签名对齐 SessionStore 接口；archive-manager.ts 调用方同步修复
- **fix(gateway): FallbackProvider 回退 provider 也用 circuit breaker 包装** — 构建 wrappedProviders map 传入 FallbackProvider，确保熔断器行为一致
- **fix(config): 向后兼容迁移去掉 as any** — 改用显式类型断言
- **fix(config): resolveFallbackModels 加 MAX_FALLBACK_DEPTH=5 深度限制** — 防止嵌套 fallback 无限递归

#### 改进

- **feat(gateway): 导出 clearPersonaCache()** — Gateway.stop() 时自动清空 persona 缓存
- **fix(schema): session.store 补充 required: ["type"] 约束**
- **docs: config.ts / init.ts 文件头注释与代码同步**

#### 测试

- 新增 `tests/config-resolve.test.ts` — 22 个测试用例，覆盖 flattenModels、resolveModelConfig 三种解析路径、fallback 深度限制、createStoreFromConfig 四种存储类型、向后兼容迁移、InMemorySessionStore agentId 隔离
- 更新 `tests/information-layer.test.ts` — updateLifecycle / markEnded 调用同步 agentId 参数
- 更新 `tests/init.test.ts` — dataDir 断言匹配新路径

## v0.10.0 (2026-09-03)

### refactor(config): 模型配置集中化 + SessionStore 接口统一 + 模型回退

架构级重构：模型配置从分散式 `providers[]` 迁移到集中式 `models.providers`，`SessionStore` 接口统一为 `agentId + sessionId` 双键定位，新增 `FallbackProvider` 支持跨 provider 模型回退。

#### Breaking: SessionStore 接口变更

所有方法新增 `agentId` 参数，消除全量扫描：

| 方法 | 旧签名 | 新签名 |
|------|--------|--------|
| `load` | `load(sessionId)` | `load(agentId, sessionId)` |
| `save` | `save(sessionId, data)` | `save(agentId, sessionId, data)` |
| `delete` | `delete(sessionId)` | `delete(agentId, sessionId)` |
| `exists` | `exists(sessionId)` | `exists(agentId, sessionId)` |

所有存储实现（JsonlSessionStore、InMemorySessionStore、SqliteSessionStore、Gateway 内置）已同步更新。

#### Breaking: 模型配置迁移到 models.providers

旧格式 `providers[]` 已移除，迁移到 `models.providers`：

```json
{
  "models": {
    "providers": {
      "openai": {
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "${OPENAI_API_KEY}",
        "api": "openai-completions",
        "models": [{ "id": "gpt-5.5", "contextWindow": 256000, "maxTokens": 32768 }]
      }
    }
  }
}
```

Agent 引用模型的方式：`"model": "openai/gpt-5.5"`（string 格式），或内联对象（向后兼容）。

#### Breaking: AgentDefinition 接口变更

- 新增 `home` 字段（agent 持久状态根目录：persona、memory、skills、sessions）
  > 注：这是 v0.10.0 当时的表述。随后 memory/wisdom 并入 `AgentDatabase`（SQLite `agent.db`），不再按 home 下目录落盘；现行约定见 `agent-definition.ts` 注释与 v0.24.5。
- `workspace` 改为可选（沙箱工作目录，默认为 home 下的 workspace 子目录）
- `fallbackModels` 从 `string[]` 改为 `ModelConfig[]`（支持内联回退配置）

#### 新增: FallbackProvider

跨 provider 模型回退：主 provider 失败时自动切换到备选。支持 chat 和 stream 两种模式。流式场景下首个 chunk 产出后的中途错误直接向上传播（不静默回退）。

#### 新增: turn.end 事件 usage 透传

`agentLoop` 的 `turn.end` 事件现在携带 LLM 返回的 `usage` 数据，runner 层在事件中附加 `contextTokens` 和 `contextWindow`，TUI 和 WebUI 可直接显示上下文大小。

#### 新增: WebUI 上下文指示器

ChatWorkspace 头部显示 `上下文: 12.3k / 256.0k`，优先使用 LLM 返回的真实 usage，回退到客户端启发式估算。

#### 已移除

- `FileWisdomStore` / `FileProjectMemory` 实现删除
- `ProjectMemory` 接口从 `cognition-types.ts` 移除
- 旧 `ProviderConfig` 类型和 `providers[]` 配置格式

#### 测试

- 新增 `tests/fallback-provider.test.ts` — 7 个测试覆盖 chat/stream 主链路成功、回退、全失败、流式中途错误传播
- 所有已有测试同步更新

## v0.9.0 (2026-08-31)

### feat(web): Conversation View Model — 会话显示模型全面升级

将 WebUI 的会话显示从"事件驱动的临时文本"升级为"可回放、可切换、可解释的对话模型"。

#### 三层消息模型

| 层 | 文件 | 职责 |
|---|---|---|
| ConversationItem 类型 | `web/conversation/types.ts` | user/assistant/tool/system 四种角色 + ViewMode + SessionViewState |
| ConversationAdapter | `web/conversation/adapter.ts` | runtime events → items, session messages → items |
| ConversationViewStore | `web/conversation/view-store.ts` | UI 消费的状态容器，管理 view mode 切换 |

#### RuntimeStore 集成

- `openSession()` 构建 history view，`createSession()` 直接进入 runtime
- `applyEvent()` 自动切 viewMode（history → hybrid）
- `sendMessage()` 根据当前 viewMode 决定目标模式
- session conversation 本地缓存，切走再切回不丢失
- 新增 `'conversation'` 和 `'viewMode'` 事件

#### agent-loop 修复

- yield `tool_start` / `tool_end` 事件（之前缺失，导致 WS 客户端收不到工具事件）
- 截断场景也补上 tool 事件

#### runner 事件增强

- `tool.exec.start` 携带 `args`
- `tool.exec.end` 携带 `result`（工具执行的实际输出内容）

#### Gateway 修复

- `buildSessionKey` 优先使用客户端传来的 sessionId，消除 `default:main` 幽灵 session
- WS chat 消息 metadata 透传 sessionId

#### WebUI ChatWorkspace

- 中栏按 role 渲染 ConversationItem（user 气泡、assistant 面板、tool 可展开卡片、system 横幅）
- 右栏 Tools / Inspector 面板从 conversation items 派生，不再依赖独立 state
- 对话区域独立滚动，输入框固定底部
- 每条对话记录和 session 列表显示时间戳
- 历史消息 tool 元数据从 `msg.toolResults` / `msg.toolCalls` 直接提取

#### 测试

- `conversation-adapter.test.ts`：34 个测试覆盖 buildHistoryItems、runtime 事件、tool 生命周期、system notices、完整对话流
- `web-runtime.test.ts`：18 个测试覆盖 viewMode 切换、hybrid 模式路径、conversation cache

---

## v0.8.0 (2026-08-29)

### refactor(arch): 4 层架构重构 + 11 领域重组 + 3 个新领域

全面重构 Octopi 架构，从 3 层升级为 4 层，Harness 层按领域自包含组织，新增 3 个核心领域。

#### 4 层架构

| 层 | 目录 | 职责 |
|---|---|---|
| Layer 0: Loop | `src/loop/` | 纯执行循环，零外部依赖 |
| Layer 1: Core | `src/core/` | 机制原语 + 接口契约 + 核心类型 |
| Layer 2: Harness | `src/harness/` | 11 个自包含领域 |
| Layer 3: Integration | `src/integration/` | 外部系统适配 |

#### Harness 11 个领域

| 领域 | 目录 | 状态 |
|---|---|---|
| Agent Building | `agent-building/` | 重组 |
| Context Management | `context/` | 已有 |
| Security | `security/` | 已有 |
| Reliability | `reliability/` | 已有 |
| Plugin Ecosystem | `plugin-ecosystem/` | 重组 |
| Distributed Agents | `distributed-agents/` | 重组 |
| Task System | `task-system/` | 重组 |
| Concurrency | `concurrency/` | 已有 |
| Execution Environment | `execution-environment/` | **新增** |
| Human-in-the-Loop | `human-in-the-loop/` | **新增** |
| Memory | `memory/` | **新增** |

#### 3 个新领域

- **Execution Environment**：进程级沙箱、工作区管理、文件操作（search/glob/diff）、git 集成
- **Human-in-the-Loop**：审批管理器、审批策略（auto/confirm-all/confirm-high-risk）、决策缓存
- **Memory**：记忆存储/检索、认知图谱（概念+关系网络）、智慧生成、项目记忆、七层智能组装（ContextIntelligence）

#### Context Intelligence — 七层智能模型

信息分馏系统：Information → Memory → Cognition → Wisdom，加上 Persona、Knowledge、Skill。

组装顺序：Wisdom（最前）→ Persona → Skill → Knowledge → Cognition → Memory → Information

#### Core 层重组

- 提取 `primitives/`（EventBus、StateMachine、AsyncTask、ProcessModel）
- 纯化 `types/`（移除对 Harness/Integration 的反向 re-export）
- 迁出策略实现（Budget、TokenEstimator、ToolLoopDetection）到 Harness
- 新增接口：`reliability.ts`、`task-decision.ts`、`execution-environment.ts`、`human-in-the-loop.ts`、`memory.ts`

#### 依赖方向

Core 零外层依赖（check-sync.sh 全部通过）。所有 re-export barrel 已清理。

#### 技术细节

- 提取 Loop 层：`src/core/loop/` → `src/loop/`
- SecurityGuard 实现：Core 只保留接口 + 纯函数，实现在 `harness/security/`
- EventBus：确认为活跃架构组件（33 个文件使用），移除错误的 @deprecated 标记
- QueueMode/ThinkingLevel：规范定义迁移到 `core/types/`
- 测试：64 文件 1022 测试全部通过

## v0.7.1 (2026-08-29)

### refactor(core): Core 层架构整理 — 分层边界收敛 + 事件桥接

基于系统性评估，对 Core 层进行 5 阶段结构调整，修正分层边界、消除类型混乱、建立事件桥接。
所有变更保持向后兼容（re-export），公共 API 零破坏。

#### Phase 1: types.ts 拆分

576 行的类型大杂烩拆为 12 个按职责命名的子模块，`types.ts` 变为 36 行 barrel re-export。

- `types/messages.ts` — 消息系统（Message, ContentBlock, ToolCall, ToolResult）
- `types/agent-definition.ts` — Agent 定义（AgentPersona, ModelConfig, AgentDefinition）
- `types/session.ts` — Session（SessionStatus, SessionMeta）
- `types/turn.ts` — Turn（TokenUsage, Turn）
- `types/tools.ts` — 工具系统（ToolDefinition, RegisteredTool, ToolHandler）
- `types/skills.ts` — Skill 系统（SkillDefinition, SkillManager）
- `types/channels.ts` — Channel Adapter（re-export 自 integration 层）
- `types/hooks.ts` — Plugin Hooks（re-export 自 harness 层）
- `types/events.ts` — Agent Event（re-export 自 harness 层）
- `types/gateway-config.ts` — Gateway 配置（re-export 自 integration 层）
- `types/queue-mode.ts` — QueueMode（re-export 自 harness 层）
- `types/thinking-level.ts` — ThinkingLevel（re-export 自 harness 层）

#### Phase 2: 非 Core 类型外迁

将不属于 Core 层的类型迁移到正确层，Core 的 types/ 子文件变为 re-export：

| 类型 | 原位置 | 新位置 |
|------|--------|--------|
| QueueMode | core/types | harness/types/queue-mode.ts |
| ThinkingLevel | core/types | harness/types/thinking-level.ts |
| HookContext | core/types | harness/types/hook-context.ts |
| ChannelAdapter/Message/Reply | core/types | integration/types/channels.ts |
| GatewayConfig | core/types | integration/types/gateway-config.ts |

#### Phase 3: 类型去重

`ErrorReason` / `ClassifiedError` 的规范定义从 `core/loop/types.ts` 移到 `core/interfaces/error-strategy.ts`，
消除了"接口文件依赖实现文件"的倒置关系。`loop/types.ts` 变为 re-export。

#### Phase 4: SecurityGuard 实现下沉

`DefaultSecurityGuard` 类（~440 行策略实现）从 `core/security-guard.ts` 迁移到 `harness/security/default-security-guard.ts`。
Core 的 `security-guard.ts` 从 630 行精简到 58 行，只保留接口 re-export + `severityToAction` + `isValidSecurityGuard`。

**修复的安全 BUG：** `isValidSecurityGuard()` 异常时返回 `true`（应为 `false`）。
原逻辑在 SecurityGuard 实现抛异常时会错误地认为 guard 有效，可能导致安全守卫被绕过。

#### Phase 5: 事件桥接

`SessionAwareRunner.handle()` 新增 EventBus 广播：循环事件适配后同时 emit 到 EventBus（跳过高频 `llm_stream_delta`）。
EventBus 订阅者（AuditTrail、TriggerEngine、EventCollector）现在可以看到循环事件。

删除 `core/loop/event-adapter.ts`（134 行），桥接逻辑统一内置到 runner.ts。

`core/index.ts` 重写，标注 EventBus / IterationBudget 的废弃方向和迁移计划。

**文件变更：**
- 新增 `src/core/types/` — 12 个子模块
- 新增 `src/harness/types/` — 4 个文件（queue-mode, thinking-level, hook-context, index）
- 新增 `src/integration/types/` — 3 个文件（channels, gateway-config, index）
- 新增 `src/harness/security/default-security-guard.ts` — 从 core 迁入
- 修改 `src/core/types.ts` — 576 行 → 36 行 barrel
- 修改 `src/core/security-guard.ts` — 630 行 → 58 行
- 修改 `src/core/index.ts` — 重写，标注废弃方向
- 修改 `src/core/interfaces/error-strategy.ts` — ErrorReason/ClassifiedError 规范定义
- 修改 `src/core/loop/types.ts` — ErrorReason/ClassifiedError 变为 re-export
- 修改 `src/core/event-bus.ts` — 更新两套事件系统共存说明
- 修改 `src/harness/runner.ts` — 新增 EventBus 事件桥
- 删除 `src/core/loop/event-adapter.ts` — 桥接逻辑内置到 runner.ts
- 修改 `src/harness/builder.ts` — DefaultSecurityGuard import 路径更新
- 修改 `src/harness/security/index.ts` — 从新位置导出
- 修改 `src/integration/gateway/gateway.ts` — DefaultSecurityGuard import 路径更新
- 修改 `src/index.ts` — DefaultSecurityGuard import 路径更新
- 修改测试文件 4 个 — import 路径更新

**测试：** 64 文件 1022 测试全通过

## v0.7.0 (2026-08-24)

### refactor(core): Phase 6 — 删除旧引擎，彻底迁移到新架构

**Breaking:** 删除 `src/core/engine.ts`（1759行）和 `AgentEngine` 类。
所有上层模块已迁移到 `Agent` + `runAgentWithReliability()` 新架构。

**迁移的源码模块（12个）：**
- `runner.ts` — AgentEngine → Agent + runAgentWithReliability
- `builder.ts` — 删除 buildEngine()，buildAgent() 为唯一构建路径
- `gateway.ts` — AgentBuilder.buildAgent() 构建
- `distributed/runtime.ts` — createAgentInstance()
- `multi-agent/process.ts`, `swarm.ts` — Agent 引用
- `supervisor.ts` — Agent 引用
- `config-bridge.ts` — BuiltAgent.agent
- `scenario-runner.ts` — Agent 引用

**修复的真实BUG（测试发现）：**
1. 空响应重试失效：onTurnComplete 注入 steer 后 agentLoop 直接退出
2. noop 无限循环：noop 检测注入 hint 后没有停止循环

**重写的测试文件（4个）：**
- planning-retry, engine-advanced, engine-empty-after-tools, core-engine

**统计：** -2568 行，39 文件变更，1035 测试全通过

## v0.6.9 (2026-08-16)

### feat(config): 支持 agent 级别 contextWindow 配置

配置文件现在支持在 agent 的 `model` 中直接配置 `contextWindow`，覆盖 provider 的 getModelInfo 默认值。

**优先级链：** agent 配置 > provider getModelInfo > 内置默认值 > 128000

**配置示例：**
```json
{
  "agents": [{
    "id": "assistant",
    "model": {
      "provider": "openai",
      "model": "gpt-4o",
      "contextWindow": 256000
    }
  }]
}
```

**文件变更：**
- 更新 `src/core/types.ts` — ModelConfig 新增 contextWindow 字段
- 更新 `src/config-schema.ts` — ModelConfigSchema 新增 contextWindow 校验
- 更新 `src/core/engine.ts` — RunConfig 新增 contextWindow + 优先级链
- 更新 `src/integration/gateway/gateway.ts` — 传递 agent.contextWindow 到 RunConfig

**测试：** 1052 passed，全量通过


### feat(tui): Footer 显示当前会话上下文大小 / 上下文窗口上限

TUI footer 区域新增 `ctx 12.3k / 128.0k` 显示，格式为 `ctx {当前估算} / {窗口上限}`。

**实现：**
- `turn.end` 事件扩展：新增 `estimatedTokens` 和 `contextWindow` 字段
- TUI 捕获 `turn.end` 中的 context 信息，更新 footer
- `formatTokens()` 辅助函数：`k`/`m` 紧凑格式

**文件变更：**
- 更新 `src/core/engine.ts` — turn.end 事件携带 context 信息
- 更新 `src/integration/tui/app.ts` — footer 显示 ctx 状态

**测试：** 1052 passed，全量通过


### feat(token): 真实 Usage 集成 — LLM 返回值校准 token 估算

参考 OpenClaw 的 `estimateContextTokens()` 策略，用 LLM 返回的真实 usage 校准启发式估算：

**改进点：**
- `afterTurn()` 存储真实 promptTokens + 消息快照 + 校准比率
- 校准比率 = actual / estimated，70/30 平滑处理防止异常值
- `assemble()` 优先用校准后的估算值（`calibrateTokens()`）
- 校准比率限制在 [0.5, 2.0] 范围内，防止极端值
- 新增 2 个测试用例：校准效果验证 + 比率钳制验证

**文件变更：**
- 更新 `src/harness/context/default-context-engine.ts` — CompactState 扩展 + afterTurn 校准 + calibrateTokens()
- 更新 `tests/context-engine.test.ts` — 新增 2 个校准测试

**测试：** 1052 passed，全量通过


### feat(token): Token 估算器优化 — 参考 OpenClaw 分层比率策略

研究了 OpenClaw 的 token 计算和上下文管理机制，对齐核心估算逻辑：

**改进点：**
- **完整 CJK 范围检测**：从只检测 U+4E00-U+9FFF 扩展到完整 CJK + 扩展A/B + 平假名 + 片假名 + 韩文 + 全角符号
- **按内容类型区分比率**：通用文本 chars/4、工具结果 chars/2、JSON chars/3（之前全局统一）
- **消息结构开销**：从 4 token 提升到 12 token（参考 OpenClaw 的 MESSAGE_BOUNDARY_OVERHEAD_TOKENS）
- **图片估算**：从 85 token 提升到 1200 token（参考 OpenClaw 的 4800 chars）
- **安全余量**：SmartRouter 估算值乘以 1.2x SAFETY_MARGIN（参考 OpenClaw）
- **统一常量文件**：新增 `src/core/token-constants.ts`，避免 Core 和 Harness 层重复定义

**文件变更：**
- 新增 `src/core/token-constants.ts` — 共享常量
- 重写 `src/core/token-estimator.ts` — CJK 感知 + 分层比率
- 重写 `src/harness/context/token-estimator.ts` — 同步核心估算器 + tool result 特殊处理
- 更新 `src/harness/context/smart-router.ts` — SAFETY_MARGIN + 正确比率
- 更新测试期望值（3 处，因估算值变化）

**测试：** 1050 passed，全量通过



## v0.6.5 (2026-08-16)

### fix(security): macOS APFS firmlink 路径不再被误判为 protected

macOS APFS 上 /Users 是 firmlink，真实路径为 /System/Volumes/Data/Users。PROTECTED_PATHS 包含 /System/，
导致用户目录下的文件访问被误拦截。
在 classifyPath 中新增 macOS Data volume 用户目录豁免，在 PROTECTED_PATHS 检查前排除。
新增 3 个回归测试用例。

## v0.6.4 (2026-08-16)

### fix(tui): 会话结束后 "streaming..." 状态残留

终态事件未重置 streamedContent，导致状态栏持续显示 "streaming..."。
所有终态事件（turn.end/engine.end/aborted 等）统一重置 streamedContent + isProcessing + status。
engine.end 改为无条件清除（不再受 isProcessing 条件限制）。

## v0.6.3 (2026-08-16)

### fix(security): /dev/null 伪设备不再被误判为 protected

`PROTECTED_PATHS` 包含 `/dev/`，导致 `/dev/null`、`/dev/zero` 等安全伪设备被误判为 critical 并 block。
新增 `SAFE_PSEUDO_DEVICES` 白名单，在检查 PROTECTED_PATHS 前先排除安全伪设备。
新增 4 个回归测试用例。

### fix(tui): 会话结束后清除 planning-only/empty-response retry 持久消息

`planning_only_retry` 和 `empty_response_retry` 事件通过 `addSystem()` 写入聊天记录后，
turn 结束时未被清除，一直残留在 TUI 界面上。

修复：SystemMessageComponent 新增 `transient` 属性，ChatLog 新增 `clearTransientSystem()` 方法，
所有终态事件调用清除。

## v0.6.1 (2026-08-16)

### fix(security): /dev/null 伪设备白名单（同 v0.6.3 内容，首次修复）

## v0.6.0 (2026-08-16)

### 并发控制模块 — 多 Key 负载均衡与资源保护

### 并发控制模块 — 多 Key 负载均衡与资源保护

新增 `concurrency` 模块，解决多用户并发场景下的 API 限流、资源耗尽和工具死循环问题。

**核心组件：**

- **ProviderPool** — 多 Key LLM Provider 负载均衡
  - 同一模型多个 API key 分散 rate limit 压力
  - 粘滞路由：同一 session 路由到同一 key，命中 prompt cache（节省 20-40% token）
  - 三种路由策略：sticky / round-robin / least-loaded
  - per-key 独立限流（RateLimiter）
  - 自动故障转移：连续 5 次错误 → 标记不健康 → 跳过；成功 → 自动恢复
  - 实现 ModelProvider 接口，对 Engine 完全透明

- **SessionGate** — 信号量并发控制
  - 限制同时运行的 Agent Loop 数量，防止服务器 OOM
  - FIFO 公平队列 + 超时保护
  - 集成到 Runner.handle() 入口

- **RateLimiter** — 令牌桶限流
  - 平滑限流，允许突发流量
  - 支持多 provider 独立限流
  - 集成到 ProviderPool 每个 slot

- **ToolValidator** — 工具结果验证
  - No-op 检测：连续空结果自动终止循环（可配置阈值）
  - 结果大小限制和截断（防止上下文膨胀）
  - 工具调用历史追踪
  - 替换 Engine 内联 noop 检测（向后兼容）

**配置驱动（octopi.json）：**
```json
{
  "concurrency": {
    "providerPool": {
      "slots": [
        { "provider": "openai-1", "weight": 2 },
        { "provider": "openai-2" }
      ],
      "routing": { "strategy": "sticky" },
      "rateLimit": { "requestsPerMinute": 60 }
    },
    "sessionGate": { "maxConcurrent": 50 }
  }
}
```

**测试：** 75 个新测试（总计 1048），零破坏性变更。

## v0.5.0 (2026-07-17)

### MCP Client — 连接外部工具生态

新增 MCP (Model Context Protocol) Client 集成，让 Octopi Agent 能调用外部 MCP Server 提供的工具。

**核心功能：**
- 连接 MCP Server（stdio/HTTP 传输）
- 自动发现并注册 MCP 工具到 ToolRegistry
- 工具名命名空间管理（`{serverId}__{toolName}`）
- 断开时自动注销工具
- 运行时动态管理（`connectServer` / `disconnectServer`）
- 目录自动发现（`loadMcpServersFromDir`）

**架构设计（遵循三层模型）：**
- Core 层：`McpClient` / `McpManager` 接口定义
- Harness 层：`DefaultMcpManager` + MCP↔Octopi 格式桥接 + 目录发现
- Integration 层：`SdkMcpClient`（包装 `@modelcontextprotocol/sdk`）

**SDK API：**
```ts
// 构建时声明
const { engine, runner, mcpManager } = await new AgentBuilder()
  .model('gpt-5.5')
  .mcp({ id: 'filesystem', transport: 'stdio', command: 'npx', args: [...] })
  .build();

// 运行时动态管理
await mcpManager.connectServer({ id: 'db', transport: 'stdio', command: '...' });
await mcpManager.disconnectServer('db');

// 目录自动发现
const configs = await loadMcpServersFromDir();
for (const c of configs) await mcpManager.connectServer(c);
```

**健壮性：**
- MCP 调用 30s 默认超时
- callTool 兼容性结果处理
- McpServerConfig 判别联合类型（编译时校验）
- 工具错误内容透传

**依赖：** `@modelcontextprotocol/sdk ^1.29.0`
**测试：** 41 个 MCP 测试（bridge 16 + manager 17 + discovery 8）

---

## v0.4.0 (2026-06-27)

### 项目定位调整

- 定位从“可嵌入的 Agent 运行时框架”调整为“可嵌入的 Agent 引擎”
- 引擎 = 核心运行时 + 干净接口，强调可嵌入、可替换、最小核心

### Bug 修复：TUI 第二轮对话无响应 + Empty Response

- **引擎层：** `finally` 块保证 `ENGINE_END` 在所有退出路径发射
- **TUI 层：** 新增 `engine.end` handler 重置 `isProcessing`
- **引擎层：** 中止安全退出（`emitAbortedMessage`）保持 session 语义完整性

### 改进：Agent 恢复/重试机制优化（参考 OpenClaw）

- **P0:** finishReason 校验 — 只有 `tool_calls` 时才执行工具
- **P1:** No-op 检测 — `ToolResult.noop` + `__noop` 约定，防止 tool-loop 死循环

### Bug 修复：TUI 第二轮对话无响应

**问题描述：**
- TUI 第一轮对话结束后一直显示 "streaming..."，导致第二轮对话无法正常开始

**根因分析：**
- 引擎在工具执行后直接 `continue` 进入下一轮迭代，没有 yield `turn.end` 事件
- TUI 依赖 `turn.end` 事件重置 `isProcessing` 状态
- 没有 `turn.end` → `isProcessing` 永远为 true → 用户无法发送第二条消息
- 另外，TUI 没有处理 `engine.end` 事件作为安全网

**修复内容：**
- **引擎层：** 用 `finally` 块保证 `ENGINE_END` 在所有退出路径上都被发射（之前只有部分路径发射）
- **TUI 层：** 新增 `engine.end` 事件处理，重置 `isProcessing` 状态（之前 TUI 不处理此事件）
- **引擎层：** 移除 `emitAbortedMessage` 和正常完成路径中的冗余 `ENGINE_END` 发射（由 `finally` 统一处理）

### 改进：Agent 恢复/重试机制优化（参考 OpenClaw）

**改进内容：**

- **P0: 中止安全退出** — `AgentEngine` 中止时（`AbortSignal`）自动写入一条 `aborted` assistant 消息到 messages 数组，保持 session 语义完整性。防止中止后 session 卡在 toolUse（无 toolResult）状态
- **P0: finishReason 校验** — 只有 `finishReason === 'tool_calls'` 时才执行工具调用，防止截断/中断的 tool call 被误执行。当 finishReason 不匹配时，yield `tool_calls.filtered` 事件并按纯文本处理
- **P1: No-op 检测** — 新增 `ToolResult.noop` 字段 + `__noop` 工具返回约定。连续 2 次 no-op 工具执行后自动终止循环，防止 tool-loop 死循环

**参考：** OpenClaw agent-core 的 `stopIfAborted()`、`removeNonExecutableToolCalls()`、no-op write/edit terminal failure 机制

## v0.3.1 (2026-06-27)

### Bug 修复：工具执行后卡死 + 超时机制 + Gateway 预算管理

**问题描述：**
- TUI 发送消息后，agent 调用工具成功但第二次模型调用永远卡住
- Gateway 运行超过 10 分钟后所有请求立即报 "Budget exceeded: timeout"
- Gateway 连接断开后 TUI 无法正常退出

**根因分析：**
1. **消息格式不匹配：** 引擎的 tool result 消息格式 `{ role: 'tool', toolResults: [...] }` 与 LLM API 期望的 `{ role: 'tool', tool_call_id, content }` 不一致，导致 API 请求卡住或报错
2. **流式调用无超时：** `stream()` 方法的 `fetch` 调用没有超时设置，API 卡住时永远等待
3. **Budget 不重置：** `IterationBudget` 在 Gateway 启动时创建一次，`startTime` 固定，运行超过 `maxWallClockMs` 后所有请求立即超时
4. **断连状态未清理：** Gateway 断连时 `isProcessing` 状态未重置，Ctrl+C 被拦截

**修复内容：**
- **Provider 层：** 新增 `flattenMessages()` 将引擎格式的 tool results 展开为 API 格式（OpenAI + Anthropic）
- **Provider 层：** `stream()` 方法添加连接超时 + 空闲超时（默认 60s，可通过 `timeoutMs` 配置）
- **Core 层：** `IterationBudget` 新增 `reset()` 方法
- **Core 层：** `AgentEngine.run()` 开头自动调用 `budget.reset?.()`，确保每次请求独立计时
- **Gateway 层：** `GatewayConfig` 新增 `budget` 字段，支持从配置文件读取预算参数
- **TUI 层：** Gateway 断连时重置 `isProcessing`，保留已流式内容，允许正常退出

**配置示例：**
```json
{
  "budget": {
    "maxIterations": 10,
    "maxToolCalls": 30,
    "maxWallClockMs": 1800000
  }
}
```

## v0.3.0 (2026-06-18)

### CLI serve 命令重构 — 后台守护进程模式

`octopi serve` 从阻塞命令改为后台守护进程，终端不再被占用。

**新增子命令：**
- `octopi serve start` — 后台启动 Gateway（fork 子进程，父进程立即退出）
- `octopi serve stop` — 优雅停止（SIGTERM → 10s 超时 → SIGKILL）
- `octopi serve restart` — 重启
- `octopi serve status` — 查看运行状态（PID、配置、启动时间）
- `octopi serve fg` — 前台模式（调试用）

**技术细节：**
- PID 文件：`~/.octopi/gateway.pid`（JSON 格式）
- 自动检测已有实例，防止重复启动
- 残留 PID 文件自动清理

### 可观测性集成 — Observer + TraceCollector + MetricsAggregator

统一两套观测系统，一行代码启用完整观测链路。

**架构：**
- `ObserverBridge` — 实现 Observer 接口，桥接到 TraceLogger + MetricsAggregator
- `TraceCollector` 增强 — 接受可选 MetricsAggregator，wrap() 时自动喂事件
- `Builder.trace()` — 一行启用完整观测链路
- CLI `--verbose` 退出时自动打印 MetricsSnapshot 摘要

### ContextEngine 智能路由

根据溢出量和工具结果可压缩空间选择最优路由。

**路由策略：**
- `fits` — 上下文在预算内，不处理
- `truncate_tool_results_only` — 只截断工具结果
- `compact_only` — 只压缩历史消息
- `compact_then_truncate` — 先压缩再截断

**其他：**
- 三层 Token 估算策略（LLM > tokenizer > 启发式）
- LLM 摘要默认开启，失败时回退到截断
- 边界对齐：不拆分 tool_call/tool_result 对

### Bug 修复

- Anthropic provider tool 消息格式错误 — tool 消息转为 user + tool_result content block
- 类型系统统一 — AgentEvent union 重命名为 AgentEventDetail，event-bus 接口为唯一标准
- ContextEngine MessageSelector 死代码修复 — 组件未被实际调用

### 测试

- 测试总数：453 → 642（+189）
- 测试文件：36 → 38

## v0.2.5 (2026-06-06)

### Harness 层 — StrategyRouter + ResourceManager（Phase 4）

新增策略路由和资源管理，让 Agent 更高效、更经济。

**新增 Strategy 模块：**
- `RuleTaskClassifier` — 规则驱动的任务分类器
  - 分类：question/lookup/analysis/creation/coding/planning/conversation
  - 复杂度：simple/moderate/complex
  - 中文分词优化
- `DefaultStrategyRouter` — 默认策略路由器
  - 6 种推理策略：direct/chain_of_thought/plan_and_execute/tool_use/reflect/multi_agent
  - 规则匹配：根据分类结果选择最合适策略

**新增 Resources 模块：**
- `ResourceManager` — 统一资源管理器
  - Token 预算：per-call/per-minute/per-hour/total 四维限制
  - 成本追踪：按模型统计，自动计算费用
  - 速率限制：请求频率 + 并发控制
  - 完整统计报告

### 测试

- 测试总数：430 → 453（+23）
- 新增 `tests/harness/strategy.test.ts` — 23 个测试

## v0.2.4 (2026-06-06)

### Harness 层 — KnowledgeStore + Reflector（Phase 3）

新增知识存储和反思器，让 Agent 能积累知识、从经验中学习。

**新增 Knowledge 模块：**
- `MemoryKnowledgeStore` — 内存知识存储（开发/测试用）
  - CRUD 操作、关键词检索、按类型/标签/置信度过滤
  - 访问计数追踪、统计信息
- `KnowledgeStage` — 上下文管道知识注入阶段
  - 从用户消息提取关键词，检索相关知识，注入 system prompt

**新增 Reflector 模块：**
- `LLMReflector` — LLM 驱动的反思器
  - 执行质量评估（assess）
  - 模式识别（detectPatterns）
  - 高置信度模式自动存入 KnowledgeStore

**类型定义：**
- `KnowledgeEntry` — 知识条目（fact/pattern/lesson/preference/skill）
- `KnowledgeStore` 接口 — 可替换的存储后端

### 测试

- 测试总数：410 → 430（+20）
- 新增 `tests/harness/knowledge.test.ts` — 20 个测试

## v0.2.3 (2026-06-06)

### Harness 层 — Planner + TaskScheduler（Phase 2）

新增规划器和任务调度器，让 Agent 能自主规划和调度任务。

**新增 Planner 模块：**
- `RulePlanner` — 规则驱动的规划器（快速、低成本、可预测）
  - 支持通配符匹配、自定义条件、优先级、once 规则
  - 内置规则：用户消息、安全事件、空闲事件
- `LLMPlanner` — LLM 驱动的规划器（灵活、处理复杂场景）
  - 事件分析 → 结构化计划（JSON）
  - 目标分解 → 可执行步骤
- `HybridPlanner` — 混合规划器（规则优先，LLM fallback）

**新增 Scheduler 模块：**
- `TaskScheduler` — 任务调度器
  - `scheduleOnce` — 延迟执行一次
  - `scheduleInterval` — 按间隔重复执行
  - `scheduleCron` — cron 表达式定时
  - `scheduleAt` — 指定时间执行
  - 支持：暂停/恢复/取消、事件发射

### 测试

- 测试总数：381 → 410（+29）
- 新增 `tests/harness/planner.test.ts` — 29 个测试

## v0.2.2 (2026-06-06)

### Harness 层 — AgentSupervisor（Phase 1）

新增 AgentSupervisor 模块，让 Agent 从“单次对话”进化为“持续运行的进程”。

**新增模块：**
- `AgentSupervisor` — 持续运行的 Agent 核心（认知循环：感知→思考→执行→反思）
- `EventCollector` — 事件收集器（聚合 EventBus + EventSource + 手动注入）
- `Planner` 接口 — 规划器接口（决定 Agent 做什么）
- `Reflector` 接口 — 反思器接口（评估执行质量、识别模式）
- `SupervisorConfig` / `AgentState` / `Plan` / `PlanStep` / `StepResult` 等类型

**设计原则：**
- 基于 Core ProcessModel 实现，有独立生命周期
- Planner 可替换（LLM 驱动、规则驱动、混合）
- Reflector 可选（没有反思器也能运行）
- 与 AgentEngine 共存（单次推理仍由 AgentEngine 完成）

### 测试

- 测试总数：367 → 381（+14）
- 新增 `tests/harness/supervisor.test.ts` — 14 个测试

## v0.2.1 (2026-06-06)

### Core 层架构升级 — 异步原语 + 进程模型

在 Core 层新增两个底层原语，为 Agent 的高级能力（异步任务、多进程协作、消息传递）打基础。

**新增核心原语：**
- `AsyncTask` — 异步任务原语（420 行）
  - 状态机：pending → running → completed | failed | cancelled
  - 支持：取消（AbortSignal）、超时、重试、事件发射、持久化
  - `spawnTask()` 便捷方法：发射后不管
- `ProcessModel` — Agent 进程模型（502 行）
  - 状态机：born → running → sleeping → waiting → dead
  - 支持：父子进程（spawn）、进程间通信（send/receive）、sleep、kill、事件
  - `spawnProcess()` 便捷方法

**新增接口：**
- `EventSource` — 外部事件源协议（webhook、file watcher、timer 等）
- `TaskStore` — 任务持久化协议（内存、文件、Redis 等）
- `MessageChannel` — 进程间通信协议（内存队列、WebSocket、消息队列等）

**设计原则：**
- 内核提供机制（mechanism），Harness 提供策略（policy）
- 内核只做“如果它不做，别人就没法做”的事
- Planner、Reflector、KnowledgeStore 等高级能力全部放 Harness 层

### 测试

- 测试总数：326 → 367（+41）
- 新增 `tests/core/async-task.test.ts` — 22 个测试
- 新增 `tests/core/process-model.test.ts` — 19 个测试

## v0.2.0 (2026-06-06)

### 架构重构 — 三层洋葱模型

完成从单体架构到三层分离的全面重构：

**Core 层（Layer 1）— 纯引擎 + 接口契约**
- `AgentEngine` — 无状态循环引擎，回调槽扩展机制
- `EventBus` — 内置事件总线（`DefaultEventBus` + `NoopEventBus`）
- `SecurityGuard` — 内置安全守卫（注入检测、敏感信息过滤，不可禁用）
- `IterationBudget` — 资源约束（迭代次数、工具调用、token、时间）
- 核心接口：`ModelProvider`、`ToolExecutor`、`ContextPipeline`、`ErrorStrategy`、`Observer`

**Harness 层（Layer 2）— 装具层**
- `AgentBuilder` — Fluent API 组装器，一行代码启动 Agent
- `SessionAwareRunner` — Session 生命周期管理（锁、持久化、并发控制）
- `PersonaLoader` — 文件式人格系统（AGENTS.md、SOUL.md 等）
  > 注：早期为根目录平铺加载。现行约定为根目录 `AGENTS.md` + `persona/*.md`（见 `persona.ts` 与 v0.24.5 init 迁移）。
- `DefaultContextPipeline` — 可插拔上下文管道（Persona → Skill → Task → History → Filter）
- `TaskStage` — Task 系统集成到 ContextPipeline
- `OutputQualityGate` — 输出质量检测迁移到 Harness 层
- `CapabilityEnforcer` + `SecurityPresets` — 安全策略预设

**Integration 层（Layer 3）— 集成层**
- `JsonlSessionStore` / `InMemorySessionStore` — 存储后端
- `NoopObserver` / `LogObserver` — 可观测性

### 新增

- `DefaultEventBus` — 全链路事件系统（`ENGINE_START`、`MODEL_CALL_END`、`INJECTION_DETECTED` 等）
- `DefaultSecurityGuard` — 注入检测 + 敏感信息过滤 + 不可信内容标记
- `IterationBudget` — 迭代次数/工具调用/token/时间四维约束
- `AgentBuilder` — Fluent API，支持 `.model()`、`.persona()`、`.store()`、`.plugin()`、`.budget()` 等
- `SessionAwareRunner` — Session 锁、持久化、Daily/Idle Reset
- `PersonaLoader` — 从目录加载 `.md` 文件，支持多 Persona 叠加
- `DefaultContextPipeline` — 管道模型，每个阶段独立可替换
- `TaskStage` — Task 系统作为 ContextPipeline 阶段注入
- `LegacyAgentRunner` — v0.1.x API 兼容层
- Plugin SDK 子路径导出：`octopi/plugin-sdk/plugin-entry`、`octopi/plugin-sdk/api` 等
- 安全预设：`SecurityPresets.development/testing/production/maximum`

### 变更

- `AgentRunner` 标记为 deprecated，推荐使用 `AgentBuilder` + `SessionAwareRunner`
- `SessionManager` 标记为 deprecated，推荐使用 `SessionAwareRunner`
- `LegacyContextEngine` 标记为 deprecated，推荐使用 `DefaultContextPipeline`
- `LLMRouter` 标记为 deprecated，推荐使用 `ModelProvider` 接口
- Task 系统从 Plugin hook 迁移到 ContextPipeline Stage
- Output Quality 从 Loop 层迁移到 Harness 层

### 测试

- 测试总数：313 → 325
- 新增 `core-engine.test.ts` — AgentEngine 核心循环测试
- 新增 `harness.test.ts` — AgentBuilder + SessionAwareRunner 测试
- 新增 `security.test.ts` — SecurityGuard + CapabilityEnforcer 测试
- 新增 `task-stage.test.ts` — TaskStage ContextPipeline 集成测试

### 文档

- 重写 `README.md` — 反映 v0.2.0 架构
- 更新 `docs/ARCHITECTURE.md` — 完整的三层架构设计文档
- 更新 `docs/REFACTORING-PLAN.md` — 重构方案 v2.0
- 更新 `docs/MIGRATION-AUDIT.md` — 代码迁移审计
- 更新 `docs/plugin-system.md` — Plugin 系统文档
- 更新 `docs/task-system.md` — Task 系统文档
- 更新 `docs/development-guide.md` — 开发指南

---

## v0.1.1 (2026-06-04)

### 重构

- **TaskTracker 异步化** — 所有 CRUD 方法改为 async，文件操作用 stat/readFile/appendFile 替代同步版本
- **applyDecision 去重** — 新建 `src/tasks/shared.ts` 提取共享函数
- **AgentLoop 命名区分** — 重命名为 AgentRunner，保留向后兼容别名
- **plugin.ts 迁移到迭代级 hook** — 从 OpenClaw per-message hook 改为 Octopi 迭代级 hook
- **advisor.ts 删除** — 移除 LoopAdvisor 模式，统一使用 Plugin hook

### 测试

- 新增 JSON 解析边界 case 测试
- 新增并发 session 隔离压力测试
- 测试总数：145 → 150

### 文档

- 新增 `src/tasks/README.md` — Task 系统架构文档
- 新增 `docs/agent-loop-architecture.md` — Agent Loop 对比分析
- 新增 `docs/architecture-refactor-analysis.md` — 架构重构分析
- 更新架构文档 v3，同步实际代码状态

## v0.1.0 (2026-06-02)

### 核心功能

- Agent Loop（消息 → 上下文组装 → 模型推理 → 工具执行 → 回复）
- Session 管理（生命周期、持久化、并发控制）
- 多 Provider 支持（OpenAI / Anthropic）
- Plugin 系统（对齐 OpenClaw 架构）
- Skill 系统（Tool 之上的结构化经验层）
- Task 系统（任务追踪与管理）
- 内置工具（shell、file_read、file_write、file_list）
