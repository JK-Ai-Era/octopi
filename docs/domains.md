# Octopi 产品域地图

> **地位**：产品域叙事权威。数字与模块清单以 [`domains.yaml`](./domains.yaml) 为**唯一计数权威**；概念定义以 [`north-star.md`](./north-star.md) 为宪法。  
> **禁止**在 README / CONTRIBUTING / architecture 等文档手写领域个数或另表。  
> 日期：2026-09-26

---

## 1. 三层词汇（禁止混用）

| 层 | 含义 | 数量 | 出现在 |
|----|------|------|--------|
| **产品域 Domain** | 限界上下文：一域一语言、可独立替换 | **10** | 对外介绍、本文 |
| **模块 Module** | `packages/engine/src/harness/<dir>/` 实现单元 | 20–30，会增减 | `domains.yaml`、CI |
| **能力 / 基建** | 横切公用能力、层词表 | 5 | 清单 `kind`，**不计入域数** |

**域 ≠ 目录。** 新建目录不自动成域；门面、词表、横切不算域。

---

## 2. 总览

```text
                    ┌─────────────────────────────────────────────┐
                    │  10 产品域（一域一语言）                       │
                    │                                             │
   权威（谁拥有真相）│  Governance · Session · Agent · Memory ·    │
                    │  Knowledge                                  │
   阶段（何时发生）  │  Activation · Run                           │
   能力（对外半边）  │  Context · Extension · Collaboration       │
                    └─────────────────────────────────────────────┘
   横切/基建（不计数）：Observability · Summary&Compact · events/types
```

对外口径：

> **Octopi Harness 分 10 个产品域**——治理、会话、智能体、记忆、知识、激活、运行、上下文、扩展、协作。

---

## 3. 产品域卡片

### 3.1 Governance 治理

| | |
|---|---|
| **问题** | 谁能做什么？ |
| **平面** | Control |
| **独占概念** | Principal、Intent、RoleDefinition、RoleBinding、Policy、Approval、Credential、Quota |
| **模块** | `session-acl` `security` `human-in-the-loop` `credentials` `accounting` |
| **失败模式** | 授权错误、越权、密钥泄露 |
| **不做** | 业务 NLU；人级 IAM（Host）；垂直流程引擎 |

---

### 3.2 Session 会话

| | |
|---|---|
| **问题** | 连续性如何维持、旧账如何查？ |
| **平面** | Continuity |
| **独占概念** | Session 聚合、Discourse、Projection、Compact 状态、SessionTask |
| **模块** | `session/`（types / compact / state-machine）`session/tasks` `session/history` |
| **失败模式** | 连续性丢失/污染、任务丢失、compact 串键 |
| **不做** | 基质内容质量；本轮是否跑对（Run） |

**说明**：Discourse 追加是权威（I2）；其余是可重建 Projection。ACL 语言属 Governance，不进本域。

---

### 3.3 Agent 智能体

| | |
|---|---|
| **问题** | 它是谁、出厂怎么配？ |
| **平面** | Agent & Substrate |
| **独占概念** | Agent 模板、Persona、Revision、挂载 |
| **模块** | `agent-building`（+ `types/agent-definition` 契约） |
| **失败模式** | 装错人设/工具、模板版本漂移 |
| **不做** | 学习产物（Memory）；外生语料（Knowledge）；对话状态 |

---

### 3.4 Memory 记忆

| | |
|---|---|
| **问题** | 它学到过什么？ |
| **平面** | Agent & Substrate |
| **独占概念** | Substrate：Memory / Cognition / Wisdom |
| **模块** | `memory` |
| **失败模式** | 学歪、遗忘、基质污染 |
| **不做** | 外生文档（Knowledge）；对话原文（Discourse） |

**基质 = 学习产物**，E3 只写本 Agent。与 Knowledge **不合并**（产品拍板 2026-09-26）。

---

### 3.5 Knowledge 知识

| | |
|---|---|
| **问题** | 世界上写着什么？ |
| **平面** | Agent & Substrate |
| **独占概念** | Knowledge、Source、KnowledgeScope、File identity / Membership |
| **模块** | `knowledge`（含 **Knowledge Service** `http-app`/`serve`/`client`） |
| **失败模式** | 无源/错源、检索错语料、索引当权威、双写 knowledge.db |
| **不做** | 命题记忆；活系统当前态（Tool） |

**独立成域**：含外生资源管理、解析、embedding、检索；**不是基质**。Scope = Global / Project / Session（无 Agent 级源）。**v0.60+**：独立 HTTP Service 为 `knowledge.db` 唯一写者（Gateway 经 Client）；File 本位防重 + Membership。Service 内分线程（v0.64）：主线程 `/health`+鉴权+纯读分发，**Writer Worker** 跑写库/ingest，Meta/Search Query Worker 只读。详见 [`knowledge.md`](./knowledge.md) 与 `arch/knowledge-service-http.md`。

---

### 3.6 Activation 激活

| | |
|---|---|
| **问题** | 刺激如何变成 0..N 次受监督的 Run？ |
| **平面** | Activation |
| **独占概念** | Trigger、Dispatch、Coalesce、preferred resolve |
| **模块** | `agent-runtime` |
| **失败模式** | 该跑没跑、重复跑、错 Agent |
| **不做** | 第二执行引擎；擅自改 primary |

---

### 3.7 Run 运行

| | |
|---|---|
| **问题** | 这一轮如何安全、正确地跑完？ |
| **平面** | Execution |
| **独占概念** | Run、RunScope、SessionLease、Effect 执行、Reliability、RunGuard、Budget 阀 |
| **模块** | `run/`（run-scope / runner）`run/reliability` `run/run-guard` `run/budget` `run/concurrency` `run/model` `run/agent`（门面） |
| **失败模式** | 串会话、跑飞、效应失控、烧预算 |
| **不做** | 会话 UI；模板内容 |

**门面**：`Agent.run()` 是 E5 生产入口，属本域，**不单列产品域**。

---

### 3.8 Context 上下文

| | |
|---|---|
| **问题** | 这一轮 LLM 到底看见什么？ |
| **平面** | Context |
| **独占概念** | ContextLayer、Assembler、Token、消息窗口、压缩入口 |
| **模块** | `context` `capabilities` |
| **失败模式** | 模型看见不该看/看不见该看 |
| **不做** | 持久化权威（Discourse/Memory/Knowledge 库） |

八层 × Scope 叉乘（I4）。Compact **算法**在 capability，**状态键**在 Session（E4）。

---

### 3.9 Extension 扩展

| | |
|---|---|
| **问题** | 能力如何扩展？工具在哪跑？ |
| **平面** | Extension |
| **独占概念** | Tool、Effect、Plugin、Skill、MCP、Sandbox、Workspace |
| **模块** | `plugin-ecosystem` `tool-effect` `execution-environment` |
| **失败模式** | 插件炸、工具踩盘、cwd 逃逸 |
| **不做** | 风险判定（Governance 策略）；会话语义 |

---

### 3.10 Collaboration 协作

| | |
|---|---|
| **问题** | 多 Agent / 子系统如何协同？ |
| **平面** | Collaboration |
| **独占概念** | Swarm、Subsystem、Signal、Workflow、AgentProcess、Discovery |
| **模块** | `multi-agent` `orchestration` `autonomous-subsystem` |
| **失败模式** | 协同死锁、信号丢失、自治体越界 |
| **不做** | 人级 IAM；垂直业务流程 |

**状态**：`incomplete`——产品完整性必有域；实现可分期，**计数仍占 10 之一**（产品拍板 2026-09-26）。

---

## 4. 横切与基建（不计入产品域）

| 类 | id | 模块 | 说明 |
|----|-----|------|------|
| Capability | observability | `observer` `diagnostics` | 调试/指标/Issue；合规 Audit 在 Session |
| Capability | summary-compact | `context/capabilities` | 摘要/压缩公用算法（Context 组装专用） |
| Capability | document-extract | `capabilities/document` | 跨域 Document 抽取 Port（session/knowledge/tools；`documents.*`） |
| Foundation | events | `events` | 事件词表 |
| Foundation | types | `types` | 层共享类型 |
| Foundation | harness-entry | `index.ts` | 层统一导出 |

---

## 5. 本体概念 → 域

| 概念 | 域 |
|------|-----|
| Host | 边界（引擎外） |
| Principal、Intent、RoleDefinition、RoleBinding、Policy、Approval、Credential、Quota | Governance |
| Session、Discourse、Projection、Compact 状态、SessionTask | Session |
| Agent、Persona、Revision、Mount | Agent |
| Substrate、Memory、Cognition、Wisdom | Memory |
| Knowledge、Source、KnowledgeScope | Knowledge |
| Trigger、Dispatch、Coalesce、PreferredResolve | Activation |
| Run、RunScope、SessionLease、Effect 执行、Reliability、RunGuard、Budget | Run |
| ContextLayer、Assembler、Token、MessageWindow | Context |
| Tool、Effect、Plugin、Skill、MCP、Sandbox、Workspace | Extension |
| Swarm、Subsystem、Signal、Workflow、AgentProcess | Collaboration |

---

## 6. 防再漂

1. **唯一计数权威**：`docs/domains.yaml`  
2. **禁止手写数字**：README_CN、CONTRIBUTING、architecture.md、harness/README 一律引用本文或清单  
3. **CI**：`packages/engine/src/harness/` 目录集合 ≡ `module_catalog`（`planned: true` 允许暂缺）；未登记 fail  
4. **DoD**：新建/改名/合并/删除 harness 目录的 PR 必须同 PR 更新 `domains.yaml`  

---

## 7. 变更记录

| 日期 | 内容 |
|------|------|
| 2026-09-26 | **域优先目录落地**：`packages/engine/src/harness/` 顶层 = 10 域 + observability + shared；tool-effect 并入 execution-environment；knowledge 契约合一；孤儿文件归 session/ 与 run/ |
| 2026-09-26 | 初版：10 产品域（Memory/Knowledge 分立；Collaboration 独立且计入）；清单 `domains.yaml` |
