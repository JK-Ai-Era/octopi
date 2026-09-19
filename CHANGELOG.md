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
