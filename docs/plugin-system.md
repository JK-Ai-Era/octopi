# Plugin System

Octopi 的 Plugin 系统完全对齐 [OpenClaw Plugin Architecture](https://docs.openclaw.ai/plugins)，提供声明式能力注册、全生命周期 hook 拦截、以及标准化的加载流程。

---

## 目录

- [架构概览](#架构概览)
- [快速开始](#快速开始)
- [Plugin 结构](#plugin-结构)
- [PluginApi 详解](#pluginapi-详解)
- [Hook 系统](#hook-系统)
- [Capability Ownership Model](#capability-ownership-model)
- [Plugin 加载流程](#plugin-加载流程)
- [配置系统](#配置系统)
- [完整示例](#完整示例)
- [子路径导出](#子路径导出)
- [API 参考](#api-参考)

---

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    PluginManager                        │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │PluginLoader  │  │ HookRunner   │  │  Capability   │  │
│  │ discovery    │  │ priority     │  │  Registry     │  │
│  │ validation   │  │ timeout      │  │  ownership    │  │
│  │ loading      │  │ intercept    │  │  conflict     │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                │                   │          │
│  ┌──────▼─────────────────▼───────────────────▼──────┐  │
│  │                   LoadedPlugin                    │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐    │  │
│  │  │ Manifest │  │ PluginApi│  │  Entry (TS)  │    │  │
│  │  │ (.json)  │  │ (hooks,  │  │  definePlugin│    │  │
│  │  │          │  │  tools,  │  │  Entry()     │    │  │
│  │  │          │  │  providers│ │              │    │  │
│  │  └──────────┘  └──────────┘  └──────────────┘    │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 4 层加载管线

| 阶段 | 职责 | 对齐 OpenClaw |
|------|------|--------------|
| **Discovery** | 扫描 loadPaths，发现 `octopi.plugin.json` | Plugin Discovery |
| **Validation** | 验证 manifest 格式、contracts、依赖 | Manifest Validation |
| **Loading** | 动态 `import()` 入口文件，获取 plugin 定义 | Module Loading |
| **Registration** | 调用 `register(api)`，收集 hooks/tools/providers | Registration Phase |

### 核心设计原则

1. **Manifest 先行** — 不执行代码就能读取元数据
2. **Capability Ownership** — 每个能力有且仅有一个 owner
3. **Hook 拦截语义** — 返回非 null 中断后续 handlers
4. **Priority 排序** — 数字越大越先执行

---

## 快速开始

### 1. 创建 Plugin 目录

```
my-plugins/
  tool-preflight/
    octopi.plugin.json    ← manifest（必填）
    index.ts              ← 入口文件（必填）
```

### 2. 编写 Manifest

```json
{
  "id": "tool-preflight",
  "name": "Tool Preflight",
  "description": "拦截并验证 tool 调用",
  "version": "1.0.0",
  "configSchema": {
    "type": "object",
    "properties": {
      "blockedTools": {
        "type": "array",
        "items": { "type": "string" }
      }
    }
  }
}
```

### 3. 编写入口文件

```ts
// index.ts
import { definePluginEntry } from 'octopi/plugin-sdk/plugin-entry';

export default definePluginEntry({
  id: 'tool-preflight',
  name: 'Tool Preflight',
  description: '拦截并验证 tool 调用',

  register(api) {
    const blockedTools = (api.pluginConfig.blockedTools as string[]) ?? [];

    api.on('before_tool_call', async (event: any) => {
      if (blockedTools.includes(event.toolName)) {
        return { block: true, blockReason: 'Blocked by policy' };
      }
      return null; // 放行
    }, { priority: 50 });
  },
});
```

### 4. 加载 Plugin

```ts
import { PluginManager } from 'octopi/plugins/manager';

const pm = new PluginManager({
  loadPaths: ['/path/to/my-plugins'],
});

const plugins = await pm.discover();
console.log(`Loaded ${plugins.length} plugins`);

// 在 AgentLoop 中使用
const result = await pm.runHook('before_tool_call', event, null);
```

---

## Plugin 结构

每个 Plugin 由两部分组成：

### Manifest (`octopi.plugin.json`)

声明式元数据，框架在不执行代码的情况下就能读取。

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "What this plugin does",
  "version": "1.0.0",
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string" },
      "enabled": { "type": "boolean", "default": true }
    }
  },
  "contracts": {
    "tools": ["my_custom_tool"],
    "providers": ["my-llm-provider"]
  },
  "activation": {
    "onStartup": true
  }
}
```

**必填字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | Plugin 唯一标识 |
| `configSchema` | JSON Schema | 配置结构描述（即使无配置也要传 `{}`） |

**常用可选字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 人类可读名称 |
| `description` | string | 简短描述 |
| `version` | string | 语义化版本 |
| `contracts` | object | 能力声明（见 [Capability Ownership](#capability-ownership-model)） |
| `activation` | object | 激活条件（见 [激活配置](#激活配置)） |
| `requiresPlugins` | string[] | 依赖的其他 plugin IDs |

### 入口文件 (`index.ts`)

使用 `definePluginEntry()` 创建 plugin 定义，default export。

```ts
import { definePluginEntry } from 'octopi/plugin-sdk/plugin-entry';

export default definePluginEntry({
  id: 'my-plugin',
  name: 'My Plugin',
  description: 'What this plugin does',

  register(api) {
    // 通过 api 注册各种能力
    api.on('gateway_start', async () => {
      api.logger.info('Plugin initialized');
    });
  },
});
```

---

## PluginApi 详解

`PluginApi` 是 `register()` 回调中接收的 api 对象。Plugin 通过它注册所有能力。

### 属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `id` | string | Plugin ID |
| `name` | string | Plugin 名称 |
| `version` | string? | Plugin 版本 |
| `description` | string? | Plugin 描述 |
| `source` | string | 入口文件路径 |
| `rootDir` | string? | Plugin 根目录 |
| `pluginConfig` | Record<string, unknown> | 用户配置（来自 config.json） |
| `logger` | PluginLogger | 带前缀的 logger |

### 注册方法

#### `api.on(hookName, handler, opts?)`

注册 hook handler。Hook 按 priority 降序执行。

```ts
api.on('before_tool_call', async (event) => {
  // 拦截逻辑
  return null; // 放行
}, { priority: 50, timeoutMs: 5000 });
```

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `hookName` | string | Hook 名称（见 [Hook 系统](#hook-系统)） |
| `handler` | (event) => Promise | Handler 函数 |
| `opts.priority` | number | 优先级，数字越大越先执行（默认 0） |
| `opts.timeoutMs` | number | 单个 handler 超时毫秒数（默认 30000） |

#### `api.registerTool(definition, handler, opts?)`

注册 Agent Tool。

```ts
api.registerTool(
  {
    name: 'web_search',
    description: 'Search the web',
    parameters: {
      query: { type: 'string', description: 'Search query', required: true },
    },
  },
  async (args, ctx) => {
    return `Results for: ${args.query}`;
  },
  { optional: false },
);
```

#### `api.registerProvider(registration)`

注册 LLM Provider。

```ts
api.registerProvider({
  id: 'my-llm',
  provider: {
    name: 'my-llm',
    models: ['my-model-v1'],
    async complete(request) {
      return { content: 'response', model: 'my-model-v1', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    },
  },
});
```

#### `api.registerChannel(registration)`

注册 Channel Adapter。

```ts
api.registerChannel({
  id: 'my-channel',
  adapter: {
    name: 'my-channel',
    async send(reply) { /* ... */ },
    async receive(handler) { /* ... */ },
  },
});
```

#### `api.registerContextEngine(id, engine)`

注册 Context Engine（exclusive slot — 同一时刻只有一个 active）。

#### `api.registerCommand(def)`

注册 Command（绕过 LLM，直接执行）。

```ts
api.registerCommand({
  name: 'clear',
  description: '清除 session 历史',
  handler: async (event) => {
    // 清除逻辑
  },
});
```

#### `api.registerService(service)`

注册后台服务（Gateway 启动时 start，关闭时 stop）。

```ts
api.registerService({
  id: 'health-checker',
  start: async () => { /* 启动健康检查 */ },
  stop: async () => { /* 停止健康检查 */ },
});
```

#### `api.resolvePath(relativePath)`

解析相对于 plugin root 的路径。

```ts
const configPath = api.resolvePath('./config/default.json');
```

### Logger

`api.logger` 提供带前缀的日志输出：

```ts
api.logger.debug('调试信息');
api.logger.info('运行信息');
api.logger.warn('警告');
api.logger.error('错误');
// 输出: [plugin:my-plugin] 运行信息
```

---

## Hook 系统

### Hook 执行模型

```
Handler 按 priority 降序执行

  priority: 100 ──→ handler_1()
                        │
                   返回非 null? ──→ 中断链，返回结果
                        │
                   返回 null ──→ 继续
                        ▼
  priority: 50  ──→ handler_2()
                        │
                   返回非 null? ──→ 中断链，返回结果
                        │
                   返回 null ──→ 继续
                        ▼
  priority: 0   ──→ handler_3()
                        │
                   返回结果
                        ▼
                   使用 defaultResult
```

**关键规则：**

- **拦截语义**：handler 返回 `null` / `undefined` → 继续执行下一个 handler
- **拦截语义**：handler 返回非 null 值 → 中断链，该值作为最终结果
- **Terminal 检测**：返回 `{ block: true }` / `{ cancel: true }` / `{ outcome: 'block' }` 时立即中断，跳过后续 handlers
- **超时**：单个 handler 超时会被捕获，不影响后续 handlers
- **异常**：单个 handler 抛出异常会被捕获，不影响后续 handlers

### Hook 分类

| Hook | 类型 | 返回值 | 说明 |
|------|------|--------|------|
| `gateway_start` | 观察 | — | Gateway 启动时触发 |
| `gateway_stop` | 观察 | — | Gateway 关闭时触发 |
| `session_start` | 观察 | — | Session 创建时触发 |
| `session_end` | 观察 | — | Session 结束时触发 |
| `message_received` | 观察 | — | 收到渠道消息时触发 |
| `message_sending` | 拦截 | `{ cancel: true }` | 发送回复前触发 |
| `message_sent` | 观察 | — | 回复发送后触发 |
| `before_model_resolve` | 拦截 | `{ provider?, model? }` | LLM 调用前，可覆盖模型 |
| `before_prompt_build` | 注入 | `{ prependContext?, systemPrompt? }` | Prompt 构建前（runAgentLoop），可注入上下文 |
| `before_agent_run` | 拦截 | `{ outcome: 'block', message? }` | Agent 执行前，可阻止 |
| `before_agent_reply` | 拦截 | `Message` | LLM 回复前，可返回合成回复 |
| `before_agent_finalize` | 拦截 | `{ action: 'revise' }` | 回复定稿前，可要求修订 |
| `before_tool_call` | 拦截 | `ToolCallResult` | Tool 执行前，可阻止/审批 |
| `after_tool_call` | 观察 | — | Tool 执行后触发 |
| `agent_end` | 观察 | — | Agent 执行完成时触发 |
| `before_compaction` | 观察 | — | Context 压缩前触发 |
| `after_compaction` | 观察 | — | Context 压缩后触发 |
| `before_install` | 拦截 | `{ block: true }` | Skill/Plugin 安装前触发 |

### Hook 执行位置架构

Hook 按执行位置分为两类：

**Gateway 级 Hook**（在 `agent-runner.ts` 中调用）

这些 Hook 处理 session 生命周期、消息路由、Agent 级拦截：

| Hook | 执行位置 | 作用 |
|------|----------|------|
| `session_start` | resolveSession | 新 Session 创建时 |
| `session_end` | Session 过期/关闭 | Session 结束时 |
| `message_received` | AgentRunner | 消息到达 Gateway 时 |
| `before_agent_run` | AgentRunner.run | Agent 执行前，可阻止 |
| `before_agent_reply` | AgentRunner.run | LLM 回复前，可合成回复 |
| `before_agent_finalize` | AgentRunner.run | 回复定稿前，可修订 |
| `agent_end` | AgentRunner.run | Agent 执行完成时 |
| `message_sending` | AgentRunner.run | 发送回复前，可取消 |
| `message_sent` | AgentRunner.run | 回复发送后 |

**Loop 级 Hook**（在 `runAgentLoop` 中调用）

这些 Hook 处理迭代、工具执行、Prompt 构建等 Agent Loop 内部逻辑：

| Hook | 执行位置 | 作用 |
|------|----------|------|
| `before_iteration` | runAgentLoop 每轮迭代前 | 注入消息/覆盖参数/决定停止 |
| `before_tool_call` | runAgentLoop 工具执行前 | 阻止/审批/覆盖参数 |
| `after_tool_call` | runAgentLoop 工具执行后 | 观察工具结果 |
| `before_prompt_build` | runAgentLoop LLM 调用前 | 注入上下文（RAG、记忆） |
| `before_compaction` | runAgentLoop 上下文压缩前 | 观察压缩前状态 |
| `after_compaction` | runAgentLoop 上下文压缩后 | 观察压缩后状态 |

**设计说明**

- Gateway 级 Hook 处理跨 session 的决策（路由、审批、合成回复）
- Loop 级 Hook 处理单次迭代的决策（工具执行、上下文注入）
- `before_iteration` 综合了原 `before_model_resolve` 的功能（provider/model 覆盖）

### Hook Event 和 Result 类型

#### `before_tool_call`

```ts
// Event
interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  call: ToolCall;
  ctx: HookContext;
}

// Result
interface ToolCallResult {
  params?: Record<string, unknown>;     // 覆盖参数
  block?: boolean;                       // 阻止执行
  blockReason?: string;                  // 阻止原因
  requireApproval?: {                    // 需要用户审批
    title: string;
    description: string;
    severity?: 'info' | 'warning' | 'critical';
    timeoutMs?: number;
    timeoutBehavior?: 'allow' | 'deny';
  };
}
```

#### `before_prompt_build`

执行位置：`runAgentLoop` —— 每轮迭代中，LLM 调用之前。

```ts
// Event
interface BeforePromptBuildEvent {
  agentId: string;            // Agent ID
  sessionId: string;          // Session ID
  messages: Message[];        // 当前对话消息
  ctx: HookContext;           // Hook 上下文
}

// Result
interface PromptBuildResult {
  prependContext?: string;      // 在消息前插入
  appendContext?: string;       // 在消息后追加
  systemPrompt?: string;        // 覆盖 system prompt
  prependSystemContext?: string; // system prompt 前置追加
  appendSystemContext?: string;  // system prompt 后置追加
}
```

#### `before_agent_reply`

```ts
// 返回 Message → 替代 LLM 回复
// 返回 null → 让 LLM 正常处理
type AgentReplyResult = Message | null;
```

#### `message_sending`

```ts
// Result
interface MessageSendingResult {
  cancel: boolean;        // 取消发送
  cancelReason?: string;  // 取消原因
}
```

### 实际使用示例

#### Tool 拦截 + Approval

```ts
api.on('before_tool_call', async (event) => {
  const { toolName } = event;

  if (toolName === 'shell') {
    return {
      requireApproval: {
        title: 'Execute shell command',
        description: `Tool "${toolName}" requires approval`,
        severity: 'warning',
        timeoutMs: 30000,
        timeoutBehavior: 'deny',
      },
    };
  }

  return null; // 放行
}, { priority: 50 });
```

#### RAG 上下文注入

```ts
api.on('before_prompt_build', async (event) => {
  const lastUser = event.messages
    .filter(m => m.role === 'user')
    .pop();

  if (!lastUser) return null;

  const results = await ragSearch(lastUser.content);
  if (results.length === 0) return null;

  return {
    prependContext: `<rag>\n${results.join('\n')}\n</rag>`,
  };
}, { priority: 10 });
```

#### 观察语义（日志记录）

```ts
// 不返回值 = 不拦截 = 所有 plugin 都执行
api.on('after_tool_call', async (event) => {
  const { call, result } = event;
  api.logger.info(`Tool ${call.toolName}: ${result.isError ? 'FAIL' : 'OK'}`);
});
```

---

## Capability Ownership Model

核心原则：**Plugin 是能力边界**。每个 provider、channel、tool 都有且仅有一个 owner。

### 为什么需要 Capability Ownership？

1. **不加载代码就能知道谁拥有什么能力** — 通过 manifest 的 `contracts` 字段
2. **冲突检测** — 两个 plugin 注册同名 tool 时报错
3. **激活规划** — 根据 manifest 决定是否需要加载某个 plugin
4. **排他性资源管理** — 某些能力（如 memory provider）同一时刻只能有一个 active

### contracts 声明

```json
{
  "contracts": {
    "tools": ["web_search", "web_fetch"],
    "providers": ["openai", "anthropic"],
    "channels": ["telegram", "discord"],
    "embeddingProviders": ["openai-embedding"],
    "speechProviders": ["openai-tts"]
  }
}
```

### 冲突检测

```ts
const registry = new CapabilityRegistry();

registry.register('plugin-a', manifestA);
registry.register('plugin-b', manifestB);

// 如果 manifestA 和 manifestB 都声明拥有 "web_search" tool
// → 抛出 PluginConflictError
```

### 查询能力

```ts
const owner = registry.getOwner('tools', 'web_search');
// → 'plugin-a'

const allTools = registry.getCapabilitiesByType('tools');
// → Map<string, string>  (capabilityId → pluginId)
```

### 排他性 Slots

某些能力类型（`kind: 'memory'`、`kind: 'context-engine'`）在同一时刻只能有一个 active plugin：

```json
{
  "id": "sqlite-memory",
  "kind": "memory",
  "contracts": { "providers": ["sqlite-memory"] }
}
```

---

## Plugin 加载流程

### Discovery

`PluginLoader` 扫描配置的 `loadPaths`，查找包含 `octopi.plugin.json` 的目录：

```
loadPaths/
  ├── tool-preflight/
  │   ├── octopi.plugin.json  ← 发现
  │   └── index.ts
  ├── tool-logger/
  │   ├── octopi.plugin.json  ← 发现
  │   └── index.ts
  └── not-a-plugin/
      └── random.txt           ← 跳过
```

### Validation

对每个发现的 manifest 执行验证：

1. JSON 格式合法
2. 必填字段存在（`id`、`configSchema`）
3. `requiresPlugins` 依赖满足
4. 无 contracts 冲突

### Loading

动态 `import()` 入口文件，获取 default export：

```ts
const entry = await import(path.join(pluginDir, 'index.ts'));
const pluginDef = entry.default; // OctopiPluginDefinition
```

### Registration

创建 `PluginApi` 实例，调用 `register(api)`：

```ts
const api = new PluginApi({
  id: manifest.id,
  name: manifest.name,
  source: entryPath,
  rootDir: pluginDir,
  pluginConfig: config,
});

await pluginDef.register(api);

// api._hooks, api._tools, api._providers 等已被填充
```

### 代码中直接创建 Plugin

不从文件系统加载时，直接用 `definePluginEntry()` 创建：

```ts
import { definePluginEntry } from 'octopi/plugin-sdk/plugin-entry';

const myPlugin = definePluginEntry({
  id: 'inline-plugin',
  name: 'Inline Plugin',
  register(api) {
    api.on('gateway_start', async () => {
      api.logger.info('Inline plugin ready');
    });
  },
});
```

---

## 配置系统

### 用户配置文件

每个 plugin 可以有独立的配置文件，通过 `PluginLoaderConfig.configDir` 指定目录：

```
config-dir/
  tool-preflight.json    ← 对应 plugin id
  tool-logger.json
```

配置文件内容是一个 JSON 对象，对应 manifest 中 `configSchema` 定义的结构：

```json
// tool-preflight.json
{
  "blockedTools": ["eval", "exec"],
  "requireApprovalFor": ["shell", "file_write"]
}
```

### 配置注入

配置通过 `api.pluginConfig` 传入 `register()` 回调：

```ts
register(api) {
  const config = api.pluginConfig;
  const blocked = (config.blockedTools as string[]) ?? [];

  api.on('before_tool_call', async (event) => {
    if (blocked.includes(event.toolName)) {
      return { block: true };
    }
    return null;
  });
}
```

### 激活配置

Manifest 中的 `activation` 字段控制 plugin 何时被加载：

```json
{
  "activation": {
    "onStartup": true,
    "onProviders": ["openai"],
    "onCommands": ["clear"],
    "onChannels": ["telegram"],
    "onConfigPaths": ["providers.openai"],
    "onCapabilities": ["provider", "tool"]
  }
}
```

| 字段 | 说明 |
|------|------|
| `onStartup` | Gateway 启动时加载 |
| `onProviders` | 配置了指定 provider 时加载 |
| `onCommands` | 用户使用指定 command 时加载 |
| `onChannels` | 配置了指定 channel 时加载 |
| `onConfigPaths` | 指定 config path 有值时加载 |
| `onCapabilities` | 需要指定能力类型时加载 |

---

## 完整示例

### 示例 1：Tool Preflight Plugin

拦截 tool 调用，支持 approval 机制。

**`octopi.plugin.json`：**

```json
{
  "id": "tool-preflight",
  "name": "Tool Preflight",
  "description": "拦截并验证 tool 调用，支持 approval 机制",
  "version": "1.0.0",
  "configSchema": {
    "type": "object",
    "properties": {
      "requireApprovalFor": {
        "type": "array",
        "items": { "type": "string" }
      },
      "blockedTools": {
        "type": "array",
        "items": { "type": "string" }
      }
    }
  },
  "activation": {
    "onStartup": true
  }
}
```

**`index.ts`：**

```ts
import { definePluginEntry } from 'octopi/plugin-sdk/plugin-entry';

export default definePluginEntry({
  id: 'tool-preflight',
  name: 'Tool Preflight',
  description: '拦截并验证 tool 调用，支持 approval 机制',

  register(api) {
    const config = api.pluginConfig;
    const blockedTools = (config.blockedTools as string[]) ?? [];
    const requireApprovalFor = (config.requireApprovalFor as string[]) ?? [];

    // priority: 50 — 在默认 priority 0 之前执行
    api.on('before_tool_call', async (event: any) => {
      const toolName = event.toolName;

      if (blockedTools.includes(toolName)) {
        api.logger.warn(`Blocked tool call: ${toolName}`);
        return {
          block: true,
          blockReason: `Tool "${toolName}" is blocked by policy`,
        };
      }

      if (requireApprovalFor.includes(toolName)) {
        api.logger.info(`Requiring approval for tool: ${toolName}`);
        return {
          requireApproval: {
            title: `Approve tool: ${toolName}`,
            description: `Tool "${toolName}" requires user approval`,
            severity: 'warning',
            timeoutMs: 30000,
            timeoutBehavior: 'deny',
          },
        };
      }

      return null; // 放行
    }, { priority: 50 });

    api.on('gateway_start', async () => {
      api.logger.info('Tool Preflight initialized');
    });
  },
});
```

### 示例 2：Tool Logger Plugin

观察语义 hook — 记录所有 tool 调用，不拦截。

**`index.ts`：**

```ts
import { definePluginEntry } from 'octopi/plugin-sdk/plugin-entry';

export default definePluginEntry({
  id: 'tool-logger',
  name: 'Tool Logger',
  description: '记录所有 tool 调用和消息事件',

  register(api) {
    // 低优先级，确保在其他 plugin 之后执行
    api.on('before_tool_call', async (event: any) => {
      api.logger.debug(`→ ${event.toolName}(${JSON.stringify(event.params).slice(0, 100)})`);
    }, { priority: -10 });

    api.on('after_tool_call', async (event: any) => {
      const status = event.result.isError ? 'FAIL' : 'OK';
      api.logger.info(`← ${event.call.toolName} → ${status}`);
    });

    api.on('session_start', async (event: any) => {
      api.logger.info(`Session started: ${event.sessionId}`);
    });
  },
});
```

### 示例 3：Task Manager Plugin

完整的 hook 编排 — `before_agent_reply` 做任务决策，`before_prompt_build` 注入上下文。

```ts
import { definePluginEntry } from 'octopi/plugin-sdk/plugin-entry';

export default definePluginEntry({
  id: 'task-manager',
  name: 'Task Manager',
  description: '任务编排系统',

  register(api) {
    const pendingContext = new Map<string, string>();

    // priority: 10 — 在默认 0 之前执行
    api.on('before_agent_reply', async (event: any) => {
      const { messages, sessionId } = event;

      // 调用 TaskManager LLM 做决策
      const decision = await taskManager.decide({ messages, sessionId });

      if (decision.injectTaskContext && decision.taskContext) {
        pendingContext.set(sessionId, decision.taskContext);
      }

      return null; // 不拦截，让主 LLM 处理
    }, { priority: 10 });

    api.on('before_prompt_build', async (event: any) => {
      const ctx = pendingContext.get(event.sessionId);
      if (!ctx) return null;

      pendingContext.delete(event.sessionId); // 用完即删
      return { prependContext: ctx };
    }, { priority: 10 });
  },
});
```

---

## 子路径导出

对齐 OpenClaw 的 `openclaw/plugin-sdk/*` 导入路径：

```ts
// Plugin 入口定义
import { definePluginEntry, defineChannelPluginEntry } from 'octopi/plugin-sdk/plugin-entry';
import type { OctopiPluginDefinition, OctopiChannelPluginDefinition } from 'octopi/plugin-sdk/plugin-entry';

// Plugin API
import { PluginApi } from 'octopi/plugin-sdk/api';
import type { PluginLogger, HookRegistrationOptions } from 'octopi/plugin-sdk/api';

// Manifest
import { validateManifest, parseManifest } from 'octopi/plugin-sdk/manifest';
import type { PluginManifest, PluginContracts } from 'octopi/plugin-sdk/manifest';

// Capability Registry
import { CapabilityRegistry } from 'octopi/plugin-sdk/capability';

// Plugin Loader
import { PluginLoader } from 'octopi/plugin-sdk/loader';
import type { LoadedPlugin, PluginLoaderConfig } from 'octopi/plugin-sdk/loader';

// Plugin Manager（顶层）
import { PluginManager } from 'octopi/plugin-sdk/manager';
```

也可以从主入口导入：

```ts
import { PluginManager, definePluginEntry, PluginApi } from 'octopi';
```

---

## API 参考

### `definePluginEntry(definition)`

创建 Plugin 定义。返回传入的 definition 对象（带验证）。

**参数验证：**
- `id` — 必填，string
- `name` — 必填，string
- `register` — 必填，function

### `defineChannelPluginEntry(definition)`

创建 Channel Plugin 定义。额外验证 `channelId` 必填。

### `PluginManager`

顶层管理器。

| 方法 | 返回值 | 说明 |
|------|--------|------|
| `discover()` | `Promise<LoadedPlugin[]>` | 发现并加载所有 plugins |
| `getAllPlugins()` | `LoadedPlugin[]` | 获取所有已加载的 plugins |
| `getRegisteredIds()` | `string[]` | 获取已注册的 plugin IDs |
| `getPlugin(id)` | `LoadedPlugin?` | 获取指定 plugin |
| `runHook(hookName, event, defaultResult, config?)` | `Promise<T>` | 运行指定 hook（拦截语义） |
| `runAllHooks(hookName, event)` | `Promise<void>` | 运行指定 hook（观察语义） |
| `getProviders()` | `Array` | 获取所有已注册的 providers |
| `getChannels()` | `Array` | 获取所有已注册的 channels |
| `getTools(includeOptional?)` | `Array` | 获取所有已注册的 tools |
| `getContextEngines()` | `Array` | 获取所有已注册的 context engines |
| `getCommands()` | `Array` | 获取所有已注册的 commands |
| `getServices()` | `Array` | 获取所有已注册的 services |
| `onGatewayStart(config?, workspaceDir?)` | `Promise<void>` | 触发 gateway_start + 启动服务 |
| `onGatewayStop()` | `Promise<void>` | 触发 gateway_stop + 停止服务 |
| `capabilities` | `CapabilityRegistry` | 能力注册中心 |

### `PluginApi`

register() 回调中接收的 api 对象。

| 方法 | 说明 |
|------|------|
| `on(hookName, handler, opts?)` | 注册 hook handler |
| `registerTool(definition, handler, opts?)` | 注册 Agent Tool |
| `registerProvider(registration)` | 注册 LLM Provider |
| `registerChannel(registration)` | 注册 Channel Adapter |
| `registerContextEngine(id, engine)` | 注册 Context Engine |
| `registerCommand(def)` | 注册 Command |
| `registerService(service)` | 注册后台服务 |
| `resolvePath(relativePath)` | 解析相对路径 |

### `CapabilityRegistry`

| 方法 | 说明 |
|------|------|
| `register(pluginId, manifest)` | 注册 plugin 的能力声明 |
| `unregister(pluginId)` | 移除 plugin 的能力声明 |
| `getOwner(type, id)` | 获取能力的 owner plugin ID |
| `getCapabilitiesByType(type)` | 获取指定类型的所有能力 |
| `getPluginCapabilities(pluginId)` | 获取 plugin 的所有能力声明 |
| `hasCapability(type, id)` | 检查能力是否存在 |
| `assertNoConflicts(pluginId, manifest)` | 断言无冲突 |
| `hasExclusiveSlotConflict(kind, manifest)` | 检查排他性 slot 冲突 |
| `listConflicts()` | 列出所有冲突 |

### `PluginLoader`

| 方法 | 说明 |
|------|------|
| `discover()` | 发现并加载所有 plugins |
| `getAllPlugins()` | 获取所有已加载的 plugins |
| `getRegisteredIds()` | 获取已注册的 plugin IDs |
| `getPlugin(id)` | 获取指定 plugin |
| `capabilities` | CapabilityRegistry 实例 |

### `LoadedPlugin`

```ts
interface LoadedPlugin {
  id: string;
  manifest: PluginManifest;
  definition: OctopiPluginDefinition;
  api: PluginApi;
  registered: boolean;
  source: string;
  config?: Record<string, unknown>;
}
```

---

_Last updated: 2026-06-02_
