## v0.7.1 (2026-08-29)

### refactor(core): Core 层架构整理 — 分层边界收敛 + 事件桥接

基于系统性评估，对 Core 层进行 5 阶段结构调整，修正分层边界、消除类型混乱、建立事件桥接。
所有变更保持向后兼容（re-export），公共 API 零破坏。

#### Phase 1: types.ts 拆分

576 行的类型大杂烩拆为 12 个按职责命名的子模块，`types.ts` 变为 36 行 barrel re-export。

- `types/messages.ts` — 消息系统（Message, ContentBlock, ToolCall, ToolResult）
- `types/agent-definition.ts` — Agent 定义（AgentPersona, ModelConfig, AgentDefinition）
- `types/session.ts` — Session（SessionStatus, SessionMeta）
- `types/turn.ts` — Turn（TokenUsage, Turn）
- `types/tools.ts` — 工具系统（ToolDefinition, RegisteredTool, ToolHandler）
- `types/skills.ts` — Skill 系统（SkillDefinition, SkillManager）
- `types/channels.ts` — Channel Adapter（re-export 自 integration 层）
- `types/hooks.ts` — Plugin Hooks（re-export 自 harness 层）
- `types/events.ts` — Agent Event（re-export 自 harness 层）
- `types/gateway-config.ts` — Gateway 配置（re-export 自 integration 层）
- `types/queue-mode.ts` — QueueMode（re-export 自 harness 层）
- `types/thinking-level.ts` — ThinkingLevel（re-export 自 harness 层）

#### Phase 2: 非 Core 类型外迁

将不属于 Core 层的类型迁移到正确层，Core 的 types/ 子文件变为 re-export：

| 类型 | 原位置 | 新位置 |
|------|--------|--------|
| QueueMode | core/types | harness/types/queue-mode.ts |
| ThinkingLevel | core/types | harness/types/thinking-level.ts |
| HookContext | core/types | harness/types/hook-context.ts |
| ChannelAdapter/Message/Reply | core/types | integration/types/channels.ts |
| GatewayConfig | core/types | integration/types/gateway-config.ts |

#### Phase 3: 类型去重

`ErrorReason` / `ClassifiedError` 的规范定义从 `core/loop/types.ts` 移到 `core/interfaces/error-strategy.ts`，
消除了"接口文件依赖实现文件"的倒置关系。`loop/types.ts` 变为 re-export。

#### Phase 4: SecurityGuard 实现下沉

`DefaultSecurityGuard` 类（~440 行策略实现）从 `core/security-guard.ts` 迁移到 `harness/security/default-security-guard.ts`。
Core 的 `security-guard.ts` 从 630 行精简到 58 行，只保留接口 re-export + `severityToAction` + `isValidSecurityGuard`。

**修复的安全 BUG：** `isValidSecurityGuard()` 异常时返回 `true`（应为 `false`）。
原逻辑在 SecurityGuard 实现抛异常时会错误地认为 guard 有效，可能导致安全守卫被绕过。

#### Phase 5: 事件桥接

`SessionAwareRunner.handle()` 新增 EventBus 广播：循环事件适配后同时 emit 到 EventBus（跳过高频 `llm_stream_delta`）。
EventBus 订阅者（AuditTrail、TriggerEngine、EventCollector）现在可以看到循环事件。

删除 `core/loop/event-adapter.ts`（134 行），桥接逻辑统一内置到 runner.ts。

`core/index.ts` 重写，标注 EventBus / IterationBudget 的废弃方向和迁移计划。

**文件变更：**
- 新增 `src/core/types/` — 12 个子模块
- 新增 `src/harness/types/` — 4 个文件（queue-mode, thinking-level, hook-context, index）
- 新增 `src/integration/types/` — 3 个文件（channels, gateway-config, index）
- 新增 `src/harness/security/default-security-guard.ts` — 从 core 迁入
- 修改 `src/core/types.ts` — 576 行 → 36 行 barrel
- 修改 `src/core/security-guard.ts` — 630 行 → 58 行
- 修改 `src/core/index.ts` — 重写，标注废弃方向
- 修改 `src/core/interfaces/error-strategy.ts` — ErrorReason/ClassifiedError 规范定义
- 修改 `src/core/loop/types.ts` — ErrorReason/ClassifiedError 变为 re-export
- 修改 `src/core/event-bus.ts` — 更新两套事件系统共存说明
- 修改 `src/harness/runner.ts` — 新增 EventBus 事件桥
- 删除 `src/core/loop/event-adapter.ts` — 桥接逻辑内置到 runner.ts
- 修改 `src/harness/builder.ts` — DefaultSecurityGuard import 路径更新
- 修改 `src/harness/security/index.ts` — 从新位置导出
- 修改 `src/integration/gateway/gateway.ts` — DefaultSecurityGuard import 路径更新
- 修改 `src/index.ts` — DefaultSecurityGuard import 路径更新
- 修改测试文件 4 个 — import 路径更新

**测试：** 64 文件 1022 测试全通过

## v0.7.0 (2026-08-24)

### refactor(core): Phase 6 — 删除旧引擎，彻底迁移到新架构

**Breaking:** 删除 `src/core/engine.ts`（1759行）和 `AgentEngine` 类。
所有上层模块已迁移到 `Agent` + `runAgentWithReliability()` 新架构。

**迁移的源码模块（12个）：**
- `runner.ts` — AgentEngine → Agent + runAgentWithReliability
- `builder.ts` — 删除 buildEngine()，buildAgent() 为唯一构建路径
- `gateway.ts` — AgentBuilder.buildAgent() 构建
- `distributed/runtime.ts` — createAgentInstance()
- `multi-agent/process.ts`, `swarm.ts` — Agent 引用
- `supervisor.ts` — Agent 引用
- `config-bridge.ts` — BuiltAgent.agent
- `scenario-runner.ts` — Agent 引用

**修复的真实BUG（测试发现）：**
1. 空响应重试失效：onTurnComplete 注入 steer 后 agentLoop 直接退出
2. noop 无限循环：noop 检测注入 hint 后没有停止循环

**重写的测试文件（4个）：**
- planning-retry, engine-advanced, engine-empty-after-tools, core-engine

**统计：** -2568 行，39 文件变更，1035 测试全通过

## v0.6.9 (2026-08-16)

### feat(config): 支持 agent 级别 contextWindow 配置

配置文件现在支持在 agent 的 `model` 中直接配置 `contextWindow`，覆盖 provider 的 getModelInfo 默认值。

**优先级链：** agent 配置 > provider getModelInfo > 内置默认值 > 128000

**配置示例：**
```json
{
  "agents": [{
    "id": "assistant",
    "model": {
      "provider": "openai",
      "model": "gpt-4o",
      "contextWindow": 256000
    }
  }]
}
```

**文件变更：**
- 更新 `src/core/types.ts` — ModelConfig 新增 contextWindow 字段
- 更新 `src/config-schema.ts` — ModelConfigSchema 新增 contextWindow 校验
- 更新 `src/core/engine.ts` — RunConfig 新增 contextWindow + 优先级链
- 更新 `src/integration/gateway/gateway.ts` — 传递 agent.contextWindow 到 RunConfig

**测试：** 1052 passed，全量通过


### feat(tui): Footer 显示当前会话上下文大小 / 上下文窗口上限

TUI footer 区域新增 `ctx 12.3k / 128.0k` 显示，格式为 `ctx {当前估算} / {窗口上限}`。

**实现：**
- `turn.end` 事件扩展：新增 `estimatedTokens` 和 `contextWindow` 字段
- TUI 捕获 `turn.end` 中的 context 信息，更新 footer
- `formatTokens()` 辅助函数：`k`/`m` 紧凑格式

**文件变更：**
- 更新 `src/core/engine.ts` — turn.end 事件携带 context 信息
- 更新 `src/integration/tui/app.ts` — footer 显示 ctx 状态

**测试：** 1052 passed，全量通过


### feat(token): 真实 Usage 集成 — LLM 返回值校准 token 估算

参考 OpenClaw 的 `estimateContextTokens()` 策略，用 LLM 返回的真实 usage 校准启发式估算：

**改进点：**
- `afterTurn()` 存储真实 promptTokens + 消息快照 + 校准比率
- 校准比率 = actual / estimated，70/30 平滑处理防止异常值
- `assemble()` 优先用校准后的估算值（`calibrateTokens()`）
- 校准比率限制在 [0.5, 2.0] 范围内，防止极端值
- 新增 2 个测试用例：校准效果验证 + 比率钳制验证

**文件变更：**
- 更新 `src/harness/context/default-context-engine.ts` — CompactState 扩展 + afterTurn 校准 + calibrateTokens()
- 更新 `tests/context-engine.test.ts` — 新增 2 个校准测试

**测试：** 1052 passed，全量通过


### feat(token): Token 估算器优化 — 参考 OpenClaw 分层比率策略

研究了 OpenClaw 的 token 计算和上下文管理机制，对齐核心估算逻辑：

**改进点：**
- **完整 CJK 范围检测**：从只检测 U+4E00-U+9FFF 扩展到完整 CJK + 扩展A/B + 平假名 + 片假名 + 韩文 + 全角符号
- **按内容类型区分比率**：通用文本 chars/4、工具结果 chars/2、JSON chars/3（之前全局统一）
- **消息结构开销**：从 4 token 提升到 12 token（参考 OpenClaw 的 MESSAGE_BOUNDARY_OVERHEAD_TOKENS）
- **图片估算**：从 85 token 提升到 1200 token（参考 OpenClaw 的 4800 chars）
- **安全余量**：SmartRouter 估算值乘以 1.2x SAFETY_MARGIN（参考 OpenClaw）
- **统一常量文件**：新增 `src/core/token-constants.ts`，避免 Core 和 Harness 层重复定义

**文件变更：**
- 新增 `src/core/token-constants.ts` — 共享常量
- 重写 `src/core/token-estimator.ts` — CJK 感知 + 分层比率
- 重写 `src/harness/context/token-estimator.ts` — 同步核心估算器 + tool result 特殊处理
- 更新 `src/harness/context/smart-router.ts` — SAFETY_MARGIN + 正确比率
- 更新测试期望值（3 处，因估算值变化）

**测试：** 1050 passed，全量通过



## v0.6.5 (2026-08-16)

### fix(security): macOS APFS firmlink 路径不再被误判为 protected

macOS APFS 上 /Users 是 firmlink，真实路径为 /System/Volumes/Data/Users。PROTECTED_PATHS 包含 /System/，
导致用户目录下的文件访问被误拦截。
在 classifyPath 中新增 macOS Data volume 用户目录豁免，在 PROTECTED_PATHS 检查前排除。
新增 3 个回归测试用例。

## v0.6.4 (2026-08-16)

### fix(tui): 会话结束后 "streaming..." 状态残留

终态事件未重置 streamedContent，导致状态栏持续显示 "streaming..."。
所有终态事件（turn.end/engine.end/aborted 等）统一重置 streamedContent + isProcessing + status。
engine.end 改为无条件清除（不再受 isProcessing 条件限制）。

## v0.6.3 (2026-08-16)

### fix(security): /dev/null 伪设备不再被误判为 protected

`PROTECTED_PATHS` 包含 `/dev/`，导致 `/dev/null`、`/dev/zero` 等安全伪设备被误判为 critical 并 block。
新增 `SAFE_PSEUDO_DEVICES` 白名单，在检查 PROTECTED_PATHS 前先排除安全伪设备。
新增 4 个回归测试用例。

### fix(tui): 会话结束后清除 planning-only/empty-response retry 持久消息

`planning_only_retry` 和 `empty_response_retry` 事件通过 `addSystem()` 写入聊天记录后，
turn 结束时未被清除，一直残留在 TUI 界面上。

修复：SystemMessageComponent 新增 `transient` 属性，ChatLog 新增 `clearTransientSystem()` 方法，
所有终态事件调用清除。

## v0.6.1 (2026-08-16)

### fix(security): /dev/null 伪设备白名单（同 v0.6.3 内容，首次修复）

## v0.6.0 (2026-08-16)

### 并发控制模块 — 多 Key 负载均衡与资源保护

### 并发控制模块 — 多 Key 负载均衡与资源保护

新增 `concurrency` 模块，解决多用户并发场景下的 API 限流、资源耗尽和工具死循环问题。

**核心组件：**

- **ProviderPool** — 多 Key LLM Provider 负载均衡
  - 同一模型多个 API key 分散 rate limit 压力
  - 粘滞路由：同一 session 路由到同一 key，命中 prompt cache（节省 20-40% token）
  - 三种路由策略：sticky / round-robin / least-loaded
  - per-key 独立限流（RateLimiter）
  - 自动故障转移：连续 5 次错误 → 标记不健康 → 跳过；成功 → 自动恢复
  - 实现 ModelProvider 接口，对 Engine 完全透明

- **SessionGate** — 信号量并发控制
  - 限制同时运行的 Agent Loop 数量，防止服务器 OOM
  - FIFO 公平队列 + 超时保护
  - 集成到 Runner.handle() 入口

- **RateLimiter** — 令牌桶限流
  - 平滑限流，允许突发流量
  - 支持多 provider 独立限流
  - 集成到 ProviderPool 每个 slot

- **ToolValidator** — 工具结果验证
  - No-op 检测：连续空结果自动终止循环（可配置阈值）
  - 结果大小限制和截断（防止上下文膨胀）
  - 工具调用历史追踪
  - 替换 Engine 内联 noop 检测（向后兼容）

**配置驱动（octopi.json）：**
```json
{
  "concurrency": {
    "providerPool": {
      "slots": [
        { "provider": "openai-1", "weight": 2 },
        { "provider": "openai-2" }
      ],
      "routing": { "strategy": "sticky" },
      "rateLimit": { "requestsPerMinute": 60 }
    },
    "sessionGate": { "maxConcurrent": 50 }
  }
}
```

**测试：** 75 个新测试（总计 1048），零破坏性变更。

## v0.5.0 (2026-07-17)

### MCP Client — 连接外部工具生态

新增 MCP (Model Context Protocol) Client 集成，让 Octopi Agent 能调用外部 MCP Server 提供的工具。

**核心功能：**
- 连接 MCP Server（stdio/HTTP 传输）
- 自动发现并注册 MCP 工具到 ToolRegistry
- 工具名命名空间管理（`{serverId}__{toolName}`）
- 断开时自动注销工具
- 运行时动态管理（`connectServer` / `disconnectServer`）
- 目录自动发现（`loadMcpServersFromDir`）

**架构设计（遵循三层模型）：**
- Core 层：`McpClient` / `McpManager` 接口定义
- Harness 层：`DefaultMcpManager` + MCP↔Octopi 格式桥接 + 目录发现
- Integration 层：`SdkMcpClient`（包装 `@modelcontextprotocol/sdk`）

**SDK API：**
```ts
// 构建时声明
const { engine, runner, mcpManager } = await new AgentBuilder()
  .model('gpt-5.5')
  .mcp({ id: 'filesystem', transport: 'stdio', command: 'npx', args: [...] })
  .build();

// 运行时动态管理
await mcpManager.connectServer({ id: 'db', transport: 'stdio', command: '...' });
await mcpManager.disconnectServer('db');

// 目录自动发现
const configs = await loadMcpServersFromDir();
for (const c of configs) await mcpManager.connectServer(c);
```

**健壮性：**
- MCP 调用 30s 默认超时
- callTool 兼容性结果处理
- McpServerConfig 判别联合类型（编译时校验）
- 工具错误内容透传

**依赖：** `@modelcontextprotocol/sdk ^1.29.0`
**测试：** 41 个 MCP 测试（bridge 16 + manager 17 + discovery 8）

---

## v0.4.0 (2026-06-27)

### 项目定位调整

- 定位从“可嵌入的 Agent 运行时框架”调整为“可嵌入的 Agent 引擎”
- 引擎 = 核心运行时 + 干净接口，强调可嵌入、可替换、最小核心

### Bug 修复：TUI 第二轮对话无响应 + Empty Response

- **引擎层：** `finally` 块保证 `ENGINE_END` 在所有退出路径发射
- **TUI 层：** 新增 `engine.end` handler 重置 `isProcessing`
- **引擎层：** 中止安全退出（`emitAbortedMessage`）保持 session 语义完整性

### 改进：Agent 恢复/重试机制优化（参考 OpenClaw）

- **P0:** finishReason 校验 — 只有 `tool_calls` 时才执行工具
- **P1:** No-op 检测 — `ToolResult.noop` + `__noop` 约定，防止 tool-loop 死循环

### Bug 修复：TUI 第二轮对话无响应

**问题描述：**
- TUI 第一轮对话结束后一直显示 "streaming..."，导致第二轮对话无法正常开始

**根因分析：**
- 引擎在工具执行后直接 `continue` 进入下一轮迭代，没有 yield `turn.end` 事件
- TUI 依赖 `turn.end` 事件重置 `isProcessing` 状态
- 没有 `turn.end` → `isProcessing` 永远为 true → 用户无法发送第二条消息
- 另外，TUI 没有处理 `engine.end` 事件作为安全网

**修复内容：**
- **引擎层：** 用 `finally` 块保证 `ENGINE_END` 在所有退出路径上都被发射（之前只有部分路径发射）
- **TUI 层：** 新增 `engine.end` 事件处理，重置 `isProcessing` 状态（之前 TUI 不处理此事件）
- **引擎层：** 移除 `emitAbortedMessage` 和正常完成路径中的冗余 `ENGINE_END` 发射（由 `finally` 统一处理）

### 改进：Agent 恢复/重试机制优化（参考 OpenClaw）

**改进内容：**

- **P0: 中止安全退出** — `AgentEngine` 中止时（`AbortSignal`）自动写入一条 `aborted` assistant 消息到 messages 数组，保持 session 语义完整性。防止中止后 session 卡在 toolUse（无 toolResult）状态
- **P0: finishReason 校验** — 只有 `finishReason === 'tool_calls'` 时才执行工具调用，防止截断/中断的 tool call 被误执行。当 finishReason 不匹配时，yield `tool_calls.filtered` 事件并按纯文本处理
- **P1: No-op 检测** — 新增 `ToolResult.noop` 字段 + `__noop` 工具返回约定。连续 2 次 no-op 工具执行后自动终止循环，防止 tool-loop 死循环

**参考：** OpenClaw agent-core 的 `stopIfAborted()`、`removeNonExecutableToolCalls()`、no-op write/edit terminal failure 机制

## v0.3.1 (2026-06-27)

### Bug 修复：工具执行后卡死 + 超时机制 + Gateway 预算管理

**问题描述：**
- TUI 发送消息后，agent 调用工具成功但第二次模型调用永远卡住
- Gateway 运行超过 10 分钟后所有请求立即报 "Budget exceeded: timeout"
- Gateway 连接断开后 TUI 无法正常退出

**根因分析：**
1. **消息格式不匹配：** 引擎的 tool result 消息格式 `{ role: 'tool', toolResults: [...] }` 与 LLM API 期望的 `{ role: 'tool', tool_call_id, content }` 不一致，导致 API 请求卡住或报错
2. **流式调用无超时：** `stream()` 方法的 `fetch` 调用没有超时设置，API 卡住时永远等待
3. **Budget 不重置：** `IterationBudget` 在 Gateway 启动时创建一次，`startTime` 固定，运行超过 `maxWallClockMs` 后所有请求立即超时
4. **断连状态未清理：** Gateway 断连时 `isProcessing` 状态未重置，Ctrl+C 被拦截

**修复内容：**
- **Provider 层：** 新增 `flattenMessages()` 将引擎格式的 tool results 展开为 API 格式（OpenAI + Anthropic）
- **Provider 层：** `stream()` 方法添加连接超时 + 空闲超时（默认 60s，可通过 `timeoutMs` 配置）
- **Core 层：** `IterationBudget` 新增 `reset()` 方法
- **Core 层：** `AgentEngine.run()` 开头自动调用 `budget.reset?.()`，确保每次请求独立计时
- **Gateway 层：** `GatewayConfig` 新增 `budget` 字段，支持从配置文件读取预算参数
- **TUI 层：** Gateway 断连时重置 `isProcessing`，保留已流式内容，允许正常退出

**配置示例：**
```json
{
  "budget": {
    "maxIterations": 10,
    "maxToolCalls": 30,
    "maxWallClockMs": 1800000
  }
}
```

## v0.3.0 (2026-06-18)

### CLI serve 命令重构 — 后台守护进程模式

`octopi serve` 从阻塞命令改为后台守护进程，终端不再被占用。

**新增子命令：**
- `octopi serve start` — 后台启动 Gateway（fork 子进程，父进程立即退出）
- `octopi serve stop` — 优雅停止（SIGTERM → 10s 超时 → SIGKILL）
- `octopi serve restart` — 重启
- `octopi serve status` — 查看运行状态（PID、配置、启动时间）
- `octopi serve fg` — 前台模式（调试用）

**技术细节：**
- PID 文件：`~/.octopi/gateway.pid`（JSON 格式）
- 自动检测已有实例，防止重复启动
- 残留 PID 文件自动清理

### 可观测性集成 — Observer + TraceCollector + MetricsAggregator

统一两套观测系统，一行代码启用完整观测链路。

**架构：**
- `ObserverBridge` — 实现 Observer 接口，桥接到 TraceLogger + MetricsAggregator
- `TraceCollector` 增强 — 接受可选 MetricsAggregator，wrap() 时自动喂事件
- `Builder.trace()` — 一行启用完整观测链路
- CLI `--verbose` 退出时自动打印 MetricsSnapshot 摘要

### ContextEngine 智能路由

根据溢出量和工具结果可压缩空间选择最优路由。

**路由策略：**
- `fits` — 上下文在预算内，不处理
- `truncate_tool_results_only` — 只截断工具结果
- `compact_only` — 只压缩历史消息
- `compact_then_truncate` — 先压缩再截断

**其他：**
- 三层 Token 估算策略（LLM > tokenizer > 启发式）
- LLM 摘要默认开启，失败时回退到截断
- 边界对齐：不拆分 tool_call/tool_result 对

### Bug 修复

- Anthropic provider tool 消息格式错误 — tool 消息转为 user + tool_result content block
- 类型系统统一 — AgentEvent union 重命名为 AgentEventDetail，event-bus 接口为唯一标准
- ContextEngine MessageSelector 死代码修复 — 组件未被实际调用

### 测试

- 测试总数：453 → 642（+189）
- 测试文件：36 → 38

## v0.2.5 (2026-06-06)

### Harness 层 — StrategyRouter + ResourceManager（Phase 4）

新增策略路由和资源管理，让 Agent 更高效、更经济。

**新增 Strategy 模块：**
- `RuleTaskClassifier` — 规则驱动的任务分类器
  - 分类：question/lookup/analysis/creation/coding/planning/conversation
  - 复杂度：simple/moderate/complex
  - 中文分词优化
- `DefaultStrategyRouter` — 默认策略路由器
  - 6 种推理策略：direct/chain_of_thought/plan_and_execute/tool_use/reflect/multi_agent
  - 规则匹配：根据分类结果选择最合适策略

**新增 Resources 模块：**
- `ResourceManager` — 统一资源管理器
  - Token 预算：per-call/per-minute/per-hour/total 四维限制
  - 成本追踪：按模型统计，自动计算费用
  - 速率限制：请求频率 + 并发控制
  - 完整统计报告

### 测试

- 测试总数：430 → 453（+23）
- 新增 `tests/harness/strategy.test.ts` — 23 个测试

## v0.2.4 (2026-06-06)

### Harness 层 — KnowledgeStore + Reflector（Phase 3）

新增知识存储和反思器，让 Agent 能积累知识、从经验中学习。

**新增 Knowledge 模块：**
- `MemoryKnowledgeStore` — 内存知识存储（开发/测试用）
  - CRUD 操作、关键词检索、按类型/标签/置信度过滤
  - 访问计数追踪、统计信息
- `KnowledgeStage` — 上下文管道知识注入阶段
  - 从用户消息提取关键词，检索相关知识，注入 system prompt

**新增 Reflector 模块：**
- `LLMReflector` — LLM 驱动的反思器
  - 执行质量评估（assess）
  - 模式识别（detectPatterns）
  - 高置信度模式自动存入 KnowledgeStore

**类型定义：**
- `KnowledgeEntry` — 知识条目（fact/pattern/lesson/preference/skill）
- `KnowledgeStore` 接口 — 可替换的存储后端

### 测试

- 测试总数：410 → 430（+20）
- 新增 `tests/harness/knowledge.test.ts` — 20 个测试

## v0.2.3 (2026-06-06)

### Harness 层 — Planner + TaskScheduler（Phase 2）

新增规划器和任务调度器，让 Agent 能自主规划和调度任务。

**新增 Planner 模块：**
- `RulePlanner` — 规则驱动的规划器（快速、低成本、可预测）
  - 支持通配符匹配、自定义条件、优先级、once 规则
  - 内置规则：用户消息、安全事件、空闲事件
- `LLMPlanner` — LLM 驱动的规划器（灵活、处理复杂场景）
  - 事件分析 → 结构化计划（JSON）
  - 目标分解 → 可执行步骤
- `HybridPlanner` — 混合规划器（规则优先，LLM fallback）

**新增 Scheduler 模块：**
- `TaskScheduler` — 任务调度器
  - `scheduleOnce` — 延迟执行一次
  - `scheduleInterval` — 按间隔重复执行
  - `scheduleCron` — cron 表达式定时
  - `scheduleAt` — 指定时间执行
  - 支持：暂停/恢复/取消、事件发射

### 测试

- 测试总数：381 → 410（+29）
- 新增 `tests/harness/planner.test.ts` — 29 个测试

## v0.2.2 (2026-06-06)

### Harness 层 — AgentSupervisor（Phase 1）

新增 AgentSupervisor 模块，让 Agent 从“单次对话”进化为“持续运行的进程”。

**新增模块：**
- `AgentSupervisor` — 持续运行的 Agent 核心（认知循环：感知→思考→执行→反思）
- `EventCollector` — 事件收集器（聚合 EventBus + EventSource + 手动注入）
- `Planner` 接口 — 规划器接口（决定 Agent 做什么）
- `Reflector` 接口 — 反思器接口（评估执行质量、识别模式）
- `SupervisorConfig` / `AgentState` / `Plan` / `PlanStep` / `StepResult` 等类型

**设计原则：**
- 基于 Core ProcessModel 实现，有独立生命周期
- Planner 可替换（LLM 驱动、规则驱动、混合）
- Reflector 可选（没有反思器也能运行）
- 与 AgentEngine 共存（单次推理仍由 AgentEngine 完成）

### 测试

- 测试总数：367 → 381（+14）
- 新增 `tests/harness/supervisor.test.ts` — 14 个测试

## v0.2.1 (2026-06-06)

### Core 层架构升级 — 异步原语 + 进程模型

在 Core 层新增两个底层原语，为 Agent 的高级能力（异步任务、多进程协作、消息传递）打基础。

**新增核心原语：**
- `AsyncTask` — 异步任务原语（420 行）
  - 状态机：pending → running → completed | failed | cancelled
  - 支持：取消（AbortSignal）、超时、重试、事件发射、持久化
  - `spawnTask()` 便捷方法：发射后不管
- `ProcessModel` — Agent 进程模型（502 行）
  - 状态机：born → running → sleeping → waiting → dead
  - 支持：父子进程（spawn）、进程间通信（send/receive）、sleep、kill、事件
  - `spawnProcess()` 便捷方法

**新增接口：**
- `EventSource` — 外部事件源协议（webhook、file watcher、timer 等）
- `TaskStore` — 任务持久化协议（内存、文件、Redis 等）
- `MessageChannel` — 进程间通信协议（内存队列、WebSocket、消息队列等）

**设计原则：**
- 内核提供机制（mechanism），Harness 提供策略（policy）
- 内核只做“如果它不做，别人就没法做”的事
- Planner、Reflector、KnowledgeStore 等高级能力全部放 Harness 层

### 测试

- 测试总数：326 → 367（+41）
- 新增 `tests/core/async-task.test.ts` — 22 个测试
- 新增 `tests/core/process-model.test.ts` — 19 个测试

## v0.2.0 (2026-06-06)

### 架构重构 — 三层洋葱模型

完成从单体架构到三层分离的全面重构：

**Core 层（Layer 1）— 纯引擎 + 接口契约**
- `AgentEngine` — 无状态循环引擎，回调槽扩展机制
- `EventBus` — 内置事件总线（`DefaultEventBus` + `NoopEventBus`）
- `SecurityGuard` — 内置安全守卫（注入检测、敏感信息过滤，不可禁用）
- `IterationBudget` — 资源约束（迭代次数、工具调用、token、时间）
- 核心接口：`ModelProvider`、`ToolExecutor`、`ContextPipeline`、`ErrorStrategy`、`Observer`

**Harness 层（Layer 2）— 装具层**
- `AgentBuilder` — Fluent API 组装器，一行代码启动 Agent
- `SessionAwareRunner` — Session 生命周期管理（锁、持久化、并发控制）
- `PersonaLoader` — 文件式人格系统（AGENTS.md、SOUL.md 等）
- `DefaultContextPipeline` — 可插拔上下文管道（Persona → Skill → Task → History → Filter）
- `TaskStage` — Task 系统集成到 ContextPipeline
- `OutputQualityGate` — 输出质量检测迁移到 Harness 层
- `CapabilityEnforcer` + `SecurityPresets` — 安全策略预设

**Integration 层（Layer 3）— 集成层**
- `JsonlSessionStore` / `InMemorySessionStore` — 存储后端
- `NoopObserver` / `LogObserver` — 可观测性

### 新增

- `DefaultEventBus` — 全链路事件系统（`ENGINE_START`、`MODEL_CALL_END`、`INJECTION_DETECTED` 等）
- `DefaultSecurityGuard` — 注入检测 + 敏感信息过滤 + 不可信内容标记
- `IterationBudget` — 迭代次数/工具调用/token/时间四维约束
- `AgentBuilder` — Fluent API，支持 `.model()`、`.persona()`、`.store()`、`.plugin()`、`.budget()` 等
- `SessionAwareRunner` — Session 锁、持久化、Daily/Idle Reset
- `PersonaLoader` — 从目录加载 `.md` 文件，支持多 Persona 叠加
- `DefaultContextPipeline` — 管道模型，每个阶段独立可替换
- `TaskStage` — Task 系统作为 ContextPipeline 阶段注入
- `LegacyAgentRunner` — v0.1.x API 兼容层
- Plugin SDK 子路径导出：`octopi/plugin-sdk/plugin-entry`、`octopi/plugin-sdk/api` 等
- 安全预设：`SecurityPresets.development/testing/production/maximum`

### 变更

- `AgentRunner` 标记为 deprecated，推荐使用 `AgentBuilder` + `SessionAwareRunner`
- `SessionManager` 标记为 deprecated，推荐使用 `SessionAwareRunner`
- `LegacyContextEngine` 标记为 deprecated，推荐使用 `DefaultContextPipeline`
- `LLMRouter` 标记为 deprecated，推荐使用 `ModelProvider` 接口
- Task 系统从 Plugin hook 迁移到 ContextPipeline Stage
- Output Quality 从 Loop 层迁移到 Harness 层

### 测试

- 测试总数：313 → 325
- 新增 `core-engine.test.ts` — AgentEngine 核心循环测试
- 新增 `harness.test.ts` — AgentBuilder + SessionAwareRunner 测试
- 新增 `security.test.ts` — SecurityGuard + CapabilityEnforcer 测试
- 新增 `task-stage.test.ts` — TaskStage ContextPipeline 集成测试

### 文档

- 重写 `README.md` — 反映 v0.2.0 架构
- 更新 `docs/ARCHITECTURE.md` — 完整的三层架构设计文档
- 更新 `docs/REFACTORING-PLAN.md` — 重构方案 v2.0
- 更新 `docs/MIGRATION-AUDIT.md` — 代码迁移审计
- 更新 `docs/plugin-system.md` — Plugin 系统文档
- 更新 `docs/task-system.md` — Task 系统文档
- 更新 `docs/development-guide.md` — 开发指南

---

## v0.1.1 (2026-06-04)

### 重构

- **TaskTracker 异步化** — 所有 CRUD 方法改为 async，文件操作用 stat/readFile/appendFile 替代同步版本
- **applyDecision 去重** — 新建 `src/tasks/shared.ts` 提取共享函数
- **AgentLoop 命名区分** — 重命名为 AgentRunner，保留向后兼容别名
- **plugin.ts 迁移到迭代级 hook** — 从 OpenClaw per-message hook 改为 Octopi 迭代级 hook
- **advisor.ts 删除** — 移除 LoopAdvisor 模式，统一使用 Plugin hook

### 测试

- 新增 JSON 解析边界 case 测试
- 新增并发 session 隔离压力测试
- 测试总数：145 → 150

### 文档

- 新增 `src/tasks/README.md` — Task 系统架构文档
- 新增 `docs/agent-loop-architecture.md` — Agent Loop 对比分析
- 新增 `docs/architecture-refactor-analysis.md` — 架构重构分析
- 更新架构文档 v3，同步实际代码状态

## v0.1.0 (2026-06-02)

### 核心功能

- Agent Loop（消息 → 上下文组装 → 模型推理 → 工具执行 → 回复）
- Session 管理（生命周期、持久化、并发控制）
- 多 Provider 支持（OpenAI / Anthropic）
- Plugin 系统（对齐 OpenClaw 架构）
- Skill 系统（Tool 之上的结构化经验层）
- Task 系统（任务追踪与管理）
- 内置工具（shell、file_read、file_write、file_list）
