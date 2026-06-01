# Agent Harness

**可嵌入的 Agent 底座框架** — 把 OpenClaw 的底层 Agent 运行时抽象为通用框架。

不包含任何平台功能（飞书、认知记忆、心跳系统等），只保留核心 Agent 能力。

## 架构

```
外部消息 → Channel Adapter → Gateway → Agent Loop → LLM
                                  ↓
                            Session Manager
                                  ↓
                            Channel Adapter → 外部回复
```

核心流程：`intake → context assemble → model infer → tool exec → streaming reply → persistence`

### 目录结构

```
src/
├── core/types.ts          # 全部接口和类型定义
├── gateway/gateway.ts     # 核心守护进程（Channel 路由 + Agent 编排）
├── agent/
│   ├── agent-loop.ts      # 核心执行循环
│   └── session-manager.ts # Session 生命周期 + 持久化
├── context/engine.ts      # 默认上下文引擎（Legacy）
├── tools/
│   ├── registry.ts        # 工具注册中心
│   └── builtin.ts         # 内置工具（shell, file_read/write/list）
├── providers/
│   ├── router.ts          # LLM 路由器
│   └── openai.ts          # OpenAI 兼容 Provider
├── plugins/hooks.ts       # 插件系统
├── protocol/http.ts       # HTTP Channel Adapter
├── config.ts              # 配置系统
└── cli.ts                 # CLI 入口
```

## 快速开始

### 安装

```bash
npm install
```

### 配置

复制示例配置：

```bash
cp agent-harness.example.json agent-harness.json
```

编辑 `agent-harness.json`，设置你的 API Key：

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

支持两种 LLM 协议（参考 OpenClaw 实现）：

| 协议 | `type` | 端点 | 认证方式 | 适用场景 |
|------|--------|------|----------|----------|
| OpenAI Chat Completions | `openai` | `/v1/chat/completions` | `Authorization: Bearer` | OpenAI、自定义兼容 endpoint（vLLM、LiteLLM 等） |
| Anthropic Messages | `anthropic` | `/v1/messages` | `x-api-key` | Claude 系列模型 |

配置中的 `type` 字段决定使用哪个协议适配器。框架自动处理两种协议之间的格式转换（system prompt 提取、工具格式映射等），上层 AgentLoop 无需感知差异。

### 使用 CLI

```bash
# 编译
npm run build

# 启动 Gateway 服务
npx agent-harness serve

# 交互式聊天
npx agent-harness chat

# 健康检查
npx agent-harness health
```

### 作为库使用

```typescript
import { AgentLoop, OpenAIProvider, getBuiltinTools } from 'agent-harness';

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
    description: 'A helpful assistant',
    systemPrompt: 'You are a helpful assistant.',
  },
  tools: { allow: ['*'] },
  model: { provider: 'openai', model: 'gpt-4o' },
};

const msg = {
  id: 'msg-1',
  channel: 'cli',
  senderId: 'user',
  senderName: 'User',
  content: 'Hello!',
  conversationId: 'conv-1',
  timestamp: Date.now(),
};

const session = loop.resolveSession(agent, msg, 'per-peer');
const reply = await loop.processMessage(agent, session, msg);
console.log(reply.content);
```

## 核心概念

### 多协议 LLM 支持

框架通过 Provider 抽象层支持不同的 LLM 协议，每个协议有独立的适配器：

```
AgentLoop
  ↓ LLMRequest（统一格式）
LLMRouter
  ↓ 路由到目标 Provider
Provider（openai | anthropic）
  ↓ 格式转换
LLM API（/v1/chat/completions | /v1/messages）
```

每个 Provider 内部负责双向格式转换：
- **OpenAI Provider**: 直接使用 OpenAI 格式，无需转换
- **Anthropic Provider**: 将 system prompt 提取为顶层字段，工具定义从 `parameters` 转为 `input_schema`，响应从 `content[]` 数组转回统一格式

这样 AgentLoop 和所有上层逻辑完全不需要关心底层协议差异。

### Agent Definition

每个 Agent 是一个完全独立的隔离单元：

```typescript
interface AgentDefinition {
  id: string;
  workspace: string;
  persona: {
    name: string;
    systemPrompt: string;
  };
  tools: {
    allow: string[];    // 白名单（["*"] = 全部）
    deny: string[];     // 黑名单
    requireConfirmation: string[];  // 需要确认的工具
  };
  model: {
    provider: string;
    model: string;
    fallbacks?: string[];
  };
}
```

### Session 管理

- **Write Lock**: 同一 session 同时只有一个 Agent Loop 在运行
- **Per-Peer 隔离**: 每个发送者独立 session
- **自动过期**: 24h daily reset + 2h idle reset
- **JSONL 持久化**: 对话记录持久化到磁盘

### Plugin 系统

8 个生命周期 hook，全部可拦截：

| Hook | 返回值 | 语义 |
|------|--------|------|
| `message_received` | - | 消息到达通知 |
| `session_start` | - | 新 session 创建 |
| `before_agent_reply` | Message \| null | 拦截：返回合成回复 |
| `before_model_resolve` | { model } \| null | 覆盖模型选择 |
| `before_prompt_build` | { prependContext } \| null | 注入额外上下文 |
| `before_tool_call` | { block } \| null | 拦截：阻止工具执行 |
| `after_tool_call` | - | 工具执行完成 |
| `message_sending` | { cancel } \| null | 拦截：取消回复发送 |

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

19 个测试覆盖所有核心模块：ToolRegistry、LLMRouter、PluginManager、AgentLoop、Gateway。

## 设计原则

1. **平台无关** — 不含飞书、Telegram 等具体实现
2. **可嵌入** — 既可以独立运行，也可以作为库嵌入
3. **LLM 无关** — 通过 Provider 抽象支持任何 LLM
4. **Channel 无关** — 通过 Channel Adapter 支持任何通信渠道
5. **可观测** — 全链路事件流，plugin 可拦截每个阶段

## License

MIT
