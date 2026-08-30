# Octopi Web Runtime 技术设计

> 目标：把 WebUI 做成 Octopi 自己的 **Web Runtime**，而不是套用通用后台模板。
>
> 设计原则：
> - Web Runtime = Web Protocol SDK + Web Runtime State + Web UI Primitives
> - 复用 Gateway 作为唯一外部入口，不绕过现有分层
> - REST 负责管理通道，WS 负责实时通道
> - 第一版不追求前端框架重，优先把协议、状态、交互语义做对

---

## 1. 设计定位

Octopi 的 WebUI 不是一个普通前端页面，而是 **Agent 运行时在浏览器侧的交互运行时**。

它应该承担三件事：

1. **协议适配**
   - 连接 Gateway
   - subscribe session
   - 发消息、abort、reconnect

2. **运行时状态建模**
   - session 状态
   - chat run 状态
   - tool run timeline
   - approval queue
   - context / budget / memory inspector

3. **UI 原语实现**
   - streaming assistant
   - tool run card / timeline
   - approval card
   - inspector panels
   - session timeline

也就是说：

- **Protocol SDK** 解决“怎么连”
- **Runtime Store** 解决“怎么理解事件”
- **UI Primitives** 解决“怎么呈现状态”

---

## 2. 现有可复用边界

### 2.1 Gateway 是外部入口

现有架构已经明确：

```
External message → Channel Adapter → Gateway → SessionAwareRunner → Agent → LLM
```

参考：
- [src/integration/gateway/gateway.ts:80](/Users/jk/Projects/octopi/src/integration/gateway/gateway.ts:80)

Web Runtime 应该和 TUI 一样，作为 **Gateway 的另一类客户端**。

---

### 2.2 HTTP + WS 通道已有雏形

当前已有：

- `POST /messages`
- `GET /health`
- `GET /metrics`
- `WS /ws`
- `AgentEvent` 广播机制

参考：
- [src/integration/protocols/http.ts:65](/Users/jk/Projects/octopi/src/integration/protocols/http.ts:65)

这说明第一版主链路已经具备 Web 化条件：
- 消息发送可用 HTTP/WS
- 流式事件可用 WS

---

### 2.3 Session 可管理

`SessionStore` 已定义完整接口：

- `load`
- `save`
- `list`
- `delete`
- `exists`

参考：
- [src/core/interfaces/session-store.ts:48](/Users/jk/Projects/octopi/src/core/interfaces/session-store.ts:48)

但当前 Gateway 还没有对外暴露对应的 REST API。

---

### 2.4 Memory / Wisdom / Cognition 已有接口

Memory 系统已有清晰接口：

- `store`
- `retrieve`
- `get`
- `update`
- `delete`
- `decay`
- `stats`

参考：
- [src/core/interfaces/memory.ts:134](/Users/jk/Projects/octopi/src/core/interfaces/memory.ts:134)

这意味着 Web Runtime 的 Inspector 层已经有接口基础，缺的是对外查询入口。

---

### 2.5 Approval 已有接口

Human-in-the-loop 已有核心契约：

- `ApprovalRequest`
- `ApprovalDecision`
- `ApprovalProvider`

参考：
- [src/core/interfaces/human-in-the-loop.ts:15](/Users/jk/Projects/octopi/src/core/interfaces/human-in-the-loop.ts:15)

因此 Approval Queue 可以直接复用现有语义，不必重新定义审批模型。

---

### 2.6 TUI 的事件处理语义值得继承

当前 TUI 已经定义了 Web Runtime 第一版需要处理的核心事件语义：

- 流式输出
- 工具执行
- turn / engine 生命周期
- 安全阻断
- budget 超限
- context 截断
- retry / loop

参考：
- [src/integration/tui/app.ts:227](/Users/jk/Projects/octopi/src/integration/tui/app.ts:227)

Web Runtime 的目标不是复刻 TUI，而是把同一套事件语义翻译成更好的状态与组件模型。

---

## 3. 总体架构

```
Browser
  ├── Web Protocol SDK
  │     - REST client
  │     - WS client
  │     - reconnect / subscribe / abort
  │
  ├── Web Runtime Store
  │     - session-store
  │     - chat-store
  │     - tool-store
  │     - approval-store
  │     - inspector-store
  │
  └── Web UI Primitives
        - StreamingAssistant
        - ToolRunCard
        - ApprovalCard
        - ContextPanel
        - MemoryPanel
        - SessionTimeline
          ↓
Gateway
  ├── REST controllers
  ├── WS subscribe protocol
  └── Gateway core
        ↓
SessionAwareRunner → Agent → LLM
```

参考核心入口：
- [src/integration/gateway/gateway.ts:80](/Users/jk/Projects/octopi/src/integration/gateway/gateway.ts:80)
- [src/harness/runner.ts:121](/Users/jk/Projects/octopi/src/harness/runner.ts:121)

---

## 4. Web Protocol SDK 设计

Web Protocol SDK 不带 UI 观点，只负责协议与连接生命周期。

### 4.1 职责

- 连接 Gateway REST
- 连接 Gateway WS
- 维护连接状态
- 发送 `chat / abort / subscribe`
- 接收 `welcome / accepted / event / state / error`
- 自动重连
- 事件分发给 Runtime Store

### 4.2 REST 能力

第一版需要支持：

- `GET /api/v1/health`
- `GET /api/v1/agents`
- `GET /api/v1/providers`
- `GET /api/v1/sessions`
- `POST /api/v1/sessions`
- `GET /api/v1/sessions/:id`
- `GET /api/v1/sessions/:id/messages`
- `POST /api/v1/sessions/:id/abort`
- `GET /api/v1/approvals`
- `POST /api/v1/approvals/:id`
- `GET /api/v1/memory/stats`
- `GET /api/v1/memory/query`

### 4.3 WS 协议

客户端发送：

```json
{ "type": "chat", "sessionId": "s1", "agentId": "a1", "content": "hi" }
{ "type": "abort", "sessionId": "s1" }
{ "type": "subscribe", "sessionId": "s1" }
{ "type": "ping" }
```

服务端返回：

```json
{ "type": "welcome", "agents": [...] }
{ "type": "accepted", "sessionId": "s1", "messageId": "m1" }
{ "type": "event", "sessionId": "s1", "event": { ...AgentEvent } }
{ "type": "state", "sessionId": "s1", "state": "idle | running | aborted | error" }
{ "type": "error", "message": "..." }
{ "type": "pong" }
```

### 4.4 连接状态机

建议维护：

- `disconnected`
- `connecting`
- `connected`
- `reconnecting`
- `failed`

每个状态都应暴露给 UI 的 TopBar。

---

## 5. Gateway REST 契约设计

### 5.1 通用响应结构

```ts
interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  cursor?: string;
}
```

### 5.2 核心资源

#### Agents

```ts
GET /api/v1/agents

interface AgentSummary {
  id: string;
  model: {
    provider: string;
    model: string;
  };
}
```

#### Providers

```ts
GET /api/v1/providers

interface ProviderSummary {
  name: string;
  circuitBreaker: {
    state: string;
    failureCount: number;
  };
}
```

#### Sessions

```ts
POST /api/v1/sessions
{
  agentId: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

GET /api/v1/sessions?agentId=...

GET /api/v1/sessions/:id

interface SessionView {
  id: string;
  agentId: string;
  status: string;
  createdAt: number;
  lastInteractionAt: number;
  updatedAt: number;
}
```

#### Messages

```ts
GET /api/v1/sessions/:id/messages?cursor=...&limit=...

interface MessagePage {
  messages: Message[];
  nextCursor?: string;
}
```

#### Abort

```ts
POST /api/v1/sessions/:id/abort
```

#### Approvals

```ts
GET /api/v1/approvals

POST /api/v1/approvals/:id
{
  action: "approve" | "reject";
  reason?: string;
}
```

#### Memory

```ts
GET /api/v1/memory/stats
GET /api/v1/memory/query?q=...&type=...&limit=...
```

---

## 6. Web Runtime Store 设计

Web Runtime 的核心不是页面状态，而是把 `AgentEvent` 翻译成“开发者可理解”的运行时状态。

### 6.1 Session Store

管理：

- current agent
- sessions list
- current session
- session create / switch / reload

状态模型：

- `loading`
- `ready`
- `switching`
- `error`

---

### 6.2 Chat Store

管理一次聊天运行状态：

- `messages`
- `streamingAssistant`
- `currentRunStatus`

状态建议：

- `idle`
- `sending`
- `waiting`
- `streaming`
- `tool-running`
- `aborted`
- `error`

### 6.3 Tool Store

管理当前 run 中的 tool timeline：

- `toolRuns[]`
- `activeToolId`
- `expandedToolId`

单个 tool run：

```ts
interface ToolRun {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  status: 'running' | 'success' | 'error';
  startedAt: number;
  endedAt?: number;
  error?: string;
}
```

---

### 6.4 Inspector Store

管理以下内容：

- `estimatedTokens`
- `contextWindow`
- `truncations`
- `retries`
- `loops`
- `budgetExceeded`
- `model errors`
- `security blocks`

这些都可以直接从 `AgentEvent` 映射。

---

### 6.5 Approval Store

管理：

- pending approvals
- completed approvals
- current focus approval

状态模型：

- `empty`
- `pending`
- `deciding`
- `decided`

---

## 7. 事件映射设计

Web Runtime 不建议直接透传 `AgentEvent` 给 UI，建议统一映射。

### 7.1 高优先级事件

- `llm_stream_delta`
- `tool.exec.start`
- `tool.exec.end`
- `turn.end`
- `engine.end`
- `aborted`
- `budget.exceeded`
- `security.blocked`
- `security.behavior_blocked`
- `context.truncated`
- `loop_detected`
- `empty_response_retry`
- `planning_only_retry`

参考：
- [src/integration/tui/app.ts:227](/Users/jk/Projects/octopi/src/integration/tui/app.ts:227)

---

### 7.2 建议映射关系

| AgentEvent | Runtime State | UI |
|---|---|---|
| `llm_stream_delta` | append streaming buffer | StreamingAssistant |
| `tool.exec.start` | push ToolRun running | ToolRunCard |
| `tool.exec.end` | mark success/error | ToolRunCard |
| `turn.end` | finalize assistant | MessageList |
| `engine.end` | reset run | TopBar + Notice |
| `aborted` | aborted notice | Notice |
| `budget.exceeded` | inspector event | Inspector |
| `security.blocked` | blocked notice | Notice + Inspector |
| `context.truncated` | inspector event | Inspector |
| `loop_detected` | inspector event | Inspector |
| `approval required` | pending approval | ApprovalQueue |

---

## 8. Web UI Primitives 设计

第一版不要做成“通用后台页面”，而是做成 **Octopi 专有 UI 原语集合**。

### 8.1 Layout Primitives

- `AppShell`
- `LeftRail`
- `CenterWorkspace`
- `RightInspector`
- `TopStatusRail`

### 8.2 Chat Primitives

- `MessageList`
- `UserMessage`
- `StreamingAssistant`
- `SystemNotice`
- `Composer`
- `AbortControl`

### 8.3 Tool Primitives

- `ToolRunCard`
- `ToolTimeline`
- `ToolRunDetail`

### 8.4 Approval Primitives

- `ApprovalQueue`
- `ApprovalCard`
- `ApprovalDecisionSheet`

### 8.5 Inspector Primitives

- `ContextPanel`
- `BudgetPanel`
- `ModelStatusPanel`
- `MemoryStatsPanel`
- `MemoryQueryPanel`

---

## 9. 第一版页面设计

### 9.1 Chat Workspace

核心页面。

左侧：
- Agents
- Sessions
- New session

中间：
- streaming chat
- tool timeline
- system notices

右侧：
- context
- budget
- memory summary
- approvals

### 9.2 Session Detail

- messages
- turns
- tool calls
- session meta
- timeline

### 9.3 Approvals

- pending
- recent
- decision detail

### 9.4 Memory Explorer

- stats
- query
- entry detail

---

## 10. 目录结构建议

```
src/
  integration/
    web/
      README.md
      api/
        router.ts
        agents.ts
        sessions.ts
        approvals.ts
        memory.ts
        health.ts
      ws/
        protocol.ts
      static/
        ...

web/
  index.html
  package.json
  tsconfig.json
  vite.config.ts
  src/
    main.tsx
    app.tsx
    lib/
      api.ts
      ws-client.ts
      event-mapper.ts
    stores/
      session-store.ts
      chat-store.ts
      tool-store.ts
      approval-store.ts
      inspector-store.ts
    components/
      layout/
        AppShell.tsx
        LeftRail.tsx
        RightInspector.tsx
        TopStatusRail.tsx
      chat/
        MessageList.tsx
        StreamingAssistant.tsx
        Composer.tsx
        AbortButton.tsx
      tool/
        ToolRunCard.tsx
        ToolTimeline.tsx
      approval/
        ApprovalQueue.tsx
        ApprovalCard.tsx
      inspector/
        ContextPanel.tsx
        BudgetPanel.tsx
        MemoryPanel.tsx
    pages/
      ChatWorkspace.tsx
      SessionDetail.tsx
      Approvals.tsx
      MemoryExplorer.tsx
```

---

## 11. 分阶段交付建议

### Phase 1：最小可用 Web Runtime

目标：
- 连上 Gateway
- 选 agent / session
- 实现主聊天链路
- 实现 abort

产出：
- Web Protocol SDK
- Gateway REST（agents / sessions / messages / abort）
- ChatWorkspace

---

### Phase 2：Tool Runtime

目标：
- tool run 可追踪
- tool timeline 可展开
- 工具失败/成功状态清晰

产出：
- Tool Store
- ToolRunCard / ToolTimeline

---

### Phase 3：Inspector Runtime

目标：
- context / budget / truncation / retry 可见
- model status 可见

产出：
- Inspector Store
- Inspector Panels

---

### Phase 4：Approval Runtime

目标：
- pending approval 可展示
- approve/reject 可操作
- approval 结果可回流

产出：
- Approval Store
- ApprovalQueue
- ApprovalCard

---

### Phase 5：Memory Runtime

目标：
- memory stats 可查
- memory query 可用
- wisdom 可浏览

产出：
- Memory API
- MemoryExplorer

---

## 12. 非目标（第一版不做）

- 多用户账号体系
- 复杂 RBAC
- SSR / RSC
- 前端重型状态机框架主导设计
- 通用后台仪表盘模板
- 全量可观测平台

---

## 13. 风险与约束

### 13.1 Gateway 管理 API 尚不完整

当前 Gateway 主要支持：
- health
- metrics
- messages
- ws

但没有完整暴露：
- agents
- sessions
- approvals
- memory

因此第一版必须先补 Gateway REST。

参考：
- [src/integration/gateway/gateway.ts:80](/Users/jk/Projects/octopi/src/integration/gateway/gateway.ts:80)

---

### 13.2 Session 语义需要统一

当前 sessionKey 由 Gateway 内部构建，前端需要一个稳定的 session id 协议。

参考：
- [src/integration/gateway/gateway.ts:229](/Users/jk/Projects/octopi/src/integration/gateway/gateway.ts:229)
- [src/core/types/session.ts:9](/Users/jk/Projects/octopi/src/core/types/session.ts:9)

---

### 13.3 Tool 执行结果当前结构偏底层

当前事件中更多是 toolCallId / toolName / isError，前端需要补一层 ToolRun 模型。

参考：
- [src/integration/tui/app.ts:227](/Users/jk/Projects/octopi/src/integration/tui/app.ts:227)

---

## 14. 总结

Octopi 的 WebUI 应该被设计为：

**Web Runtime = Web Protocol SDK + Runtime State + UI Primitives**

而不是：

**WebUI = 普通前端框架 + 通用后台页面**

这样可以做到：

- 与 Octopi 分层一致
- 先把 Agent 交互语义做对
- 后续更容易演进成嵌入式 Web Runtime / Playground / Admin
- 避免前端架构过早绑架产品形态

---

## 15. 下一步建议

优先做这三件事：

1. **补齐 Gateway REST 契约**
2. **实现 Web Protocol SDK**
3. **实现 ChatWorkspace + Runtime Store**

其中，真正决定第一版质量的不是前端样式，而是：

- session 语义是否清晰
- tool run 是否可追踪
- approval 是否顺畅
- context / memory 是否可解释
- WS 状态是否稳定

这些才是 Octopi Web Runtime 的核心设计问题。
