# Octopi 🐙

**可嵌入的 Agent 引擎**

> Agent 不是一个 class——它是一个完整的运行时。
> 运行时、连续性、治理——一部宪法管到底。

> **语言说明**：英文版见 [README.md](./README.md)。本文为中文对译，变更须双语同步。

[English](./README.md) · [文档](./docs/) · [架构](./docs/architecture.zh.md) · [参与贡献](./docs/CONTRIBUTING.zh.md)

![License](https://img.shields.io/badge/license-Apache--2.0-blue) ![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen) ![npm](https://img.shields.io/npm/v/octopi-agent?label=octopi-agent)

---

## 一个 loop 不是一个产品

写一个 agent loop 只要一百行代码。把它装进产品不是。

从"demo 能跑"到"生产能用"之间，横着五堵墙：

- **失忆**——每次会话从零开始，agent 学到的任何东西都活不过一次对话。
- **垃圾记忆**——外挂的向量库会兴高采烈地记住它本不该相信的东西。
- **上下文腐烂**——窗口被填满，直到模型看不见真正重要的东西，而没人说得清为什么。
- **权限只是承诺**——权限写在 prompt 里，而不是刻在引擎里。
- **无人值守的运行**——凌晨三点第一次跑飞的时候，什么都没在看着，唯一的策略是 `maxTurns`。

框架把 loop 给你，把五堵墙留给你。

**Octopi 是一台把五堵墙当作自己职责的引擎。** 会话连续性是一等聚合；学习基质配得上一套真正的知识形成理论；上下文管线可以细到 token 逐层检视；治理不可被关掉；监督分得清"资源上限"和"行为异常"。

---

## Octopi 是什么

Octopi 是一台**可嵌入的 Agent 引擎**——你构建 AI 驱动产品的组件，不是独立应用，不是聊天包装器，不是编排 DSL。

- **边界归你。** 宿主提供 `Principal`、维护 `conversationId ↔ sessionId` 映射、持有人级 IAM。引擎只消费结构化 `Intent`，永远不做权限 NLU。
- **运行时归引擎。** Session、Run、记忆、上下文、工具、安全、预算、监督——都是有定义的本体，不是你发明的胶水代码。

```text
你的产品 ── Principal / Intent / IAM ──► Octopi 引擎 ──► 模型、工具、世界
             （边界归你）                （运行时 · 连续性 · 治理）
```

---

## 宪法

多数框架定义类。Octopi 定义**法**——一套有独占定义、有可执行不变量的本体。几条物理定律：

| 对象 | 它是什么 |
|---|---|
| **Session** | 连续性的一等聚合（`sessionId`） |
| **Discourse** | Session 的追加式权威日志 |
| **Projection** | 一切派生视图（status / tasks / compact / 索引）——可失效重建，永不是权威 |
| **Agent** | 模板：persona、工具、默认模型、基质——从来不是一口活状态 |
| **Run / RunScope** | 一次 episode；**所有可变上下文只活在 RunScope 里**，写回后即丢弃 |
| **Substrate** | 跨会话学到的东西：Memory / Cognition / Wisdom |
| **Principal / Intent** | 驱动者，以及结构化请求（`run` / `consult` / `handoff`……）——必进审计，永不从自然语言里猜 |

以及它们推导出的不变量：

- **I1**——可变上下文只存在于 RunScope。Agent 是模板；同一个 agent 可以多会话真并发而不串味（租约键 = `sessionId`，从第一天起）。
- **I2**——Discourse 是唯一权威。其余一切都是可失效重建的投影。
- **I3**——Accountability ≠ Agency。能干活不等于能担责；执行者切换不等于 `handoff`。
- **I5**——效应面与认知面同等受策略约束。工具会触碰世界，它的效应是策略问题，不是信任问题。
- **I6**——引擎消费结构化 Intent，Principal 必进审计日志。"听懂话"归宿主，"执法"归引擎。

### 宪法驱动开发

宪法不是文档装饰——**它就是开发方法本身，也是这个项目可靠性的最大保障。**

每个概念有且只有一个权威定义；每条不变量都是可执行的法，有指名的实现落点和验收测试。设计决策走变更记录、双语同步修订——从不靠口口相传。当代码与宪法冲突时，让步的是代码。

这就是上面那些不变量能在并发与生长中活下来的原因：RunScope 隔离、Discourse 权威、权限格不是开发者记得的口号——它们被**检查**：依赖边界自动校验、清单单一权威、违法即失败的测试。任何新工作只先回答一个问题：*它违反宪法吗？*

📖 **[阅读完整宪法 →](./docs/north-star.zh.md)** (English: [docs/north-star.md](./docs/north-star.md))

---

## 五门你在框架里找不到的科学

### 1. 知识的形成科学——分馏链

Octopi 不"存储记忆"。它建模的是**知识如何形成、如何被证伪、如何被淘汰**：

```text
Information ──蒸馏──► Memory ──织网──► Cognition ──凝结──► Wisdom
 （原始交互）         （命题）          （概念图谱）          （判断范式）
```

**Memory——命题，不是数据块。** 每条记忆是一个有类型的命题：`fact`（什么是真的）、`method`（怎么做更有效）、`norm`（应该怎么行动）。活动日志、统计句、人格复读在门口就被拒收。六道门（G1–G6）执法形态、溯源、反模式、检索锚点、冲突容量与安全。置信度按来源定价：用户直接指令 **0.9**，模型自己的推断 **0.4**——而没有可引用来源的推断进 **shadow 区**：搜得到，**永不注入**上下文。0 条记忆是合法状态——这个系统宁可无知，不肯存垃圾。

**Cognition——拒绝迷信的图谱。** 概念是节点，边必须持证上岗：一条 `causes` 边需要 **2 条独立记忆**背书（或 1 条 strengthened 记忆 + 一次失败→修复闭环）——共现永远升格不成因果。边有 Hebbian 可塑性（`w = 1-(1-w)(1-η·e)`）和分关系衰减；新边先进快图（shadow），经巩固进入慢图。检索是沿关系的**扩散激活**，不是关键词命中。设计规则明明白白：*错强边的代价高于缺边。*

**Wisdom——可证伪的判断力。** 一条 wisdom 是一个 *maxim（范式）*——"面对这类问题该怎么想"——带场景、反场景、效果。范式是假设：出生为 `candidate`，在 `trial` 中试用，晋升 `active`，被反例 `contested`，被更好的范式 `superseded`。连出厂预设的置信度都是 **0.7**，不是 1.0。信用分配展示 `applied / assisted / contested` 计数——**从不展示"成功率 87%"这种谎话**。

**让这一切成立的规则：** *产生归 LLM，执法归代码。* 不用正则猜语义，不用 schema 假装理解。

### 2. 上下文的物理学——八层 × Scope

别处的"上下文工程"是 prompt 模板。这里是一条**有类型、有所有权、有预算的管线**：

- **八层内容类型**按优先级装配：
  `Wisdom → Persona → Skill → Knowledge → Cognition → Memory → Runtime → Information`。
  前七层构成 system prompt，第八层是消息窗口。
- **三条所有权带**——Agent 基质（跨会话持久）/ Run（易失，绝不回写模板）/ Session（一等连续性）。它*解释了*为什么多个 agent 可以共用一条对话线，却永不共享人格与记忆。
- **形成 ≠ 装配。** 分馏链（知识怎么形成）与装配序（模型看到什么）是正交的两根轴——这一点，业界还没人把它说出口。
- **带校准的 Token 计量**——三层估算（LLM 实测 → tokenizer → 启发式，中文约 1.5 token/字），再用实测平滑出 `calibrationRatio`。
- **逐层预算竞争 + manifest**——每层的入选或裁撤都有理由、可检视。*"这一轮的 prompt 为什么长这样"是一个有答案的问题。*
- **Compact 键 = `(sessionId, agentId)`**——摘要跟着"会话 × 智能体"走，永不污染模板。

### 3. 权威的法学——可执行的问责

- **有效权限是格上的交集**：
  `引擎底线 ∩ 角色上限 ∩ Agent maxSessionRights ∩ 绑定覆盖`。
  非法授权在 **grant 的那一刻**就被拒绝，不是用到时才报错。
- **角色目录是一等配置**——`owner / specialist / reviewer / operator / steward` 出厂即种子，你的业务角色进同一目录。specialist 可以读全史、写自己的记忆——但问责永远在 primary 手里。
- **`handoff` 是带审计的 Principal 变更**，默认仅宿主可发起；agent 不得自我晋升。"换个人来答"是 `preferred` + 一次授权——永远不是静默接管。
- **每次运行都知道是谁在驱动。** Principal 进 run 记录、进审计流水；引擎从不猜驱动者是谁。

### 4. 权力的治理——安全与效应是原语

- **两层安全**：规则引擎永远在线、**没有任何 bypass 选项**（守卫契约里根本不存在 `skip`/`disable`），外加可选的 LLM 安全智能体处理语义边缘。
- **五层守卫**——输入、输出、工具调用、工具输出、行为。Shell 解析深达四层（引号感知拆分 → 命令识别 → 重定向解析 → wrapper 识别）：`rm -rf /` 是 `critical`，`rm -rf ./dist` 是 `low`。确定性注入模式（`$(...)`、反引号、`| bash`）在边界上直接剪断。
- **六种降级策略**，不是一刀切：替换命令、收紧范围、要求确认、加护栏、拒绝、移交安全智能体。
- **Client Tools——设备是受治理的一等工具。** 客户端能力（`photo_capture`、`html_ui`、`mic_listen`、`voice_play`、`location_watch`……）注册为模型可调用的普通 tool——但敏感设备必须显式声明 `purpose` 并获得同意（`none / prompt / strict` 三档）。红线：禁静默采集、禁伪造同意、禁空成功、禁大字节进上下文。身份是四根正交轴——Principal · ClientInstance · Agent · Run——设备属于*人*，不属于 agent。
- **检索到的知识按"资料"包装，不按"指令"**——grounding 块标注为不可信参考内容，审计保留全文。检索投毒在包装层就被拆掉引信。

### 5. 运行的工程学——可靠性与激活

- **预算 ⊥ 守卫，这是设计判断。** 资源上限不是行为异常。账本**只记录、永不杀进程**；策略是部署方 opt-in；控制优雅降级：`observe → warn → compact → wrap-up → stop`。引擎不会因为 token 名义和就腰斩一个健康的多工具任务——这个 bug 真的杀过运行（31 轮被虚幻的"2M tokens"拦腰斩断），重构后它在结构上不可能再发生。
- **Cache-aware 计量**——`inputUncached / inputCached / inputCacheWrite` 是一等物理量；禁止用减法编造 cache。
- **失败的分类学**——Loop · Thrash · Drift · Stall · Blowup · Burn——配恢复升级阶梯：`inject_hint → 更硬的 hint → 截断 → 停止`。同一失败形态连续三次恢复无效，运行必停。
- **可靠性工具箱**：planning-only 重试、空响应重试、No-op 检测、工具循环检测（Rabin–Karp 指纹）、熔断器、两层 TaskSupervisor（规则检测 → LLM 审查）。
- **激活——刺激变成受监督的运行。** 定时、事件、升级、agent 信号、webhook 被*编译*成运行（Trigger → Dispatch → Coalesce），带去重和唯一会话互斥——没有第二个执行队列。两次用户消息之间，事情会*发生*。
- **自主子系统**，五维模型——`Sense + Think + Act + Signal + Boundary`——声明式目录（`SUBSYSTEM.md` + `config.yaml` + `handler.ts`）。出厂四个：`memory-steward`、`wisdom-steward`、`cognition-steward`、`safety-guard`。steward 们就是基质越长越大还保持干净的原因。

---

## 架构

四层。一条依赖铁律：**外 → 内。Core 零外层依赖。**

```text
┌────────────────────────────────────────────────────────────┐
│  Layer 3  Integration——LLM Provider · 存储 · 可观测性 ·     │
│           HTTP/WS Gateway · TUI · Web Runtime              │
│  ┌────────────────────────────────────────────────────────┐│
│  │  Layer 2  Harness——10 个产品域 + 横切/基建              ││
│  │           governance · session · agent · memory ·      ││
│  │           knowledge · activation · run · context ·     ││
│  │           extension · collaboration                    ││
│  │  ┌────────────────────────────────────────────────────┐││
│  │  │  Layer 1  Core——EventBus · StateMachine ·          │││
│  │  │           Kernel ports（ModelProvider、Security-   │││
│  │  │           Guard、RunGuard、ErrorStrategy……）        │││
│  │  │  ┌────────────────────────────────────────────────┐│││
│  │  │  │  Layer 0  Loop——纯 async generator：           ││││
│  │  │  │  agentLoop · callModel · classifyError         ││││
│  │  │  └────────────────────────────────────────────────┘│││
│  │  └────────────────────────────────────────────────────┘││
│  └────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────┘
```

Octopi Harness 分 10 个产品域——治理、会话、智能体、记忆、知识、激活、运行、上下文、扩展、协作——按三个平面分组：*权威*（治理 · 会话 · 智能体 · 记忆 · 知识）、*阶段*（激活 · 运行）、*能力*（上下文 · 扩展 · 协作）。计数权威是 [docs/domains.yaml](./docs/domains.yaml)，叙事见 [docs/domains.zh.md](./docs/domains.zh.md)。

Loop 层是**纯 async generator**——零状态、零外部依赖——所以它之上的整个运行时都是可替换的契约：`ModelProvider`、`SessionStore`、`ContextEngine`、`SecurityGuard`……

---

## 快速开始

**前置**：Node.js ≥ 24。

```bash
npm install octopi-agent
```

### 最快路径——CLI

```bash
npx octopi init      # 脚手架 OCTOPI_HOME：agents/、sessions/、config
npx octopi doctor    # 检查环境
npx octopi chat      # 在终端里和你的 agent 对话
npx octopi serve     # 启动 Gateway（REST + WS）
```

### 嵌入代码

```typescript
import { AgentBuilder, OpenAIProvider } from 'octopi-agent';

const { agent, runner } = await new AgentBuilder()
  .model(new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }))
  .persona('./my-agent')
  .build();

for await (const event of runner.handle('session-1', userMessage)) {
  if (event.type === 'llm_stream_delta') {
    process.stdout.write(event.data.delta);
  }
}
```

### 文件即配置

Persona 与技能就是 Markdown——可 diff、可评审、可版本管理。扩展 = 加一个文件。组合 = 叠加目录。

```text
my-agent/
├── AGENTS.md           # 主 persona——最先加载
├── persona/            # 补充 persona，按文件名字母序
│   ├── 10-soul.md
│   ├── 20-identity.md
│   └── 30-user.md
└── skills/
    └── deploy/
        └── SKILL.md    # 两阶段加载：先读元数据，内容按需加载
```

学习基质（Memory / Cognition / Wisdom）住在每个 agent 自己的 SQLite 库里——它是*长出来的*，不是手写的。见 [docs/memory.zh.md](./docs/memory.zh.md)。

### 挂载 MCP 服务器

```typescript
import { AgentBuilder, createSdkMcpClient } from 'octopi-agent';

const { agent, runner } = await new AgentBuilder()
  .model('gpt-4o')
  .mcpClientFactory(createSdkMcpClient)
  .mcp({
    id: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
  })
  .build();
```

---

## 能力巡览

| 能力 | 一句话 | 详情 |
|---|---|---|
| **插件与 hooks** | 拦截 + 观察两类语义、按优先级排序、per-handler 超时；生命周期覆盖从模型解析到循环结束 | [docs/plugin-system.zh.md](./docs/plugin-system.zh.md) |
| **技能** | 两阶段加载：启动只读 frontmatter，内容按需——100 个技能只花几百 token | [docs/plugin-system.zh.md](./docs/plugin-system.zh.md) |
| **MCP** | 原生，命名空间 `{serverId}__{toolName}`；stdio/SSE | [docs/architecture.zh.md](./docs/architecture.zh.md) |
| **知识** | 源是权威、索引可重建；两阶段索引（分钟级可搜）；Global/Project/Session 三级 Scope；独立 Knowledge Service 是 `knowledge.db` 的唯一写者 | [docs/knowledge.zh.md](./docs/knowledge.zh.md) |
| **会话任务** | 目标与步骤作为会话投影，配任务工具 | [docs/task-system.zh.md](./docs/task-system.zh.md) |
| **Web 搜索** | `web_search` 工具；内置 duckduckgo / tavily / brave / serper / mimo，按序降级 | `octopi.example.json` |
| **文档端口** | PDF / Office 抽取公用能力（`documents.*`） | [docs/architecture.zh.md](./docs/architecture.zh.md) |
| **多智能体** | Swarm 拓扑（层级 / 流水线 / 广播 / 对等），跑在受治理的角色之上 | [docs/domains.zh.md](./docs/domains.zh.md) |
| **人机协同** | 审批请求/决议是引擎契约，Gateway 与 UI 都能接 | [docs/architecture.zh.md](./docs/architecture.zh.md) |
| **可观测性** | Telemetry（trace、metrics、exporter）+ Run Observatory 调试观测 | [docs/observer-domain.zh.md](./docs/observer-domain.zh.md) |
| **交互面** | 终端（TUI）、Gateway（REST + WS）、带上下文检查器的 Web Runtime | [docs/architecture.zh.md](./docs/architecture.zh.md) |

---

## 设计原则

1. **Agent 是运行时，不是 class。** 工作区、会话存储、工具集、模型配置、persona——这是一个 scope，不是一个对象。
2. **机制，而非策略。** 框架提供机制，集成方提供策略。默认值都是 opt-in，绝不冒充引擎定律夹带私货。
3. **接口大于实现。** 换模型厂商、换存储、换上下文引擎——契约不动。
4. **安全是内置的。** 不是开关。agent 越强，安全越不能依赖开发者的自觉。
5. **文件即配置。** persona、技能、指令都是 Markdown。Git 就是编辑器。
6. **边界归宿主。** 人级 IAM、路由、身份留在你的产品里；引擎只执法，永不冒充。
7. **每个域可独立理解。** 你可以在不装下整个系统的前提下深耕一个域。

---

## 测试与质量

```bash
npm test
```

240+ 测试文件，三层纪律：单元（Mock）、**录制回放**（确定性回归）、E2E 真实 API——外加 `ChaosProvider` 故障注入和架构依赖检查。测试不是覆盖率表演；它是不变量保持不变的方法。

---

## 现状与边界

Octopi 处于 v0.7x，迭代很快。诚实地说清边界：

- **部署假设**：单进程是 v1 现实；跨进程需要分布式 Session Lease（进程内租约已有）。
- **协作域**标注 `status: incomplete`——语义已定义，部分实现分期交付。
- **不适合所有人**：如果单厂商 SDK 的 loop 就够用，或者你要的是垂直业务流程引擎，或者你要把人级 IAM 放进引擎里——Octopi 不是你想要的。它是为"在自身产品逻辑之下还需要连续性、学习与治理"的产品准备的引擎。

开放项见 [docs/KNOWN-ISSUES.zh.md](./docs/KNOWN-ISSUES.zh.md)。

---

## 包与导入面

五个可发布包（npm workspaces）：

```text
octopi-agent               套件（CLI bin: octopi）+ 配置 IO
  ├─ @octopi-agent/engine    Harness 十域 + 库集成
  │    └─ @octopi-agent/core Loop + Kernel 契约
  ├─ @octopi-agent/gateway   HTTP/WS 进程面 + Web Runtime
  └─ @octopi-agent/webui     预构建 Web 控制台
```

| 需求 | 导入 |
|---|---|
| 套件 / CLI | `octopi-agent` |
| 运行时 | `@octopi-agent/engine` |
| 内核 | `@octopi-agent/core` |
| Gateway / Web 客户端 | `@octopi-agent/gateway` |
| Plugin SDK | `@octopi-agent/engine/plugin-sdk/plugin-entry` |

---

## 文档

- **概念**——[宪法](./docs/north-star.zh.md) · [产品域](./docs/domains.zh.md) · [记忆](./docs/memory.zh.md) · [知识](./docs/knowledge.zh.md) · [上下文层](./docs/context-layer-contracts.zh.md) · [任务](./docs/task-system.zh.md) · [插件](./docs/plugin-system.zh.md) · [自主子系统](./docs/autonomous-subsystem.zh.md) · [观测](./docs/observer-domain.zh.md)
- **指南**——[参与贡献](./docs/CONTRIBUTING.zh.md) · [已知问题](./docs/KNOWN-ISSUES.zh.md) · [示例配置](./octopi.example.json) · [JSON Schema](./octopi.schema.json)
- **参考**——[架构](./docs/architecture.zh.md) · [域清单](./docs/domains.yaml) · [变更日志](./CHANGELOG.md)

---

## 许可证

Apache-2.0——见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。
