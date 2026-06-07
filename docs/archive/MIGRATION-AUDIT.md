> **[ARCHIVED]** — 本文档已归档。核心内容已整合到 [ARCHITECTURE.md](../ARCHITECTURE.md)。
> 保留供历史参考，不再作为活跃开发文档。

# Octopi 代码迁移审计

> 日期：2026-06-05 | 状态：v0.2.0 已完成核心迁移

---

## 总览

| 分类 | 文件数 | 代码行数 | 状态 |
|---|---|---|---|
| 新架构（Core/Harness/Integration） | 28 | ~4,500 | ✅ 已完成 |
| 旧代码（需要迁移或清理） | 38 | ~7,200 | ⚠️ 部分迁移 |
| **合计** | **66** | **~11,700** | |

---

## 逐模块审计

### ✅ 已迁移到新架构

| 模块 | 旧代码 | 新架构替代 | 状态 |
|---|---|---|---|
| 循环引擎 | `loop/run-agent-loop.ts` (971行) | `core/engine.ts` (642行) | ✅ 新引擎可用 |
| 事件系统 | 无 | `core/event-bus.ts` (151行) | ✅ 新增 |
| 安全守卫 | 无 | `core/security-guard.ts` (224行) | ✅ 新增 |
| 资源约束 | `loop/iteration-budget.ts` (51行) | `core/budget.ts` (144行) | ✅ 新增 |
| 上下文组装 | `context/engine.ts` (164行) | `harness/context/pipeline.ts` (223行) | ✅ 新增 |
| Session 管理 | `agent/session-manager.ts` (372行) | `harness/runner.ts` (202行) | ✅ 新增 |
| 组装器 | 无 | `harness/builder.ts` (363行) | ✅ 新增 |
| Persona | 无 | `harness/persona/loader.ts` (108行) | ✅ 新增 |
| 安全策略 | 无 | `harness/security/` (232行) | ✅ 新增 |
| 存储后端 | 无 | `integration/storage/` (185行) | ✅ 新增 |
| 可观测性 | 无 | `integration/observability/` (89行) | ✅ 新增 |

### ⚠️ 旧代码仍在使用（通过兼容层）

| 模块 | 文件 | 行数 | 被谁使用 | 迁移难度 |
|---|---|---|---|---|
| **PluginManager** | `plugins/manager.ts` | 836 | LegacyAgentRunner | 🟡 中 |
| **PluginApi** | `plugins/api.ts` | 412 | PluginManager | 🟡 中 |
| **PluginLoader** | `plugins/loader.ts` | 379 | PluginManager | 🟡 中 |
| **PluginManifest** | `plugins/manifest.ts` | 357 | PluginManager | 🟡 中 |
| **CapabilityRegistry** | `plugins/capability.ts` | 222 | PluginManager | 🟡 中 |
| **PluginEntry** | `plugins/entry.ts` | 134 | Plugin SDK | 🟢 低 |
| **ToolRegistry** | `tools/registry.ts` | 186 | LegacyAgentRunner | 🟡 中 |
| **BuiltinTools** | `tools/builtin.ts` | 325 | CLI、测试 | 🟢 低 |
| **SkillManager** | `skills/manager.ts` | 182 | LegacyAgentRunner | 🟢 低 |
| **OpenAIProvider** | `providers/openai.ts` | 343 | LLMRouter | 🟢 低 |
| **AnthropicProvider** | `providers/anthropic.ts` | 398 | LLMRouter | 🟢 低 |
| **LLMRouter** | `providers/router.ts` | 75 | LegacyAgentRunner | 🟢 低 |
| **SessionManager** | `agent/session-manager.ts` | 372 | LegacyAgentRunner | 🟡 中 |
| **LegacyContextEngine** | `context/engine.ts` | 164 | 旧 AgentRunner | 🟢 低 |
| **Gateway** | `gateway/gateway.ts` | 387 | CLI | 🟡 中 |
| **HttpAdapter** | `protocol/http.ts` | 117 | Gateway | 🟢 低 |
| **Config** | `config.ts` | 134 | CLI | 🟢 低 |
| **CLI** | `cli.ts` | 339 | 入口 | 🟢 低 |

### ❌ 未迁移（旧架构独有）

| 模块 | 文件 | 行数 | 说明 | 迁移难度 |
|---|---|---|---|---|
| **TaskSystem** | `tasks/` (6文件) | 715 | 任务管理，LLM 决策器 + 状态追踪 | 🔴 高 |
| **旧 AgentRunner** | `agent/agent-runner.ts` | 561 | deprecated，LegacyAgentRunner 替代 | 🟢 可删除 |
| **旧 Loop 辅助** | `loop/error-classifier.ts` | 202 | 旧 loop 专用 | 🟢 可删除 |
| | `loop/message-converter.ts` | 127 | 旧 loop 专用 | 🟢 可删除 |
| | `loop/output-quality-gate.ts` | 494 | 输出质量检测（有价值，需迁移） | 🟡 中 |
| | `loop/output-error-classifier.ts` | 315 | 输出错误分类（有价值，需迁移） | 🟡 中 |
| | `loop/output-quality-types.ts` | 223 | 类型定义 | 🟢 低 |
| **旧 PluginAdapter** | `harness/compat/plugin-adapter.ts` | 62 | 占位，功能不完整 | 🟡 中 |

---

## 测试审计

| 测试文件 | 行数 | 依赖旧代码 | 依赖新架构 | 状态 |
|---|---|---|---|---|
| `core-engine.test.ts` | 424 | 0 | 2 | ✅ 纯新架构 |
| `harness.test.ts` | 232 | 0 | 4 | ✅ 纯新架构 |
| `legacy-runner.test.ts` | 185 | 0 | 2 | ✅ 纯新架构 |
| `security.test.ts` | 140 | 0 | 2 | ✅ 纯新架构 |
| `agent-loop.test.ts` | 382 | 5 | 1 | ⚠️ 旧 loop 测试 |
| `loop.test.ts` | 406 | 4 | 1 | ⚠️ 旧 loop 测试 |
| `openclaw-compat.test.ts` | 634 | 4 | 0 | ⚠️ 旧兼容测试 |
| `output-quality-*.test.ts` | 1366 | 6 | 0 | ⚠️ 旧质量检测测试 |
| `skill-manager.test.ts` | 274 | 1 | 0 | ⚠️ 旧 Skill 测试 |
| `task-*.test.ts` | 1633 | 11 | 2 | ⚠️ 旧 Task 测试 |
| `anthropic-provider.test.ts` | 75 | 2 | 0 | ⚠️ 旧 Provider 测试 |

---

## 迁移优先级

### P0：必须迁移（核心功能缺失）

1. **Task System → Harness 层 ContextPipeline Stage**
   - `TaskTracker` → `harness/tasks/tracker.ts`（保留 JSONL 持久化）
   - `TaskManager` → `harness/tasks/manager.ts`（保留 LLM 决策器）
   - `TaskStage` → `harness/context/stages/task-stage.ts`（新增，ContextPipeline 阶段）
   - `TaskManagerPlugin` → 不再需要，Task 直接作为管道阶段注入
   - 集成方式：ContextPipeline Stage（不是回调槽）

2. **Output Quality Gate → Core 层回调槽**
   - `OutputQualityGate` → Core 的 `afterModelCall` 回调槽
   - `OutputErrorClassifier` → 集成到 ErrorStrategy
   - 这些是有价值的安全/质量保障，不应丢失

### P1：应该迁移（减少维护负担）

3. **Plugin System → Harness 层完整适配**
   - 当前 PluginAdapter 是占位实现
   - 需要完整桥接所有 hook 到回调槽
   - PluginManager 保留，但通过适配器注入到 AgentEngine

4. **旧 Loop 测试迁移**
   - `agent-loop.test.ts` → 测试新 AgentEngine
   - `loop.test.ts` → 测试新 AgentEngine
   - 保留测试覆盖，但用新架构重写

### P2：可以后做（向后兼容即可）

5. **Provider 接口统一**
   - 旧 `LLMProvider` → 新 `ModelProvider` 接口
   - 通过适配器桥接，不需要立即重写

6. **旧代码清理**
   - 删除 `agent/agent-runner.ts`（deprecated）
   - 删除 `loop/` 中已被替代的辅助模块
   - 删除 `harness/compat/` 中的临时适配器

---

## 迁移方案

### Phase 7: Task System 迁移（2-3 天）

```
src/tasks/ → src/harness/tasks/

核心理念：
  Task System 是“上下文增强机制”，不是“拦截/修改机制”。
  它通过往 system prompt 注入任务上下文，让主 Agent 自然地决定行为。
  因此，Task 应该是 ContextPipeline 的一个 Stage，不是回调槽。

迁移内容：
1. TaskTracker → harness/tasks/tracker.ts
   - JSONL 持久化保留
   - 状态管理保留
   - 接口不变

2. TaskManager → harness/tasks/manager.ts
   - LLM 决策器保留
   - 接口适配到 ModelProvider

3. TaskStage → harness/context/stages/task-stage.ts（新增）
   - 实现 ContextStage 接口
   - 内部组合 TaskTracker + TaskManager
   - 在 process() 中：
     a. await tracker.loadSession(sessionId)
     b. await manager.decide(input)
     c. await applyDecision(tracker, ...)
     d. ctx.systemPrompt += taskContext

4. 管道阶段顺序：
   PersonaStage → SkillStage → TaskStage → HistoryStage → CompactStage → FilterStage

5. 不再需要 TaskManagerPlugin

测试：
- 迁移 task-system.test.ts 和 task-integration.test.ts
- 确保 313+ 测试全部通过
```

### Phase 8: Output Quality Gate 迁移（1-2 天）

```
src/loop/output-*.ts → src/core/quality/

迁移内容：
1. OutputQualityGate → core/quality/gate.ts
   - 检测逻辑保留
   - 通过 afterModelCall 回调槽注入

2. OutputErrorClassifier → core/quality/classifier.ts
   - 分类逻辑保留
   - 集成到 ErrorStrategy

测试：
- 迁移 output-quality-*.test.ts
```

### Phase 9: Plugin 完整适配（2-3 天）

```
增强 harness/compat/plugin-adapter.ts

迁移内容：
1. 完整桥接所有 PluginManager hooks
2. 异步 hook 支持（before_agent_reply 等）
3. Plugin 信任分级集成到 CapabilityEnforcer

测试：
- 迁移 openclaw-compat.test.ts
```

### Phase 10: 旧代码清理（1 天）

```
删除：
- src/agent/agent-runner.ts（deprecated）
- src/loop/error-classifier.ts（已替代）
- src/loop/iteration-budget.ts（已替代）
- src/loop/message-converter.ts（已替代）
- src/loop/index.ts（已替代）
- src/context/engine.ts（已替代）

保留：
- src/loop/output-quality-*.ts（待 Phase 8 迁移）
- src/plugins/*（Phase 9 仍在使用）
- src/tasks/*（Phase 7 迁移）
```

---

## 预估

| 阶段 | 内容 | 工作量 | 风险 |
|---|---|---|---|
| Phase 7 | Task System 迁移 | 2-3 天 | 中 |
| Phase 8 | Output Quality Gate 迁移 | 1-2 天 | 中 |
| Phase 9 | Plugin 完整适配 | 2-3 天 | 中 |
| Phase 10 | 旧代码清理 | 1 天 | 低 |
| **合计** | | **6-9 天** | |

---

## 附录：回调槽 vs ContextPipeline Stage

迁移 Task System 时，有一个关键设计决策：用回调槽还是 ContextPipeline Stage？

### 回调槽
- **适合**：拦截、修改、过滤（同步，轻量）
- **例子**：权限检查、输出过滤、模型覆盖
- **特点**：同步执行，不改变上下文组装流程

### ContextPipeline Stage
- **适合**：上下文增强、注入（异步，可重量）
- **例子**：Persona 注入、Skill 注入、任务上下文注入
- **特点**：异步执行，直接修改 system prompt

### 结论

Task System 的核心理念是“对 Agent 透明”——主 Agent 只需要在 system prompt 里看到任务上下文，然后自然地行动。这本质上是上下文增强，不是拦截/修改。因此 Task System 应该是 ContextPipeline Stage，不是回调槽。

回调槽保持同步不变，不需要为 Task System 改为 async。
