# Octopi 🐙

**可嵌入的 Agent 底座框架** - 从 OpenClaw 提炼的核心 Agent 运行时。

> Agent 不是一个 class,而是一个完整的 scope。
> Session 不是聊天记录,而是一个完整的交互生命周期。
> Agent 需要的不是一个 API,而是一个操作系统。

---

## 为什么做 Octopi

OpenClaw 是一个完整的 AI 助手平台--内置飞书、Telegram、记忆系统、心跳调度......它很强,但也意味着:你只能用它做"AI 助手"。

我们想要的是 OpenClaw 里面那些**真正通用的东西**:

- Agent Loop(消息 → 上下文组装 → 模型推理 → 工具执行 → 回复)
- Session 管理(生命周期、持久化、并发控制)
- 多 Provider 支持(OpenAI / Anthropic / 任何兼容协议)
- Plugin 系统(每个生命周期阶段可拦截)
- 工具注册与执行

把这些抽出来,去掉所有平台绑定,就是 **Octopi**。

你可以用它做一个 CLI bot、一个 Web 应用的 AI 后端、一个嵌入式助手、一个你自己都还没想到的东西。它不预设你做什么,只负责 Agent 运行时该做的事。

## 核心理念

### 1. Agent 是一个世界,不是一段代码

一个 Agent 拥有自己的 workspace、session store、tool set、model config、persona。两个 Agent 之间完全隔离,就像两个进程。

### 2. Session 是一等公民

所有状态归 Session,不归 Agent。同一 Agent 的不同用户有独立的 Session。Session 有完整的生命周期:创建 → 活跃 → 过期 → 重建。并发通过 write lock + lane-aware queue 管理,不是简单的锁。

### 3. Context Engine 可插拔

上下文组装不是"把消息拼起来",而是一个 4 阶段生命周期:`Ingest → Assemble → Compact → AfterTurn`。每个阶段都可以被 Plugin 替换。这意味着你可以在不改 Agent Loop 的情况下,实现 RAG、记忆注入、上下文压缩等任何策略。

### 4. 协议无关,上层无感

Agent Loop 发出的是统一的 `LLMRequest`,不关心底层是 OpenAI 还是 Anthropic。Provider 层负责双向格式转换。换模型只改配置,不改代码。

### 5. Hook 覆盖全链路

8 个生命周期 hook，全部可拦截：消息到达、模型选择、prompt 构建、工具执行、回复发送、session 生命周期。不是“可选功能”，是架构的核心。

### 6. Skill 是 Tool 和 Agent 之间的桥梁

Tool 是原子能力（`file_read`, `shell`），Skill 是“怎么用工具做好一件事”。

- Tool: `shell` → Skill: “怎么用 ffmpeg 从视频抽帧”
- Tool: `file_read` → Skill: “怎么读 PDF 提取关键信息”
- Tool: `web_fetch` → Skill: “怎么抓取网页并绕过反爬”

Skill 以 Markdown 文件（`SKILL.md`）存在于 `skills/` 目录下，Context Engine 在 assemble 阶段根据用户意图自动匹配并注入上下文。每次最多激活一个 Skill，避免上下文污染。

```
skills/
├── video-frames/SKILL.md    # 视频帧提取
├── pdf-reader/SKILL.md      # PDF 阅读
└── web-scraper/SKILL.md     # 网页抓取
```

```markdown
# SKILL.md 格式
---
name: 视频帧提取
description: 从视频中使用 ffmpeg 提取关键帧
triggers: 视频, 抽帧, ffmpeg, 关键帧
tools: shell
---
# 从视频提取帧
## 使用 ffmpeg 从视频中提取关键帧
### 提取单帧（指定时间点）
```bash
ffmpeg -ss 00:01:30 -i input.mp4 -frames:v 1 output.png
```
```

Skill 匹配策略（优先级从高到低）：
1. **显式指定** — 用户消息中包含 `skill:<id>` 标记
2. **触发词匹配** — 消息包含 Skill 的 trigger 关键词
3. **描述匹配** — 关键词重叠

## 架构

```
外部消息 → Channel Adapter → Gateway → Agent Loop → LLM
                                  ↓
                            Session Manager
                                  ↓
                            Channel Adapter → 外部回复
```

核心循环:`intake → context assemble → model infer → tool exec → streaming reply → persistence`

```
┌──────────────────────────────────────────────────────────┐
│                     Gateway (守护进程)                     │
│                                                          │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────┐  │
│  │  Channel    │  │  Session   │  │  Command Queue     │  │
│  │  Router     │  │  Manager   │  │  (Lane-aware FIFO) │  │
│  └─────┬──────┘  └─────┬──────┘  └────────┬───────────┘  │
│        │               │                   │              │
│  ┌─────▼───────────────▼───────────────────▼───────────┐  │
│  │                  Agent Loop                          │  │
│  │  intake → assemble → infer → tools → reply → save   │  │
│  └──────────┬──────────────────────────┬───────────────┘  │
│             │                          │                  │
│  ┌──────────▼────────┐  ┌──────────────▼───────────────┐  │
│  │  Context Engine    │  │  Plugin System               │  │
│  │  (4阶段生命周期)    │  │  (8个Hook点,全部可拦截)      │  │
│  └────────────────────┘  └──────────────────────────────┘  │
│                                                          │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────┐  │
│  │  Tool       │  │  LLM       │  │  Skill             │  │
│  │  Registry   │  │  Router    │  │  Manager           │  │
│  └────────────┘  └────────────┘  └────────────────────┘  │
│                                                          │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  Multi-Agent Runtime                                  │ │
│  │  ┌──────┐ ┌──────┐ ┌──────┐                         │ │
│  │  │Agent1│ │Agent2│ │Agent3│  ← 完全隔离              │ │
│  │  └──────┘ └──────┘ └──────┘                         │ │
│  └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

## 快速开始

```bash
npm install
npm run build
```

### 配置

```bash
cp octopi.example.json octopi.json
```

编辑 `octopi.json`,设置 LLM Provider:

```json
{
  "providers": [
    {
      "type": "openai",
      "name": "openai",
      "apiKey": "sk-your-key-here",
      "models": ["gpt-4o", "gpt-4o-mini"]
    },
    {
      "type": "anthropic",
      "name": "anthropic",
      "apiKey": "sk-ant-your-key-here",
      "models": ["claude-sonnet-4-20250514", "claude-haiku-4-20250414"]
    }
  ]
}
```

也支持任何 OpenAI 兼容 endpoint(vLLM、Ollama、LiteLLM 等)。

### 启动

```bash
# Gateway 服务
npx octopi serve

# 交互式聊天
npx octopi chat

# 健康检查
npx octopi health
```

### 作为库使用

```typescript
import { AgentLoop, OpenAIProvider, getBuiltinTools } from 'octopi';

const loop = new AgentLoop();
loop.registerProvider(new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  models: ['gpt-4o'],
}));

for (const tool of getBuiltinTools()) {
  loop.registerTool(tool);
}

const agent = {
  id: 'my-agent',
  workspace: './workspace',
  persona: {
    name: 'Assistant',
    systemPrompt: 'You are a helpful assistant.',
  },
  tools: { allow: ['*'] },
  model: { provider: 'openai', model: 'gpt-4o' },
};

const session = loop.resolveSession(agent, message, 'per-peer');
const reply = await loop.processMessage(agent, session, message);
```

## 核心概念

### Agent Definition

每个 Agent 是一个完全独立的隔离单元:

```typescript
interface AgentDefinition {
  id: string;
  workspace: string;          // 文件系统路径(persona、记忆、技能)
  persona: {
    name: string;
    systemPrompt: string;
  };
  tools: {
    allow: string[];           // 白名单(["*"] = 全部)
    deny: string[];            // 黑名单
    requireConfirmation: string[];
  };
  model: {
    provider: string;
    model: string;
    fallbacks?: string[];
  };
}
```

### Session 管理

- **Write Lock** - 同一 session 同时只有一个 Agent Loop 在运行
- **Per-Peer 隔离** - 每个发送者独立 session
- **自动过期** - 24h daily reset + 2h idle reset
- **JSONL 持久化** - 对话记录持久化到磁盘,人类可读

### Context Engine

4 阶段生命周期,每阶段可被 Plugin 替换:

| 阶段 | 时机 | 职责 |
|------|------|------|
| **Ingest** | 新消息到达 | 消息入库 |
| **Assemble** | LLM 调用前 | 组装上下文(裁剪、注入、token 预算) |
| **Compact** | 上下文溢出 | 压缩旧历史 |
| **AfterTurn** | 一轮完成 | 持久化状态 |

### Plugin 系统

8 个 hook,全部可拦截:

| Hook | 返回值 | 语义 |
|------|--------|------|
| `message_received` | - | 消息到达通知 |
| `session_start` | - | 新 session 创建 |
| `before_agent_reply` | Message \| null | 拦截:返回合成回复 |
| `before_model_resolve` | { model } \| null | 覆盖模型选择 |
| `before_prompt_build` | { prependContext } \| null | 注入额外上下文 |
| `before_tool_call` | { block } \| null | 拦截:阻止工具执行 |
| `after_tool_call` | - | 工具执行完成 |
| `message_sending` | { cancel } \| null | 拦截:取消回复发送 |

### 多协议 LLM

```
AgentLoop → LLMRequest(统一格式)→ LLMRouter → Provider → LLM API
```

| 协议 | type | 适用场景 |
|------|------|----------|
| OpenAI Chat Completions | `openai` | OpenAI、vLLM、Ollama、LiteLLM 等 |
| Anthropic Messages | `anthropic` | Claude 系列模型 |

### 内置工具

| 工具 | 功能 |
|------|------|
| `shell` | 执行 shell 命令 |
| `file_read` | 读取文件内容 |
| `file_write` | 写入文件内容 |
| `file_list` | 列出目录内容 |

## 测试

```bash
npm test
```

27 个测试覆盖所有核心模块。

## 与 OpenClaw 的关系

| 维度 | OpenClaw | Octopi |
|------|----------|--------|
| 定位 | 完整的 AI 助手平台 | 可嵌入的 Agent 底座框架 |
| 渠道 | 内置飞书/Telegram/Slack... | 不内置,通过 Channel Adapter 接入 |
| 记忆 | 内置 Dreaming/RAG/Memory | 接口预留,实现自由选择 |
| 部署 | 单机守护进程 | 可嵌入现有应用,也可独立运行 |
| 目标用户 | 终端用户 | 开发者 |

OpenClaw 是 Octopi 的"参考实现"和"灵感来源"。Octopi 从 OpenClaw 学到了 Session 一等公民、Context Engine 可插拔、Hook 覆盖全链路等核心设计理念,但只保留通用的 Agent 运行时。

## License

MIT
