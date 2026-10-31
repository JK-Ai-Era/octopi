# 已知问题

> **语言说明**：英文版见 [KNOWN-ISSUES.md](./KNOWN-ISSUES.md)。本文为中文对译，变更须双语同步。
> 最后更新：2026-10-16（清理已解决条目——本文件仅保留**开放项**与**现存边界**；已解决/已关闭问题见 `CHANGELOG` 与对应架构文档）

## Session / ACL 能力层

**运行时行为注记（v0.42.0+ / v0.43.0）：**

- Gateway **默认**注入 `SessionAclService` + **进程内共享** `SessionLease` 到全部 Runner（**非 opt-in 兼容性变化**）。
- `handle` 在 run 前 `authorizeRun`：primary 自动 owner；非 primary 无绑定 → `engine.error`；effective 交集含 `agents[].maxSessionRights`（E6 L1）。
- handoff：`primaryAgentId` 迁移；旧 primary 的 `owner` **降级 specialist**。
- `preferredOnly`（默认 true）：`switch(mode=handoff)` 需要 `intent=admin_handoff`。
- `filterHistory` / `appendRunAudit` / 业务 grant 仍供宿主调用；guest/handoff 经 sessionId 一等存储可读同一 Session。

**仍开放：** 分布式 Session Lease 实现；角色 DB/控制台；Quota 经济层。

**Session ACL per-tool（SEC-2，v0.78.0）：** `SessionRights.toolRights`（`allow` / `deny` / `denyCapabilities`）与 `agents[].tools`、`toolSurface` **求交**（只收窄；deny 优先）。工具列表与 `beforeToolCall` 双闸强制。`agents[].maxSessionRights.toolRights` 为 L1 天花板，grant 拒绝非法拓宽。出厂角色工具面不限；guest/只读等用自定义角色表达。

**L4 process 牢笼（v0.75.0–0.76.0）：** 能力契约 + supervised spawn + bwrap/Seatbelt，且 **shell 已统一走 ProcessSandbox**（`docs/process-isolation.zh.md`）。仍开放：自带 Windows Job Object / 受限令牌 helper；container 后端。无 L4 时 `untrusted` 经 `untrustedAdmission` 拒绝或降级。声明 `boundary.security: sandboxed` 的子系统无 L4 时在加载期拒载（SEC-6 fail-closed，v0.90.9）——无牢笼后端的宿主（如今日 Windows）需显式声明 `trusted`/`privileged`；第一方内置子系统即如此声明。

**EffectPolicy 缺省（v0.75.0）：** 省略 `mode` 即 `workspace`（secure-by-default）。脚手架显式 `"mode": "host"`。原先依赖「未写 mode=host」的部署需补 `"effectPolicy": { "mode": "host" }`。

**HITL 单模型（SEC-7，v0.79.0）：** 唯一确认面是 `confirmHighRisk` 与 `confirmEffect`，均返回 `HitlDecision`（`deny` / `approve` / `approve_session` / `approve_always`）。session/always 由引擎 `HitlDecisionCache` 记账，宿主只表达决策。`approve_session` 按 `sessionId` 分桶；`approve_always` 按 `agentId` 分桶（信任级不同的 agent 不共享 always）。缺 scope id 降级 one-shot。已删除 `ApprovalManager` / `ApprovalProvider`。Gateway 确认走 `pendingApprovals`（Web `/approvals`）；`askUser` 只留给 `ask_user` 工具。无人值守 / 无钩子 / 超时仍 fail-closed。确认意图携带 `timeoutMs`（引擎确认窗）供宿主对齐审批卡生命周期；拒绝如实记录来源（超时 / 人工拒绝 / 通道故障 / 取消），只有真实拒绝才标注人工拒绝。工具**输出**侧 high/critical 仍直接拦、无确认语义。缓存 key 粒度：high_risk 按工具名；效应确认自 v0.94.2 起按「效应类型 **+ 目标**」（path / command / operation / domain）——一次 `approve_session` 只覆盖同一目标，不再整类放行（旧「有意粗粒度」已于 2026-10-26 翻案）。

审批归因可信度：配置 `channels.http.apiKey` 后 web 面凭钥准入，`confirmedBy` 记持钥方（credential-backed）；未配置时控制台对 LAN 敞开、署名为客户端自报（可仿冒）——**LAN 部署建议启用 `apiKey`**。完整多用户认证留产品化阶段。

**运维特权通道（ops P3/P4）：** `priv_exec`（allowlist 全等 / `full` 全量档 + `privilegedAck` + 常驻 `PRIVILEGED` 标记 + root/elevated 声明闸）与危险命令减速带。**Windows 边界**：win-job 助手服务（OP-ISO-1）落地之前，Windows 上**没有物理隔离兜底**——那里的 P3/P4 本质是「elevated 进程 + 常驻标记 + 各级闸门」，**不得对外表述为沙箱**。`runas /savecred` 与计划任务提权旁路属有意不做（无人值守提权绝不依赖存储的同意）。

## Knowledge 外源出站 — 已知限制

**状态：** OP-14 主线已落地；下列为有意保留的边界

- **connect 时再校验，非真·IP 钉扎**（SEC-3，v0.77）：`network-guard` 在 connect `lookup` 再校验地址（Knowledge + `http_request`）。真钉扎 / hostname allowlist 需注入自定义 `lookup`/`filterAddresses` 或嵌入方 dispatcher；极高威胁模型请自备钉扎。
- **`credential_bindings` 有绑定则强制**（SEC-3，v0.77）：绑定为空默认可解析（兼容）；绑定非空须命中 `consumer_kind`+`consumer_id`。`credentials.requireBindings: true`（或 `effectPolicy.mode=untrusted`）下无绑定即拒。
- **`http_request` 已有 SSRF 门**（SEC-3，v0.77）：默认拒私网/环回/链路本地/metadata；内网目标需 `security.network.allowPrivateNetwork`，且 **metadata/链路本地（含 IPv4-mapped、`fe80::/10`）始终拒绝**。shell `curl`/`wget` 仍无出站门，除非 L4 jail `network: deny`。
- **OAuth**：`oauth2_client` 仅当已换成 access token 时按 bearer。

## 会话附件（OP-15）— 已知限制

**状态：** 主链已落地（v0.54.x）；规格为内部文档（含 as-built 与遗留清单，不对外）

- **大文件默认不全文注入**：超出 `inject.fullTextMaxChars` 只注开头（约 `headChars`），模型可能再 `file_read`——属分层策略，非缺陷。
- **文档抽取**：会话附件与 Knowledge ingest 共用 `harness/capabilities/document`（`documents.*`）；未启用抽取/无后端时仍只落盘不进召回。
- **默认不建 Knowledge source**：检索需显式「升为可检索」或 promote。
- **manifest 无跨请求锁**：并发上传同会话可能互相覆盖登记（单用户 Web 场景低发）。
- **上传 API 为 JSON+base64**：超大文件宜后续 multipart。
- **FileBlock 经 convertToLlm 变为文字指针**：非 provider 原生 file 附件格式。

## Knowledge 索引 / 向量 — 开放边界（2026-10 as-built）

**状态：** Phase A/B、watch、abort/resume（**跨重启**）、supersede reindex、BLOB 向量、FTS5、代码不嵌入、embed secret 策略、**Knowledge Service 拆分（唯一写者 + File identity）** 已落地（见 `docs/knowledge.zh.md` §8.1）。

**v0.59.1–v0.60.0 已修**（摘要）：鉴权闸门、路径归属、凭证跨域、SSRF/body 超时、`.html` 归属、parse 可取消超时、向量闸门看 KNN 结果、强制 hybrid、FTS5、中止落库、poll 不 supersede、embed 硬超时、ANN-lite 桶、ingest 模块拆分、prune/LIKE/FTS 清扫；**注册即 ingest、Document worker 路由、Document 能力迁 `harness/capabilities/document` + 单一工厂、停机 SSE 死锁、worker 错误序列化、walk 不 supersede**。

**仍开放：**

- **Office 超大表**：worker+可取消超时；仍可能 `parse_timeout` skip，不无限重试。
- **sqlite-vec 生产必选**：未加载时大库（>5 万向量）**禁止 JS 全扫**，走邻桶 + 强制关键词；百万级必须 `stats.sqliteVec=1`。HNSW 可选后端待立项。
- **DROP 后文件体积**：SQLite 不自动缩容，需 `VACUUM`。
- **watch 可能漏事件**：reconcile parse 缺口扫描（约 60s）兜底，非零延迟。
- **`running` 槽**：UI「任务」= job 数；embed 并行是 job 内 lanes。
- **catalog topics 抽样**：每源最多 128 条 path。
- **embed secret skip 墓碑**：`dimensions=0` 不自动重嵌；改策略后需 reprocess。
- **仅 connect 时再校验**：无真·IP 钉扎；极高威胁模型需 custom dispatcher / lookup 注入。
- **`ingest.ts` 体量**：已拆 job-control/queue/embed-runner/fts/vector-ann；watch/poll/parse 仍在主文件。

## 配置键已声明但尚未接线（2026-10）

**状态**：schema 接受这些键，但目前**没有任何消费方**——配置了也不生效。记录在此以免被误当作已接线的行为。顶层映射守卫（`tests/config-gateway-top-level-mapping.test.ts`）将其分类为 `ignored`；实现时请改判为 `mapped`。

- **`compact`**（compact 能力缺省：`defaultProtectHead` / `defaultProtectTail` / `defaultTargetTokens` / `defaultMode`）：会话压缩实际读取 `contextEngine` 键（`protectFirstN` / `protectLastN` / `targetTokens`）；能力级缺省目前无消费方。
- **`session.reset` / `session.maintenance`**（每日/空闲重置与存储清理旋钮）：`session` 是 passthrough schema 块，但 engine 与 gateway 均不消费这些字段（v0.86.37 已将其从 `GatewayConfig` 类型中作为死面移除）。

以下不是缺陷——宿主层直接消费、刻意不经 `GatewayConfig` 的键：`channels`、`web`、`webSearch`、`summary`、`defaults`（由 `src/cli/daemon.ts` / `src/config.ts` 消费）。

### mapped 段内部的子键缺口（2026-10，review 跟进）

顶层映射守卫只查段级键；以下**子键** schema 接受但暂无消费方（配置了不生效）：

- **`plugins.configs`**（按插件配置）：已透传过边界，但 `PluginLoader` 尚不读取。
- **`models.mode`**（`merge` / `replace`）：无消费方；provider/模型合并行为目前固定。
- **`session` passthrough 附加键**（`reset` / `maintenance` 及任何拼写错误的键）：`SessionConfigSchema` 是 `.passthrough()`；实际只消费 `dmScope` / `idleExpiryMs`。
- **`wisdom.formation` / `wisdom.evaluation` / `wisdom.govern` / `wisdom.capacity.softCap` / `wisdom.injection.coreMaxTokens`** 与 **`cognition.capacity` / `cognition.retrieval` / `cognition.consolidation`**：steward 调参目前写在各子系统 `config.yaml` 的 `metadata.config`；`octopi.json` 侧只消费 `*.enabled`、`wisdom.capacity.hardCap`、`wisdom.injection.{coreMaxItems,scenarioMaxItems,trialVisible}`（v0.97.25 起）与 `cognition.identity.*` / `cognition.relations.*`。
- **`gateway`**（顶层：`port` / `host` / `debugRest`）：规划中的 Gateway 覆盖段（`arch/npm-package-split.md`）；daemon 目前读 `args.port` / `channels[]` / `web`，配置它无效果（映射守卫分类为 `ignored`）。


## 压缩摘要路径 — 已知边界（2026-10，F8 review 跟进）

- **`summaryPort` 不在 F8 交接契约内。** `CompactEngine` 的 `summaryPort` 分支仅共用四段式任务文本（`HANDOVER_SUMMARY_TASK`）；其预算语义（`policy.budget` 硬顶）、previous-摘要合并提示、fold/task 快照注入由 `SummaryExtractor` / `capabilities/summary/executor` 契约自行决定，与 `summarizeFn` 路径不完全一致。默认装配不传 `summaryPort`（manual / proactive / overflow 均走 `summarizeFn`）；启用该 Port 的部署需自行核对契约差异。
- **`context.compact.summarize_fallback` 暂无 WebUI 消费端。** 事件已进 run timeline（observer `TIMELINE_TYPES`），但 `web/runtime/store.ts` / `web/conversation/adapter.ts` 无对应 case，会话 inspector 不渲染 cache-miss 旁路。
- **自动压缩路径拿不到新鲜 taskSnapshot**（F8R-05，manual 路有）。自动摘要只能用注入到会话历史里的 task 快照副本（可能过期）；收口需把 `taskSnapshot` 顺着 `AssembleParams → applyProactiveCompact / overflow → compress` 透传，延后处理。
