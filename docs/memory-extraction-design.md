# Session → Memory 提取设计（完整方案）

> 目标：基于 octopi 自主子系统架构，设计一套**可落地、可扩展、多语言友好**的记忆提取方案。
>
> 核心原则：不依赖“自然语言规则覆盖”，而是依赖“结构化事件 + 语义特征 + 记忆策略”。

---

## 0. 总体定位

把“从 session 提取 memory”定义为一个**自治子系统**，职责是：

1. 从 session 中提取**结构化证据**（不是全量总结）
2. 生成**结构化记忆候选**（MemoryCandidate）
3. 入库到现有 MemoryStore（不新建存储范式）

推荐子系统目录：

- `harness/autonomous-subsystem/subsystems/memory-extractor`
- 或先做内置实现：`harness/memory/extraction/session-memory-extractor.ts`

与七层模型对齐：
- 这个子系统负责 `Information → Memory`
- 后续 `Memory → Cognition / Wisdom` 由独立子系统负责（解耦）

---

## 1. 设计目标（Definition of Done）

### 1.1 可回放
- 每次提取都基于 `SessionExtractEvent[]`，而不是原始 messages
- 可重跑、可回归测试、可审计

### 1.2 多语言友好
- 规则层不直接匹配自然语言
- 语义特征层承担“确认/否定/重复/冲突”判断
- 新语言增加时，主要调模型/特征，不改规则骨架

### 1.3 成本可控
- 支持增量提取（只处理 delta）
- 长 session 不全量 LLM，只做局部精炼
- 高噪声内容在入记忆前被筛掉

### 1.4 与现有架构一致
- 复用 `MemoryStore` 接口（`harness/memory/types.ts`）
- 复用 session 生命周期（`SessionLifecycleStatus` / `MemoryExtractionStatus`）
- 通过 autonomous subsystem 的 Sense/Think/Act/Signal 闭环运行

---

## 2. 整体架构（三层）

```
┌──────────────────────────────────────────────────┐
│ Event Layer（确定性、可回放）                        │
│  - SessionExtractEvent                            │
│  - 来源：runner/session/task/tool/error lifecycle │
└──────────────────────┬───────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────┐
│ Semantic Layer（语言无关）                          │
│  - embedding similarity                           │
│  - polarity（confirm / reject / neutral）         │
│  - repetition / contradiction / drift detection   │
└──────────────────────┬───────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────┐
│ Memory Policy Layer（策略层）                       │
│  - 记忆类型决策（preference/decision/lesson...）    │
│  - 置信度/重要性计算                                │
│  - 去重、升级、衰减                                 │
│  - 入库 / 跳过 / 冲突覆盖                           │
└──────────────────────────────────────────────────┘
```

关键点：
- **Event Layer 负责“发生了什么”**
- **Semantic Layer 负责“语义上是什么”**
- **Policy Layer 负责“要不要记住”**

这三层解耦后，规则难度显著下降。

---

## 3. 触发机制（含人类特殊场景）

### 3.1 默认触发
优先在 session 生命周期边界触发：

- `session_end`（主触发）
- `recent` 且 `memoryExtraction == 'pending'`（批量补齐）

参考现有生命周期字段：
- `src/harness/session-types.ts`：`SessionLifecycleStatus` / `MemoryExtractionStatus`

### 3.2 半场触发（Human Resume）
当 session 仍在 `active`，但：
- `idle > threshold`（例如 60 分钟无交互）
- 出现明显目标漂移（`goal_change`）

此时做一次“半场提取（soft）”，避免中间态记忆丢失。

### 3.3 高价值事件触发（Event-driven）
以下事件到达时触发局部提取（不必等 session_end）：

- `user_confirm`（用户明确确认）
- `user_reject`（用户明确否定）
- `goal_change`（目标/优先级改变）
- `decision_made`（方案落地）
- `fix_applied`（错误修复成功）

### 3.4 Task 生命周期触发（可选）
如果后续接入 task 系统：
- `task_complete` / `task_cancel` 时触发 task 级 memory 提取
- session 结束时再做一次 session 级去重合并

---

## 4. SessionExtractEvent（事件层设计）

建议存成独立 JSONL：`extract-events.jsonl`，和 session 消息解耦。

### 4.1 事件类型
```ts
export type ExtractEventType =
  | 'goal_set'
  | 'goal_change'
  | 'constraint_set'
  | 'decision_made'
  | 'decision_override'
  | 'user_confirm'
  | 'user_reject'
  | 'tool_call'
  | 'tool_failure'
  | 'tool_success'
  | 'error'
  | 'fix_applied'
  | 'assistant_summary';
```

### 4.2 事件结构
```ts
export interface SessionExtractEvent {
  ts: number;
  type: ExtractEventType;
  sessionId: string;
  agentId?: string;
  turnId?: string;
  // 关键：可溯源
  sourceMessageIds?: string[];
  payload: Record<string, unknown>;
}
```

### 4.3 为什么用事件而不是原始消息
- 原始消息噪声太大（寒暄、格式、重复）
- 事件层能保留“发生了什么”的事实
- 事件层对语言依赖低，跨语言更稳

---

## 5. SessionExtractBundle（提取器输入）

提取器不直接吃 session messages，吃压缩后的 bundle。

```ts
export interface SessionExtractBundle {
  sessionId: string;
  agentId: string;
  startAt: number;
  endAt?: number;
  events: SessionExtractEvent[];
  condensedTurns: CondensedTurn[];
  runSummary: RunSummary;
  humanCheckpoints: HumanCheckpoint[];
}

export interface CondensedTurn {
  turnId: string;
  ts: number;
  userIntent?: string;       // 1-2句
  constraints?: string[];    // 用户约束
  decisions?: string[];      // 决策点
  toolFailures?: string[];   // 工具失败
  toolSuccess?: string[];    // 工具成功
  conclusion?: string;       // 当轮结论
}

export interface RunSummary {
  totalTurns: number;
  totalToolCalls: number;
  failureRate: number;
  majorErrors: string[];
  resolvedErrors: string[];
}

export interface HumanCheckpoint {
  ts: number;
  kind: 'confirm' | 'reject' | 'goal_change' | 'constraint_set';
  text?: string;
  sourceEventIds?: string[];
}
```

---

## 6. MemoryCandidate（提取器输出）

```ts
export interface MemoryCandidate {
  type: MemoryType;       // preference / decision / lesson / discovery / context / relationship
  content: string;        // 一句自然语言（最终入记忆）
  source: string;         // sessionId + turnId
  evidence: string[];     // event ids / message ids
  confidence: number;     // 0..1
  importance: number;     // 0..1
  tags: string[];
}
```

入库存储仍走现有 `MemoryStore.store()`（`harness/memory/types.ts`）。

---

## 7. Rule 设计（新范式）

核心改变：**Rule 不再写自然语言匹配规则，而是写“信号组合规则”**。

### 7.1 信号（Signal）
信号由 Semantic Layer 产出，Rule 只消费信号：

- `repeat.semantic >= N`
- `confirm.signal == true`
- `reject.signal == true`
- `goal.change == true`
- `decision.locked == true`
- `error.to.success == true`

### 7.2 规则示例（策略规则）

#### 7.2.1 Preference（用户偏好）
```yaml
id: preference_from_constraint
when:
  - signal: constraint_set
  - signal: semantic.repeat >= 2
then:
  memory_type: preference
  confidence: 0.75
  importance: 0.7
  boost:
    - when: user_confirm
      add_confidence: 0.15
```

#### 7.2.2 Decision（重要决策）
```yaml
id: decision_when_locked
when:
  - signal: decision_made
  - signal: goal.change == false  # 目标未漂移
then:
  memory_type: decision
  confidence: 0.8
  importance: 0.8
```

#### 7.2.3 Lesson（踩坑经验）
```yaml
id: lesson_from_failure_then_success
when:
  - signal: error_count >= 2
  - signal: fix_applied == true
then:
  memory_type: lesson
  confidence: 0.8
  importance: 0.85
```

#### 7.2.4 Discovery（关键发现）
```yaml
id: discovery_from_external_proof
when:
  - signal: external_evidence_found == true
  - signal: contradiction_penalty < 0.3
then:
  memory_type: discovery
  confidence: 0.7
  importance: 0.7
```

#### 7.2.5 Override（目标漂移）
```yaml
id: decision_override_on_goal_change
when:
  - signal: goal.change == true
then:
  memory_type: decision
  action: upsert
  confidence: 0.75
  importance: 0.8
  tags: ['override']
```

### 7.3 评分函数（推荐）
```ts
score = w1*explicitness
      + w2*semanticRepeat
      + w3*outcomeSuccess
      + w4*userConfirmation
      - w5*contradictionPenalty
```

默认权重建议（可按 agent profile 调）：
- `w1=0.30, w2=0.25, w3=0.20, w4=0.20, w5=0.35`

---

## 8. Semantic Layer 设计（语言无关关键层）

### 8.1 三个核心特征
1. **重复度（Repeat）**：相同语义在 session 中重复出现
2. **极性（Polarity）**：confirm / reject / neutral
3. **漂移度（Drift）**：当前结论与早期目标/约束偏离

### 8.2 实现策略（分阶段）
- Phase 1（MVP）：
  - embedding 相似度（cosine）做重复检测
  - 简单极性分类器（可先 rule+embedding hybrid）
- Phase 2：
  - 目标漂移检测（goal embedding vs 当前 turn embedding）
  - 冲突检测（new memory vs existing memory）

### 8.3 为什么多语言友好
- `confirm/reject/repeat/drift` 是语义概念
- 只要 embedding/分类模型支持多语言，规则层无需为每种语言写 pattern
- 新语言扩展成本主要在模型与评测集，不在规则代码

---

## 9. 与现有代码的对齐点

### 9.1 Session 生命周期
- `SessionLifecycleStatus`: `active | recent | extracted | archived`
- `MemoryExtractionStatus`: `pending | completed | skipped`

建议在“半场提取”时新增语义状态：
- `memoryExtraction = 'pending'` 保持不变
- `extractionMeta.lastRunStatus = 'soft' | 'success' | 'error'`

### 9.2 Memory 存储
复用：
- `MemoryStore.store()`
- `MemoryStore.retrieve()`
- `MemoryStore.update()`

不做新的记忆存储范式。

### 9.3 自主子系统
映射五维：
- Sense：lifecycle 变更、idle 超时、关键事件
- Think：Rule + Semantic 特征计算
- Act：入库 memory、可选去重覆盖
- Signal：`memory.extracted`、`memory.conflict`
- Boundary：默认 `suggest`，不直接改主系统策略

---

## 10. 落地路线（3 个里程碑）

### M1：可回放 MVP（rule + event）
- 定义 `SessionExtractEvent` / `SessionExtractBundle` / `MemoryCandidate`
- 在 `session_end` 触发提取
- 实现 rule 骨架（preference/decision/lesson）
- 单测：session 片段 → candidates

### M2：多语言增强（semantic layer）
- 接入 embedding 相似度
- 接入 confirm/reject 极性检测
- 增加去重（相似度阈值 0.90~0.94）

### M3：自治化（subsystem 正式注册）
- Sense 条件触发
- Signal 下游：推动 cognition/wisdom
- 增加 conflict/upsert 策略
- 增加评测集（中英双语）

---

## 11. 风险与对策

### 11.1 规则漂移
- 风险：规则越来越多、越来越难维护
- 对策：规则只吃信号，不直接吃文本；信号可回归测试

### 11.2 记忆爆炸
- 风险：低质量记忆太多，召回噪声高
- 对策：score 阈值 + 去重 + 衰减 + conflict 覆盖

### 11.3 过度抽取
- 风险：每次会话都生成大量记忆，成本高
- 对策：增量提取 + 事件驱动 + 局部提取

### 11.4 误判（把噪声当记忆）
- 风险：寒暄/格式文本被误记
- 对策：Event Layer 优先；Semantic Layer 二次过滤

---

## 12. 结论

这个方案的核心结论是：

- **不要用规则去穷举人类语言**
- **用事件层保证确定性，用语义层保证泛化，用策略层保证质量**
- 这样架构才能在多语言、长会话、复杂人类行为下持续演进

按这个方向，`octopi` 的 memory 提取会是一个**稳定、可回放、可演进**的自治子系统，而不是一个越来越难维护的规则集合。


---

## 13. 前置架构改造（已落地）

为支撑“自治子系统直接承载 memory 提取”，已在自主子系统架构中完成以下通用改造：

### 13.1 类型层扩展（通用）
- `SenseContext` 增加主会话生命周期态：
  - `sessionLifecycle`
  - `lastInteractionAt`
  - `idleMs`
  - `extractionStatus`
- `SubsystemInput` 增加结构化扩展点：
  - `payload?: Record<string, unknown>`
  - `sessionMetadata` 支持扩展字段
- `ActResult` 增加动作目标语义：
  - `target?: string`（如 `context / memory-store / knowledge`）
- 新增通用状态类型：
  - `SessionLifecycleStatus`
  - `ProcessExtractionStatus`

### 13.2 Sense 能力增强（通用）
新增 `SessionLifecycleBridge`，负责把主会话生命周期状态转为子系统可感知的事件与指标：
- 监听 `session.lifecycle.updated`
- 监听 `engine.end`
- 计算 idle 指标
- 提供 `getSessionSenseContext(sessionId)` 片段给 SenseEngine condition 使用

### 13.3 Input 注入增强（通用）
改造 `buildAgentInput`，将生命周期态注入到：
- `sessionMetadata`
- `payload.sessionLifecycle`

### 13.4 Runner 生命周期事件（通用）
`SessionAwareRunner.handle()` 中新增通用事件发射：
- 消息到达后：`session.lifecycle.updated`（active + lastInteractionAt）
- 本轮处理完成：`session.lifecycle.updated`（lifecycle + extractionStatus + lastInteractionAt）
- 异常路径：`session.lifecycle.updated`（recent + pending）

### 13.5 结论
这些改造不是 memory 专属，而是让所有“session 级子系统”都能基于生命周期触发与输入上下文运行。
