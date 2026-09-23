# Octopi 🐙

**可嵌入的 Agent 底座引擎**

> Agent 不是一个 class，是一个完整的运行时。
> 框架的价值不在于提供了多少默认实现，而在于定义了多少清晰的接口。

[English](./README.md) | [架构设计](./docs/ARCHITECTURE.md) | [开发规范](./docs/CONTRIBUTING.md)

---

## 什么是 Octopi？

Octopi 是一个可嵌入的 Agent 底座引擎，用于构建 AI 驱动的应用。它提供你的产品所需要的 Agent 运行时基础设施——就像汽车需要引擎一样，你的产品需要一个 Agent 引擎来拥有 AI 能力。

- **可嵌入** — 不是独立应用，而是产品的组件
- **4 层架构** — Loop → Core → Harness → Integration，边界清晰，层次独立
- **15 个自包含领域** — 每个领域可独立理解、独立测试、独立替换
- **8 层上下文智能** — 智慧、人格、技能、知识、认知、记忆、运行时、信息（记忆见 [docs/memory.md](./docs/memory.md)）
- **安全内置** — 注入检测、风险评估、审批流程——不可选、不可绕过
- **原生多智能体** — 从架构底层支持分布式智能

---

## 架构

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 3: Integration — 外部适配                              │
│  LLM Provider · 存储 · 可观测性 · Gateway · TUI · Web Runtime   │
│                                                              │
│  ┌──────────────────────────────────────────────────────────┐│
│  │  Layer 2: Harness — 15 个自包含领域                       ││
│  │  agent-building · context · security · reliability        ││
│  │  plugin-ecosystem · multi-agent · autonomous-subsystem    ││
│  │  session-tasks · run-guard · orchestration · concurrency  ││
│  │  execution-env · hitl · memory                            ││
│  │                                                          ││
│  │  ┌──────────────────────────────────────────────────────┐││
│  │  │  Layer 1: Core — 机制原语 + 接口契约 + 核心类型       │││
│  │  │  EventBus · StateMachine · Kernel ports                │││
│  │  │                                                      │││
│  │  │  ┌──────────────────────────────────────────────────┐│││
│  │  │  │  Layer 0: Loop — 纯执行循环                      ││││
│  │  │  │  agentLoop · callModel · classifyError           ││││
│  │  │  └──────────────────────────────────────────────────┘│││
│  │  └──────────────────────────────────────────────────────┘││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

**依赖方向：外 → 内。Core 零外层依赖。**

### Layer 0: Loop — 纯执行循环

引擎的核心。`agentLoop()` 是一个纯 async generator：输入消息 → 调用 LLM → 执行工具 → 输出协议事件。零状态，零外部依赖。可运行门面见 Harness 的 `Agent.run()`。

### Layer 1: Core — Kernel 契约

基础设施原语（EventBus、StateMachine）和 **Kernel ports**（ModelProvider、ErrorStrategy、SecurityGuard、RunGuard、ReliabilityHarness）+ 共享词汇表。**Product ports**（ToolBus、SessionStore、Observer=Telemetry）与 Domain 契约（ContextEngine、Memory、MCP…）在 Harness。Run Observatory 见 [docs/observer-domain.md](./docs/observer-domain.md)。不包含策略实现。**不 re-export Loop。**

### Layer 2: Harness — 领域

| 领域 | 职责 |
|------|------|
| **Agent** | **可运行门面**：`Agent.run()` = reliability 包装 |
| **Agent Building** | Builder、人格加载、配置桥接 |
| **Context Management** | 消息选择、压缩、Token 估算；七层 ContextLayer 装配（见 [context-layer-contracts](./docs/context-layer-contracts.md)） |
| **Security** | 风险评估、Shell 解析、降级策略、安全智能体 |
| **Reliability** | 可靠性包装、HarnessLoopEvent、断路器、重试、监督 |
| **Plugin Ecosystem** | Plugin、Tool、Skill、MCP、斜杠命令 |
| **Multi-Agent** | Agent 注册发现、Swarm 编排、AgentProcess |
| **Autonomous Subsystem** | Sense/Think/Act/Signal/Boundary 五维子系统框架 |
| **Session Tasks** | 会话任务（goal/step）、注入、只读 UI；见 [task-system](./docs/task-system.md) |
| **Run Guard** | 单次 run 过程监督（continue/recover/stop） |
| **Agent Runtime** | 激活宿主：Trigger → 受监督 Run（long-lived；见 [arch/agent-runtime.md](./arch/agent-runtime.md)） |
| **Orchestration** | experimental 编排（子路径 `octopi/harness/orchestration`） |
| **Concurrency** | 多 Key LLM 负载均衡、限流、Session 门控 |
| **Execution Environment** | 沙箱、工作区管理、文件操作 |
| **Human-in-the-Loop** | 审批流程、决策缓存、基于风险的策略 |
| **Memory** | 命题记忆（fact/method/norm）、门控/置信度、认知/智慧存储、Memory Steward — 见 [docs/memory.md](./docs/memory.md) |
| **Observer** | 开发调试用 Run Observatory：`observer.level`（缺省 `off`）、`/debug/run/*`、Web Run 面板 — 见 [docs/observer-domain.md](./docs/observer-domain.md)（与 Telemetry 的 Core `Observer` 分离） |

### Layer 3: Integration — 外部适配

LLM Provider（OpenAI、Anthropic）、存储后端（JSONL、SQLite、Memory）、Telemetry 可观测性（Trace、Metrics、Exporters；配置键 `observability`）、协议（HTTP）、Gateway、TUI、Web Runtime。

---

## Context Intelligence — 七层智能模型

Octopi 独特的上下文智能组装方法，让 agent 通过更有效的 context 变得更聪明：

```
智慧（思维范式）        ← 最高优先级，放在 system prompt 最前面
人格（身份、特质）
技能（工作流指导）      ← 条件加载
知识（外部参考资料）    ← 按需检索
认知（概念关系网络）    ← 概念之间的关系
记忆（行动命题）        ← fact / method / norm（跨会话可行动洞察）
信息（原始消息）        ← 窗口管理 + 压缩
```

这是一个**信息分馏系统**：原始信息通过逐层提炼，产出越来越高层级的理解。

**实现**：`harness/context/` 的 `ContextLayer` 契约 + `DefaultContextAssembler`。  
默认路径已接 Persona / Skill / Knowledge / Memory / Runtime；Wisdom / Cognition 待打磨。  
详见 [docs/context-layer-contracts.md](./docs/context-layer-contracts.md)。

---

## 快速开始

```typescript
import { AgentBuilder, OpenAIProvider } from 'octopi';

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

### MCP 集成

一行代码连接任何 MCP Server：

```typescript
const { agent, runner } = await new AgentBuilder()
  .model('gpt-4o')
  .mcp({
    id: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
  })
  .build();
```

### Web Search（多 Provider）

在 `octopi.json` / `~/.octopi/octopi.json` 配置后自动注册 `web_search` 工具：

```json
{
  "webSearch": {
    "provider": "mimo",
    "fallbacks": ["duckduckgo"],
    "defaultLimit": 5,
    "timeoutMs": 90000,
    "providers": {
      "mimo": { "api": "mimo", "apiKey": "${MIMO_API_KEY}", "model": "mimo-v2.5-pro" },
      "duckduckgo": { "api": "duckduckgo" }
    }
  }
}
```

内置 provider：`duckduckgo`（免 key）、`tavily`、`brave`、`serper`、`mimo`。主 provider 失败或空结果时按 `fallbacks` 降级。

---

## 核心设计原则

**Agent 是运行时，不是类。** Agent 是一个完整的运行时作用域：工作区、Session 存储、工具集、模型配置、人格定义。框架提供机制，集成方提供策略。

**接口 > 实现。** 框架的价值在于接口。`ModelProvider` 让你替换 LLM 厂商；`SessionStore` 让你更换存储；`ContextEngine` 让你自由组合上下文管理。

**安全是内置的。** 注入检测、风险评估、审批流程——不是配置开关，而是内置约束。Agent 越强大，安全越不能依赖开发者自觉。

**文件即配置。** 人格、技能、智慧、操作指令——全部用 Markdown 文件定义。扩展 = 加文件。组合 = 叠加目录。

**每个领域可独立理解。** 在 vibe coding 环境中，上下文有限，你可以聚焦于单个领域而不需要理解整个系统。

---

## 测试

```bash
npm test
```

64 个测试文件，1022 个测试。三层策略：单元测试（Mock）、录制回放、E2E 真实 API。ChaosProvider 故障注入。

---

## 项目结构

```
src/
├── loop/                    Layer 0  纯执行循环
├── core/                    Layer 1  原语 + 接口 + 类型
│   ├── primitives/               EventBus、StateMachine
│   ├── interfaces/               18 个接口契约
│   └── types/                    核心类型定义
├── harness/                 Layer 2  自包含领域
│   ├── agent-building/           Builder、人格、配置桥、Runner 注入
│   ├── context/                  ContextLayer 装配、窗口压缩、compact-key（E4）
│   ├── capabilities/             公用能力（横切）：summary 摘要提取 + compact 压缩引擎
│   ├── session-acl/              角色目录、authorizeRun、preferred/handoff（E6/I3）
│   ├── tool-effect/              toolIsolation 工具 cwd（I5）
│   ├── security/                 风险评估、Shell 解析
│   ├── reliability/              可靠性包装、断路器
│   ├── plugin-ecosystem/         Plugin、Tool、Skill、MCP
│   ├── multi-agent/              Agent 注册发现、Swarm、AgentProcess
│   ├── autonomous-subsystem/     Sense/Think/Act/Signal/Boundary 子系统框架
│   ├── session-tasks/            会话任务 SessionTask（默认）
│   ├── run-guard/                过程监督（DefaultRunGuard）
│   ├── orchestration/            experimental 编排（workflow/scheduler/planner）
│   ├── concurrency/              负载均衡、限流、SessionLease
│   ├── execution-environment/    沙箱、工作区
│   ├── human-in-the-loop/        审批流程
│   ├── memory/                   记忆、认知、智慧
│   └── runner.ts                 SessionAwareRunner（session 锁、tool cwd、ACL）
├── integration/             Layer 3  外部适配
└── testing/                 测试工具
```

运行时关键配置（见 `octopi.example.json` 与 `docs/KNOWN-ISSUES.md`）：
`toolIsolation`、`sessionAcl`、`agents[].workspace` / `maxSessionRights`、`summary` / `compact` / `models.level.summary`（公用能力）。

---

## 相关文档

- [架构设计](./docs/ARCHITECTURE.md) — 完整架构设计文档
- [架构全景](./arch/overview.md) — DDD 领域组织
- [分层规则](./arch/layer-rules.md) — 依赖方向规则
- [架构不变量](./arch/invariants.md) — 架构约束
- [Plugin 系统](./docs/plugin-system.md) — Plugin 系统详细文档
- [会话任务 SessionTask](./docs/task-system.md) — 设计基准
- [领域切分](./docs/domain-split.md) — run-guard / orchestration / AsyncTask
- [开发规范](./docs/CONTRIBUTING.md) — 开发指南
- [更新日志](./CHANGELOG.md) — 版本历史
- [Web Runtime 技术设计](./docs/web-runtime-design.md) — Web Protocol SDK / Runtime Store / WebUI 设计
- [WebUI 会话显示模型设计](./docs/web-conversation-model-design.md) — Session 展示模型设计

---

## 许可证

MIT
