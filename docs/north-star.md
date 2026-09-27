# Octopi 架构宪法

> **架构宪法**  
> **地位**：核心理念与长期不变量。高于单次交付节奏；实现可分层迭代，但 **不得违反不变量**。修订须显式改本文并走变更记录。  
> **产品定位**：Octopi = **可嵌入的 Agent 引擎**（运行时 + 连续性 + 治理底座），不是聊天包装器。

---

## 0. 为什么需要这份文件

同 Agent 多 Session 并发、上下文所有权、八层模型、Session↔Agent 基数与角色治理等问题，若只按短期排期评价，容易把 **必要的架构升维** 误判成「过度设计」。

本文件固定 **中长期尺度上的本体、不变量与预留位**，使实现、评审与嵌入方集成有同一部宪法。

---

## 1. 本体（Ontology）

嵌入式 Agent 引擎的本体不是「聊天循环」，而是下列概念。每个概念有**独占定义**；双记（两词同义）与杂物筐（一词多归属）视为宪法缺陷，修订时必须拆开。

### 1.0 概念总表

| 概念 | 定义 | 归属平面 |
|------|------|----------|
| **Host** | 嵌入边界：提供 Principal、映射 `conversationId`↔`sessionId`、持有人级 IAM | 边界（引擎外） |
| **Principal** | 驱动者：宿主用户 / 租户 / 服务 / 定时器 / 子系统 / 其它 agent | Control；必进审计 |
| **Intent** | 结构化驱动请求（`run` / `preferred` / `consult` / `handoff`…）；引擎不做 NLU | Control |
| **Agent** | 身份 + **模板**：persona、tools/skill 挂载、默认模型、`workspace`(cwd)、revision | Agent & Substrate / `agents/<id>` |
| **Substrate** | 该 Agent 跨 Session 持久的**学习产物**：Memory / Cognition / Wisdom | Agent & Substrate |
| **Knowledge** | **外生语料**（源锚定、索引可重建）；Scope = Global / Project / Session | Agent & Substrate |
| **Session** | 对话/任务 **连续性聚合**（标识 `sessionId`；宿主可映射 conversationId） | Continuity / Session Store |
| **Discourse** | Session 的**追加权威日志**（信息流；内容类型 = 八层 Information） | Continuity |
| **Projection** | **可失效重建**的派生视图（status / tasks / compact 视图 / 检索索引…） | Continuity |
| **RoleDefinition** | 角色目录条目（一等配置；非封闭枚举） | Control |
| **RoleBinding** | Agent 以某角色出现在某 Session 上的参与记录（权利预设 + 可覆盖） | Control |
| **Run** | 一次 episode：`(sessionId, agentId, …)` | Execution |
| **RunScope** | 该次 episode 的全部 **可变上下文**（messages 工作区、systemPrompt 身份、tool 运行时、compact 播种、resolvedModel…） | **仅 Run** / Execution |
| **Tool** | 可调用能力（定义 + 执行器）；挂 Agent，经 Run 调用 | Extension |
| **Effect** | 工具对世界的效应（cwd / 副作用 / 并发 / 幂等）；受 I5 约束 | Extension 定义 + Execution 执行 |

```text
Host ──(conversationId ↔ sessionId)── Session 聚合
  │                                     Discourse(I2) · Projection · compact[(s,a)]
  └── Principal ──Intent──► Control ──► Activation ──► Run( Session × Agent[× Role] )
                                                         │
                                                      RunScope
                                         （可变上下文唯一栖息地，I1）
```

**写回关系（非实体）**：Run 结束 → Discourse 追加 + Projection 更新 + Audit 落盘。原「Episode 产物」**不作**本体实体。

**易混对照（强制分词）**：

| 问句 | 概念 |
|------|------|
| 我学到过什么？ | **Substrate / Memory** |
| 世界上写着什么？ | **Knowledge**（源锚定；索引非权威） |
| 发生过什么？ | **Discourse**（追加权威） |
| 这一轮的临时棚？ | **RunScope**（仅 Run） |
| 它是谁、出厂怎么配？ | **Agent**（模板；不含学习产物） |
| 手 vs 手碰过什么？ | **Tool** vs **Effect**；活系统当前态用 Tool，文档用 Knowledge |

### 1.1 责任与执行分离（协作语义）

| 字段 | 含义 |
|------|------|
| **Accountability** | 主责：`primaryAgentId`；对用户/合规负责；变更 = handoff |
| **Agency** | 当前任务推进权：由 Role 与 preferred/显式 Run 决定 |
| **Exposure** | `readScope`：Run 能见多少 Discourse |
| **Learning** | `writeMemory`：能否写 **本 Agent** 基质 |
| **Responsibility transfer** | handoff：改 Accountability；**不是** specialist 权限的隐式结果 |

出厂 `specialist` 可拥有 Agency + Learning + full Exposure，**默认不拥有 Accountability**。

### 1.2 preferred vs primary

| 字段 | 服务什么 | 谁改 |
|------|----------|------|
| **primaryAgentId** | 问责与缺省人设 | 宿主/管理面（handoff） |
| **preferredAgentId** | Activation：Trigger 未指明 agent 时的 **session 缺省执行者** | 宿主切换意图 / 策略；**不是**业务路由替代宿主 |

- 外部 `run(sessionId, agentId)` 仍应 **显式 agentId**（可审计）。  
- 引擎 Runtime 在 schedule/escalate 等路径可 resolve 到 `preferred`。  
- 引擎 **不**擅自把 preferred 变成 primary。

### 1.3 Context：类型轴 × Scope 轴（八层叉乘）

**内容类型（产品八层）** 与 **归属 Scope** 是两条正交轴，不得焊死。

```text
类型轴（八层）:
  1 Wisdom · 2 Persona · 3 Skill · 4 Knowledge · 5 Cognition
  6 Memory · 7 Runtime · 8 Information

Scope 轴:
  Global / Tenant / Project / Agent / Session / (Session×Agent) / Run
```

| 层 | 常见 Scope | 说明 |
|----|------------|------|
| Persona / Skill | **Agent** | **模板**（Agent 身份），非 Substrate |
| Wisdom / Cognition / Memory 库 | **Agent** | **Substrate**（学习产物；E3 只写本 Agent） |
| Knowledge | **Global / Project / Session** | 外生语料；**无 Agent 级源**（「独享」= 只挂给它的 Project）；预留 Tenant。以 `docs/knowledge.md` 资源模型为准 |
| Runtime | **Run**（Session 感知） | tasks / guidance / injectedContext |
| Information | **Session**（Discourse） | 消息权威 |
| Compact | **(Session × Agent)** | Information 窗口派生视图，**非** Agent 模板状态 |
| 装配后 systemPrompt | **RunScope** | 产物，不回写 Agent 单例 |

**恒等式：** 产品八层 = system 侧 ContextLayer（1–7，含 runtime）+ Information（消息窗口）。  
实现 `ContextLayerId` 不必为叙事增删；**实现必须遵守所有权与缓存键**。

---

## 2. 长期不变量（必须可检验）

### 宪法级（架构违反 = 错误）

| # | 不变量 |
|---|--------|
| **I1** | **可变对话/运行上下文只存在于 RunScope**；Agent 是模板与基质，禁止充当「当前 session 工作区」。 |
| **I2** | **Discourse 权威 = Session 追加日志**；status / compact / tasks 等为投影，**可失效重建**。 |
| **I3** | **Accountability ≠ Agency**；执行切换（preferred / Run 目标）≠ 主责移交（handoff）。 |
| **I4** | **上下文 = 类型（八层）× Scope 叉乘**；不得用「七层/八层柱状图」冒充全部归属问题。 |
| **I5** | **效应面与认知面同等受策略约束**：工具 cwd/副作用/MCP 有并发与隔离语义，非法外之地。 |
| **I6** | **引擎消费结构化 Intent，不做权限 NLU**；**Principal 必进 Run/审计**；人级 IAM 归宿主，引擎强制 Agent×Session 裁决。 |

### 工程级（实现必须遵守）

| # | 不变量 |
|---|--------|
| **E1** | 同一 `sessionId` 的 Run **串行**（会话一致性）；同 Agent 不同 Session **可并发**。 |
| **E2** | 锁/租约权威键 = `sessionId`（分布式下为 **Session Lease** 的逻辑键）。 |
| **E3** | Memory/Wisdom/Cognition **只写本 Agent 库**；无「guest 写入 owner 基质」的缺省路径。 |
| **E4** | Compact 键 = `(sessionId, agentId)`；不借用他人 compact 当缺省。 |
| **E5** | Loop 保持无状态；唯一生产路径：`Agent.run` / `runAgentWithReliability` + **per-run context**。 |
| **E6** | 角色有效权限 = `L0 底线 ∩ 角色 max ∩ Agent maxSessionRights ∩ 绑定覆盖`；非法授予在 grant 时拒绝。 |
| **E7** | 单进程是 v1 部署假设；跨进程必须实现 **Session Lease**，禁止假装内存锁全局有效。 |

---

## 3. 平面（Planes）

平面回答「谁拥有真相 / 何时发生 / 引擎对外半边是什么」。**禁止**把「数据归属」与「运行阶段」混作同一张无分组清单。三组如下：

```text
权威平面（谁拥有真相）      阶段平面（何时发生）      能力面（对外开放的半边）
──────────────────        ──────────────────        ─────────────────────────
Control                    Activation                Context
Continuity                 Execution                 Extension
Agent & Substrate                                     Collaboration
```

```text
Host ── Principal ──Intent──► Control
                                │ Role/Policy/Credential/Quota 裁决
                           Activation ──► Run( Session × Agent[× Role] )
                                               │
                                            RunScope (I1)
                                               │
         ┌─────────────────────────────────────┼─────────────────────────────────────┐
         ▼                                     ▼                                     ▼
    Execution 物理                         Context 装配                         Extension 执行
    Lease/串行/Reliability                 八层×Scope (I4)                      Tool/Effect (I5)
    Guard/Budget 阀                        systemPrompt → RunScope              Plugin/Skill/MCP
                                               │
                                               ▼
                                 写回：Discourse 追加 (I2) + Projection + Audit

Agent & Substrate（跨 Run 持久）:
  Agent 模板 · Substrate(Memory/Cognition/Wisdom) · Knowledge(Global/Project/Session)
```

### 3.1 权威平面 — 谁拥有真相

| 平面 | 拥有 | 不负责 |
|------|------|--------|
| **Control** | Principal、Intent、RoleDefinition、RoleBinding 裁决、Policy、Approval（HITL）、Credential、Quota/Economy 挂载点 | 业务 NLU；人级 IAM（归 Host）；垂直行业流程引擎 |
| **Continuity**（原 Session） | Session 聚合、Discourse、Projection、compact[(s,a)]、SessionTask、Audit 流 | Agent 基质内容质量；本轮跑得对不对 |
| **Agent & Substrate**（原 Agent Registry） | Agent 模板、Revision、Memory/Cognition/Wisdom 读写、Knowledge 存储与检索 | 某次对话状态；本轮 systemPrompt 实例 |

### 3.2 阶段平面 — 何时发生

| 平面 | 拥有 | 不负责 |
|------|------|--------|
| **Activation** | Trigger 来源、Dispatch、Coalesce、preferred resolve、多 Agent 显式路由 | 第二执行引擎；擅自改 primary |
| **Execution**（原 Run Physics） | Run、RunScope、SessionLease/串行、隔离、Effect 策略**执行**、Reliability、RunGuard、Budget 阀 | 会话产品 UI；模板内容 |

### 3.3 能力面 — 引擎对外开放的半边

| 平面 | 拥有 | 不负责 |
|------|------|--------|
| **Context** | ContextLayer、Assembler、八层装配、Token、消息窗口、压缩策略入口 | 持久化权威（Discourse/Memory/Knowledge 库） |
| **Extension** | Tool 注册与调用面、Plugin、Skill、MCP、Sandbox、`workspace`(cwd)、命令 | 风险**判定**（策略权威在 Control）；会话语义 |

### 3.4 协作与横切

| 名称 | 管什么 | 说明 |
|------|--------|------|
| **Collaboration**（产品域，实现可分期） | Swarm、Subsystem、Signal、Workflow、AgentProcess、Discovery | **产品完整性必有**；多 Agent / 子系统协同。实现 `status: incomplete` 不取消其域地位（见 `docs/domains.md`） |
| **Observability**（横切） | Telemetry、Run Observatory、Issue 注册 | 调试/指标；**不是**合规流水（Audit 在 Continuity） |

---

## 4. 角色目录（长期形态）

角色拆为 **RoleDefinition**（目录条目）× **RoleBinding**（Session 上参与记录）；目录是配置，绑定是参与。

- 角色目录是 **一等配置**（文件为权威缺省；DB/控制台为可选覆盖后端），**不是**封闭代码枚举。  
- 出厂种子（产品已拍板）：**owner / specialist / reviewer / operator / steward**。  
- 业务角色（consultant 等）进 **同一目录** 自定义，不进引擎硬编码。

| 概念 | 长期要求 |
|------|----------|
| specialist | full Exposure + Learning + Agency（canManageTasks）；无 Accountability |
| reviewer | full Exposure；无 Learning/Agency 改任务 |
| operator | 最小 Exposure；旁路执行 |
| steward | 治理：全读、可写自身基质、可管理 tasks |
| handoff | 默认仅 Principal 控制面（宿主）；`allowAgentInitiatedHandoff` 缺省 false |

**切换缺省（产品）：** `preferred` + grant `specialist`；**不是**自动 handoff。

---

## 5. Reserved 设计位（现在不填满，禁止无位空洞）

下列位是长期架构 **必有** 的格子；实现可以分期，但 API/存储/文档不得假装不存在。

| 设计位 | 含义 | 最小预留 |
|--------|------|----------|
| **Principal** | Run/Intent/审计中的驱动者 | `actorId?` / `tenantId?` 字段与审计维度 |
| **Session Lease** | 分布式下替代内存锁 | 锁接口与 `sessionId` 键；实现可先 in-process |
| **ToolEffectPolicy** | 工具效应并发/沙箱/幂等 | 不变量 I5 + tool context 中 cwd/sandbox 字段位 |
| **AgentRevision** | 模板版本绑 Run | RunRecord：`agentRevision?` |
| **Quota / Economy** | token/费用按 Principal/Session/Agent/Role | Budget 已 per-run；挂载点位 |
| **Replay** | 从 Discourse + 审计复现 | append 权威（I2）；投影可重建 |
| **Scope 叉乘** | Knowledge 等多 scope | store 接口不绑死 `agentId` 唯一键；Knowledge 以 `docs/knowledge.md` 为准（Global/Project/Session） |
| **Briefing** | handoff/会诊交接摘要 | Participant 可选 `briefing`；≠ 对方 compact |
| **Intent 类型** | preferred / consult / handoff / run… | Intent 已为一等概念；控制面 API 形状可先最小集 |

---

## 6. 与「过度设计」的边界

### 6.1 不是过度（长期正课）

- RunScope 隔离与 Session 连续性聚合  
- 角色目录与 ACL  
- 八层 × Scope  
- 审计、归因、compact 分键  
- preferred + Activation  
- Principal / Intent / Host 进契约  
- Knowledge 与 Memory 分立（外生 vs 学习产物）

### 6.2 仍是真过度（避免）

| 形态 | 为何错 |
|------|--------|
| 同一概念多套真相且无权威序 | 角色/配置必须「一种语义、可插拔后端」 |
| 引擎内垂直业务路由流程 | 提供 resolve 钩子，不替宿主写工单系统 |
| 叙事/UI 跑在 Run 物理之前当门禁 | 八层 UI ≠ 不变量 I1 已实现 |
| 为假想共识系统过度设计 | Lease 可替换即可，非 v1 上分布式共识 |
| 用「内部可破坏」否定终态契约 | 中间 API 可 breaking；**不变量与本体以本文件为准** |

### 6.3 范围切割与架构评价的关系

```text
理念层   ← 本文件（现在定稿，长期不变）
物理层   ← RunScope / Lease / append 权威 / Effect Policy（完整设计，可迭代实现）
能力层   ← 控制台、配额 UI、多 scope Knowledge…
战术层   ← 某季度先并发测试还是先 grant API（不改变宪法）
```

实现验收以 **不变量** 为准，不以「今天能不能不写角色表」为准。

---

## 7. 已知长期风险（备案，非否决）

| 风险 | 缓解 |
|------|------|
| specialist 接近 owner，产品滥用后要求隐式 handoff | I3；handoff 仅控制面；文档强调 Accountability |
| full Exposure 成本 | Quota 设计位；租户收紧角色 max |
| 多实例误用内存锁 | E7；Lease 接口预留 |
| 工具踩踏 workspace | I5；session 级 sandbox 或租约策略 |
| 模板热更与 Memory 语义断裂 | AgentRevision 绑 Run |
| 八层柱状图掩盖 Scope | I4；文档强制叉乘表述 |
| 宿主把引擎 ACL 当人级 IAM | I6；契约写明边界 |

---

## 8. 实现关系（不变量如何落到代码）

| 不变量 | 主要落点 |
|--------|----------|
| I1 / E1 / E5 | RunScope：`SessionAwareRunner` / `Agent.run` / convertToLlm / toolContext |
| I2 | Session 存储：append 权威 + 投影（Projection） |
| I3 / E6 | RoleDefinition / RoleBinding 与 handoff（session ACL） |
| I4 | 八层 × Scope（上下文所有权；Knowledge 见 `docs/knowledge.md`） |
| I5 | Tool / Effect：上下文与 `workspace` 策略 |
| I6 / Principal / Intent / Host | 控制面 API：actor/tenant/Intent 字段位；人级 IAM 边界在 Host |
| E2 / E7 | 锁 → 可替换 Lease |
| E3 / E4 | Substrate 写路径（Memory/Wisdom/Cognition）；compact `(sessionId, agentId)` |
| Knowledge 源锚定 | `knowledge/` 管道；索引非权威，权威是 source |

**架构验收：** 不仅「串味测试绿」，且实现不违反 I1/E1/E5，tool 身份来自 RunScope；工具效应面至少有文档级策略与接口位。

---

## 9. 关联文档

| 文档 | 角色 |
|------|------|
| **`docs/north-star.md`（本文）** | **架构宪法（中文工作权威）** |
| **`docs/north-star.en.md`** | 英文对译；修订须双语同步 |
| **`docs/domains.md`** | **产品域地图（10 域）** |
| **`docs/domains.yaml`** | 域/模块唯一计数权威 |
| `docs/architecture.md` | 产品向架构说明 |
| `docs/KNOWN-ISSUES.md` | 已知问题摘要 |
| `docs/context-layer-contracts.md` | ContextLayer / Assembler 契约 |

实施阶段与内部专题见开发仓内交接材料（不对外）。

---

## 10. 变更记录

| 日期 | 内容 |
|------|------|
| 2026-09-26 | **Collaboration 升为正式产品域**（产品完整性必有；实现可 incomplete）；落地 `docs/domains.md` / `docs/domains.yaml`（10 产品域）。I1–I6 / E1–E7 未改。 |
| 2026-09-26 | 新增英文对译 [`north-star.en.md`](./north-star.en.md)；本文仍为中文工作权威，修订须双语同步 |
| 2026-09-26 | **本体补丁 + 平面二次划分**（领域结构前置）：拆 Agent/Substrate 双记；Session 写清聚合；删除「Episode 产物」实体改为写回关系；Role 拆 RoleDefinition×RoleBinding；补 Host/Intent/Knowledge/Tool/Effect/Projection；Knowledge Scope 勘误为 Global/Project/Session（无 Agent 级源，以 `docs/knowledge.md` 为准）；平面改为三组七平面（Control/Continuity/Agent&Substrate · Activation/Execution · Context/Extension）+ 横切 Observability/Collaboration。**I1–I6 / E1–E7 未改**。 |
| 2026-09-21 | 初稿：本体、不变量 I1–I6 / E1–E7、控制面分层、八层×Scope、Accountability/Agency、Reserved 设计位、过度设计边界、实现关系 |
| 2026-09-21 | **定稿**；后续实现与评审以本文不变量为准 |
| 2026-09-21 | **I1 落地**：RunScope ALS + per-run AgentContext；见 CHANGELOG v0.35.0 |
| 2026-09-21 | 文首定位定为 **「架构宪法」**；正文不展开文档目录体系 |
| 2026-09-21 | 关联文档仅保留对外 `docs/`；实施规划归内部交接材料 |
| 2026-09-21 | **Phase B–G 实现状态**（内部验收，见 CHANGELOG v0.36–v0.41）：I5 toolIsolation、模型 2 primary/归因、compact E4、ACL E6、preferred/handoff I3、Lease 接口位 E2/E7、AgentRevision 字段位。不变量本身未改。 |
| 2026-09-21 | 删除文首过时的「状态」行（仅标注 I1/v0.35.0，落后于当前实现）；修订须走变更记录的要求并入「地位」行。不变量与正文未改。 |
