# 任务系统 (Task Management System)

## 设计理念

### 问题

Agent 天然活在"当前对话"里。用户说"帮我分析代码质量",Agent 开始干活,但用户突然问了句"天气怎么样",Agent 就把分析任务忘了。下次用户回来问"分析得怎么样了",Agent 一脸茫然——它不记得自己在干活。

这不是 Agent 笨,是它没有**工作记忆**。人有前额叶皮层管理"正在做的事",Agent 需要一个等价物。

### 目标

1. **对 Agent 透明** — 主 Agent 不需要"知道"任务系统的存在,它只需要在 system prompt 里看到"你有一个未完成的任务",然后自然地行动
2. **对用户透明** — 用户不需要说"继续任务",他们只需要正常说话,系统自动判断意图
3. **轻量决策** — 用一个小模型做消息分类,不做规则引擎,不写 if-else
4. **可插拔** — 通过 ContextPipeline Stage 或 Plugin 系统集成,零侵入 Agent Loop

## 架构

Task 系统有两种集成方式：

### 方式一：ContextPipeline TaskStage（推荐）

TaskStage 是 Task 系统在新架构中的主要集成方式。因为 Task 的本质是"上下文增强"——往 system prompt 注入任务上下文，让主 Agent 自然决定行为——它是 ContextPipeline 的一个 Stage，不是回调槽。

```
用户消息到达
    │
    ▼
ContextPipeline.process()
    │
    ▼
┌─────────────────────────────────────────────┐
│  TaskStage.process()                         │
│                                              │
│  1. tracker.loadSession(sessionId)           │
│  2. manager.decide(input) — LLM 决策         │
│  3. applyDecision(tracker, ...) — 更新状态   │
│  4. ctx.systemPrompt += taskContext           │
│                                              │
│  ┌─────────────┐    ┌─────────────────────┐  │
│  │ TaskTracker  │◄──│  TaskManager (LLM)  │  │
│  │ (状态管理)    │    │  (轻量决策器)        │  │
│  └──────┬──────┘    └─────────────────────┘  │
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

**管道阶段顺序：**
```
PersonaStage → SkillStage → TaskStage → HistoryStage → CompactStage → FilterStage
```

### 方式二：Plugin Hook（兼容层）

通过 TaskManagerPlugin 以 Plugin hook 方式集成，保留向后兼容。

```
用户消息到达
    │
    ▼
┌─────────────────────────────────────────────┐
│  before_iteration hook                       │
│                                              │
│  1. tracker.loadSession(sessionId)           │
│  2. manager.decide(input) — LLM 决策         │
│  3. applyDecision(tracker, ...) — 更新状态   │
│  4. 缓存 taskContext                         │
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
const task = await tracker.create(sessionId, '分析代码质量');

// 中断 (当用户发了无关消息时)
await tracker.interrupt(task.id, '用户发了新消息');

// 恢复 (当用户回来继续时)
await tracker.resume(task.id);

// 完成
await tracker.complete(task.id);

// 取消
await tracker.cancel(task.id);

// 查询
tracker.getActiveTasks(sessionId);      // in_progress + interrupted
tracker.getInterruptedTasks(sessionId);  // interrupted only
```

> **注意**: 所有 CRUD 方法均为异步（`async`），内部使用 `stat()` / `readFile()` / `appendFile()` 替代同步 I/O。

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
const manager = new TaskManager(provider, 'gpt-5.5-mini');

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

> **v0.1.1 变更**: 已从 OpenClaw per-message hook (`before_agent_reply`) 迁移到 Octopi 迭代级 hook (`before_iteration`)，适配 Octopi 独有的 hook 时机（每次 LLM 调用前而非每次用户消息前）。

**两个 Hook:**

| Hook | 时机 | 作用 |
|------|------|------|
| `before_iteration` | 每次 LLM 调用前 | 调用 TaskManager,更新状态,缓存 taskContext |
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

### 方式一：通过 AgentBuilder + TaskStage（推荐）

```ts
import { AgentBuilder } from 'octopi/harness';
import { TaskStage } from 'octopi/harness/context/stages/task-stage';
import { OpenAIProvider } from 'octopi/providers/openai';

const provider = new OpenAIProvider({ apiKey: '...' });

const { engine, runner } = await new AgentBuilder()
  .model(provider)
  .persona('./my-agent')
  .contextPipeline(new DefaultContextPipeline({
    stages: [
      new PersonaStage(),
      new SkillStage(),
      new TaskStage({           // Task 作为管道阶段注入
        provider: provider,
        model: 'gpt-5.5-mini',
        dataDir: './data/tasks',
      }),
      new HistoryStage(),
      new FilterStage(),
    ],
  }))
  .build();
```

### 方式二：通过 Plugin Hook（兼容层）

```ts
import { AgentBuilder } from 'octopi/harness';
import { createTaskManagerPlugin } from 'octopi/tasks/plugin';
import { OpenAIProvider } from 'octopi/providers/openai';

const provider = new OpenAIProvider({ apiKey: '...' });

const taskPlugin = createTaskManagerPlugin(provider, {
  enabled: true,
  model: 'gpt-5.5-mini',
  dataDir: './data/tasks',
});

const { engine, runner } = await new AgentBuilder()
  .model(provider)
  .persona('./my-agent')
  .plugin(taskPlugin)
  .build();
```

### 配置说明

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `provider` | 决策用的 ModelProvider | 必填 |
| `model` | 决策用的模型名称 | 必填 |
| `dataDir` | 任务数据持久化目录 | `./data/tasks` |
| `enabled` | 是否启用（仅 Plugin 方式） | `true` |

## 设计决策

### Q: 为什么不直接告诉主 LLM "你有任务"?

因为任务系统不应该改变主 Agent 的行为方式。主 Agent 不需要"知道"任务系统的存在——它只需要在 system prompt 里看到相关上下文,然后自然地行动。这样保持了 Agent 的通用性。

### Q: 为什么用轻量模型做决策?

消息分类是简单的语义理解任务。`gpt-5.5-mini` 级别的模型就能胜任,成本几乎为零。主 Agent 才需要用强模型做复杂推理。

### Q: 被中断的任务怎么恢复?

TaskManager 会判断用户的回归意图。当检测到用户在继续之前的话题时,`before_iteration` 会 `resume()` 任务,`before_prompt_build` 会注入包含恢复提示的上下文。主 Agent 看到上下文后,会自然地向用户确认是否继续。

### Q: 任务数据怎么存储?

JSONL append-only 文件,按 session 隔离。每行是一个事件(`create`, `interrupt`, `resume`, `complete`, `cancel`)。系统启动时从 JSONL 重放恢复状态。这种设计简单、可靠、可审计。

v0.1.1 起 `loadSession` 和 `appendEvent` 均改为异步，避免阻塞事件循环。

### Q: TaskStage 和 TaskManagerPlugin 有什么区别?

TaskStage 是新架构的集成方式，通过 ContextPipeline 的管道阶段注入任务上下文。TaskManagerPlugin 是旧的 Plugin hook 方式，通过 `before_iteration` + `before_prompt_build` 集成。

两者内部逻辑相同（都用 TaskTracker + TaskManager），区别在于集成位置：
- **TaskStage**：在 ContextPipeline 中，每次 `process()` 时执行
- **TaskManagerPlugin**：在 Plugin hook 链中，每次迭代时执行

新项目推荐使用 TaskStage，TaskManagerPlugin 保留向后兼容。

### Q: 子任务怎么办?

由主 Agent 自行管理。TaskTracker 只管主任务级别的状态。如果主 Agent 认为一个复杂任务需要拆解为多个子步骤,它可以在自己的上下文中管理,不需要任务系统介入。

### Q: 多任务并发怎么办?

一个 session 可以有多个活跃任务。TaskTracker 的 `getActiveTasks()` 返回所有 `in_progress` 和 `interrupted` 的任务,TaskManager 在决策时可以看到全部活跃任务。

## 与其他系统的协作

| 系统 | 关系 |
|------|------|
| **ContextPipeline** | TaskStage 作为管道阶段注入任务上下文（推荐） |
| **Plugin 系统** | TaskManagerPlugin 通过 `before_iteration` 和 `before_prompt_build` 集成（兼容层） |
| **Session 管理** | 任务按 session 隔离,随 session 生命周期管理 |
| **记忆系统** | 独立运作。记忆系统管长期知识,任务系统管当前工作 |
