# Octopi — 架构设计文档 v5

> 可嵌入的 Agent 底座框架，参考 OpenClaw 架构设计

**最后更新**: 2026-06-04
**测试覆盖**: 150 tests, 7 test files (all passing)

---

## 设计原则

1. **Gateway 模式** — 单一长驻守护进程，拥有所有通信面
2. **Session 是一等公民** — 所有状态归 Session，不是归 Agent
3. **Context Engine 可插拔** — 上下文组装是 4 阶段生命周期
4. **Plugin Hooks 无处不在** — 每个生命周期阶段都可以拦截
5. **Skill 两阶段加载** — 元数据始终在 prompt，全文按需读取
6. **Markdown 即记忆** — 记忆是文件，不是数据库 blob
7. **Capability Ownership** — 每个能力有且仅有一个 owner
8. **事件流原生** — Agent Loop 是 AsyncIterable，天然支持流式输出、中断、可观测性

---

## 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                    Application Layer                          │
│   (Web App / CLI / Bot / 嵌入式)                             │
└──────────────────────────┬───────────────────────────────────┘
                           │ Protocol (HTTP / WebSocket)
┌──────────────────────────▼───────────────────────────────────┐
│                    Gateway                                    │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  Channel      │  │  Session     │  │  Agent             │  │
│  │  Router       │  │  Manager     │  │  Resolver          │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬───────────┘  │
│         │                 │                    │              │
│  ┌──────▼─────────────────▼────────────────────▼───────────┐  │
│  │              Agent Loop (AsyncIterable<AgentEvent>)      │  │
│  │                                                         │  │
│  │  Layer 1: Pre-Iteration (Plugin before_iteration hook)       │  │
│  │       ↓                                                 │  │
│  │  Layer 2: LLM Decision (ContextEngine → LLM → Response) │  │
│  │       ↓                                                 │  │
│  │  Layer 3: Tool Execution (validate → dedup → execute)   │  │
│  │                                                         │  │
│  │  Cross-cutting: IterationBudget / ErrorClassifier       │  │
│  │                 AbortSignal / RetryPolicy               │  │
│  └──────────────┬──────────────────────┬───────────────────┘  │
│                 │                      │                      │
│  ┌──────────────▼───────┐  ┌───────────▼──────────────────┐  │
│  │  Context Engine      │  │  Plugin System               │  │
│  │  (4-stage lifecycle) │  │  (hooks + capabilities)      │  │
│  └──────────────────────┘  └──────────────────────────────┘  │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  Tool         │  │  LLM         │  │  Skill             │  │
│  │  Registry     │  │  Router      │  │  Manager           │  │
│  └──────────────┘  └──────────────┘  └────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  Multi-Agent Runtime                                      │ │
│  │  ┌──────┐ ┌──────┐ ┌──────┐                             │ │
│  │  │Agent1│ │Agent2│ │Agent3│  ← 完全隔离                  │ │
│  │  └──────┘ └──────┘ └──────┘                             │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## 源码结构

```
src/
├── core/
│   └── types.ts              # 所有核心类型定义（消息、Agent、Session、Tool、Plugin、AgentEvent 等）
├── loop/                     # ✅ 新 Agent Loop 模块
│   ├── run-agent-loop.ts     # runAgentLoop() 异步生成器（三层架构核心循环）
│   ├── iteration-budget.ts   # IterationBudget（防无限循环计数器）
│   ├── error-classifier.ts   # ErrorClassifier（7 种错误分类 + jitteredBackoff）
│   ├── message-converter.ts  # MessageConverter（内部/LLM 消息格式转换）
│   └── index.ts              # 统一导出
├── gateway/
│   └── gateway.ts            # Gateway 守护进程（消息路由、Agent 管理、生命周期）
├── agent/
│   ├── agent-runner.ts       # AgentRunner class（原 AgentLoop，保留向后兼容别名）
│   └── session-manager.ts    # Session CRUD、write lock、JSONL 持久化
├── context/
│   └── engine.ts             # LegacyContextEngine（尾部裁剪 + token 估算）
├── plugins/
│   ├── manager.ts            # PluginManager（hook 执行、能力查询、生命周期）
│   ├── loader.ts             # PluginLoader（发现、验证、加载、注册）
│   ├── api.ts                # PluginApi（register() 回调接收的 API 对象）
│   ├── entry.ts              # definePluginEntry() / defineChannelPluginEntry()
│   ├── manifest.ts           # manifest 验证和解析
│   ├── capability.ts         # CapabilityRegistry（能力所有权、冲突检测）
│   └── hooks.ts              # Hook 底层注册机制
├── skills/
│   └── manager.ts            # DefaultSkillManager（两阶段加载）
├── tasks/
│   ├── shared.ts             # applyDecision 共享函数（去重）
│   ├── tracker.ts            # TaskTracker（任务状态机 CRUD，全异步）
│   ├── task-manager.ts       # TaskManager（LLM 轻量决策器）
│   ├── plugin.ts             # TaskManagerPlugin（迭代级 hook 集成层）
│   ├── types.ts              # 任务系统类型定义
│   └── index.ts              # 统一导出
├── tools/
│   ├── registry.ts           # ToolRegistry（全局/Agent 级工具、策略）
│   └── builtin.ts            # 内置工具（shell、file_read、file_write、file_list）
├── providers/
│   ├── router.ts             # LLMRouter（provider 路由）
│   ├── openai.ts             # OpenAI 兼容 provider
│   └── anthropic.ts          # Anthropic Messages provider
├── protocol/
│   └── http.ts               # HTTP Channel Adapter
├── config.ts                 # 配置加载（JSON + 环境变量替换）
├── cli.ts                    # CLI 入口
└── index.ts                  # 统一导出
```

---

## 核心模块详解

### 1. Gateway — 消息路由与生命周期管理

Gateway 是框架的入口，负责将外部消息路由到正确的 Agent 和 Session。

```
外部消息 → Channel Adapter → Gateway.resolveAgent() → AgentRunner.processMessage()
                                                    ↓
                                              Session Manager
                                                    ↓
                                              Channel Adapter → 外部回复
```

**关键职责：**
- **Agent 路由**: 按 `channelBindings` 匹配 Agent，无匹配则 fallback 到第一个 Agent
- **Session 路由**: 根据 `dmScope` 决定 session 隔离策略（main / per-peer / per-channel-peer）
- **Plugin 生命周期**: 通过 `PluginManager` 管理 gateway_start/stop、message_received/sending/sent
- **Skill 发现**: 注册 Agent 时自动扫描 `skillDirectory`

```typescript
// Gateway 核心 API
class Gateway {
  registerAgent(agent: AgentDefinition): void;
  registerChannel(adapter: ChannelAdapter): void;
  registerProvider(provider: LLMProvider): void;
  registerTool(tool: RegisteredTool, agentId?: string): void;
  getPluginManager(): PluginManager;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: ChannelMessage): Promise<void>;
}
```

### 2. Agent Loop — 三层架构核心执行循环

Agent Loop 是框架的"心脏"。采用事件流原生设计，是一个 `AsyncIterable<AgentEvent>`。

**三层架构：**

```
┌───────────────────────────────────────────────┐
│  Layer 1: Meta-Decision (顾问层)               │
│                                               │
│  LoopAdvisor[] — 按 priority 排序执行          │
│  输出: MetaDecision (inject/override/stop)     │
└───────────────────┬───────────────────────────┘
                    ↓
┌───────────────────────────────────────────────┐
│  Layer 2: LLM Decision (模型层)                │
│                                               │
│  ContextEngine.assemble() → LLMProvider       │
│  输出: content + toolCalls                     │
└───────────────────┬───────────────────────────┘
                    ↓
┌───────────────────────────────────────────────┐
│  Layer 3: Tool Execution (执行层)              │
│                                               │
│  参数验证 → 修复 → 去重 → 截断检测 → 执行      │
│  输出: ToolResult[]                             │
└───────────────────┬───────────────────────────┘
                    ↓
               检查 shouldContinue
```

**执行流程：**

```
1. 检查中断 / 预算 / 最大轮次
2. Layer 1: Pre-Iteration（Plugin before_iteration hook）
   → 消息注入 / 参数覆盖 / 决定停止
3. Layer 2: LLM Decision（ContextEngine 组装 → LLM 调用）
   → 无 tool calls → 返回最终响应（loop_end completed）
   → 有 tool calls → 进入执行层
4. Layer 3: Tool Execution（参数验证/去重 → 逐个执行）
5. Turn 后处理（通知 advisors → 检查 steering → 继续循环）
```

**事件流示例：**

```typescript
for await (const event of runAgentLoop(config, input, signal)) {
  switch (event.type) {
    case 'loop_start':          // 循环开始
    case 'turn_start':          // 一轮开始
    case 'messages_injected':   // 消息被注入
    case 'llm_request':         // LLM 请求发出
    case 'llm_stream_delta':    // 流式增量
    case 'llm_response':        // LLM 响应完成
    case 'tool_call_start':     // 工具开始执行
    case 'tool_call_result':    // 工具执行完成
    case 'loop_end':            // 循环结束（completed/max_turns/budget_exhausted/interrupted/error）
  }
}
```

**关键设计：**
- **AsyncIterable 原生** — 天然支持流式输出、中断控制、外部可观测性
- **IterationBudget** — 默认 90 次迭代，防无限循环
- **ErrorClassifier** — 7 种错误分类，各有不同的重试策略
- **AbortSignal** — 任意点中断

```typescript
// 新 Loop 核心 API
async function* runAgentLoop(
  config: AgentLoopConfig,
  input: Message,
  signal?: AbortSignal,
): AsyncIterable<AgentEvent>
```

### 3. Loop Advisor — 统一的循环扩展点

Loop Advisor 是 Agent Loop 的核心扩展机制。每轮迭代前，按 priority 依次调用所有注册的 Advisor。

```typescript
interface LoopAdvisor {
  name: string
  priority: number  // 越小越先执行
  beforeTurn(ctx: AdvisorContext): Promise<MetaDecision | null>
  afterTurn?(ctx: AdvisorContext, result: TurnResult): Promise<void>
  onLoopEnd?(ctx: AdvisorContext): Promise<void>
}
```

**MetaDecision 能力：**

| 能力 | 字段 | 说明 |
|------|------|------|
| 消息注入 | `injectMessages` | 向当前轮次注入额外消息 |
| 模型覆盖 | `overrideModel` | 临时切换到其他模型 |
| Thinking 覆盖 | `overrideThinking` | 调整 thinking level |
| 停止循环 | `shouldStop + stopReason` | 决定不再调用 LLM |
| 任务上下文 | `taskContext` | 注入到 system prompt |

### 4. Session Manager — 会话状态管理

Session 是对话的完整生命周期，一个 Session 对应一个 Agent + 一个渠道 + 一个对等方。

**Session 隔离策略：**
- `main`: 所有消息共享一个 session（单用户场景）
- `per-peer`: 每个发送者一个 session
- `per-channel-peer`: 每个渠道+发送者一个 session
- `per-account-channel-peer`: 每个 account+渠道+发送者一个 session

**持久化格式：** JSONL（每行一个消息或 turn 记录）

### 5. Context Engine — 上下文组装

4 阶段生命周期，每个阶段可被 Plugin 替换：

| 阶段 | 时机 | 职责 |
|------|------|------|
| `ingest` | 新消息到达 | 记录消息、更新索引 |
| `assemble` | LLM 调用前 | 按 token budget 裁剪消息、转换为 API 格式 |
| `compact` | 上下文满了 | 压缩旧消息（可选） |
| `afterTurn` | 一轮完成 | 更新索引、触发后台任务 |

**LegacyContextEngine**（内置默认）：
- `ingest`: no-op（SessionManager 处理）
- `assemble`: 从尾部裁剪，保留最新消息，转换为 OpenAI API 格式
- `compact`: no-op（不自己管理压缩）
- `afterTurn`: no-op

### 6. Plugin System — 完整的插件生命周期

Plugin 系统对齐 OpenClaw Plugin Architecture，提供 4 层加载管线。

**加载管线：**

| 阶段 | 职责 | 实现 |
|------|------|------|
| Discovery | 扫描 loadPaths，发现 `octopi.plugin.json` | `PluginLoader.scanDirectory()` |
| Validation | 验证 manifest 格式、contracts、依赖 | `validateManifest()` |
| Loading | 动态 `import()` 入口文件 | `PluginLoader.loadPluginFromDir()` |
| Registration | 调用 `register(api)`，收集 hooks/tools/providers | `PluginLoader.registerPlugin()` |

**Plugin 结构：**
```
my-plugin/
├── octopi.plugin.json    ← manifest（必填）
├── index.ts              ← 入口文件（必填）
└── ...
```

**PluginApi 注册能力：**

| 方法 | 说明 |
|------|------|
| `api.on(hookName, handler, opts?)` | 注册 hook handler（按 priority 降序执行） |
| `api.registerTool(definition, handler, opts?)` | 注册 Agent Tool |
| `api.registerProvider(registration)` | 注册 LLM Provider |
| `api.registerChannel(registration)` | 注册 Channel Adapter |
| `api.registerContextEngine(id, engine)` | 注册 Context Engine（排他性 slot） |
| `api.registerCommand(def)` | 注册 Command（绕过 LLM） |
| `api.registerService(service)` | 注册后台服务 |
| `api.registerWebSearchProvider(provider)` | 注册 Web Search Provider |
| `api.registerMediaUnderstandingProvider(provider)` | 注册 Media Understanding Provider |
| `api.registerImageGenerationProvider(provider)` | 注册 Image Generation Provider |
| `api.registerSpeechProvider(provider)` | 注册 Speech Provider |
| `api.registerModelCatalogProvider(catalog)` | 注册 Model Catalog |
| `api.registerMemoryEmbeddingProvider(provider)` | 注册 Memory Embedding Provider |

**Capability Ownership Model：**
- 每个 provider、channel、tool 有且仅有一个 owner
- 通过 manifest 的 `contracts` 字段声明
- 冲突检测：两个 plugin 注册同名 tool 时报错
- 排他性 Slots：某些能力类型（memory、context-engine）同一时刻只能有一个 active

### 7. Hook System — 全链路拦截

Hook 按 priority 降序执行，支持拦截语义和超时控制。

**Hook 执行模型：**
```
priority: 100 → handler_1() → 返回非 null? → 中断链，返回结果
                                   ↓ 返回 null
priority: 50  → handler_2() → 返回非 null? → 中断链，返回结果
                                   ↓ 返回 null
priority: 0   → handler_3() → 返回结果
```

**Terminal 检测：** `{ block: true }` / `{ cancel: true }` / `{ outcome: 'block' }` 立即中断

**完整 Hook 目录：**

| Hook | 类型 | 返回值 | 说明 |
|------|------|--------|------|
| `gateway_start` | 观察 | — | Gateway 启动时触发 |
| `gateway_stop` | 观察 | — | Gateway 关闭时触发 |
| `session_start` | 观察 | — | Session 创建时触发 |
| `session_end` | 观察 | — | Session 结束时触发 |
| `message_received` | 观察 | — | 收到渠道消息时触发 |
| `message_sending` | 拦截 | `{ cancel: true }` | 发送回复前触发 |
| `message_sent` | 观察 | — | 回复发送后触发 |
| `before_model_resolve` | 拦截 | `{ provider?, model? }` | 可覆盖模型 |
| `before_prompt_build` | 注入 | `{ prependContext?, systemPrompt? }` | 可注入上下文 |
| `before_agent_reply` | 拦截 | `Message` | 可返回合成回复 |
| `before_agent_finalize` | 拦截 | `{ action: 'revise' }` | 可要求修订 |
| `before_tool_call` | 拦截 | `ToolCallResult` | 可阻止/审批工具调用 |
| `after_tool_call` | 观察 | — | 工具执行后触发 |
| `agent_end` | 观察 | — | Agent 执行完成时触发 |
| `before_compaction` | 观察 | — | Context 压缩前触发 |
| `after_compaction` | 观察 | — | Context 压缩后触发 |
| `before_install` | 拦截 | `{ block: true }` | Skill/Plugin 安装前触发 |

### 8. Skill System — 两阶段加载

Skill 是 Tool 之上的结构化经验层。Tool 是原子能力，Skill 是"怎么用工具做好一件事"。

**两阶段设计（对齐 Agent Skills 标准）：**

| 阶段 | 时机 | 内容 | Token 开销 |
|------|------|------|-----------|
| 阶段 1 | 启动时 | `discover()` 扫描 SKILL.md frontmatter（name/description） | 几百 token（100 个 Skill） |
| 阶段 2 | LLM 按需 | LLM 用 read 工具读取 SKILL.md 获得完整指令 | 按需 |

**SKILL.md 格式：**
```markdown
---
name: video-frames
description: Extract frames or short clips from videos using ffmpeg
---

# 完整的 Skill 指令...
```

**输出格式（注入 system prompt）：**
```xml
<available_skills>
  <skill>
    <name>video-frames</name>
    <description>Extract frames from videos using ffmpeg</description>
  </skill>
</available_skills>

Use the read tool to load a skill file when needed.
```

**关键特性：**
- 100 个 Skill 只占 system prompt 几百 token
- 匹配精度由 LLM 判断，比触发词匹配更智能
- 支持热重载（每次从文件读取最新内容）
- `disableModelInvocation: true` 的 Skill 不注入 prompt，只能显式调用

### 9. Task System — 基于 Plugin Hook 的任务管理

任务系统通过 `TaskManagerAdvisor`（LoopAdvisor 实现）集成到 Agent Loop，在每轮迭代前判断消息意图并注入任务上下文。

**问题：** Agent 天然活在"当前对话"里，用户中途切换话题，Agent 就忘了之前的任务。

**集成方式：**

| 方式 | 接口 | 状态 |
|------|------|------|
| Plugin Hook | `TaskManagerPlugin` | ✅ 迭代级 hook 集成 |
||

**核心流程：**

```
用户消息到达
    ↓
TaskManagerPlugin.before_iteration() hook
    ↓
TaskManager (轻量 LLM) 判断消息意图
    ↓
更新任务状态 + 构建 taskContext
    ↓
返回 prependContext
    ↓
Loop 注入 taskContext 到 system prompt
    ↓
主 LLM 看到上下文，自然地继续/确认/忽略
```

**任务状态机：**
```
创建 → in_progress ──interrupt──→ interrupted ──resume──→ in_progress
                │                                      │
                │cancel                                │cancel
                ↓                                      ↓
            cancelled                              cancelled

                │complete                            │complete
                ↓                                      ↓
            completed                              completed
```

**组件：**
- **TaskTracker**: 纯状态管理，JSONL append-only 持久化
- **TaskManager**: 轻量 LLM 做消息分类（gpt-4o-mini 级别即可）

- **TaskManagerPlugin**: 通过迭代级 hook 集成

### 10. Error Classifier — 智能错误处理

7 种错误类型，各有不同的重试策略：

| 错误类型 | 可重试 | 策略 |
|---------|--------|------|
| `rate_limit` | ✅ | 尊重 Retry-After 头，exponential backoff |
| `network` | ✅ | exponential backoff + jitter |
| `timeout` | ✅ | exponential backoff |
| `server` (5xx) | ✅ | exponential backoff |
| `context_length` | ❌ | 压缩上下文后重试（不是 backoff 重试） |
| `auth` | ❌ | 不重试，直接报错 |
| `billing` | ❌ | 不重试，直接报错 |

**重试策略：** `jitteredBackoff(attempt, baseDelayMs, maxDelayMs)`
- 基础延迟 × 2^attempt
- 加 0~25% 随机抖动（防止 thundering herd）
- 尊重 rate limit 的 Retry-After 头

### 11. IterationBudget — 循环防爆

```typescript
class IterationBudget {
  consume(): boolean      // 消费一次迭代，返回是否允许
  refund(): void          // 退还一次（如程序化工具调用）
  consumeGrace(): boolean // 预算耗尽后给一次额外机会，仅一次
  reset(): void           // 重置（新 session 时）
}
```

默认预算：90 次迭代。父 Agent 的预算来自 `config.iterationBudget`。

### 12. Tool System — 全局/Agent 级工具管理

**工具优先级：** Agent 级工具 > 全局工具

**内置工具：**
- `shell` — 执行 shell 命令
- `file_read` — 读取文件
- `file_write` — 写入文件
- `file_list` — 列出目录

**ToolRegistry API：**
```typescript
registry.register(tool, agentId?);        // 注册（全局或 Agent 级）
registry.unregister(name, agentId?);      // 注销
registry.get(name, agentId?);             // 获取（Agent 级优先）
registry.listForAgent(agentId);           // 列出 Agent 可用的所有工具
registry.getDefinitionsForLLM(agentId);   // 转换为 OpenAI function calling 格式
registry.execute(name, args, context);    // 执行（含参数校验）
```

### 13. Provider System — LLM 路由

**LLMRouter** 管理多个 LLM Provider，按名称路由请求。

**已实现 Provider：**
- `OpenAIProvider` — OpenAI Chat Completions API 兼容
- `AnthropicProvider` — Anthropic Messages API

**Agent 通过 `ModelConfig` 指定 provider + model，支持 fallback。**

### 14. Memory System — 文件即记忆

设计目标：记忆不锁在数据库里，应该是人类可读可编辑的文件。

```
workspace/
├── MEMORY.md              # 长期记忆（每次启动注入）
├── memory/
│   ├── 2026-01-01.md      # 每日笔记
│   └── .dreams/           # Dreaming 短期存储
└── DREAMS.md              # Dreaming 人类审核界面
```

**三层记忆模型：**
- **MEMORY.md** — 精炼的长期记忆，每次启动注入 system prompt
- **memory/YYYY-MM-DD.md** — 每日工作记忆
- **memory_search** — 语义搜索所有记忆（需 embedding provider）

**当前状态：** 接口已定义，完整实现待开发。

### 15. Command Queue — 消息队列模式

定义了多消息并发到达时的处理策略：

| 模式 | 行为 |
|------|------|
| `steer` | 插入当前处理的下一个位置（默认） |
| `followup` | 排队等待当前处理完成 |
| `collect` | 等待更多消息后批量处理 |
| `interrupt` | 取消当前处理，立即处理新消息 |

**当前状态：** 类型已定义，完整实现待开发。

---

## 配置系统

**配置文件：** `octopi.json`（支持 `${ENV_VAR}` 环境变量替换）

```json
{
  "agents": [{
    "id": "assistant",
    "workspace": "./workspace",
    "persona": {
      "name": "Assistant",
      "description": "A helpful assistant",
      "systemPrompt": "You are a helpful assistant."
    },
    "tools": { "allow": ["*"] },
    "model": {
      "provider": "openai",
      "model": "gpt-4o"
    },
    "skillDirectory": "./skills"
  }],
  "providers": [{
    "type": "openai",
    "name": "openai",
    "apiKey": "${OPENAI_API_KEY}",
    "models": ["gpt-4o", "gpt-4o-mini"]
  }],
  "channels": [{
    "type": "http",
    "port": 3000
  }],
  "session": {
    "dmScope": "per-peer",
    "reset": {
      "dailyHour": 4,
      "idleMinutes": 60
    }
  }
}
```

---

## 测试覆盖

| 测试文件 | 覆盖模块 | 测试数 |
|----------|----------|--------|
| `loop.test.ts` | IterationBudget, ErrorClassifier, MessageConverter, runAgentLoop 集成 | 25 |
| `agent-loop.test.ts` | AgentRunner, ToolRegistry, LLMRouter, PluginManager, Gateway | 17 |
| `task-system.test.ts` | TaskTracker, TaskManager | 29 |
| `task-integration.test.ts` | TaskManagerPlugin 集成、多 Plugin 共存、并发隔离、错误恢复 | 32 |
| `skill-manager.test.ts` | DefaultSkillManager 两阶段加载 | ~10 |
| `openclaw-compat.test.ts` | OpenClaw 兼容性 | ~5 |
| `anthropic-provider.test.ts` | AnthropicProvider | ~5 |

---

## 模块实现状态

| 模块 | 状态 | 说明 |
|------|------|------|
| Core Types | ✅ 完整 | 消息、Agent、Session、Tool、Plugin、AgentEvent(28种) 等所有类型 |
| Agent Loop (新) | ✅ 完整 | AsyncIterable 三层架构、IterationBudget、ErrorClassifier、MessageConverter |
| Agent Loop (旧) | ✅ 兼容 | 旧 AgentRunner class（原 AgentLoop），保留向后兼容别名 |
| Gateway | ✅ 完整 | 消息路由、Agent 管理、Plugin 生命周期 |
| Session Manager | ✅ 完整 | CRUD、write lock、JSONL 持久化 |
| Plugin System | ✅ 完整 | 4 层加载管线、hook 执行、capability ownership |
| Skill System | ✅ 完整 | 两阶段加载、system prompt 注入、热重载 |
| Task System | ✅ 完整 | 状态机、LLM 决策器、Plugin hook 集成、applyDecision 去重 |
| Tool Registry | ✅ 完整 | 全局/Agent 级、策略、LLM 格式转换 |
| Builtin Tools | ✅ 完整 | shell、file_read、file_write、file_list |
| LLM Providers | ✅ 完整 | OpenAI + Anthropic |
| Config System | ✅ 完整 | JSON 配置 + 环境变量替换 |
| HTTP Protocol | ⚠️ 骨架 | 基础 HTTP adapter，缺 WebSocket/SSE 流式 |
| Context Engine | ⚠️ 骨架 | Legacy 只做尾部裁剪，缺 RAG/向量检索 |
| Memory System | ⚠️ 接口 | 类型和接口已定义，实现待开发 |
| Command Queue | ⚠️ 接口 | 类型已定义，实现待开发 |

---

## 与 OpenClaw 的差异

| 维度 | OpenClaw | Octopi |
|------|----------|--------|
| 定位 | 完整的 AI 助手平台 | 可嵌入的底座框架 |
| 渠道 | 内置 WhatsApp/Telegram/Slack/Feishu | 不内置，通过 ChannelAdapter 接入 |
| 部署 | 单机守护进程 | 可嵌入现有应用，也可独立部署 |
| 复杂度 | 高（生产级） | 中（框架级，应用层自由发挥） |
| 学习成本 | 需要了解整个生态 | 接口优先，渐进式采用 |
| Agent Loop | Plugin hook 驱动 | AsyncIterable 事件流 + Plugin hook |

---

## 路线图

| Phase | 模块 | 优先级 | 说明 |
|-------|------|--------|------|
| P1 | Gateway 适配新 Loop | 高 | Gateway.handleEvent 全面切换到 runAgentLoop |
| P1 | HTTP Protocol 补齐 | 高 | WebSocket/SSE 流式协议 |
| P2 | Context Engine 增强 | 高 | 消息摘要、重要性排序、RAG 集成 |
| P2 | Steering Plugin | 高 | 中途指令处理（Plugin hook 实现） |
| P3 | Memory System 落地 | 中 | 文件记忆 + 语义搜索 + Dreaming |
| P3 | Policy Plugin | 中 | 安全策略检查（Plugin hook 实现） |
| P4 | Command Queue 实现 | 中 | steer/followup/collect/interrupt |
| P5 | Multi-Agent 协调 | 低 | 命令队列 + Agent 间通信 |

---

_本文档与系统实际架构保持同步更新。代码变更时必须同步更新此文档。_
