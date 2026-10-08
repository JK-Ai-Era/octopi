# Knowledge — 知识

> 产品域（Agent & Substrate 平面）｜问题：**世界上写着什么？**  
> 概念权威：[`docs/north-star.md`](../../../docs/north-star.md) ｜ 产品文档：[`docs/knowledge.md`](../../../docs/knowledge.md) ｜ Service 契约：`arch/knowledge-service-http.md`

## 拥有概念

Knowledge · Source · KnowledgeScope（Global / Project / Session）· File identity / Membership

## 职责

外生语料：源登记、同步/摄取、解析、embedding、索引（可重建）、检索、溯源。

- **源锚定**：每条命中必须能回答「来自哪个 source」
- **Index 非权威**：权威是源本身
- **无 Agent 级源**：「独享」= 只挂给它的 Project
- **v0.60+**：本域含 **Knowledge Service**（`http-app` / `serve` / `client`）——`knowledge.db` **唯一写者**（Writer Worker）；Gateway 只经 Client
- **File 本位**：`identity_key` + Membership（Corpus 废弃）；同文件多源只 parse 一次

## 与 Memory 的对偶（禁止合并）

| | Knowledge | Memory |
|---|---|---|
| 问句 | 世界上写着什么 | 我学到过什么 |
| 来源 | 外部世界 | 交互提炼 |
| Scope | Global / Project / Session | 仅 per-agent（E3） |

## 契约

`catalog-types.ts` / `catalog-index.ts`：Tier 0 catalog（system 只注入「有哪些源」）。  
实现依赖本目录 `types.ts`；**不**再拆到 `context/knowledge/`。

实现口径（FTS5 / 中止跨重启 / 向量闸门 / embed secret / File identity / Service）见 **`docs/knowledge.md` §8.1**。

## 模块（拆分后）

线程边界（v0.64，详见 `docs/knowledge.md` §2.1.1）：

```text
主线程     listen · health · 鉴权 · 纯读直达 Meta/Search · SSE
Meta/Search Worker  只读 SQL（WAL）
Engine/API  写路由编排（禁止可写 SQLite）
Writer      knowledge.db 唯一写 + ingest
Parse       抽取 / 切块 / FTS token
```

| 文件 | 职责 |
|------|------|
| `serve.ts` / `http-bridge.ts` / `read-http.ts` | 主线程：桥 + **纯读分发**（`isPureReadRoute`） |
| `engine-thread.ts` / `http-app.ts` | Engine/API：写路由编排 + SSE；注入 `write`+`query` |
| `writer-service.ts` / `writer-worker.ts` / `writer-worker-client.ts` | **Writer Worker**：唯一写者 + ingest RPC |
| `query-service.ts` / `query-worker.ts` / `query-worker-client.ts` | **只读查询面**（meta/search 角色；`:memory:` Local） |
| `job-control-state.ts` | jobControl 纯 SQL（禁依赖 ingest 内存态） |
| `local-stack.ts` | 测试 / `:memory:` 同进程装配 |
| `client.ts` | Gateway 侧 Client |
| `knowledge-serve-child.ts` / `start-service-process.ts` / `writer-lock.ts` | manageLocal fork 子进程 + 写者锁 |
| `parse-text-in-worker.ts` / `text-parse-worker.ts` | 文本切块 + FTS token（Worker） |
| `file-identity.ts` / `membership-store.ts` | File identity / 认领 / 零认领 purge |
| `ingest.ts` | 编排 / parse / watch / poll / reconcile（`startIngestRuntime`） |
| `job-queue.ts` | jobs 表原语 |
| `job-control.ts` | 中止纪元（DB 权威） |
| `embed-runner.ts` | Phase B + 外发 secret 策略 |
| `fts.ts` / `vector-ann.ts` | 关键词倒排 / 向量桶裁剪 |
| `index-store.ts` | files/chunks/向量投影（COUNT 1s TTL 缓存） |

## 边界

- **不做**：命题记忆；活系统当前态（Tool 实时查）
- **失败模式**：无源/错源、检索错语料、索引当权威、**双写 knowledge.db**
