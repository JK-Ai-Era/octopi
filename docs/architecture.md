# Octopi 架构设计文档

> 版本：v0.7.0 | 日期：2026-08-24
>
> 本文档是 Octopi 框架的完整架构设计，采用 DDD（领域驱动设计）思想按领域组织。
> 详细架构文档位于 `arch/` 目录，本文档是面向外部使用者的精简版。

---

## 1. 设计哲学

### 1.1 Agent 是一个运行时，不是一个类

传统框架把 Agent 做成一个 class——继承它，override 几个方法，你就有了一个 Agent。但真实的 Agent 需要的是一个**完整的运行时环境**：

- 一个消息循环引擎
- 一套上下文组装策略
- 一个模型调用能力
- 一组工具执行能力
- 一个状态持久化后端
- 一套人格描述文件
- 一组生命周期插件
- 一套安全策略

这些组件的组合方式是无穷的。框架不应该预设组合方式，而应该提供**清晰的接口**和**可替换的组件**。

### 1.2 三层分离：引擎 / 装具 / 集成

```
Core（引擎）     → 最小循环，纯接口，零实现依赖，安全内置
Harness（装具）  → 人格、插件、技能、策略、Session 管理、可靠性
Integration（集成）→ 协议、存储、沙盒、可观测性、LLM Provider
```

**依赖方向：外 → 内。内层不知道外层的存在。**

### 1.3 接口即契约

框架的价值不在于提供了多少默认实现，而在于定义了多少清晰的接口。

### 1.4 安全是内置的，不是附加的

安全不是"加一个安全模块"，而是每一层都有安全职责。Core 层的安全检查（SecurityGuard）不可禁用、不可绕过。

---

## 2. 快速开始

```typescript
import { AgentBuilder } from 'octopi';

const { agent, runner } = await new AgentBuilder()
  .model(myProvider)
  .persona('./my-agent')
  .tool(myTool)
  .budget({ maxIterations: 15 })
  .build();

// 处理用户消息
for await (const event of runner.handle(sessionId, userMessage, runConfig)) {
  if (event.type === 'llm_stream_delta') {
    process.stdout.write(event.data.delta);
  }
}
```

---

## 3. 核心概念

### 3.1 Agent Loop（核心循环）

核心循环是纯函数，不持有持久状态：

```
agentLoop(context, config, signal)
  → 调用 LLM → 解析响应 → 执行工具 → 循环
  → 通过 async generator yield 事件流
```

**Agent 类**管理消息历史和消息队列（steering/followUp），提供 `run()` / `continue_()` 生命周期。

### 3.2 可靠性包装

`runAgentWithReliability()` 包装核心循环，注入可靠性行为：

| 机制 | 问题 | 解法 |
|------|------|------|
| Planning-only 重试 | 模型只说不做 | 检测 promise 语言 → 注入 steer 指令 |
| 空响应重试 | 模型什么都不说 | 检测空内容 → 注入 steer 指令 |
| No-op 检测 | 工具返回无变化 | 连续 no-op → 注入 hint → 超阈值停止 |
| 工具循环检测 | 同一工具反复调用 | Rabin-Karp 哈希检测 → warning → critical |
| TaskSupervisor | Agent 偏离任务 | 自适应间隔检查 → 规则 + LLM 审查 |

### 3.3 上下文管理

ContextEngine 统一管理消息选择、压缩和 Token 估算：

```
消息到达 → MessageSelector（四区域划分）→ SmartRouter（路由决策）→ Compressor（压缩）
```

**智能路由**：fits / truncate_tool_results_only / compact_only / compact_then_truncate

### 3.4 安全架构

两层安全：
- **Layer 0+1（确定性）**：硬边界 + 风险规则引擎，始终启用
- **Layer 2（非确定性）**：LLM 安全智能体，可选启用

SecurityGuard 五层防护：InputGuard → OutputGuard → ToolGuard → OutputGuard → BehaviorGuard

### 3.5 Session 管理

SessionAwareRunner 管理 Session 生命周期：
- 消息持久化
- Session 锁（同一 session 同时只有一个运行）
- Daily reset / Idle reset
- 并发控制（SessionGate）

---

## 4. 源码结构

```
src/
├── core/                          # Layer 1: 纯引擎
│   ├── loop/                      # 核心循环
│   │   ├── agent-loop.ts          # agentLoop() 纯函数
│   │   ├── agent.ts               # Agent 类
│   │   ├── call-model.ts          # LLM 调用
│   │   └── error-classifier.ts    # 错误分类
│   ├── interfaces/                # 接口契约
│   ├── event-bus.ts               # 事件总线
│   ├── security-guard.ts          # 安全守卫
│   ├── budget.ts                  # 资源约束
│   ├── state-machine.ts           # 状态机
│   ├── async-task.ts              # 异步原语
│   ├── process-model.ts           # 进程模型
│   ├── tool-loop-detection.ts     # 工具循环检测
│   ├── circuit-breaker.ts         # 断路器
│   ├── types.ts                   # 核心类型
│   └── index.ts
│
├── harness/                       # Layer 2: 装具层
│   ├── builder.ts                 # AgentBuilder — Fluent API
│   ├── runner.ts                  # SessionAwareRunner
│   ├── config-bridge.ts           # 配置桥接
│   ├── context/                   # 上下文管理引擎
│   ├── security/                  # 安全策略
│   ├── plugins/                   # Plugin 系统
│   ├── tools/                     # 工具注册中心
│   ├── skills/                    # Skill 管理
│   ├── mcp/                       # MCP 集成
│   ├── tasks/                     # 任务管理
│   ├── planner/                   # 规划器
│   ├── scheduler/                 # 任务调度
│   ├── workflow/                  # 工作流引擎
│   ├── strategy/                  # 策略路由
│   ├── quality/                   # 输出质量检测
│   ├── reflector/                 # 反思器
│   ├── knowledge/                 # 知识存储
│   ├── persona/                   # 人格系统
│   ├── resources/                 # 资源管理
│   ├── commands/                  # 斜杠命令
│   ├── supervisor/                # 智能监督
│   ├── reliability/               # 可靠性包装
│   ├── distributed/               # 分布式智能体
│   ├── multi-agent/               # 多 Agent 编排
│   ├── concurrency/               # 并发控制
│   ├── process/                   # 进程管理
│   ├── budget/                    # 预算管理
│   └── index.ts
│
├── integration/                   # Layer 3: 集成层
│   ├── providers/                 # LLM Provider
│   ├── storage/                   # 存储后端
│   ├── observability/             # 可观测性
│   ├── gateway/                   # 网关
│   ├── protocols/                 # 协议适配
│   ├── tui/                       # 终端 UI
│   ├── mcp/                       # MCP SDK Client
│   ├── sandbox/                   # 沙盒
│   └── index.ts
│
├── testing/                       # 测试工具
│   ├── recording-provider.ts      # 录制
│   ├── replay-provider.ts         # 回放
│   ├── chaos-provider.ts          # 故障注入
│   ├── scenario-runner.ts         # 场景运行器
│   └── scenario-composer.ts       # 场景组合
│
├── config.ts                      # 配置加载
├── cli.ts                         # CLI 入口
└── index.ts                       # 统一导出
```

---

## 5. 接口清单

| 接口 | 文件 | 当前实现 |
|------|------|---------|
| `ModelProvider` | `core/interfaces/model-provider.ts` | OpenAI, Anthropic, ProviderPool |
| `ToolExecutor` | `core/interfaces/tool-executor.ts` | DefaultToolExecutor |
| `ContextEngine` | `core/interfaces/context-engine.ts` | DefaultContextEngine |
| `ErrorStrategy` | `core/interfaces/error-strategy.ts` | DefaultErrorStrategy |
| `Observer` | `core/interfaces/observer.ts` | NoopObserver, LogObserver, ObserverBridge |
| `SessionStore` | `core/interfaces/session-store.ts` | JsonlSessionStore, InMemorySessionStore, SqliteSessionStore |
| `TaskStore` | `core/interfaces/task-store.ts` | MemoryTaskStore |
| `TaskSupervisor` | `core/interfaces/task-supervisor.ts` | DefaultTaskSupervisor |
| `EventSource` | `core/interfaces/event-source.ts` | — |
| `MessageChannel` | `core/interfaces/message-channel.ts` | — |
| `AgentCommunicator` | `core/interfaces/agent-message.ts` | DefaultAgentCommunicator |
| `AgentRegistry` | `core/interfaces/agent-registry.ts` | DefaultAgentRegistry |
| `McpClient` | `core/interfaces/mcp-client.ts` | SdkMcpClient |

---

## 6. 数据流

```
用户消息
  ↓
SessionAwareRunner.handle()
  ↓
TaskDecisionProvider.decide()  ← 可选，判断任务状态
  ↓
runAgentWithReliability()      ← 可靠性包装
  ↓
agentLoop()                    ← 核心循环
  ↓
ContextEngine.assemble()       ← 智能路由 → 消息选择 → 压缩
  ↓
ModelProvider.call()           ← LLM 推理
  ↓
[如果返回 tool_calls]
  ↓
SecurityGuard.checkToolCall()  ← 安全检查
  ↓
ToolExecutor.execute()         ← 工具执行
  ↓
[回到 ModelProvider.call()]
  ↓
AgentEvent 流输出
```

---

## 7. AgentBuilder — Fluent API

```typescript
const { agent, harness, runner, mcpManager, runtime, events } = await new AgentBuilder()
  // 模型
  .model(myProvider)
  .provider('backup', backupProvider)  // 多 key
  .concurrency({ providerPool: { ... } })  // 负载均衡

  // 工具
  .tool(myTool)
  .mcp({ id: 'fs', transport: 'stdio', command: 'npx', args: [...] })

  // 上下文
  .contextEngine(myContextEngine)
  .summarize(mySummarizeFn)

  // 安全
  .withRiskPolicy(myRiskPolicy)
  .withSafetyGuard({ cwd: '/data' })

  // 可靠性
  .taskSupervisor()
  .reliability({ planningRetry: { maxAttempts: 3 } })

  // 可观测性
  .trace({ captureToolArgs: true })

  // 分布式智能体
  .withDistributedAgent(myAgentSpec)

  // Session
  .store(mySessionStore)
  .persona('./my-agent')

  // 构建
  .build();
```

---

## 8. Plugin 系统

### Hook 语义

- **拦截语义**：返回非 null/undefined 中断后续 handlers
- **观察语义**：所有 plugin 都执行

### 对齐 OpenClaw 的 Hook Catalog

- `before_model_resolve` — 模型选择
- `before_prompt_build` — Prompt 构建
- `before_agent_run` — Agent 运行
- `before_tool_call` / `after_tool_call` — 工具调用
- `message_received` / `message_sending` — 消息生命周期
- `session_start` / `session_end` — Session 生命周期
- `gateway_start` / `gateway_stop` — Gateway 生命周期

### Plugin 注册能力

providers, channels, tools, contextEngines, commands, services, webSearchProviders, mediaUnderstandingProviders, imageGenerationProviders, modelCatalogProviders

---

## 9. 分布式智能体

### 统一抽象

```
DistributedAgent = Trigger + InputPolicy + Execution + OutputPolicy
```

### OutputPolicy 模式

| 模式 | 行为 | 用途 |
|------|------|------|
| `intercept` | 同步阻塞工具执行 | 安全审查 |
| `replace_context` | 替换主 Agent 上下文 | 上下文增强 |
| `inject_context` | 注入信息到主 Agent | 信息补充 |
| `notify` | 通知（不干预） | 审计/日志 |

### 执行模式

- **LLM**：使用独立 Agent 实例 + runAgentWithReliability
- **Code**：直接调用 handler 函数
- **Hybrid**：preProcess → LLM → postProcess

---

## 10. 测试

### 三层策略

```
单元测试（Mock）→ 确定性，快速
录制回放 → 录一次，无限次回放
E2E 真实 API → 验证真实行为
```

### ChaosProvider 故障规则

empty, timeout, malformed, rate_limit, error, truncated, partial-tool

---

## 11. 技术栈

- **语言：** TypeScript (ESM, Node.js >=20)
- **构建：** tsc
- **测试：** Vitest (node --experimental-vm-modules)
- **核心模块：** Agent Loop, Session Manager, Context Engine, Plugin System, Skill Manager, Tool Registry, LLM Router

---

## 12. 相关文档

- `arch/overview.md` — 架构全景（DDD 领域组织）
- `arch/dependency-map.md` — 模块依赖图
- `arch/layer-rules.md` — 分层规则
- `arch/invariants.md` — 架构不变量
- `docs/plugin-system.md` — Plugin 系统详细文档
- `docs/task-system.md` — Task 系统详细文档
- `docs/CONTRIBUTING.md` — 开发规范
