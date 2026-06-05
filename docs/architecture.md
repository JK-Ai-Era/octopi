# Octopi 架构设计文档

> 版本：v2.0 | 日期：2026-06-05

本文档是 Octopi 框架的完整架构设计，记录了设计决策的背景、权衡和原则。

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
Harness（装具）  → 人格、插件、技能、策略、Session 管理
Integration（集成）→ 协议、存储、沙盒、可观测性
```

**依赖方向：外 → 内。内层不知道外层的存在。**

这意味着：
- Core 可以独立存在，不需要 Harness 和 Integration
- Harness 可以独立测试，只需要 mock Core 的接口
- Integration 可以自由替换，不影响 Core 和 Harness

### 1.3 接口即契约

框架的价值不在于提供了多少默认实现，而在于定义了多少清晰的接口。接口一旦定义清楚，整个生态就能围绕它生长。

### 1.4 安全是内置的，不是附加的

安全不是"加一个安全模块"，而是每一层都有安全职责。Core 层的安全检查（SecurityGuard、IterationBudget）不可禁用、不可绕过。

---

## 2. Core 层详解

### 2.1 为什么 Core 是无状态的

AgentEngine 不持有 Session 状态。消息历史由调用方传入，处理后由调用方持久化。

**原因：**
- **可测试性** — 不需要 mock SessionStore 就能测试 Agent 循环
- **可复用性** — 同一个 AgentEngine 可以在有 Session 和无 Session 的场景下使用
- **关注点分离** — "怎么循环"和"怎么存储"是两个独立的问题

**无状态意味着：**
```typescript
// AgentEngine 的 run 方法签名
async *run(messages: Message[], config: RunConfig): AsyncGenerator<AgentEvent>

// 消息从哪来？调用方决定。
// 处理后消息去哪？调用方决定。
// AgentEngine 只负责：消息 → 推理 → 工具 → 输出
```

### 2.2 为什么用回调槽而不是 LifecycleHooks 接口

v1.0 设计中，Core 层定义了 `LifecycleHooks` 接口，Harness 层的 `PluginManager` 实现它。这导致了职责混乱：

- Core 定义了扩展机制（hooks）
- 但实际的扩展实现（PluginManager）在 Harness
- 到底谁拥有 hooks？

**修正：** Core 只暴露**回调槽（Callback Slots）**—— AgentEngine 上的可选函数属性。Harness 层可以把任何东西注入到这些槽里：hook chain、middleware pipeline、event emitter。

```typescript
// Core：只暴露槽位
class AgentEngine {
  onMessage?: (msg: Message) => Message | null;
  beforeModelCall?: (req: LLMRequest) => LLMRequest | null;
  // ...
}

// Harness：注入实现
engine.onMessage = (msg) => pluginManager.runHookChain('onMessage', msg);
```

**好处：**
- Core 不预设扩展机制
- Harness 可以用任何方式实现扩展
- 同一个 AgentEngine 可以同时被多个 Harness 组件注入

### 2.3 为什么 EventBus 是内置的

EventBus 不是可选的插件，是 Core 的一部分。原因：

1. **可观测性是生产级必需** — 没有事件系统就无法监控、调试、审计
2. **事件是解耦的通信方式** — Harness 和 Integration 通过订阅事件获知 Core 内部状态
3. **零成本** — NoopEventBus 的开销为零，不影响不需要事件的场景

```typescript
// 内置事件类型
ENGINE_START / ENGINE_END           — 引擎生命周期
ITERATION_START / ITERATION_END     — 循环迭代
MODEL_CALL_START / MODEL_CALL_END   — 模型调用
TOOL_EXEC_START / TOOL_EXEC_END     — 工具执行
INJECTION_DETECTED                  — 安全事件
BUDGET_EXCEEDED                     — 资源事件
```

### 2.4 为什么 SecurityGuard 是内置的

Prompt Injection 是 Agent 框架最严重的安全威胁。如果安全检查是 Plugin，它就可以被禁用或替换——这不可接受。

**Core 层的安全检查：**
- `checkUserInput()` — 消息到达时
- `checkToolOutput()` — 每次工具执行后
- `checkModelOutput()` — 每次模型调用后

**不可禁用，不可绕过。** 但检查的**策略**（灵敏度、模式）由 Harness 层配置。

### 2.5 ContextPipeline 为什么是管道而不是单一接口

v1.0 的 `ContextStrategy` 是一个单一接口 `assemble()`。但实际上，上下文组装涉及多个阶段：

```
Persona 注入 → Skill 匹配 → 历史组装 → 上下文压缩 → 不可信标记
```

把这些全部塞进一个 `assemble()` 方法，会导致这个方法变成"什么都管"的上帝方法。

**修正：** ContextPipeline 采用管道模型，每个阶段是一个独立的 `ContextStage`：

```typescript
interface ContextStage {
  readonly name: string;
  process(ctx: StageContext): Promise<StageContext>;
}
```

阶段可以独立替换、组合、测试。

---

## 3. Harness 层详解

### 3.1 为什么 Persona 是文件式的

v1.0 设计了结构化的五维 Persona 模型（身份/行为/能力/知识/交互）。但大哥指出：**这对 Agent 的可塑性限制太大。**

OpenClaw 的做法是用一套 Markdown 文件（AGENTS.md、SOUL.md、IDENTITY.md 等），每个文件是自由文本，没有 schema。

**文件式 Persona 的优势：**
- 无 schema → 自由表达任何特质
- 扩展 = 加文件 → 不需要改接口
- 组合 = 目录叠加 → 不需要代码
- 人可读 → 用户直接编辑

**Core 层不知道 Persona 的存在。** Persona 只是生成 `systemPrompt` 字符串的一种方式，通过 ContextPipeline 的 PersonaStage 注入。

### 3.2 为什么 Session 管理在 Harness 而不是 Core

AgentEngine 是无状态的循环引擎。Session 管理（加载/保存/锁/生命周期）是 Harness 层的 `SessionAwareRunner` 的职责。

**原因：**
- 测试 Agent 循环时不需要 mock SessionStore
- 无 Session 场景（单次调用、批处理）可以直接用 AgentEngine
- Session 管理策略（锁、并发、持久化）可以独立替换

### 3.3 Plugin 如何挂载到 Core

Plugin 不直接访问 AgentEngine。PluginManager 负责：

1. 加载和管理所有 Plugin
2. 将多个 Plugin 的 hooks 组合成回调函数
3. 注入到 AgentEngine 的回调槽

```typescript
// PluginManager.applyTo()
engine.onMessage = (msg) => {
  for (const plugin of sortedPlugins) {
    const result = plugin.hooks.onMessage?.(msg);
    if (result === null) return null;  // 拦截
    if (result !== undefined) msg = result;  // 修改
  }
  return msg;
};
```

### 3.4 Skill 如何注入到上下文

Skill 不直接修改消息。SkillManager 通过 ContextPipeline 的 SkillStage 注入：

1. 用户消息到达
2. SkillManager 匹配合适的 Skill
3. SkillStage 将 Skill 内容作为额外上下文注入到 PipelineInput

---

## 4. Integration 层详解

### 4.1 协议适配器

每个协议适配器持有 `SessionAwareRunner`（不是 AgentEngine），负责：
- 将外部消息格式转换为内部 `Message`
- 调用 `runner.handle()` 获取事件流
- 将事件流转换为外部响应格式

### 4.2 存储后端

`SessionStore` 接口的实现：
- `JsonlSessionStore` — 默认，文件系统
- `InMemorySessionStore` — 测试用
- `RedisSessionStore` — 生产环境
- `SqliteSessionStore` — 轻量级生产环境

### 4.3 沙盒

工具执行的安全隔离：
- `SandboxLevel.NONE` — 开发环境，无隔离
- `SandboxLevel.PROCESS` — 进程级隔离
- `SandboxLevel.CONTAINER` — Docker 容器
- `SandboxLevel.WASM` — WASM 沙盒

### 4.4 可观测性

Observer 接口的实现：
- `NoopObserver` — 默认，零开销
- `LogObserver` — 日志输出
- `OTelObserver` — OpenTelemetry 集成

---

## 5. 安全架构

### 5.1 威胁模型

| 威胁 | 攻击面 | 防线 |
|---|---|---|
| Prompt Injection（直接） | 用户输入 | Core: SecurityGuard.checkUserInput() |
| Prompt Injection（间接） | 工具返回值、外部内容 | Core: SecurityGuard.checkToolOutput() |
| 工具越权 | 工具调用参数 | Harness: ToolPolicyManager |
| 工具沙盒逃逸 | 工具执行过程 | Integration: Sandbox |
| 跨 Session 泄露 | Session 访问 | Harness: SessionIsolation |
| 敏感信息泄露 | 模型输出 | Core: SecurityGuard.checkModelOutput() |
| 恶意 Plugin | Plugin 注册 | Harness: PluginTrustLevel |
| 资源耗尽 | Agent 循环 | Core: IterationBudget |

### 5.2 密钥管理原则

**密钥不经过 LLM。** 密钥由 Integration 层的 SecretManager 管理。Agent 调用工具时，ToolExecutor/Sandbox 从 SecretManager 获取密钥并注入执行环境。Agent 从始至终看不到密钥。

### 5.3 不可信内容标记

外部内容（工具返回值、网页抓取、文件读取）在 ContextPipeline 中被标记为不可信。SecurityGuard 在检查时使用这些标记，区分"可信的系统指令"和"可能被注入的外部内容"。

---

## 6. 设计决策记录 (ADR)

### ADR-001: Core 无状态

**决策：** AgentEngine 不持有 Session 状态。

**理由：** 可测试性、可复用性、关注点分离。

**权衡：** 调用方需要自己管理 Session，增加了集成成本。但 AgentBuilder 和 SessionAwareRunner 封装了这个复杂性。

### ADR-002: 回调槽而非 LifecycleHooks 接口

**决策：** Core 只暴露回调槽，不定义扩展机制接口。

**理由：** 避免 Core 和 Harness 的职责混乱。Core 不预设扩展方式。

**权衡：** Harness 层需要自己实现 hook chain 逻辑。但这正是 Harness 层的职责。

### ADR-003: 文件式 Persona

**决策：** Persona 是一组 Markdown 文件，不是结构化对象。

**理由：** 可塑性。用户可以自由表达任何特质，不需要框架预设 schema。

**权衡：** 难以程序化地查询 persona 的具体属性（比如"这个 persona 的决策风格是什么"）。但这是有意的——框架不应该理解 persona 的语义。

### ADR-004: SecurityGuard 内置

**决策：** Core 层的安全检查不可禁用。

**理由：** Prompt Injection 是最严重的安全威胁，不能是可选的。

**权衡：** 开发调试时可能不方便。可以通过 SecurityGuard 的配置降低灵敏度，但不能完全禁用。

### ADR-005: ContextPipeline 管道模型

**决策：** 上下文组装采用管道模型，支持多阶段。

**理由：** 单一接口 `assemble()` 会变成上帝方法。管道模型允许独立替换每个阶段。

**权衡：** 管道的阶段顺序很重要，错误的顺序可能导致问题。需要文档明确约定默认顺序。

### ADR-006: EventBus 内置

**决策：** EventBus 是 Core 的一部分，不是可选插件。

**理由：** 可观测性是生产级必需。事件是解耦的通信方式。

**权衡：** 增加了 Core 的复杂度。但 NoopEventBus 的开销为零。

---

## 7. 与 OpenClaw 的关系

Octopi 是从 OpenClaw 提炼的框架。两者的关系：

| 方面 | OpenClaw | Octopi |
|---|---|---|
| 定位 | 完整的 AI 助手平台 | 可嵌入的 Agent 底座 |
| 通信 | 内置飞书、Telegram 等 | 协议适配器可选 |
| 记忆 | 内置记忆系统 | 通过 ContextPipeline 注入 |
| 调度 | 内置心跳、定时任务 | 通过 Plugin 扩展 |
| Persona | 内置文件系统 | 文件式 PersonaLoader |
| 安全 | 平台级安全策略 | Core 内置 + Harness 配置 |

Octopi 保留了 OpenClaw 中通用的 Agent 运行时能力，去除了所有平台绑定。
