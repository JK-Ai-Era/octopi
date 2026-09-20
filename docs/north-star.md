# Octopi 架构北极星（宪法级）

> **文档定位**：**对外架构宪法**（`docs/` = 对外；`arch/` = 内部设计稿，不对外）。  
> **地位**：核心理念与长期不变量。高于单次交付节奏；实现可分层迭代，但 **不得违反不变量**。  
> **状态**：定稿 2026-09-26；**I1 Run 物理已落地**（v0.35.0：RunScope ALS + per-run AgentContext）。修订须显式改本文并走变更记录。  
> **产品定位**：Octopi = **可嵌入的 Agent 引擎**（运行时 + 连续性 + 治理底座），不是聊天包装器。

---

## 0. 为什么需要这份文件

同 Agent 多 Session 并发、上下文所有权、八层模型、Session↔Agent 基数与角色治理等问题，若只按短期排期评价，容易把 **必要的架构升维** 误判成「过度设计」。

本文件固定 **中长期尺度上的本体、不变量与预留位**，使实现、评审与嵌入方集成有同一部宪法。内部更细的专题讨论稿见 `arch/`（不对外）；**对外以本文为准**。

---

## 1. 本体（Ontology）

嵌入式 Agent 引擎的本体不是「聊天循环」，而是：

| 概念 | 定义 | 归属 |
|------|------|------|
| **Principal** | 驱动者：宿主用户 / 租户 / 服务 / 定时器 / 子系统 / 其它 agent | 控制面；必进审计 |
| **Agent** | 能力与行为模板 + 学习基质（persona、tools、默认模型、Memory/Wisdom/Cognition…） | Registry / `agents/<id>` |
| **Session** | 对话/任务 **连续性一等 ID**（宿主可映射 conversationId） | Session Store |
| **Role** | Agent 出现在某 Session 上的 **参与形态**（权利预设 + 可覆盖） | 角色目录 + Participant 绑定 |
| **Run** | 一次 episode：`(sessionId, agentId, …)` | 执行层 |
| **RunScope** | 该次 episode 的全部 **可变上下文**（messages 工作区、systemPrompt 身份、tool 运行时、compact 播种、resolvedModel…） | **仅 Run** |
| **Substrate** | Agent 基质：跨 Session 持久的学习与模板产物 | Agent |
| **Discourse** | Session 信息流：Information（消息/任务连续性） | Session |
| **Episode 产物** | Run 结果、归因消息、compact 视图、审计记录 | Session 派生 + 审计 |

```text
Principal ──Intent──► Control Plane ──► Run( Session × Agent[× Role] )
                                              │
                                              ▼
                                           RunScope
                              （可变上下文唯一栖息地）
```

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
  Global / Tenant / Project / Agent / (Session×Agent) / Run
```

| 层 | 常见 Scope | 说明 |
|----|------------|------|
| Wisdom / Persona / Skill / Cognition / Memory 库 | **Agent** | Substrate |
| Knowledge | Agent / **Project** / **Global**（预留 Tenant） | 多 scope 引用 |
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

## 3. 控制面与数据面

```text
┌──────────────────────────────────────────────────────────┐
│ Principal (user / tenant / service / timer / subsystem)   │
└───────────────────────────┬──────────────────────────────┘
                            │ structured Intent
┌───────────────────────────▼──────────────────────────────┐
│ Control Plane                                             │
│  AuthZ hook（宿主 IAM 边界）· Role catalog · Quota        │
│  preferred resolve · grant/revoke · handoff · policy     │
└───────────────┬───────────────────────────┬──────────────┘
                │                           │
┌───────────────▼────────────┐  ┌───────────▼──────────────┐
│ Session Plane               │  │ Activation Host          │
│  Discourse append (权威)    │  │  triggers → Runs         │
│  Participants / Roles       │  │  coalesce / abort        │
│  Projections (status,…)     │  │  model A: await Run      │
│  compact[(s,a)] / audit     │  └───────────┬──────────────┘
└───────────────┬─────────────┘              │
                │         ┌──────────────────▼─────────────┐
                └────────►│ Run Physics                     │
                          │  Session Lease                  │
                          │  RunScope 隔离 (I1)             │
                          │  Tool Effect Policy (I5)        │
                          │  Budget / Guard（per-run）      │
                          └──────────────────┬─────────────┘
                                             ▼
                          Agent Registry + Substrate IO + LLM/Tools
```

| 平面 | 职责 | 不负责 |
|------|------|--------|
| **Control** | Principal 边界、角色目录、策略、意图裁决、配额概念 | 业务 NLU 权限；垂直行业流程引擎 |
| **Session** | Discourse、参与关系、投影、compact、审计 | Agent 基质内容质量 |
| **Activation** | 刺激 → 0..N 次受监督 Run | 第二执行引擎；改 primary |
| **Run Physics** | 隔离、串行、工具效应、可靠性 | 会话产品 UI |
| **Agent Registry** | 模板、revision、基质挂载 | 某次对话状态 |

---

## 4. 角色目录（长期形态）

- 角色目录是 **一等配置**（文件为权威缺省；DB/控制台为可选覆盖后端），**不是**封闭代码枚举。  
- 出厂种子（产品已拍板）：**owner / specialist / reviewer / operator / steward**。  
- 业务角色（consultant 等）进 **同一目录** 自定义，不进引擎硬编码。  
- 详见 `arch/session-acl.md`。

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
| **ToolEffectPolicy** | 工具效应并发/沙箱/幂等 | 文档不变量 I5 + tool context 中 cwd/sandbox 字段位 |
| **AgentRevision** | 模板版本绑 Run | RunRecord：`agentRevision?` |
| **Quota / Economy** | token/费用按 Principal/Session/Agent/Role | Budget 已 per-run；挂载点位 |
| **Replay** | 从 Discourse + 审计复现 | append 权威（I2）；投影可重建 |
| **Scope 叉乘** | Knowledge 等多 scope | store 接口不绑死 `agentId` 唯一键 |
| **Briefing** | handoff/会诊交接摘要 | Participant 可选 `briefing`；≠ 对方 compact |
| **Intent 类型** | preferred / consult / handoff / run… | 控制面 API 形状；实现可先最小集 |

---

## 6. 与「过度设计」的边界

### 6.1 不是过度（长期正课）

- RunScope 隔离与 Session 一等  
- 角色目录与 ACL  
- 八层 × Scope  
- 审计、归因、compact 分键  
- preferred + Activation  
- Principal 进契约  

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

**OP-AR-3 的正确读法：** Run 物理是 **不变量 I1/I5/E1 的实现**，不是「内部随便先修个 bug」。  
实现可以先做 Run 物理再做 ACL 存储，但 **PR/设计审查以不变量为准**，不以「今天能不能不写角色表」为准。

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

## 8. 实现关系（不变量如何落到现有专题）

| 不变量 | 主要落点 |
|--------|----------|
| I1 / E1 / E5 | OP-AR-3 RunScope：`SessionAwareRunner` / `Agent.run` / convertToLlm / toolContext |
| I2 | Session 存储：append 权威 + 投影（`arch/session-agent-run.md` 演进） |
| I3 / E6 | `arch/session-acl.md` 角色与 handoff |
| I4 | `arch/context-model.md` 八层 × Scope |
| I5 | Tool 上下文与 workspace 策略（专题，可与 Run 物理同期设计接口） |
| I6 / Principal | 控制面 API：actor/tenant/Intent 字段位 |
| E2 / E7 | 锁 → 可替换 Lease |
| E3 / E4 | Memory 写路径；compact `(sessionId, agentId)` |

**关闭 OP-AR-3（架构验收）：** 不仅「串味测试绿」，且实现不违反 I1/E1/E5，tool 身份来自 RunScope；工具效应面至少有文档级策略与接口位。

---

## 9. 关联文档

| 文档 | 角色 | 对外 |
|------|------|------|
| **`docs/north-star.md`（本文）** | **宪法权威副本** | ✅ |
| `docs/IMPLEMENTATION-PLAN.md` | 跨会话实施规划 | ✅ |
| `docs/architecture.md` | 产品向架构说明 | ✅ |
| `docs/KNOWN-ISSUES.md` | 已知问题摘要 | ✅ |
| `arch/north-star.md` | 内部指针 → 本文 | ❌ |
| `arch/session-agent-run.md` 等 | 内部专题稿 | ❌ |

---

## 10. 变更记录

| 日期 | 内容 |
|------|------|
| 2026-09-26 | 初稿：本体（含 Principal）、宪法不变量 I1–I6 / E1–E7、控制面分层、八层×Scope、Accountability/Agency、Reserved 设计位、过度设计边界、与 OP-AR-3 的实现关系 |
| 2026-09-26 | **定稿**：宪法生效；后续实现与评审以本文不变量为准 |
| 2026-09-26 | **I1 落地**：`RunScope` ALS + Runner/`Agent.run` per-run context；见 CHANGELOG v0.35.0 |
| 2026-09-26 | **迁入 `docs/`**：对外宪法权威路径为 `docs/north-star.md`；`arch/` 侧改为指针 |
