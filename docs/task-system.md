# 任务系统 (Task Management System)

## 设计理念

### 问题

Agent 天然活在"当前对话"里。用户说"帮我分析代码质量",Agent 开始干活,但用户突然问了句"天气怎么样",Agent 就把分析任务忘了。下次用户回来问"分析得怎么样了",Agent 一脸茫然——它不记得自己在干活。

这不是 Agent 笨,是它没有**工作记忆**。人有前额叶皮层管理"正在做的事",Agent 需要一个等价物。

### 目标

1. **对 Agent 透明** — 主 Agent 不需要"知道"任务系统的存在,它只需要在 system prompt 里看到"你有一个未完成的任务",然后自然地行动
2. **对用户透明** — 用户不需要说"继续任务",他们只需要正常说话,系统自动判断意图
3. **轻量决策** — 用一个小模型做消息分类,不做规则引擎,不写 if-else
4. **可插拔** — 通过 Plugin 系统集成,零侵入 Agent Loop

## 架构

```
用户消息到达
    │
    ▼
┌─────────────────────────────────────────────┐
│  before_agent_reply hook                     │
│                                              │
│  ┌─────────────┐    ┌─────────────────────┐  │
│  │ TaskTracker  │◄──│  TaskManager (LLM)  │  │
│  │ (状态管理)    │    │  (轻量决策器)        │  │
│  └──────┬──────┘    └─────────────────────┘  │
│         │                                    │
│    更新任务状态                                │
│    缓存 taskContext                           │
└─────────┼────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────┐
│  before_prompt_build hook                    │
│                                              │
│  注入 taskContext 到 system prompt            │
└─────────┼────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────┐
│  主 Agent Loop (主 LLM 执行)                  │
│                                              │
│  主 LLM 看到 taskContext,自然地决定:          │
│  - 继续之前的工作                              │
│  - 向用户确认是否继续                          │
│  - 忽略(如果当前对话更重要)                    │
└─────────────────────────────────────────────┘
```

## 组件

### TaskTracker — 状态管理器

纯状态管理,不依赖 LLM。负责任务的 CRUD 和持久化。

**任务状态机:**

```
  ┌──────────┐
  │  创建     │
  └────┬─────┘
       │ create()
       ▼
  ┌──────────────┐   interrupt()   ┌──────────────┐
  │ in_progress  │ ───────────────►│  interrupted  │
  │  (进行中)    │                 │   (被中断)     │
  └──────┬───────┘ ◄───────────────┴──────┬───────┘
         │                  resume()      │
         │                                │
         │ cancel()                       │ cancel()
         ▼                                ▼
  ┌──────────────┐                ┌──────────────┐
  │  cancelled   │                │  cancelled   │
  │   (已取消)    │                │   (已取消)    │
  └──────────────┘                └──────────────┘

         │ complete()                     │ complete()
         ▼                                ▼
  ┌──────────────┐                ┌──────────────┐
  │  completed   │                │  completed   │
  │   (已完成)    │                │   (已完成)    │
  └──────────────┘                └──────────────┘
```

**API:**

```ts
const tracker = new TaskTracker(dataDir);

// 创建任务 (自动设为 in_progress)
const task = tracker.create(sessionId, '分析代码质量');

// 中断 (当用户发了无关消息时)
tracker.interrupt(task.id, '用户发了新消息');

// 恢复 (当用户回来继续时)
tracker.resume(task.id);

// 完成
tracker.complete(task.id);

// 取消
tracker.cancel(task.id);

// 查询
tracker.getActiveTasks(sessionId);      // in_progress + interrupted
tracker.getInterruptedTasks(sessionId);  // interrupted only
```

**持久化:** JSONL append-only 文件,每行一个事件。

```jsonl
{"ts":1749000000000,"taskId":"a1b2c3","action":"create","description":"分析代码质量","sessionId":"s1","status":"in_progress"}
{"ts":1749000005000,"taskId":"a1b2c3","action":"interrupt","status":"interrupted"}
{"ts":1749000010000,"taskId":"a1b2c3","action":"resume","status":"in_progress"}
{"ts":1749000015000,"taskId":"a1b2c3","action":"complete","status":"completed"}
```

### TaskManager — LLM 决策器

用一个**轻量模型**做消息分类。每次用户消息到达时,给它一个结构化 prompt,让它判断：

1. 这条消息和当前任务的关系是什么？(继续/无关/新任务/完成确认)
2. 要不要注入任务上下文？
3. 要不要中断/恢复/完成某个任务？

**调用方式:**

```ts
const manager = new TaskManager(provider, 'gpt-4o-mini');

const decision = await manager.decide({
  sessionId,
  currentTasks: tracker.getActiveTasks(sessionId),
  newMessage: userMessage,
  recentContext: recentMessages.map(format).join('\n'),
});
```

**决策输出:**

```ts
interface TaskDecision {
  // 是否向主 Agent 注入任务上下文
  injectTaskContext: boolean;
  // 要注入的上下文文本
  taskContext: string;
  // 要中断的任务 ID 列表
  interruptedTasks: string[];
  // 要新建的任务描述 (null = 不新建)
  newTask: string | null;
  // 判定完成的任务 ID (null = 不完成)
  completesTask: string | null;
  // 要恢复的任务 ID (null = 不恢复)
  resumeTask: string | null;
  // 决策原因
  reason: string;
}
```

**为什么用 LLM 而不是规则引擎？**

判断"这条消息和任务有没有关系"需要语义理解。"继续"、"接着来"、"那个代码分析怎么样了"都是继续信号;"算了不搞了"、"我换个方向"都是取消信号。规则引擎写不完,LLM 一个 few-shot prompt 就搞定了。

### TaskManagerPlugin — Hook 集成层

将 TaskTracker 和 TaskManager 接入 Agent Loop 的 Plugin 系统。

**两个 Hook:**

| Hook | 时机 | 作用 |
|------|------|------|
| `before_agent_reply` | 用户消息到达后,LLM 调用前 | 调用 TaskManager,更新状态,缓存 taskContext |
| `before_prompt_build` | Prompt 构建前 | 注入 taskContext 到 system prompt |

**恢复交互设计:**

当 TaskManager 判定要恢复一个被中断的任务时,注入的上下文会要求主 Agent 向用户说明情况并询问是否继续。这不是生硬的"请继续你的任务",而是一段自然的引导：

```xml
<task_context>
你有一个被中断的任务：分析代码质量。用户回来了,向用户说明你之前的进展和当前状态,并询问是否要继续。
</task_context>
```

主 Agent 看到这段上下文后,会自然地生成类似这样的回复：

> 你之前让我分析代码质量,我已经完成了静态分析部分,正在做依赖检查。要继续吗？

## 使用方式

### 基本配置

```ts
import { Octopi, AgentLoop, TaskManagerPlugin, TaskManager, TaskTracker } from '@asunaworks/octopi';

const octopi = new Octopi();

// 创建 Agent Loop
const agentLoop = new AgentLoop({
  sessionManager: octopi.getSessionManager(),
  llmRouter: octopi.getLLMRouter(),
});

// 注册任务管理插件
const taskPlugin = new TaskManagerPlugin(provider, {
  enabled: true,
  provider: 'openai',              // 决策用的 provider
  model: 'gpt-4o-mini',            // 轻量模型即可
  dataDir: './data/tasks',         // 持久化目录
});
agentLoop.registerPlugin(taskPlugin);

const gateway = new Gateway({
  agentLoop,
  channels: [wechatAdapter],
});
```

### 配置说明

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `enabled` | 是否启用任务系统 | `true` |
| `provider` | 决策用的 provider 名称 | 必填 |
| `model` | 决策用的模型名称 | 必填 |
| `dataDir` | 任务数据持久化目录 | `./data/tasks` |

### 禁用任务系统

```ts
const taskPlugin = new TaskManagerPlugin(provider, {
  enabled: false,  // 完全禁用,零开销
  provider: 'openai',
  model: 'gpt-4o-mini',
  dataDir: './data/tasks',
});
```

## 设计决策

### Q: 为什么不直接告诉主 LLM "你有任务"?

因为任务系统不应该改变主 Agent 的行为方式。主 Agent 不需要"知道"任务系统的存在——它只需要在 system prompt 里看到相关上下文,然后自然地行动。这样保持了 Agent 的通用性。

### Q: 为什么用轻量模型做决策?

消息分类是简单的语义理解任务。`gpt-4o-mini` 级别的模型就能胜任,成本几乎为零。主 Agent 才需要用强模型做复杂推理。

### Q: 被中断的任务怎么恢复?

TaskManager 会判断用户的回归意图。当检测到用户在继续之前的话题时,`before_agent_reply` 会 `resume()` 任务,`before_prompt_build` 会注入包含恢复提示的上下文。主 Agent 看到上下文后,会自然地向用户确认是否继续。

### Q: 任务数据怎么存储?

JSONL append-only 文件,按 session 隔离。每行是一个事件(`create`, `interrupt`, `resume`, `complete`, `cancel`)。系统启动时从 JSONL 重放恢复状态。这种设计简单、可靠、可审计。

### Q: 子任务怎么办?

由主 Agent 自行管理。TaskTracker 只管主任务级别的状态。如果主 Agent 认为一个复杂任务需要拆解为多个子步骤,它可以在自己的上下文中管理,不需要任务系统介入。

### Q: 多任务并发怎么办?

一个 session 可以有多个活跃任务。TaskTracker 的 `getActiveTasks()` 返回所有 `in_progress` 和 `interrupted` 的任务,TaskManager 在决策时可以看到全部活跃任务。

## 与其他系统的协作

| 系统 | 关系 |
|------|------|
| **Plugin 系统** | TaskManagerPlugin 通过 `before_agent_reply` 和 `before_prompt_build` 集成 |
| **Session 管理** | 任务按 session 隔离,随 session 生命周期管理 |
| **Context Engine** | 通过 `before_prompt_build` 注入任务上下文到 system prompt |
| **记忆系统** | 独立运作。记忆系统管长期知识,任务系统管当前工作 |
