# Observer Domain — 观测领域

> **地位**：外部文档（tracked）。与 [architecture.md](./architecture.md)、[north-star.md](./north-star.md) 一致。  
> **内部设计笔记**：`arch/observer-domain.md`（gitignored，不入库）。

---

## 1. 产品心智：一个领域，两个子域

Octopi 的「Observer」不是单一类，而是 **观测领域（Observer Domain）** 下两个正交子域：

| 子域 | 代码位置 | 消费者 | 生产缺省 |
|------|----------|--------|----------|
| **Telemetry**（运营可观测） | `core/interfaces/observer.ts` + `integration/observability/*`（NoopObserver / LogObserver / ObserverBridge / TraceLogger / MetricsAggregator） | 指标、追踪、Exporter | 可接生产（`observability` 配置） |
| **Run Observatory**（开发调试） | `harness/observer/*`（ObserverHub + Run 投影） | Web 右栏 **Run** 面板、`/debug/run/*` | **`observer.level=off`** |

```text
Observer Domain
├── Telemetry        — Core Observer → Trace / Metrics（运营）
└── Run Observatory  — ObserverHub → 快照 / debug REST / Run 面板（开发）
         ▲
         └── 共享事件源：EventBus / HarnessLoopEvent / SecurityGuard
```

**不合并成一个实现类**：敏感面、失败策略、保留策略、消费者均不同。配置键保持双轨：

- `observability` — Telemetry  
- `observer` — Run Observatory（Run 现场）

二者同属 Observer Domain 心智，实现分离。

---

## 2. Run Observatory（开发调试）

### 2.1 职责

开发/测试时观察 **Run 可变现场**（宪法 I1）：RunScope、workspace vs LLM messages、Guard metrics、timeline，以及 security / memory / tool.effect 投影。  
**EventBus 仍是协调总线**；ObserverHub 负责打包可检视快照，观测失败 fail-open，不打断业务路径。

### 2.2 与 Core `Observer` 的区别

| | Core `Observer` | Run Observatory `ObserverHub` |
|--|-----------------|-------------------------------|
| 接口 | `recordMetric` / `startSpan` / `log` | 事件摄入 + 快照投影 |
| 数据 | 计数、延迟、span | systemPrompt、消息、工具、安全事件 |
| 缺省 | 可 Noop / 常开 | **`level=off`** |
| 出口 | OTel/Webhook/文件 | `/debug/run/*` + Web Run 面板 |

禁止把产品 `ObserverHub` 实现成 Core `Observer`，也禁止在 Core→Harness 方向依赖 Hub。

### 2.3 配置（`octopi.json`）

```json
{
  "observer": {
    "level": "full",
    "webPanel": true,
    "failOpen": true
  }
}
```

| 字段 | 语义 |
|------|------|
| `level` | `off`（**缺省**，不采集）/ `summary`（无 message 全文）/ `full`（全文 + `context.llm`） |
| `webPanel` | 跟 level：`off` 强制关；开启档位默认 true，可显式 false |
| `channels` | 分通道覆盖；未列出按 level 预设 |
| `payload` / `retention` | 正文开关与保留；**message 全文**须 `payload.messageFullText && retention.messagesPerRun==='full'` |
| `failOpen` | 观测异常只 warn（默认 true） |

summary/full 预设默认开启已实现通道：`run.scope` / `run.messages` / `run.timeline` / `run.guard` / `context.layers` / `context.compact` / `tool.effect` / `security` / `memory`；`context.llm` 仅 `level=full`。

配置形态必须与 `src/config-schema.ts`、`octopi.schema.json`、`octopi.example.json` 同步。

### 2.4 Run 身份

- `RunScope.runId` + `createRunId(sessionId, agentId)`（`harness/run-scope.ts`）  
- Observer **不另造权威 Run ID**；Hub 优先 `scope.runId`  
- 与宪法 Run = `(sessionId, agentId, …)` 对齐  

### 2.5 采样路径（避免双计）

| 来源 | 路径 |
|------|------|
| Runner 生命周期 / loop 适配事件 | `SessionAwareRunner.emitObserved` → **先** `hub.ingestEvent` **再** EventBus |
| ContextEngine（compact 等） | Builder `assemble` 的 `emit` 回调 → Hub + bus |
| SecurityGuard | `emitRunEvent` 附带 RunScope 身份；reliability 拦截 → `security_blocked` → `security.blocked` |
| Gateway | **只写** Context 面板用的 layers Map；**不**再 `hub.ingestEvent`（防止 timeline/lifecycle 双计） |

Context 契约层（产品「上下文」页签）与 Run 现场（Observer）**并存**：

- Gateway `lastContextLayers` — Context 面板，与 `observer.level` 无关  
- ObserverHub — Run 观测，在 level≠off 时快照  

### 2.6 调试 REST（非产品 API）

挂在 HTTP 根路径（**不在** `/api/v1` 下）：

```http
GET /debug/run/:sessionId/scope
GET /debug/run/:sessionId/messages?phase=entry|final&runId=&view=workspace|llm
```

受 `observer.level` / `webPanel` 门控。SDK 使用 `baseUrl + /debug/run/...`（`getDebugJson`），不要拼进 `restBase=/api/v1`。

### 2.7 通道投影（`RunObservatorySnapshot`）

| 通道 | 内容 |
|------|------|
| run.scope | agentId / model / cwd / isolation / systemPrompt 长度与预览（full 另有全文切换） |
| run.messages | workspace entry/final；full 下含正文；diff |
| run.timeline | engine / tool / compact / security 等适配后事件 |
| run.guard | iteration、tokensΣ（各轮 usage 之和，**非**当前上下文长度）、consecErr 等 |
| context.llm | ContextEngine 出口消息摘要（full 可看正文） |
| tool.effect (I5) | 本 Run cwd/isolation + 按工具 calls/errors |
| security | injection / policy / sensitive / blocked 等结构化事件 |
| memory | memory_store / memory_search **只读**摘要（Observer 不写库，E3） |

Web UI：右栏 **Run** 页签（`RunObservatoryPanel`）。

### 2.8 内存与保留

- runs / timeline：FIFO（`retention.runsPerSession` / `timelineEvents`）  
- session 键与 `lastLlmBySession` 随 run/session 淘汰清理  
- 进程内缓存；跨进程部署时观测天然是 per-process（与 E7 单进程假设一致）  

---

## 3. 开发者注意

1. **生产/嵌入缺省不采集**；要调试再显式 `observer.level=summary|full` 并重启引擎。  
2. **新跑一轮才会采样**；改配置后不会回填历史 run。  
3. 改配置 shape 时同步 Zod + schema + example + 本文。  
4. 勿在 Gateway 再次 `hub.ingestEvent` Runner 已摄入的事件。  
5. Core Telemetry（`observability`）与 Run Observatory（`observer`）不要混用配置键。  
6. 宪法约束仍适用：I1（现场只在 RunScope）、I2（Discourse 权威）、E3（memory 只读投影）、I5（工具效应面）。

---

## 4. 相关文档

- [architecture.md](./architecture.md) — 分层与 Harness 领域  
- [north-star.md](./north-star.md) — 宪法不变量  
- [CONTRIBUTING.md](./CONTRIBUTING.md) — 文档/测试同步规范  
- `src/harness/observer/*` — Hub / DTO / 快照实现  
- `octopi.schema.json` — `observer` 配置 Schema  
