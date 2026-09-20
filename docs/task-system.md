# SessionTask（会话任务）

> **地位**：会话任务的**唯一设计基准**。实现、命名、测试与此冲突时以本文为准。  
> 其余曾被塞进 `task-system` 的模块见 [docs/domain-split.md](./domain-split.md)。  
> 最后更新：2026-06-12

---

## 1. 问题

Agent 活在「当前对话」里。用户委托了一件多轮才能做完的事，中途插一句无关话，Agent 就忘了自己在干什么。

需要的不是新的「任务运行时」，而是：

> 在 **Session 聚合**上维护一份**未闭合工作项列表（两级：goal / step）**，每轮让主 LLM 看见 goal（步骤只 rollup），由主 LLM 用工具收放。

---

## 2. 概念定位

| 层 | 载体 | 含义 |
|----|------|------|
| 当下对话 | `Session.messages` | 工作记忆（scratchpad） |
| **未闭合工作项** | **`Session.tasks`** | **本设计（SessionTask）** |
| 跨会话沉淀 | Memory 子系统 | 长期记忆 |

**不是**与 Session 并列的「工作记忆领域」，**不是**执行原语（`AsyncTask`），**不是**编排实例，**不是**过程监督。

一句话：**会话任务列表挂在 Session 上；goal 是用户委托，step 是该委托下的执行计划（depth=1）。**

---

## 3. 目标与非目标

### 目标

| # | 目标 |
|---|------|
| G1 | 主 LLM 每轮能看见未闭合任务 |
| G2 | 用户用自然语言增删改任务；由 LLM 调工具落实 |
| G3 | 状态可实时投影到 UI（**只读**） |
| G4 | 单一写入路径，避免与对话上下文分叉 |
| G5 | 随 Session 一起持久化与恢复 |
| G6 | 复杂任务可挂**步骤列表**，UI 可展示进度；注入保持精简 |

### 非目标

- 不做 UI 直接 PATCH 任务状态（见 §7）
- 不做每条用户消息的侧车 LLM 分类/抽任务
- 不做与 Workflow/AsyncTask 共用状态机
- 不做跨会话任务同步（归 Memory / 产品层另议）
- 不做 depth>1 的任务树
- 不把全部 step 描述默认注入 system prompt

---

## 4. 写入模型（核心决策）

```text
用户说话 ──► 主 LLM（完整上下文）──► task_* 工具 ──► SessionTaskService
                                                      │
                                                      ├─► SessionStore
                                                      └─► EventBus session.task.*
                                                              │
                                                              ▼
                                                         UI 只读面板
```

| 路径 | 是否允许 | 说明 |
|------|----------|------|
| 主 LLM 调用 `task_*` | **唯一业务写入** | 增删改、状态迁移 |
| 系统生命周期钩子 | 允许（窄） | 如会话归档时批量 drop 仍 open 的任务；不解析语义 |
| 用户 UI 直接改状态/内容 | **不允许（v1）** | 改任务请对 Agent 说 |
| 侧车模型每条消息改任务 | **不允许（默认）** | 避免双写与静默失败 |

**为何砍掉 UI 直写：**

1. 任务变更必须带对话语境；LLM 手上有完整 messages，UI 没有。
2. 多写入方会引入「面板已 done、回复仍写进行中」、中途撤销、幂等协议等复杂度，收益主要是省几次打字。
3. 产品形态是对话优先：用户说「把代码分析标成完成」「跳过第 4 步」即可；一致性由「谁看见上下文谁改」保证。

UI 若要快捷操作，应做成**把自然语言发进会话**（快捷短语按钮），而不是绕过 LLM 写 Store。

---

## 5. 状态机与两级结构

### 5.1 两级模型

```text
Session.tasks
├── goal     parentId 为空     用户级委托（列表主条目）
│    ├── step  parentId=goal   执行计划项
│    └── step
└── goal
```

| 约定 | 说明 |
|------|------|
| depth = 1 | step 下禁止再挂子项 |
| 无 step 合法 | 简单任务不必拆解 |
| step 不单独开域 | 与 goal 同表、同 Service、同事件 |

### 5.2 状态迁移

```text
        task_create
            │
            ▼
        ┌───────┐   task_complete    ┌───────┐
        │ open  │ ─────────────────► │ done  │
        └───┬───┘                    └───────┘
            │  ▲                         ▲
     task_pause │ task_resume             │
            ▼  │                          │
        ┌────────┐   task_complete        │
        │ paused │ ───────────────────────┘
        └───┬────┘
            │ task_drop
            ▼
        ┌─────────┐
        │ dropped │
        └─────────┘
```

| 状态 | 含义 | 注入？ |
|------|------|--------|
| `open` | 未完成 | goal：是；step：不单列，进 rollup |
| `paused` | 显式暂停 | goal：是；step：可 rollup 提及 |
| `done` | 已完成 | 否 |
| `dropped` | 已放弃 | 否 |

**goal / step 附加规则**

- goal `complete` 必须由 Agent **显式**调用；**不**因最后一个 step 变 done 而自动完成（步骤齐了可能仍差结论/交付物）。
- goal `drop` 时 Service **级联** drop 仍 `open`/`paused` 的子 step。
- 约定同一 goal 下至多一个 step 为「当前步」（最小 `order` 的 open）；UI 高亮即可，Service 不强约束并发 open 数量（v1）。
- 终态不回迁；重做则新建。

---

## 6. 数据模型

```ts
/** Session 聚合扩展 */
interface SessionData {
  // ...既有字段
  tasks: SessionTask[]; // 默认 []
}

interface SessionTask {
  id: string;
  /** 空/缺省 → goal；有值 → 所属 goal 的 step */
  parentId?: string;
  description: string;
  status: 'open' | 'paused' | 'done' | 'dropped';
  /** Agent 维护的简短进展，仅展示用 */
  progressNote?: string;
  /** step 展示顺序；goal 可忽略 */
  order?: number;
  createdAt: number;
  updatedAt: number;
}
```

**持久化**：随 `SessionStore` 一起保存。  
**禁止**独立的 `data/tasks/**/tasks.jsonl`、禁止第二套 `loadSession`。

迁移期：旧 JSONL 可一次性导入 `Session.tasks`（旧条目视为 goal），之后只读 SessionStore。

---

## 7. UI 穿透（只读，两级）

任务列表是 Session 的结构化状态，**不是**从 assistant 文案里解析的 checklist。

```text
[open] 分析代码质量并输出报告           ← goal
         ✓ 1. 扫描模块结构
         ✓ 2. 静态分析
         → 3. 检查循环依赖              ← 当前 step
         · 4. 汇总风险点
         · 5. 生成报告
```

| 通道 | 用途 |
|------|------|
| `session.task.snapshot` | 打开会话时全量（含 step，由 UI 组树） |
| `session.task.updated` | 单条变更（goal 或 step） |
| `GET /sessions/:id/tasks` | 刷新 / 历史 |

约定：

- 面板以 **Store 中的 SessionTask 为准**；聊天叙述可以短暂口语化。
- step 事件驱动刷新 → 复杂任务的「实时进度」体感来自步骤，不是改 goal 状态。
- 变更事件在 Service 写 Store **成功之后**发出。
- v1 **不提供** `PATCH .../tasks/:id` 业务接口。
- 快捷按钮（可选）：向会话发送预置用户消息，仍走主 LLM。

---

## 8. 每轮数据流

```text
SessionAwareRunner.handle(userMessage)
  1. session.messages.push(user)
  2. 渲染注入（仅 goal + step rollup，见 §9）
  3. 主 Agent Loop
       · task_* 工具维护 goal/step
       · 工具 → SessionTaskService → Store → emit
  4. 保存 Session（含 tasks）
```

注入仅在 **run 开始**一次；本轮内不再重读列表。工具在本轮内改的状态，**下一轮**注入自然反映。需要 step 全量时 Agent 调 `task_list`（进对话工具结果，不进 system 注入）。

---

## 9. 注入文案（goal + rollup）

**默认不罗列全部 step**，避免 system prompt 被计划项淹没。

```xml
<session_tasks>
当前会话未完成任务：

- [g1] open | 分析代码质量并输出报告
      进度：步骤 2/5（当前：检查循环依赖）
      进展：静态分析已完成
- [g2] paused | 整理发布说明草稿

说明：
- 用户要求继续或话题回归时，可恢复对应任务或先说明进展。
- 与当前消息无关时，优先处理当前消息，不要强行续做。
- 完成或放弃时请调用 task_complete / task_drop，保持列表与对话一致。
</session_tasks>
```

渲染规则：

1. 只列出 `parentId` 为空且 status ∈ {open, paused} 的 goal。  
2. 若有子 step：追加 `进度：done+dropped / total（当前：order 最小的 open step 描述）`。  
3. step 的 `progressNote` 不进入注入（避免膨胀）。  

原则：只陈述事实与工具义务，不规定「必须继续」。

---

## 10. 工具

| 工具 | 参数 | 行为 |
|------|------|------|
| `task_list` | `status?`, `parent_id?` | 列出任务；默认可含子项摘要 |
| `task_create` | `description`, `parent_id?` | 无 parent → goal；有 → step |
| `task_plan` | `goal_id`, `steps: string[]` | 一次创建有序 step（推荐复杂任务使用） |
| `task_complete` | `task_id`, `progress_note?` | → `done`（goal/step 通用） |
| `task_pause` | `task_id`, `reason?` | → `paused` |
| `task_resume` | `task_id` | `paused` → `open` |
| `task_drop` | `task_id`, `reason?` | → `dropped`；goal 级联 drop 未闭合 step |
| `task_note` | `task_id`, `progress_note` | 仅更新进展，不改状态 |

约定：

- 工厂注入 **唯一** `SessionTaskService`（基于当前 `SessionData`）。
- 错误必须带 message（如 `Task not found: ${id}`）；禁止 `throw new Error()`。
- 非法迁移：返回明确错误，由模型纠正。
- **幂等（建议）**：对已 `done` 再 `complete`、已 `dropped` 再 `drop` → 成功 no-op。

---

## 11. SessionTaskService

Harness 内唯一写入口（工具与系统钩子共用）：

```ts
interface SessionTaskService {
  list(sessionId: string, opts?: { parentId?: string; status?: SessionTask['status'] }): SessionTask[];
  listActiveGoals(sessionId: string): SessionTask[];
  create(sessionId: string, description: string, parentId?: string): Promise<SessionTask>;
  /** 仅当 goal 存在且未终态时创建；按数组顺序写 order=0..n-1 */
  plan(sessionId: string, goalId: string, steps: string[]): Promise<SessionTask[]>;
  complete(sessionId: string, taskId: string, progressNote?: string): Promise<SessionTask>;
  pause(sessionId: string, taskId: string, reason?: string): Promise<SessionTask>;
  resume(sessionId: string, taskId: string): Promise<SessionTask>;
  drop(sessionId: string, taskId: string, reason?: string): Promise<SessionTask>;
  note(sessionId: string, taskId: string, progressNote: string): Promise<SessionTask>;
}
```

实现要点：

- 读写当前 `SessionData.tasks`，经 `SessionStore` 持久化。
- 状态机与 goal 级联 drop 在 Service 内，不在工具 handler 散落。
- `parentId` 必须指向存在的 goal，否则报错。
- 成功后 `emit` 任务事件；失败不发。

---

## 12. System Prompt 约定（给主 LLM）

```text
你可以用 task_* 工具维护「会话任务列表」。

- goal：用户级委托。多轮才能完成的委托先 task_create，再开工。
- step：复杂任务的执行计划。可用 task_plan(goal_id, steps) 或 task_create(parent_id) 登记；
  每完成一步 task_complete(step_id)；收尾时再显式 task_complete(goal_id)。
- 用户明确不做了：task_drop；暂时搁置：task_pause；要继续：task_resume。
- 推进中可用 task_note 记一句进展。
- 琐碎的单轮问答不要建任务。
- 用户用自然语言要求增删改任务/步骤时，调用对应工具落实，不要只在回复里口头答应。
```

---

## 13. 一致性说明（有意取舍）

| 现象 | 是否问题 | 处理 |
|------|----------|------|
| Agent 文案说「正在做」，列表已是 open | 否 | 列表是意图真相；叙述可口语化 |
| 本轮刚 create，注入要下一轮才有 | 否 | 注入在 run 开始；工具是本轮执行体 |
| 模型忘调工具只在正文写「记下了」 | 是 | 靠 §12 prompt；测试抽查；必要时工具结果回显强制 |
| 用户在 UI 看到列表想改 | — | **对 Agent 说**；或点快捷消息按钮 |

不引入：version/CAS、run 中 revocation、双写入方对齐、侧车对齐。

---

## 14. 与旧设计映射

| 旧 | 新 |
|----|----|
| `TaskTracker` + 独立 JSONL | `Session.tasks` + `SessionTaskService` |
| `TaskManager`（每条消息 LLM） | 删除（默认无） |
| `DefaultTaskDecisionProvider` | Runner 内渲染注入（无独立 Provider 也可；若保留接口则仅为渲染钩子） |
| `task_create/list/update` | 保留语义，handler 改走 Service；补全错误信息 |
| `interrupted` 状态 | 删除 |
| `harness/task-system/tasks/` | 迁至 `harness/session-tasks/` 或并入 session 模块 |
| UI 直写任务 API | 不提供 |

---

## 15. 测试基准

1. 空 `tasks` → 不注入。  
2. `task_create`（无 parent）后为 goal，下一轮注入含该条目。  
3. `task_create` / `task_plan` 建 step：挂在正确 goal 下，`order` 正确。  
4. 注入**不**罗列全部 step，只含 `进度：x/y（当前：…）` rollup。  
5. `task_complete` goal 后不再注入；step 完成只改 rollup，goal 仍注入。  
6. **不**自动 complete：全部 step done 后 goal 仍为 open，直到显式 complete。  
7. goal `drop` 级联 drop 未闭合 step，并发事件。  
8. pause/resume/drop 状态与注入一致。  
9. 工具非法迁移 / `parent_id` 不存在 → 明确错误。  
10. 事件：goal/step 变更均发出 `session.task.updated`。  
11. 同一 Service：工具写入后 `list` 可见（无双 Store）。  
12. 重载 Session 后 `tasks`（含 step）仍在。  
13. 连续两轮注入，`session_tasks` 块不叠写进同一 prompt 基底。

---

## 16. 设计决策（ADR）

| ID | 决策 | 理由 |
|----|------|------|
| A1 | 挂在 Session 上，不叫 WorkingMemory 领域 | 避免与 messages / 第二 Store 概念撞车 |
| A2 | 命名 SessionTask，禁止裸 Task | 与 AsyncTask 等隔离 |
| A3 | **仅主 LLM 工具写入** | 变更必须带上下文；砍多写入方复杂度 |
| A4 | UI 只读穿透 | 可见性要；直写会分叉 |
| A5 | turn-start 注入一次 | prompt 稳定，接受本轮内略旧 |
| A6 | 无侧车默认分类 | 去掉延迟与静默失败 |
| A7 | 持久化并入 SessionStore | 单真相源 |
| A8 | **两级 goal/step，depth=1** | 进度可见 + 可恢复；禁止树蔓延 |
| A9 | **注入只 rollup step** | 避免计划项淹没 system prompt |
| A10 | goal 不自动 complete | 步骤齐 ≠ 交付齐 |

---

## 17. 落地顺序

1. `SessionData.tasks` + `SessionTask` 类型。  
2. `SessionTaskService`（状态机 + Store + 事件）。  
3. 工具改接 Service；错误信息补全。  
4. Runner 注入渲染 `<session_tasks>`。  
5. Gateway/Web 暴露只读任务 API / 事件。  
6. 删除旧 Tracker JSONL / TaskManager 默认路径。  
7. 按 [domain-split.md](./domain-split.md) 拆走 run-guard / orchestration。

---

## 18. 相关文档

| 文档 | 关系 |
|------|------|
| [domain-split.md](./domain-split.md) | 其余模块领域切分 |
| [docs/web-conversation-model-design.md](web-conversation-model-design.md) | UI 任务面板可作为 conversation view 一部分 |
| [架构宪法](./north-star.md) | 长期不变量（含分层与 Run 作用域） |
