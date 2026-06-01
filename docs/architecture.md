# Octopi — 架构设计文档 v2

> 参考 OpenClaw 架构，重新设计的可嵌入 Agent 底座框架

## 核心设计原则（从 OpenClaw 学到的）

1. **Gateway 模式** — 单一长驻守护进程，拥有所有通信面
2. **Session 是一等公民** — 所有状态归 Session，不是归 Agent
3. **Context Engine 可插拔** — 上下文组装不是写死的，是 4 阶段生命周期
4. **Lane-aware Queue** — 并发不是简单的锁，是按 lane 的 FIFO + steering
5. **Plugin Hooks 无处不在** — 每个生命周期阶段都可以拦截
6. **Markdown 即记忆** — 记忆是文件，不是数据库里的 blob

## 整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                    Application Layer                          │
│   (你的应用: Web App / CLI / Bot / 嵌入式)                   │
└──────────────────────────┬───────────────────────────────────┘
                           │ Protocol (HTTP / WebSocket / RPC)
┌──────────────────────────▼───────────────────────────────────┐
│                    Gateway (核心守护进程)                      │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  Channel      │  │  Session     │  │  Command Queue     │  │
│  │  Router       │  │  Manager     │  │  (Lane-aware FIFO) │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬───────────┘  │
│         │                 │                    │              │
│  ┌──────▼─────────────────▼────────────────────▼───────────┐  │
│  │                   Agent Loop                              │  │
│  │  intake → context assemble → model infer → tool exec     │  │
│  │       → streaming reply → persistence                    │  │
│  └──────────────┬──────────────────────┬───────────────────┘  │
│                 │                      │                      │
│  ┌──────────────▼───────┐  ┌───────────▼──────────────────┐  │
│  │  Context Engine      │  │  Plugin System               │  │
│  │  (Ingest/Assemble/   │  │  (Hooks at every lifecycle)  │  │
│  │   Compact/AfterTurn) │  │                              │  │
│  └──────────────────────┘  └──────────────────────────────┘  │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  Tool         │  │  LLM         │  │  Memory            │  │
│  │  Registry     │  │  Router      │  │  System            │  │
│  └──────────────┘  └──────────────┘  └────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  Multi-Agent Runtime                                      │ │
│  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                    │ │
│  │  │Agent1│ │Agent2│ │Agent3│ │SubAg.│                     │ │
│  │  └──────┘ └──────┘ └──────┘ └──────┘                     │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

## 核心概念

### 1. Gateway — 不是 API Server，是 Agent 的操作系统

OpenClaw 的关键洞察：Agent 需要的不是 "一个 API"，而是 "一个操作系统"。

Gateway 职责：
- 拥有所有通信面（channel adapters）
- 管理所有 Agent 的生命周期
- 维护 session 状态
- 执行 command queue
- 运行 plugin hooks

```typescript
interface Gateway {
  // 生命周期
  start(): Promise<void>;
  stop(): Promise<void>;

  // Agent 管理
  registerAgent(agent: AgentDefinition): void;
  getAgent(id: string): AgentDefinition | undefined;

  // Channel 管理
  registerChannel(adapter: ChannelAdapter): void;

  // 运行时
  send(params: SendParams): Promise<SendResult>;
}
```

### 2. Agent — 不是一个 class，是一个完整的 scope

OpenClaw 的关键洞察：Agent 不是 "一段代码"，而是 "一个有自己记忆、工具、人格的独立实体"。

每个 Agent 拥有：
- **Workspace** — 文件目录（persona 文件、记忆、技能）
- **Session Store** — 自己的会话历史
- **Tool Set** — 自己可用的工具集
- **Model Config** — 自己的模型配置
- **Context Engine** — 自己的上下文组装策略

```typescript
interface AgentDefinition {
  id: string;
  workspace: string;          // 文件系统路径
  persona: AgentPersona;
  tools: ToolPolicy;          // 工具白名单/黑名单
  model: ModelConfig;
  contextEngine?: string;     // 可选：自定义上下文引擎
}
```

### 3. Session — 对话的完整生命周期

OpenClaw 的关键洞察：Session 不是 "聊天记录"，而是 "一个完整的交互生命周期"。

```typescript
interface Session {
  id: string;
  agentId: string;
  channelId: string;          // 来源渠道
  peerId: string;             // 对话方标识

  // 生命周期
  status: SessionStatus;
  createdAt: number;
  sessionStartedAt: number;   // 当前 session 开始时间（用于 daily reset）
  lastInteractionAt: number;  // 最后一次用户交互（用于 idle reset）

  // 状态
  transcript: Transcript;     // JSONL 格式的完整对话记录
  context: ContextState;      // 当前上下文窗口状态
}
```

**Session 隔离策略**（从 OpenClaw 学到）：
- DM 默认共享一个 session（单用户场景）
- 多用户时用 `per-channel-peer` 隔离
- Group chat 天然隔离

**Session 生命周期**：
- Daily reset — 每天凌晨 4 点自动新建 session
- Idle reset — N 分钟无交互自动新建
- Manual reset — 用户 `/new` 命令

### 4. Context Engine — Agent 的大脑组装器

OpenClaw 的关键洞察：上下文组装不是 "把消息拼起来"，而是一个 4 阶段生命周期。

```
Ingest（新消息入库）
  ↓
Assemble（模型调用前，组装上下文）
  ↓
Compact（上下文满了，压缩旧历史）
  ↓
After Turn（一轮完成，持久化状态）
```

每个阶段都可以被 Plugin 替换！

```typescript
interface ContextEngine {
  info: { id: string; name: string; ownsCompaction: boolean };

  // 1. 新消息到达
  ingest(params: { sessionId: string; message: Message }): Promise<void>;

  // 2. 组装模型上下文（在每次 LLM 调用前）
  assemble(params: {
    sessionId: string;
    messages: Message[];
    tokenBudget: number;
    availableTools: string[];
  }): Promise<AssembleResult>;

  // 3. 压缩（上下文满了或用户手动触发）
  compact(params: {
    sessionId: string;
    force: boolean;
  }): Promise<CompactResult>;

  // 4. 一轮完成后
  afterTurn(params: {
    sessionId: string;
    turn: Turn;
  }): Promise<void>;
}
```

### 5. Command Queue — 并发不是简单的锁

OpenClaw 的关键洞察：多个消息同时到达时，不是简单排队，而是有策略的。

```
Queue Modes:
- steer:     注入到正在运行的 agent（不中断）
- followup:  排队等当前运行结束
- collect:   合并多条消息为一次调用
- interrupt: 中断当前运行，执行最新的
```

```typescript
interface CommandQueue {
  // 入队
  enqueue(sessionKey: string, params: QueueParams): void;

  // 设置模式
  setMode(sessionKey: string, mode: QueueMode): void;
}

type QueueMode = 'steer' | 'followup' | 'collect' | 'interrupt';
```

### 6. Memory System — 文件即记忆

OpenClaw 的关键洞察：记忆不应该锁在数据库里，应该是人类可读可编辑的文件。

```
workspace/
├── MEMORY.md              # 长期记忆（每次启动加载）
├── memory/
│   ├── 2026-01-01.md      # 每日笔记
│   ├── 2026-01-02.md
│   └── .dreams/           # Dreaming 短期存储
└── DREAMS.md              # Dreaming 人类审核界面
```

**三层记忆模型**：
- **MEMORY.md** — 精炼的长期记忆，每次启动注入
- **memory/YYYY-MM-DD.md** — 每日工作记忆
- **memory_search** — 语义搜索所有记忆

**Dreaming 机制**（从 OpenClaw 学到）：
- 后台定期运行
- 从短期记忆中筛选有价值的内容
- 只有通过评分门限的才晋升到 MEMORY.md
- 晋升过程写入 DREAMS.md 供人类审核

### 7. Plugin System — 一切皆可插拔

OpenClaw 的关键洞察：Hook 不是 "可选功能"，是架构的核心。

```typescript
interface PluginHooks {
  // 模型调用前
  before_model_resolve(params): Promise<ModelOverride | null>;
  before_prompt_build(params): Promise<PromptInjection | null>;
  before_agent_reply(params): Promise<Reply | null>;

  // 工具调用
  before_tool_call(params): Promise<{ block: boolean } | null>;
  after_tool_call(params): Promise<void>;

  // 消息生命周期
  message_received(params): Promise<void>;
  message_sending(params): Promise<{ cancel: boolean } | null>;
  message_sent(params): Promise<void>;

  // Session 生命周期
  session_start(params): Promise<void>;
  session_end(params): Promise<void>;
}
```

### 8. Multi-Agent — 每个 Agent 是独立的世界

OpenClaw 的关键洞察：多 Agent 不是 "多个实例"，而是 "多个完全隔离的世界"。

```
┌─ Gateway ─────────────────────────────────────────┐
│                                                    │
│  ┌─ Agent A ──────────┐  ┌─ Agent B ──────────┐   │
│  │ workspace: /a/     │  │ workspace: /b/     │   │
│  │ sessions: a/*.jsonl│  │ sessions: b/*.jsonl│   │
│  │ tools: [web,exec]  │  │ tools: [web]       │   │
│  │ model: gpt-4o      │  │ model: claude-3    │   │
│  └────────────────────┘  └────────────────────┘   │
│                                                    │
│  Channel Bindings:                                 │
│  - feishu:user1 → Agent A                         │
│  - telegram:group1 → Agent B                      │
│  - feishu:user2 → Agent A                         │
└────────────────────────────────────────────────────┘
```

## Agent Loop 详细流程

```
1. 消息到达 (Channel Adapter)
   ↓
2. Channel Router → 路由到正确的 Agent + Session
   ↓
3. Command Queue → 检查当前 session 是否有运行中的任务
   ├─ steer: 注入到当前运行
   ├─ followup: 排队
   ├─ collect: 合并
   └─ interrupt: 中断当前运行
   ↓
4. Session 准备
   ├─ 获取 session write lock
   ├─ 加载 session 状态
   └─ 准备 workspace
   ↓
5. Context Engine: Assemble
   ├─ 加载 system prompt (persona + workspace files)
   ├─ 注入 memory context
   ├─ 组装对话历史（token budget 裁剪）
   └─ 注入 plugin 的 systemPromptAddition
   ↓
6. LLM Router → 选择 provider + model
   ↓
7. Plugin: before_agent_reply → 可以拦截并返回合成回复
   ↓
8. LLM 调用（流式）
   ├─ 流式输出 → Channel Adapter 实时推送
   └─ 如果有 tool_calls → 进入工具执行
   ↓
9. 工具执行
   ├─ Plugin: before_tool_call → 可以拦截
   ├─ 执行工具
   ├─ Plugin: after_tool_call → 后处理
   └─ 将结果加入上下文，回到步骤 5
   ↓
10. 回复完成
    ├─ Plugin: message_sending → 可以取消
    ├─ 发送到 Channel
    ├─ Plugin: message_sent
    └─ Context Engine: afterTurn
   ↓
11. 持久化
    ├─ 写入 session transcript (JSONL)
    ├─ 更新 session metadata
    └─ 释放 session write lock
```

## 目录结构

```
octopi/
├── src/
│   ├── core/                 # 核心类型和接口
│   │   ├── types.ts          # 所有类型定义
│   │   └── index.ts
│   ├── gateway/              # Gateway 守护进程
│   │   ├── gateway.ts        # Gateway 主类
│   │   ├── channel-router.ts # 消息路由
│   │   └── command-queue.ts  # Lane-aware 命令队列
│   ├── agent/                # Agent 运行时
│   │   ├── agent-loop.ts     # 核心循环
│   │   ├── session-manager.ts# Session 管理
│   │   └── transcript.ts     # JSONL 持久化
│   ├── context/              # 上下文引擎
│   │   ├── engine.ts         # ContextEngine 接口 + legacy 实现
│   │   ├── compaction.ts     # 压缩策略
│   │   └── prompt-builder.ts # System prompt 组装
│   ├── tools/                # 工具系统
│   │   ├── registry.ts       # 工具注册中心
│   │   ├── policy.ts         # 工具策略（白名单/黑名单/沙箱）
│   │   └── executor.ts       # 工具执行器
│   ├── memory/               # 记忆系统
│   │   ├── file-memory.ts    # 基于文件的记忆（MEMORY.md + daily notes）
│   │   ├── search.ts         # 语义搜索
│   │   └── dreaming.ts       # 后台巩固
│   ├── providers/            # LLM Provider
│   │   ├── router.ts         # Provider 路由
│   │   └── openai.ts         # OpenAI 兼容实现
│   ├── plugins/              # 插件系统
│   │   ├── hooks.ts          # Hook 注册与执行
│   │   ├── plugin-loader.ts  # 插件加载
│   │   └── plugin-api.ts     # 插件 API
│   ├── protocol/             # 通信协议
│   │   ├── http.ts           # HTTP API
│   │   └── websocket.ts      # WebSocket（可选）
│   └── index.ts              # 统一导出
├── config/
│   └── default.json          # 默认配置
├── docs/
│   └── architecture.md       # 本文档
└── tests/
```

## 与 OpenClaw 的差异

| 维度 | OpenClaw | Octopi |
|------|----------|---------------|
| 定位 | 完整的 AI 助手平台 | 可嵌入的底座框架 |
| 渠道 | 内置 WhatsApp/Telegram/Slack... | 不内置，通过 Channel Adapter 接入 |
| 部署 | 单机守护进程 | 可嵌入现有应用，也可独立部署 |
| 复杂度 | 高（生产级） | 中（框架级，应用层自由发挥） |
| 学习成本 | 需要了解整个生态 | 接口优先，渐进式采用 |

## 下一步

1. **Phase 1**: 核心类型 + Agent Loop + Session（当前骨架的重构）
2. **Phase 2**: Context Engine + Memory System
3. **Phase 3**: Plugin System + Hook 点
4. **Phase 4**: Command Queue + Multi-Agent
5. **Phase 5**: Protocol Layer (HTTP/WebSocket)
