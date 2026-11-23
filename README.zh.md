# Octopi 🐙

**可嵌入的 Agent 引擎**

> Agent 不是一个 class——它是一个完整的运行时。
> 运行时、连续性、治理——一部宪法管到底。

> **语言说明**：英文版见 [README.md](./README.md)。本文为中文对译，变更须双语同步。

[English](./README.md) · [文档](./docs/) · [架构](./docs/architecture.zh.md) · [参与贡献](./docs/CONTRIBUTING.zh.md)

[![CI](https://github.com/JK-Ai-Era/octopi/actions/workflows/ci.yml/badge.svg)](https://github.com/JK-Ai-Era/octopi/actions/workflows/ci.yml) ![License](https://img.shields.io/badge/license-Apache--2.0-blue) ![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen) ![npm](https://img.shields.io/npm/v/octopi-agent?label=octopi-agent)

---

## 一个 loop 不是一个产品

写一个 agent loop 只要一百行代码。把它装进产品不是。

从"demo 能跑"到"生产能用"之间，横着五堵墙：

- **失忆**——每次会话从零开始，agent 学到的任何东西都活不过一次对话。
- **垃圾记忆**——外挂的向量库会兴高采烈地记住它本不该相信的东西。
- **上下文腐烂**——窗口被填满，直到模型看不见真正重要的东西，而没人说得清为什么。
- **权限只是承诺**——权限写在 prompt 里，而不是刻在引擎里。
- **无人值守的运行**——凌晨三点第一次跑飞的时候，什么都没在看着，唯一的策略是 `maxSteps`。

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

## 快速开始

**前置**：Node.js ≥ 24。

```bash
npm install -g octopi-agent
```

### 三分钟跑通第一次对话

```bash
octopi init
```

全新机器上，`octopi init` **就是**首启体验：它脚手架 `OCTOPI_HOME`，然后带你在终端里走完配置向导。
状态机共九步；终端模式自动选中命令行，所以你要答的是八步：

```text
语言 → 部署模式 → 模型服务 → API Key → 选模型
     → 连通性测通 → 起服务 → 第一句话
```

- **部署模式是真实决策，不是走过场**：*个人使用*（本机单人、免登录）、*单组织多用户*（一个组织、多人、
  组织内共享知识库）、*多组织多租户*（一套部署上互相隔离的多个组织）。两种组织模式会要求设 admin
  密码——输两遍，落盘存的是 scrypt 哈希。
- **API Key 绝不写进 `octopi.json`**：它落 `OCTOPI_HOME/.env`，配置里只留 `${VAR}` 占位。向导在落盘前
  会真测一遍 provider，失败都带出路（重试 / 重新录 key / 换 provider / 保存并退出）。
- **配置即时生效**——向导先写盘再起服务，Web 向导还会把配置热应用进运行中的 gateway。
  若对**已在跑**的 gateway 重跑 `octopi init`，需要重启服务（或改走控制台配置页）：CLI 向导不做热应用。

向导收尾会问你要不要直接起服务、直接开聊，并**打印控制台访问密钥**（脚手架时随机生成的
`channels[type=http].apiKey`）。本机访问无需它；局域网或远程访问时，把它填进 WebUI 登录页的
「访问密钥」栏。

```bash
octopi serve start   # gateway + Web 控制台（向导可以直接替你起）
octopi chat          # 终端 TUI 对话，同一个 agent、同一份配置
octopi doctor        # 诊断部署/配置，不需要 LLM
octopi --version     # 已安装版本（也可: octopi version / -v）
```

裸跑 `octopi` 同一规则：未初始化 → 进 init 向导；已初始化 → 进终端对话。

**偏好浏览器？** `octopi init --web` 会在服务没跑时替你启动（`serve start` 本身幂等），
然后按 setup 链接打开 Web 向导。全新部署上这条链接就是 `octopi serve start` 打印的那条：

```text
🧙 首启配置向导（Web）：http://localhost:8180/?setup=<token>
```

（`8180` 是默认端口；配置了 `web.port` 时以终端打印的链接为准。）链接 30 分钟内有效，向导完成后即吊销。
向导接口对**任何来源**都要求这个令牌（包括本机回环），因此机器上没有别的东西能驱动向导改写配置；
浏览器从非本机来源发起的请求会被拒。若已没有有效 token（配置已完成或已过期），`--web` 会明说并指向控制台，
而不是打开一个没有向导的页面。命令行向导与 Web 向导共享同一状态机、写同一份配置——任选其一。

**非交互**（CI、dotfiles、脚本化安装）——`--yes` 跳过向导，全部取自 flag 与环境变量，
因此不做任何探针：

```bash
OCTOPI_API_KEY=sk-… octopi init --yes --provider deepseek --model deepseek-flash
```

`--yes` 取默认值 + 环境变量：`OCTOPI_API_KEY`（需要 key 的预设必填——只有免钥的 `ollama` 可省）、
`OCTOPI_DEPLOYMENT_MODE`、`OCTOPI_ADMIN_PASSWORD`（组织模式必填）、`OCTOPI_ORG_NAME`、
`OCTOPI_ADMIN_NAME`、`OCTOPI_LANG`。默认值：provider = `ollama`，部署模式 = `personal`。
`--web` 交给浏览器向导，`--cli` 强制走命令行。

**第二个 agent** 有自己的向导——选类型、取名并告诉它怎么称呼你、拿到挂资料的指引、然后试聊。
它要求部署的 registry 里已有用户：

```bash
octopi agent new
```

---

## 动手构建

### 嵌入代码

```typescript
import { AgentBuilder, OpenAIProvider } from 'octopi-agent';

const { runner, runtime } = await new AgentBuilder()
  .model(new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    models: ['gpt-6.1-terra'],
    defaultModel: 'gpt-6.1-terra',
  }))
  .persona('./my-agent')
  .build();

const userMessage = { role: 'user' as const, content: 'hello', timestamp: Date.now() };

for await (const event of runner.handle('session-1', userMessage, {
  systemPrompt: '', // 交给 runner 每轮解析 persona（改文件下一轮即生效）
  agentId: 'default',
  sessionId: 'session-1',
})) {
  if (event.type === 'llm_stream_delta') {
    process.stdout.write(String(event.data?.delta ?? ''));
  }
}

runtime?.dispose(); // 自主子系统持有定时器——dispose 后进程才能退出
```

`runner.handle()` 是会话感知入口：会话生命周期与写回都由它负责。`systemPrompt` 留空时由 runner 每轮
解析 persona（改 `AGENTS.md` 下一轮即生效）；传字符串则把该 prompt 钉死在本次调用上。若只要单个 agent、
不需要宿主会话存储，`build({ mode: 'core' })` + `agent.run()` 是库层路径。已有配置文件的宿主可以跳过
builder：`buildFromConfigFile()` 返回 `agentId → BuiltAgent` 的 `Map`（含 `agent`、`runner`、
`runtime` 等）。

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

MCP SDK 客户端是 Integration 适配器——从子路径导入，不在包根：

```typescript
import { AgentBuilder, OpenAIProvider } from 'octopi-agent';
import { createSdkMcpClient } from '@octopi-agent/engine/integration';

const { agent, runner, mcpManager, runtime } = await new AgentBuilder()
  .model(new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY!, models: ['gpt-6.1-terra'], defaultModel: 'gpt-6.1-terra' }))
  .persona('./my-agent')
  .mcpClientFactory(createSdkMcpClient)
  .mcp({
    id: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
  })
  .build();

// 与上面的循环相同，只是工具面里多了这个 MCP 服务器的工具
console.log(agent.context.tools?.map((t) => t.name));

await mcpManager.disconnectAll(); // MCP 服务器是子进程，不断开会挂住进程
runtime?.dispose();
```

工具以 `{serverId}__{toolName}` 命名空间注册（分隔符为 `__`），上面这个服务器注册的工具都挂在
`filesystem` 前缀下——两个服务器提供同名工具也不会撞。

---

## 宪法

### 它是什么

宪法不是文档装饰——**它就是开发方法本身，也是这个项目可靠性的最大保障。**

每个概念有且只有一个权威定义；每条不变量都是可执行的法，有指名的实现落点——承重的那几条还配有破即失败的测试。设计决策走变更记录、双语同步修订——从不靠口口相传。当代码与宪法冲突时，让步的是代码。

多数框架定义类。Octopi 定义**法**——以及一个必须服从它的代码库。

### 本体——每个概念只有一个权威定义

一个东西只被命名一次，是可检验性的前提。引擎由这些对象构成：

| 对象 | 它是什么 |
|---|---|
| **Host** | 嵌入边界：提供 Principal、映射 `conversationId ↔ sessionId`、拥有人级 IAM |
| **Principal / Intent** | 驱动者，以及结构化请求（`run` / `preferred` / `consult` / `handoff`……）——必进审计，永不从自然语言里猜 |
| **Agent** | 模板：persona、工具、默认模型、基质——从来不是一口活状态 |
| **Substrate** | 跨会话学到的东西：Memory / Cognition / Wisdom |
| **Knowledge** | **外生语料**（以源为锚；索引可重建）——Scope 是 Global / Project / Session，**没有 Agent 级** |
| **Session** | 连续性的一等聚合（`sessionId`） |
| **Discourse** | Session 的追加式权威日志 |
| **Projection** | 一切派生视图（status / tasks / compact / 索引）——可失效重建，永不是权威 |
| **Run / RunScope** | 一次 episode；**所有可变上下文只活在 RunScope 里**，写回后即丢弃 |
| **Turn / Step** | Turn 是一次对话交换；Step 是一次模型回合。绝不用同一个词指两者 |

这张表存在的理由，是杀掉三组混淆：**Substrate**（agent 学到的）≠ **Knowledge**（世界写下的）≠ **Discourse**（发生过什么）。派生视图叫 **Projection**，它可以由权威重建——反过来永远不行。

### 不变量——可执行的法

宪法级（架构违反 = 错误）：

- **I1**——可变上下文只存在于 RunScope。Agent 是模板；同一个 agent 可以多会话真并发而不串味（租约键 = `sessionId`，从第一天起）。
- **I2**——Discourse 是唯一权威。其余一切都是可失效重建的投影。
- **I3**——Accountability ≠ Agency。能干活不等于能担责；执行者切换不等于 `handoff`。
- **I4**——上下文是**类型 × Scope 的叉乘**，不是层数。优先级顺序永远替代不了归属。
- **I5**——效应面与认知面同等受策略约束。工具会触碰世界，它的效应是策略问题，不是信任问题。
- **I6**——引擎消费结构化 Intent，Principal 必进审计日志。"听懂话"归宿主，"执法"归引擎。

工程级（实现必须遵守）——`I` 回答「什么必须成立」，`E` 回答「实现允许怎么建」：E1 同一 `sessionId` 的 Run 串行、同 Agent 不同 Session 可并发；E2 锁/租约键是 `sessionId`；E3 基质只由它自己的 agent 写；E4 compact 键是 `(sessionId, agentId)`；E5 Loop 无状态，只走 `Agent.run` + per-run context；E6 有效权限是交集（`底线 ∩ 角色 ∩ Agent ∩ 绑定`），非法授予在 grant 时拒绝；E7 内存锁绝不假装全局有效——一个 gateway 主机可以跑多个 run 进程，部署超出这一形态时由真正的 Session Lease 接管；E8 易变上下文永不进 system prompt 前缀，也永不靠改写历史"丢掉"它。

### 它凭什么起作用

这些不变量不是交给开发者记住的口号。执法是**分级的**，而分级本身被写清楚，而不是暗示：

**每次构建都检查——破了 CI 就红：**

- **依赖方向是被检查的，不是被要求的**——`tests/architecture/boundaries.test.ts` 会让 core → harness 的导入直接失败，同一条规则也镜像进 lint（`no-restricted-imports`）。
- **清单有单一权威**——域的数量来自 `docs/domains.yaml`，文档与代码漂移就是红灯（`tests/architecture/domains-catalog.test.ts`）。
- **行为类不变量各有定向测试**——RunScope 隔离（I1）、会话投影（I2）、会话 ACL 与 handoff（I3/E6）、租约与 revision（E2/E7）、缓存稳定装配（E8），破了就红。
- **结构漂移有闸门**——`arch/check-sync.sh` 在路径清单或模块图与目录树不符时变红。

**作为契约持有，各有着名落点：** 每条不变量在宪法的实现映射表里都有归属实现（I4 → 上下文归属、I5 → 工具/效应策略、E3/E4 → 基质写入路径与 compact 键……）。它们在写代码的接缝处强制执行，但并非每条都已能独立让构建失败——说成"全部"才是这份文档本身要防的那种不实陈述。

**规则只能慢慢地改**——不变量先在宪法及其变更记录里改，代码随后跟上。永不反过来。

这就是这些法能在并发与生长中活下来的原因：承重的那批被**检查**，其余的写在能被检查的地方。

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
  前七层是装配器拼出的内容，第八层 `Information` **就是**对话本身。
- **缓存稳定的前缀（E8 装配位置）**——system prompt 只装整个会话内不变的内容；
  一切易变的——datetime、会话任务/指导、随查询择取的 Memory / Cognition /
  Wisdom——都放进该轮 `<turn_start>` 用户消息内 turn 级的 `<turn_context>`。
  历史 append-only 全回放：过期择取冻在自己的 turn 里，绝不中段删改。
  *收益：provider 前缀缓存轮轮命中——延迟热、输入按缓存价计费。*
- **三条所有权带**——Agent 基质（跨会话持久）/ Run（易失，绝不回写模板）/ Session（一等连续性）。它*解释了*为什么多个 agent 可以共用一条对话线，却永不共享人格与记忆。
- **形成 ≠ 装配。** 分馏链（知识怎么形成）与装配序（模型看到什么）是正交的两根轴——这一点，业界还没人把它说出口。
- **带校准的 Token 计量**——三层估算（LLM 实测 → tokenizer → 启发式；分类查表：中文 1 token/字），实测经按 model 分键的校准台账（`ContextSizeLedger`）作用到所有决策读数。
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

550+ 测试文件，三层纪律：单元（Mock）、**录制回放**（确定性回归）、E2E 真实 API——外加 `ChaosProvider` 故障注入和架构依赖检查。测试不是覆盖率表演；它是不变量保持不变的方法。

---

## 现状与边界

Octopi 处于 pre-1.0，迭代很快。诚实地说清边界：

- **部署假设**：**单机 gateway + 多个 run 进程**今天已支持——`fleet.replicasPerVersion`（上限 64）会自举 N 个 run 实例，会话粘在实例上，同一会话至多一个活动 run（冲突直拒 `lease_held`；租约表在 gateway 内，`fleet.leaseTtlMs` 作 TTL 兜底）。配额、会话与并发以该主机为界。
- **协作域**标注 `status: incomplete`——语义已定义，部分实现分期交付。
- **不适合所有人**：如果单厂商 SDK 的 loop 就够用，或者你要的是垂直业务流程引擎，或者你要把人级 IAM 放进引擎里——Octopi 不是你想要的。它是为"在自身产品逻辑之下还需要连续性、学习与治理"的产品准备的引擎。
- **具体硬约束**（开工前先看，别事后才碰）：
  - **Node.js ≥ 24 是硬性要求。** 我们用内置 `node:sqlite` 而不是自带原生 SQLite 绑定——原生绑定在跨平台安装上会碎，和向量检索叠加也难缠。Node 22 及更早版本装不上。

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
