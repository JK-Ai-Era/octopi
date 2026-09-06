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


---

## 14. 真实采集链路（已落地）

### 14.1 语义信号（语言无关）
新增 `SemanticSignals`，用于在事件信号之外补充 confirm/reject 弱信号：
- 不依赖特定语言关键词
- 基于长度、否定前缀、标点极性等结构特征
- 可后续替换为 embedding/polarity 模型

### 14.2 SessionExtractCollector
监听通用 EventBus 事件并聚合为 `SessionExtractBundle`：
- `turn.end`
- `tool.exec.start` / `tool.exec.end`
- `session.lifecycle.updated`
- `engine.end`

产出包括：
- SessionExtractEvent[]（可回放）
- RunSummary（工具调用数、失败率、主要错误）

### 14.3 MemoryExtractorBridge
在主会话生命周期更新为 `recent + pending` 时：
1. 从 `SessionExtractCollector` 生成 `SessionExtractBundle`
2. 发射 `memory.extractor.bundle.ready`
3. 调用 `runtime.trigger('memory.extractor')`

### 14.4 Runtime 通用透传
`SubsystemRuntime.onTrigger()` 已支持将 `SenseContext.eventData.bundle` 透传到 `SubsystemInput.payload.sessionExtractBundle`。
这意味着子系统可以基于“事件携带的结构化输入”运行，而不必只依赖主上下文。


---

## 15. 提取素材落盘与恢复（已落地）

### 15.1 ExtractorStore 接口
新增通用接口：
- `appendEvents(agentId, sessionId, events)`
- `loadEvents(agentId, sessionId)`
- `saveBundle(agentId, sessionId, bundle, meta)`
- `loadBundle(agentId, sessionId)`
- `updateMeta(agentId, sessionId, meta)`
- `listPending(agentId)`

### 15.2 实现
- `InMemoryExtractorStore`：测试/开发用
- `JsonlExtractorStore`：生产可用的 JSONL 落盘方案
  - `<agentHome>/extract/events/<sessionId>.jsonl`
  - `<agentHome>/extract/bundles/<sessionId>.json`
  - `<agentHome>/extract/meta/<sessionId>.json`

### 15.3 采集器与桥接层联动
- `SessionExtractCollector` 在每次事件写入时 append store
- `SessionExtractCollector.buildBundle()` 时 saveBundle 快照
- `MemoryExtractorBridge` 在内存无 bundle 时，可从 store 兜底加载并触发子系统

### 15.4 恢复策略
- 进程重启后，`listPending(agentId)` 可发现待处理 session
- 再次触发 `recent+pending` 生命周期事件即可恢复提取流程


---

## 16. 去重/升级与断点续提（已落地）

### 16.1 MemoryDeduplicator
- 同源去重：相同 `source` 标签不重复入库
- 容量控制：同 `type + tags` 超阈值时跳过或升级最弱条目
- 升级策略：当新候选的 `confidence/importance` 更高时，update 旧条目

### 16.2 PendingExtractor
- 定时扫描 `ExtractorStore.listPending(agentId)`
- 对每个 pending session 构建 `SessionExtractBundle` 并触发 `memory.extractor`
- 触发后将 meta 标记为 `completed`

### 16.3 效果
- 避免重复记忆膨胀
- 进程重启后可自动恢复未完成提取


---

## 17. 去重集成与退避重试（已落地）

### 17.1 去重集成
`createMemoryExtractorSubsystem(options)` 新增 `deduplicator?: MemoryDeduplicatorOptions`。  
子系统 handler 在入库前执行 `filterAndUpgrade()`，仅入库 accepted candidates，重复或升级场景走 update 路径。

### 17.2 PendingExtractor 退避重试
新增配置：
- `baseRetryMs`（默认 60_000）
- `maxRetryMs`（默认 10*60_000）
- `maxRetries`（默认 5）

失败时按指数退避推迟下次扫描；超过 maxRetries 后将 extractionStatus 标记为 `error`，避免无限重试。


---

## 18. 置信度门控（已落地）

`createMemoryExtractorSubsystem(options)` 新增：
- `minConfidence`（默认 0.6）
- `minImportance`（默认 0.6）

在 `filterAndUpgrade` 之后，再执行一次阈值过滤：低于阈值的候选不入库，仅保留事件证据。  
这样可以进一步降低噪声，避免低质量记忆进入召回。

---

## 19. 多租户 pending 扫描策略（已落地）

`PendingExtractor` 新增 `agentConfigs`，支持为不同 agent 配置：
- `scanIntervalMs`
- `baseRetryMs / maxRetryMs / maxRetries`
- `subsystemId`

效果：
- 高优先级 agent 可以更高频扫描
- 不稳定 agent 可以更保守重试
- 不同 agent 可绑定不同子系统实例


---

## 20. 动态阈值策略（已落地）

新增 `ThresholdPolicy`，根据 session 运行质量自适应调整：
- `failureRate` 越高 → 阈值越高（更保守）
- `majorErrors` 越多 → 阈值越高
- `eventCount` 越少 → 阈值越高（样本少时更保守）

`createMemoryExtractorSubsystem` 会使用 `defaultThresholdPolicy` 计算 `minConfidence/minImportance`。

---

## 21. PendingExtractor 可观测事件（已落地）

在 `scan()` / `scanAgent()` 中新增通用观测事件：
- `pending.extractor.scan.start`
- `pending.extractor.scan.session.triggered`
- `pending.extractor.scan.session.error`
- `pending.extractor.scan.complete`

可用于接入监控、日志、告警。


---

## 22. Agent Profile 阈值策略（已落地）

`createProfileThresholdPolicy(config)` 支持：
- 不同 `agentProfile` 使用不同基线（`baseConfidence / baseImportance`）
- 仍保留动态阈值修正（failure/event 修正）

`createMemoryExtractorSubsystem` 新增 `agentProfile` 选项，传入给阈值策略。

---

## 23. Bridge 可观测事件（已落地）

`MemoryExtractorBridge` 新增事件：
- `memory.bridge.lifecycle.matched`
- `memory.bridge.bundle.hit`
- `memory.bridge.bundle.miss`
- `memory.bridge.bundle.loaded`
- `memory.bridge.trigger.start`
- `memory.bridge.trigger.complete`
- `memory.bridge.trigger.error`

用于实时链路监控与问题定位。


---

## 24. 记忆提取系统收敛（v0.12.0）

### 24.1 观测事件统一
所有观测事件统一为 `memory.extractor.*` 前缀：
- bridge: `memory.extractor.bridge.*`
- pending: `memory.extractor.pending.*`

### 24.2 用户信号来源修正
runner 的 `turn.end` 事件新增 `userText`。  
collector 优先使用 `userText` 做 confirm/reject 语义检测，避免把助手语气误判为用户决定。

### 24.3 兜底恢复
bridge 在 `bundle.miss` 时会写入 pending meta，确保 pending extractor 可接管恢复。

### 24.4 采集态清理
bridge 在 `trigger.complete` 与 `trigger.error` 后 reset session 采集态，避免长时间运行内存累积。

### 24.5 端到端回归
新增回归测试：同一 bundle 重复触发不会导致记忆条目翻倍。


---

## 25. 指标接入与 SLO 告警（已落地）

### 25.1 ExtractionMetricsBridge
将以下事件聚合到 MetricsStore：
- `memory.extractor.trigger.success`
- `memory.extractor.trigger.error`
- `memory.extractor.bundle.eventCount`
- `memory.extractor.pending.count`
- `memory.extractor.accepted.count`

### 25.2 AlertEvaluator
新增最小可用告警：
- `memory.extractor.alert.high_error_rate`
- `memory.extractor.alert.high_pending`

可通过 threshold 配置 SLO 触发条件。

---

## 26. PendingExtractor 回压限流（已落地）

新增 `BackpressureController`：
- pending 超阈值时降速（`backoffIntervalMs`）
- 并发触发上限 `maxConcurrentTriggers`

PendingExtractor 支持 `options.backpressure` 配置，避免一次性触发过多任务打爆模型/IO。

---

## 27. 定义文件驱动迁移（v0.14.0）

### 27.1 从工厂模式到定义文件驱动

memory-extractor 从 `createMemoryExtractorSubsystem()` 工厂函数迁移为定义文件驱动子系统。

**目录结构**：
```
src/subsystems/memory-extractor/
├── config.yaml           ← 定义文件（Sense/Think/Act/Inject/Resume/Observability/Metadata）
├── SUBSYSTEM.md          ← 文档
├── handler.ts            ← 核心处理器（标准契约导出）
├── types.ts              ← 注入依赖常量和配置接口
├── contracts/
│   └── bundle.ts         ← 输入输出契约类型
└── policies/
    ├── threshold.ts      ← 动态阈值策略（含修复奖励）
    ├── profile-threshold.ts
    └── dedup.ts          ← 去重与升级策略
```

**handler.ts 标准契约导出**：
```typescript
export default {
  handler,           // 核心执行函数
  contract: { input: 'SessionExtractBundle', output: 'ExtractionResult' },
  dependencies: ['memoryStore', 'modelProvider'],
}
```

**配置通过注入传递**：无模块级状态。handler 从 `deps.__subsystem_config__` 读取配置，支持多实例隔离。

### 27.2 子系统定义标准扩展

为支持定义文件驱动，扩展了子系统定义标准：

| 新增类型 | 作用 |
|---------|------|
| `SubsystemHandler` | 标准导出契约（handler + contract + dependencies） |
| `SubsystemContract` | 输入/输出类型声明 |
| `RuntimeInjectConfig` | 依赖注入声明（`requires: string[]`） |
| `LifecycleResumeConfig` | 断点续提恢复配置 |
| `ObservabilityConfig` | 观测性事件前缀 |
| `SubsystemSpec.metadata` | 子系统特定配置扩展点 |

**运行时自动注入**：
- `SubsystemRuntime` 从 `spec.metadata.config` 自动注入 `__subsystem_config__`
- 从 `ModelResolver` 解析 `spec.think.model` 后注入 `__resolved_model__`

### 27.3 Harness 层兼容

旧的 harness 文件改为 deprecated re-export：
- `session-extractor.ts` → re-export `contracts/bundle.ts` + `handler.extractCandidates`
- `threshold-policy.ts` → re-export `policies/threshold.ts`
- `memory-deduplicator.ts` → re-export `policies/dedup.ts`

基础设施文件不变（采集层、胶水层、恢复层、观测层）。

---

## 28. Hybrid 模式（规则+LLM）（v0.14.0）

### 28.1 链路设计

```
SessionExtractBundle
  → [code] 规则提取（extractCandidates）→ ruleCandidates
  → [code] 事件压缩（condenseEvents）→ 人类可读文本
  → [llm]  语义提取（enrichWithLLM）→ llmCandidates
  → [code] 合并 → 去重 → 阈值 → 入库
```

### 28.2 LLM 增强的价值

- 理解隐式偏好（"我觉得这样更好"但无 constraint_set 事件）
- 识别隐式决策（讨论后达成共识但无 decision_made 事件）
- 跨语言理解（中英混合场景）
- 提取更丰富、具体的记忆内容（而非"有 N 条约束"的统计性描述）

### 28.3 容错设计

- **LLM 失败不阻断**：`catch → return []`，规则提取结果仍然入库
- **无 modelProvider 自动降级**：未注入则跳过 LLM 步骤，等价于 code 模式
- **信号数据标记 mode**：`signals[0].data.mode = 'code' | 'hybrid'`

### 28.4 使用方式

通过 `config.yaml` 的 `metadata.config` 配置：
```yaml
metadata:
  config:
    llmEnrichment:
      model: mini
      temperature: 0.3
      maxTokens: 2048
```

---

## 29. 阈值策略改进（v0.14.0）

### 29.1 修复奖励机制

原来的策略悖论：**最有价值的 session（出了问题又修好了）反而最容易被保守阈值过滤掉**。

改进：当 session 有修复记录（`resolvedErrors > 0`），阈值惩罚被部分对冲：
```
resolvedRelief = failureDelta × resolvedRatio × 0.8
```
其中 `resolvedRatio = resolvedErrors.length / (majorErrors.length + resolvedErrors.length)`。

最多抵消 80% 的失败惩罚。对于无修复记录的 session，行为和原来完全一致。

### 29.2 未修复错误独立惩罚

`majorDelta` 只针对未修复的错误：
```
unresolvedMajor = max(0, majorErrors.length - resolvedErrors.length)
```

---

## 30. models.level 配置（v0.14.0）

### 30.1 配置格式

`octopi.json` 的 `models` 节点新增 `level` 段：
```json
{
  "models": {
    "level": {
      "mini": { "primary": "bailian/glm-5", "fallback": ["ollama/qwen3.5:2b"] },
      "standard": { "primary": "bailian/kimi-k2.5", "fallback": ["bailian/glm-5"] },
      "pro": { "primary": "bailian/kimi-k2.5", "fallback": ["bailian/glm-5"] }
    }
  }
}
```

### 30.2 链路

```
octopi.json → config.ts (LevelMap) → config-bridge.ts (builder.withModelLevels)
  → SubsystemRuntime (SharedDeps.modelLevels) → ModelResolver (resolve("mini"))
    → primary: bailian/glm-5, fallback: [ollama/qwen3.5:2b]
```

子系统 config.yaml 写 `think.model: mini`，运行时自动解析到具体 provider/model，primary 失败时按 fallback 顺序降级。

---

## 31. 子系统启动链路接通（v0.14.0）

### 31.1 断点修复

之前子系统架构的代码完整，但从配置到运行的整条启动链路从未接通。v0.14.0 修复了以下断点：

| 环节 | 修复 |
|------|------|
| config-bridge → SubsystemLoader | 新增 `resolveSubsystemSpecs()` 三级搜索路径加载 |
| config-bridge → builder | 调用 `withSubsystemDir()` / `withSubsystemAuditDir()` / `withModelLevels()` |
| config-bridge → runtime | 自动注入 modelProvider 到 injectRegistry |
| octopi.json → subsystems | 新增 `subsystems.auditDir` 配置 |
| config-schema | 新增 models.level + subsystems 的 Zod 校验 |

### 31.2 三级搜索路径（架构文档 4.9）

```
[1] <project>/.octopi/subsystems/    项目级（进 git）
[2] ~/.octopi/subsystems/            用户级（不进 git）
[3] <octopi-bundle>/subsystems/      框架级（随 npm 包）
```

同名覆盖：项目级 > 用户级 > 框架级。异名共存。

### 31.3 配置

`octopi.json` 只需声明审计目录，子系统目录路径由架构决定：
```json
{
  "subsystems": {
    "auditDir": "./data/audit"
  }
}
```
