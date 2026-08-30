# Octopi WebUI 会话显示模型设计

> 目标：把 WebUI 的会话显示从“事件驱动的临时文本”升级为“可回放、可切换、可解释的对话模型”。
>
> 背景：当前第一版 WebUI 已经能连通 Gateway、发消息、收流式结果，但会话显示仍存在两个典型问题：
> 1. 对话过程中，当前会话更容易呈现“最后结果”，而不是完整交互过程
> 2. 重新打开历史会话后，消息可能为空或结构不一致

---

## 1. 问题定义

### 1.1 现象

#### 现象 A：当前对话只看到最后结果
- 用户发消息后，assistant 最终回复存在
- 但中间的 tool 执行、重试、状态变化没有稳定沉淀为“可回看记录”
- 当前页面更像是“实时输出窗口”，而不是“对话记录”

#### 现象 B：重新打开历史会话后内容为空
- 左栏切回某个 session 时，中栏可能显示为空
- 说明当前 `openSession()` 读到的是 session raw messages，而不是整理后的 conversation view
- Web 端缺少对历史数据的统一解释层

---

## 2. 根因分析

### 2.1 WebUI 当前没有 conversation model
当前 WebUI 直接消费两种数据：
- `AgentEvent` 实时流
- `SessionMessages` 历史列表

但这两者都不能直接作为 UI 展示的“最终对话模型”。

### 2.2 实时流和历史消息语义不一致
实时流强调：
- 当前 run 状态
- partial content
- tool run 变化

历史消息强调：
- 已完成的 message sequence
- 可回放结果

如果前端不做 merge，就会出现：
- 过程中看起来不完整
- 回放时看起来不一致

### 2.3 当前 adapter 过于扁平
当前 Web Runtime Store 直接维护：
- `messages`
- `streamingContent`
- `tools`
- `inspector`

这些是运行时状态，不是 conversation view。

也就是说，现在只有 **runtime state**，没有 **conversation view model**。

参考：
- [src/integration/web/runtime/store.ts:167](/Users/jk/Projects/octopi/src/integration/web/runtime/store.ts:167)
- [src/harness/runner.ts:99](/Users/jk/Projects/octopi/src/harness/runner.ts:99)
- [src/harness/runner.ts:264](/Users/jk/Projects/octopi/src/harness/runner.ts:264)

---

## 3. 设计目标

### 3.1 对当前会话要“像对话，不像终端输出”
用户应能看到：
- user message
- assistant reply
- tool execution
- system notice
- 当前 streaming 状态

### 3.2 对历史会话要“可恢复，可解释”
用户切回 session 时，应看到：
- 稳定的对话记录
- assistant 历史结果
- tool 执行总结
- 可展开的 inspector

### 3.3 对进行中会话和历史会话要统一显示框架
不能一套逻辑专门给“当前”，另一套专门给“历史”。  
应通过 **view mode** 切换来复用同一套渲染组件。

---

## 4. 核心设计：三层消息模型

建议 WebUI 分三层：

```
Runtime Message Layer
Session History Layer
Conversation Merge Layer
```

---

### 4.1 Runtime Message Layer
负责当前 session 的实时交互展示。

数据来源：
- WS `event`
- WS `state`
- 当前 run 状态
- 当前 tool timeline
- 当前 streaming buffer

特点：
- 实时性强
- 允许临时状态
- 不要求立即等于最终历史

适合展示：
- user 发送
- assistant partial
- tool running
- inspector live status

---

### 4.2 Session History Layer
负责历史会话回放。

数据来源：
- REST `GET /sessions/:id/messages`
- Gateway session store
- 可选 turns/tool records

特点：
- 稳定
- 可分页
- 可恢复

适合展示：
- 已完成 user message
- 已完成 assistant message
- tool summary
- system notice

---

### 4.3 Conversation Merge Layer
负责把 runtime 和 history 统一成页面可展示的 view。

规则：

#### 当前 session + run running
优先展示 runtime view

#### 当前 session + run idle
展示 session history + 本地已沉淀结果

#### 切换到历史 session
直接展示 session history view

#### 历史 session + 收到新 runtime event
叠加 runtime overlay

---

## 5. Conversation View Model

WebUI 不应直接渲染 `Message[]` 或 `AgentEvent[]`。  
建议统一使用 `ConversationItem[]`。

```ts
type ConversationRole = 'user' | 'assistant' | 'tool' | 'system';

type ConversationItem =
  | UserConversationItem
  | AssistantConversationItem
  | ToolConversationItem
  | SystemConversationItem;

interface BaseConversationItem {
  id: string;
  role: ConversationRole;
  createdAt: number;
  sessionId: string;
  source: 'runtime' | 'history' | 'merged';
  focusable?: boolean;
}

interface UserConversationItem extends BaseConversationItem {
  role: 'user';
  content: string;
}

interface AssistantConversationItem extends BaseConversationItem {
  role: 'assistant';
  status: 'streaming' | 'completed' | 'error';
  content: string;
  toolCalls?: string[];
  toolResults?: string[];
  error?: string;
}

interface ToolConversationItem extends BaseConversationItem {
  role: 'tool';
  toolName: string;
  toolCallId: string;
  status: 'running' | 'success' | 'error';
  summary?: string;
  expandable?: boolean;
  args?: unknown;
  result?: unknown;
  error?: string;
}

interface SystemConversationItem extends BaseConversationItem {
  role: 'system';
  kind: 'info' | 'warning' | 'error' | 'retry' | 'truncated' | 'blocked' | 'aborted';
  message: string;
}
```

---

## 6. SessionView 扩展设计

建议前端维护一个 session view state：

```ts
interface SessionViewState {
  sessionId: string;
  agentId: string;
  mode: 'runtime' | 'history' | 'hybrid';
  runStatus: RunStatus;
  items: ConversationItem[];
  streaming: {
    active: boolean;
    content: string;
    assistantItemId?: string;
  };
  toolIndex: Record<string, string>; // toolCallId -> conversationItemId
  inspector: InspectorState;
  approvals: PendingApproval[];
}
```

---

## 7. Runtime -> Conversation 映射规则

### 7.1 用户发送
- 生成一条 `UserConversationItem`
- 立即进入 view

### 7.2 `llm_stream_delta`
- 如果没有 assistant streaming item，创建一条 `streaming`
- 持续追加 content
- source = `runtime`

### 7.3 `tool.exec.start`
- 插入一条 `ToolConversationItem`
- status = `running`
- 关联到当前 assistant item（可选）

### 7.4 `tool.exec.end`
- 更新对应 tool item
- status = success / error
- 填充 result / error

### 7.5 `turn.end`
- 将当前 assistant streaming item 转为 `completed`
- 如果 content 为空但有 tool history，保留 tool 纪录
- 清理 streaming buffer

### 7.6 `engine.end / aborted / error`
- 插入必要 system notice
- 重置 run overlay

---

## 8. History -> Conversation 映射规则

### 8.1 用户消息
直接映射为 `UserConversationItem`

### 8.2 Assistant 消息
映射为 `AssistantConversationItem`，status = `completed`

### 8.3 工具结果
映射为 `ToolConversationItem`，status = `success/error`

### 8.4 非文本 assistant content
当前 assistant content 可能是非字符串结构。  
建议第一版采用降级策略：
- 字符串：直接展示
- 数组：提取 text block
- 其他：JSON fallback

参考：
- [src/harness/runner.ts:99](/Users/jk/Projects/octopi/src/harness/runner.ts:99)

---

## 9. 当前设计缺陷与修正建议

### 9.1 `openSession()` 不应直接把 raw messages 当最终 conversation
当前实现直接把 `messages.messages` 当中栏内容。  
这会导致：
- runtime 和 history 不一致
- assistant/tool 结构无法稳定表达

建议：
- `openSession()` 只负责拉取原始数据
- 然后经过 `ConversationAdapter.buildHistoryView()` 转换

### 9.2 Runtime Store 不应承担 view 组装
当前 runtime store 同时承担：
- 连接状态
- session 管理
- chat messages
- tool timeline
- inspector

职责过重。  
建议拆分：
- `OctopiRuntimeStore`：协议与运行时状态
- `ConversationViewStore`：conversation items 与显示逻辑

### 9.3 当前 turn.end 过于“单值化”
当前更容易把 turn 当成单条 assistant text。  
但真实场景有：
- tool history
- partial retries
- security blocked
- truncated context

因此 view model 应支持多 item 沉淀，而不是“一条 assistant 文本打天下”。

---

## 10. View Mode 设计

建议支持三种模式：

### 10.1 `runtime`
用于当前 session、当前 run

优先展示：
- user
- assistant streaming
- active tool cards
- live inspector

---

### 10.2 `history`
用于历史 session、无 active run

优先展示：
- user
- assistant completed
- tool summary
- system notice

---

### 10.3 `hybrid`
用于“当前 session 重新打开”或“历史 session 收到新事件”

策略：
- 先加载 history view
- 再叠加 runtime overlay
- 如果同一 turn 已完成，替换为 completed item

---

## 11. 组件拆分建议

### 11.1 中栏主结构
- `ConversationPanel`
  - `ConversationList`
  - `StreamingOverlay`
  - `Composer`

### 11.2 item 组件
- `UserMessageCard`
- `AssistantMessageCard`
- `ToolRunCard`
- `SystemNoticeCard`

### 11.3 右栏联动
- `InspectorPanel`
- `ToolTimelinePanel`
- `ApprovalPanel`

---

## 12. 第一版落地范围建议

### Phase 1：建立 conversation view model ✅
- 定义 `ConversationItem`（`conversation/types.ts`）
- 实现 `ConversationAdapter`（`conversation/adapter.ts`）
- 替换当前 chat messages 渲染（`runtime/store.ts` 集成 adapter）

### Phase 2：区分 runtime / history ✅
- `openSession()` 改为 history view
- 当前会话改为 runtime view
- 切换 session 时维护 view mode（`history` / `runtime` / `hybrid`）
- ChatWorkspace 中栏改为渲染 `ConversationItem[]`

### Phase 3：补齐 tool / system item ✅
- tool 执行沉淀为 item（`agent-loop.ts` yield `tool_start` / `tool_end`）
- retry / truncated / blocked 沉淀为 system item
- 中栏 tool card 支持展开/折叠（args/result/summary）
- 右栏 Tools / Inspector 面板从 conversation items 派生

### Phase 4：补齐 hybrid 模式 ✅
- 历史 session 支持叠加 runtime overlay
- viewMode 状态机：`openSession→history`, `sendMessage→hybrid`, `applyEvent→hybrid`
- session conversation 本地缓存（切走再切回不丢失）
- 历史消息 tool 元数据提取（`msg.toolResults` / `msg.toolCalls`）

---

## 13. 实施顺序建议

1. **先做 ConversationAdapter**
   - `runtime events -> items`
   - `session messages -> items`

2. **再做 ConversationViewStore**
   - view mode
   - items
   - streaming overlay

3. **再改 ChatWorkspace**
   - 只消费 view model
   - 不再直接消费 raw messages / raw events

4. **最后补细节**
   - tool expand/collapse
   - inspector focus
   - approval focus

---

## 14. 对当前代码的具体建议

### 14.1 当前 `OctopiRuntimeStore.openSession()` 需要拆
当前：
- 加载 session view
- 加载 messages
- 直接赋值给 chat.messages

建议：
- 保留数据加载
- 增加 `buildHistoryView(sessionId, messages)`
- 渲染层只依赖 items

参考：
- [src/integration/web/runtime/store.ts:167](/Users/jk/Projects/octopi/src/integration/web/runtime/store.ts:167)

### 14.2 当前 runtime event mapping 需要 item 化
当前直接改：
- `messages`
- `tools`
- `inspector`

建议改为：
- 生成/更新 `ConversationItem`
- `messages` 只作为 legacy 状态或删除

参考：
- [src/integration/web/runtime/store.ts:246](/Users/jk/Projects/octopi/src/integration/web/runtime/store.ts:246)

### 14.3 当前 `assistant_message -> turn.end` 链路需要保留多态
当前实现偏“单文本结果”。  
Web 端应支持：
- assistant with tool history
- assistant with empty text but visible tool trace
- assistant with error/system notice

参考：
- [src/harness/runner.ts:99](/Users/jk/Projects/octopi/src/harness/runner.ts:99)
- [src/harness/runner.ts:264](/Users/jk/Projects/octopi/src/harness/runner.ts:264)

---

## 15. 结论

当前 WebUI 的会话显示问题，不是单纯的 UI bug，而是缺少一个 **conversation model 层**。

正确的解法不是继续在 runtime state 上补丁，而是引入：

- `ConversationItem`
- `ConversationAdapter`
- `ConversationViewStore`
- `View Mode (runtime / history / hybrid)`

这样 WebUI 才会从“实时事件面板”升级为“真正的对话工作台”。

---

## 16. 下一步建议

下一个新会话建议直接做这三步：

1. **定义 conversation view model**
2. **实现 ConversationAdapter**
3. **重构 ChatWorkspace 中栏为 view-model 驱动**

这三步做完，当前两个问题才会从根本上解决。
