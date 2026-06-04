# Tasks 模块

任务管理系统 — 自动追踪和管理多任务。

## 架构

```
tasks/
├── tracker.ts     # TaskTracker — 任务状态管理 + JSONL 持久化
├── task-manager.ts # TaskManager — LLM 决策器（解析 JSON 响应）
├── plugin.ts      # TaskManagerPlugin — Plugin 系统集成
├── shared.ts      # applyDecision — 共享函数
├── types.ts       # 类型定义（Task, TaskEvent, TaskDecision）
└── advisor.ts     # [deprecated] LoopAdvisor 模式（迁移中）
```

## 核心组件

### TaskTracker

任务状态管理 + JSONL 持久化。

```ts
const tracker = new TaskTracker('./data/tasks');

// 创建任务
const task = await tracker.create(sessionId, '分析重构效果');

// 状态变更
await tracker.interrupt(task.id, '用户发了新消息');
await tracker.resume(task.id);
await tracker.complete(task.id);
await tracker.cancel(task.id);

// 查询
const active = tracker.getActiveTasks(sessionId);
const interrupted = tracker.getInterruptedTasks(sessionId);

// 恢复 session 状态
await tracker.loadSession(sessionId);
```

**持久化格式：**

每个 session 有独立的 JSONL 文件：
```
data/
  <sessionId>/
    tasks.jsonl
```

事件类型：
- `create` — 创建任务
- `start` — 开始执行
- `interrupt` — 打断任务
- `resume` — 恢复任务
- `complete` — 完成任务
- `cancel` — 取消任务

### TaskManager

LLM 决策器 — 调用 LLM 分析任务状态并做出决策。

```ts
const manager = new TaskManager(provider, 'gpt-4o');

const decision = await manager.decide({
  sessionId,
  currentTasks: tracker.getActiveTasks(sessionId),
  newMessage: '帮我查天气',
  recentContext: '...',
});

// decision 包含：
// - interruptedTasks: 要打断的任务 ID 列表
// - resumeTask: 要恢复的任务 ID
// - completesTask: 要完成的任务 ID
// - cancelTask: 要取消的任务 ID
// - newTask: 新任务描述
// - injectTaskContext: 是否注入任务上下文
// - taskContext: 任务上下文文本
// - reason: 决策原因
```

**JSON 解析边界 case 处理：**

- LLM 输出多个 JSON 对象 → 取最后一个
- LLM 输出字段类型错误 → 使用默认值
- LLM 输出无 JSON → 返回默认决策
- LLM 输出 JSON 语法错误 → 返回默认决策

### TaskManagerPlugin

Plugin 系统集成 — 通过 `before_iteration` hook 自动执行任务管理。

```ts
const plugin = createTaskManagerPlugin(provider, {
  enabled: true,
  provider: 'openai',
  model: 'gpt-4o',
  dataDir: './data/tasks',
});

// 注册到 PluginManager
pluginManager.register(plugin);
```

**Hook 执行流程：**

1. `before_iteration`:
   - 加载 session 的任务状态（`loadSession`）
   - 调用 TaskManager LLM 做决策
   - 执行决策（interrupt, create, complete, resume, cancel）
   - 返回 `prependContext` 注入任务上下文

2. `after_iteration`:
   - 目前不做自动更新
   - 由 TaskManager LLM 在下一轮 before_iteration 中判断

## 使用示例

### 基础用法

```ts
import { TaskTracker } from './tasks/tracker.js';
import { TaskManager } from './tasks/task-manager.js';
import { applyDecision } from './tasks/shared.js';

const tracker = new TaskTracker('./data/tasks');
const manager = new TaskManager(provider, 'gpt-4o');

// 加载 session 状态
await tracker.loadSession(sessionId);

// 获取活跃任务
const currentTasks = tracker.getActiveTasks(sessionId);

// 调用 LLM 决策
const decision = await manager.decide({
  sessionId,
  currentTasks,
  newMessage: '用户消息',
  recentContext: '最近上下文',
});

// 执行决策
await applyDecision(tracker, sessionId, decision);
```

### Gateway 集成

```ts
import { Gateway } from './gateway/gateway.js';
import { createTaskManagerPlugin } from './tasks/plugin.js';

const gateway = new Gateway({ agents: [agent] });
gateway.registerProvider(openaiProvider);

// 注册 TaskManager plugin
const taskPlugin = createTaskManagerPlugin(openaiProvider, {
  enabled: true,
  provider: 'openai',
  model: 'gpt-4o',
  dataDir: './data/tasks',
});
gateway.getPluginManager().register(taskPlugin);

await gateway.start();
```

## Session 隔离

每个 session 有独立的任务状态和 JSONL 文件。

- `tracker.create(sessionId, ...)` — 任务绑定到特定 session
- `tracker.loadSession(sessionId)` — 只加载该 session 的任务
- `tracker.getActiveTasks(sessionId)` — 只返回该 session 的活跃任务

并发 session 操作安全：
- 不同 session 的任务上下文互不干扰
- 文件持久化路径独立（`data/<sessionId>/tasks.jsonl`）

## 测试覆盖

- `tests/task-system.test.ts` — CRUD + 持久化 + JSON 解析边界 case
- `tests/task-integration.test.ts` — Plugin 集成 + Session 隔离 + 并发压力测试

## 迁移状态

- `advisor.ts` — **deprecated**（LoopAdvisor 模式，迁移中）
- `shared.ts` — 新增（applyDecision 共享函数）

## 参考

- OpenClaw 的 `TaskTracker` 设计（持久化 + session 隔离）
- OpenClaw 的 `LoopAdvisor` 模式（迭代级 hook）