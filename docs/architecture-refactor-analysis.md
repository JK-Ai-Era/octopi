# Agent Loop 架构重构分析

> **状态**: ✅ 已完成 — v0.1.2 (2026-06-04)
>
> - Phase 1: advisor.ts 删除 ✅
> - Phase 2: plugin.ts 迁移到迭代级 hook ✅
> - Phase 3: TaskTracker 异步化 ✅
> - Phase 4: applyDecision 去重（shared.ts）✅
> - Phase 5: AgentLoop → AgentRunner 命名区分 ✅
> - Phase 6: 测试补充（148 tests）✅
> - Phase 7: 文档更新 ✅
>
> **最终结论**: 采用方向 C（简化——去掉 Advisor，统一使用 Plugin hook），已实施完成。

## 一、现状：三个系统各自为政

### 1. Task 系统 (`src/tasks/`)
**职责**：追踪用户的多步任务（创建、中断、恢复、完成、取消）

```
用户说"帮我写个网站" → TaskManager LLM 判断 → 创建任务
用户说"算了先吃饭"   → TaskManager LLM 判断 → 中断任务
用户说"继续写网站"   → TaskManager LLM 判断 → 恢复任务
```

组件：
- `TaskTracker`：纯状态管理（CRUD + JSONL 持久化）
- `TaskManager`：轻量 LLM 决策器（分类问题，不是生成问题）
- `TaskManagerPlugin`：通过 Plugin hooks 集成到 `src/agent/`
- `TaskManagerAdvisor`：通过 LoopAdvisor 集成到 `src/loop/`

**问题**：Task 系统写了两套集成层——Plugin 版和 Advisor 版。

### 2. Advisor 系统 (`src/loop/` 中的 LoopAdvisor)
**设计理念**：让外部模块参与 Agent Loop 的每轮决策

```typescript
interface LoopAdvisor {
  beforeTurn(ctx): MetaDecision;   // 每轮开始前
  afterTurn(ctx, result): void;    // 每轮结束后
  onSteering(messages): MetaDecision;  // 新消息到达时
  onLoopEnd(ctx): void;            // 循环结束时
}
```

MetaDecision 可以：
- 注入消息（`injectMessages`）
- 注入任务上下文到 system prompt（`taskContext`）
- 覆盖模型/thinking/maxTokens
- 决定停止循环（`shouldStop`）

**只有 `src/loop/` 用了，`src/agent/` 没有。**

### 3. Agent Loop
两个实现：

| | `src/loop/agent-loop.ts` | `src/agent/agent-loop.ts` |
|---|---|---|
| **形式** | `runAgentLoop()` 异步生成器 | `AgentLoop` 类 |
| **被 Gateway 用** | ❌ | ✅ |
| **错误重试** | ✅ classifyError + 指数退避 | ❌ |
| **迭代预算** | ✅ IterationBudget | ❌ |
| **工具防护** | ✅ 验证/去重/截断检测 | ❌ |
| **Advisor** | ✅ 完整集成 | ❌ |
| **Plugin hooks** | ❌ | ✅ |
| **Session 管理** | ❌ | ✅ |
| **Skill 系统** | ❌ | ✅ |

## 二、核心问题

**`src/loop/` 是为 Advisor 设计的，但 Gateway 用的是 `src/agent/`。**

结果：
- Task 系统写了两套集成（Plugin + Advisor），功能重复
- Advisor 的生命周期比 Plugin 更完整（有 afterTurn、onLoopEnd），但没人用
- `src/agent/` 缺少 `src/loop/` 的健壮性（重试、预算、防护）

## 三、设计方向

### 核心原则：分层，不是合并

```
┌─────────────────────────────────────────────┐
│              Task Manager                    │  ← 业务层（一个具体模块）
├─────────────────────────────────────────────┤
│              Hook System                     │  ← 扩展层（统一的扩展点）
├─────────────────────────────────────────────┤
│           Agent Loop (robust)                │  ← 执行层（带防护的核心循环）
├─────────────────────────────────────────────┤
│    Session / Context / Skills / Providers    │  ← 基础层
└─────────────────────────────────────────────┘
```

### 方向 A：Plugin 吸收 Advisor

把 Advisor 的完整生命周期合并到 Plugin 系统：

```typescript
// 现有 Plugin hooks
'before_agent_reply'    → 每条消息到达时
'before_prompt_build'   → 构建 prompt 前

// 新增（来自 Advisor）
'before_turn'           → 每轮 LLM 调用前
'after_turn'            → 每轮 LLM 调用后
'on_loop_end'           → 循环结束时
'on_steering'           → Steering 消息到达时
```

统一的 Hook 返回值：
```typescript
interface HookResult {
  // 是否拦截（不继续执行后续 hooks 和主流程）
  intercept?: { response: string };
  // 注入上下文
  prependContext?: string;
  // 覆盖参数
  overrideModel?: string;
  overrideThinking?: string;
  overrideMaxTokens?: number;
  // 停止循环
  shouldStop?: boolean;
  stopReason?: string;
}
```

优点：
- 一个统一的扩展机制，不维护两套
- Plugin 已经有 `register(api)` 的注册模式，扩展自然
- Task Manager 只需要一个 Plugin 实现

缺点：
- Plugin 的 `api.on()` 回调签名需要扩展支持新的 lifecycle events
- 需要处理 hooks 之间的优先级和冲突

### 方向 B：保留双轨，明确分工

```
Plugin hooks → "我在意每条消息"（渠道适配、持久化、日志）
LoopAdvisor → "我在意循环策略"（任务管理、安全策略、预算控制）
```

Plugin 处理"数据流"——消息过滤、格式转换、持久化。
Advisor 处理"决策流"——是否中断、是否停止、是否覆盖参数。

优点：
- 职责清晰，两类扩展点的语义不同
- 不需要改 Plugin 系统

缺点：
- 两套扩展机制，学习成本高
- Task Manager 的逻辑需要知道放在哪边

### 方向 C：简化——去掉 Advisor，Plugin + 直接编码

核心循环自己处理策略，不外挂 Advisor：

```typescript
// Agent Loop 内部
async processMessage(...) {
  // 1. TaskManager 直接注入（作为 loop 的一部分，不是 hook）
  const taskDecision = await this.taskManager.decide(...);
  if (taskDecision.taskContext) injectContext(taskDecision.taskContext);

  // 2. Plugin hooks 处理数据流
  await this.plugins.emit('before_agent_reply', ...);

  // 3. 核心循环（带防护）
  while (budget.hasRemaining()) {
    const response = await this.callLLM(...);
    if (!response.toolCalls) break;
    await this.executeTools(...);
  }
}
```

优点：
- 最简单，没有抽象层
- 容易理解执行顺序

缺点：
- 扩展性差，每加一个功能都要改 loop 本身
- 不符合开闭原则

## 四、我的初步判断

**倾向方向 A（Plugin 吸收 Advisor）**，原因：

1. **消除双轨**：Task Manager 不需要维护 Plugin + Advisor 两套集成
2. **统一扩展点**：未来加新功能只需要实现 Plugin，不用想"该用 Plugin 还是 Advisor"
3. **保留完整生命周期**：Advisor 的 afterTurn / onLoopEnd 语义有价值，合并到 Plugin 不丢失
4. **Gateway 统一**：只需要维护一个 Agent Loop 实现

**关键决策**：
- Plugin hooks 是否需要返回 MetaDecision？还是用独立的 "Hook 返回值" 类型？
- 多个 hooks 的冲突如何处理？（比如一个 hook 要 stop，另一个要 override model）
- `src/loop/` 的健壮性（重试、预算、防护）是否可以直接合并到 `src/agent/`？

## 五、需要大哥决策的问题

1. **方向选择**：A（Plugin 吸收 Advisor）/ B（双轨）/ C（去掉 Advisor）？
2. **如果选 A**：Plugin 的 hook 返回值怎么设计？需要统一的 MetaDecision 还是每个 hook 独立的返回类型？
3. **Task Manager 的定位**：它是"框架内置能力"还是"通过 Plugin 扩展的外部模块"？这决定了它是否需要特殊的 loop 集成。
4. **`src/loop/` 的去留**：如果合并到 `src/agent/`，原来的 `runAgentLoop` 是否可以删掉？
