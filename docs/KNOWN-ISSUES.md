# 已知问题

> 最后更新：2026-10-01（清理已解决条目——本文件仅保留**开放项**与**现存边界**；已解决/已关闭问题见 `CHANGELOG` 与对应架构文档）

## Session / ACL 能力层

**运行时行为注记（v0.42.0+ / v0.43.0）：**

- Gateway **默认**注入 `SessionAclService` + **进程内共享** `SessionLease` 到全部 Runner（**非 opt-in 兼容性变化**）。
- `handle` 在 run 前 `authorizeRun`：primary 自动 owner；非 primary 无绑定 → `engine.error`；effective 交集含 `agents[].maxSessionRights`（E6 L1）。
- handoff：`primaryAgentId` 迁移；旧 primary 的 `owner` **降级 specialist**。
- `preferredOnly`（默认 true）：`switch(mode=handoff)` 需要 `intent=admin_handoff`。
- `filterHistory` / `appendRunAudit` / 业务 grant 仍供宿主调用；guest/handoff 经 sessionId 一等存储可读同一 Session。

**仍开放：** 分布式 Session Lease 实现；工具 capability 收紧；角色 DB/控制台；Quota 经济层。

## Knowledge 外源出站 — 已知限制

**状态：** OP-14 主线已落地；下列为有意保留的边界

- **DNS TOCTOU**：`network-guard` 在 `lookup` 后校验 IP，但 `fetch` 由 undici 再次解析；未 pin 连接到已校验 IP。极高威胁模型需 custom dispatcher（后续）。
- **`credential_bindings` 只记录不强制**：绑定用于审计/最小权限方向；`http_request.credential` 仍按名解析（未强制 consumer 白名单）。
- **`http_request` 自身无 SSRF 门禁**：live-query 工具语义宽松；Knowledge ingest 走 `guardedFetch`。
- **OAuth**：`oauth2_client` 仅当已换成 access token 时按 bearer。

## 会话附件（OP-15）— 已知限制

**状态：** 主链已落地（v0.54.x）；规格 `arch/knowledge-session-attachments.md`（as-built §0.1 / 遗留 §13）

- **大文件默认不全文注入**：超出 `inject.fullTextMaxChars` 只注开头（约 `headChars`），模型可能再 `file_read`——属分层策略，非缺陷。
- **文档抽取**：会话附件与 Knowledge ingest 共用 `harness/capabilities/document`（`documents.*`）；未启用抽取/无后端时仍只落盘不进召回。
- **默认不建 Knowledge source**：检索需显式「升为可检索」或 promote。
- **manifest 无跨请求锁**：并发上传同会话可能互相覆盖登记（单用户 Web 场景低发）。
- **上传 API 为 JSON+base64**：超大文件宜后续 multipart。
- **FileBlock 经 convertToLlm 变为文字指针**：非 provider 原生 file 附件格式。

## Knowledge 索引 / 向量 — 开放边界（2026-10 as-built）

**状态：** Phase A/B、watch、abort/resume（**跨重启**）、supersede reindex、BLOB 向量、FTS5、代码不嵌入、embed secret 策略、**Knowledge Service 拆分（唯一写者 + File identity）** 已落地（见 `docs/knowledge.md` §8.1 / `arch/knowledge-service-http.md`）。

**v0.59.1–v0.60.0 已修**（摘要）：鉴权闸门、路径归属、凭证跨域、SSRF/body 超时、`.html` 归属、parse 可取消超时、向量闸门看 KNN 结果、强制 hybrid、FTS5、中止落库、poll 不 supersede、embed 硬超时、ANN-lite 桶、ingest 模块拆分、prune/LIKE/FTS 清扫；**注册即 ingest、Document worker 路由、Document 能力迁 `harness/capabilities/document` + 单一工厂、停机 SSE 死锁、worker 错误序列化、walk 不 supersede**。

**仍开放：**

- **Office 超大表**：worker+可取消超时；仍可能 `parse_timeout` skip，不无限重试。
- **sqlite-vec 生产必选**：未加载时大库（>5 万向量）**禁止 JS 全扫**，走邻桶 + 强制关键词；百万级必须 `stats.sqliteVec=1`。HNSW 可选后端待立项。
- **DROP 后文件体积**：SQLite 不自动缩容，需 `VACUUM`。
- **watch 可能漏事件**：reconcile parse 缺口扫描（约 60s）兜底，非零延迟。
- **`running` 槽**：UI「任务」= job 数；embed 并行是 job 内 lanes。
- **catalog topics 抽样**：每源最多 128 条 path。
- **embed secret skip 墓碑**：`dimensions=0` 不自动重嵌；改策略后需 reprocess。
- **DNS TOCTOU / credential_bindings 不强制**：无 IP 钉扎；极高威胁模型需 custom dispatcher。
- **symlink**：`sourceOwnsPath` 未 `realpath`，root 内链出文件可能入索引（低优先级）。
- **`ingest.ts` 体量**：已拆 job-control/queue/embed-runner/fts/vector-ann；watch/poll/parse 仍在主文件。
