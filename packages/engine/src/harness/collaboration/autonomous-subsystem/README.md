# Autonomous Subsystem — 自主子系统

> Layer: Layer 2

独立于主 Agent Loop 之外、为解决特定问题而自主运行的子系统框架。

**五维模型**：Sense + Think + Act + Signal + Boundary。

**与 Multi-Agent 的边界**：Autonomous Subsystem 管「子系统如何感知、思考并回写主系统」；Multi-Agent 管「多个 Agent 实例如何协作」。二者正交。

## 职责

- SubsystemRuntime — 核心运行时
- SubsystemLoader — 子系统目录加载（config.yaml + SUBSYSTEM.md + handler.ts）
- SenseEngine / MetricsStore — 条件触发、冷却期、循环防护
- ThinkExecutor / ModelResolver — code / llm / hybrid 执行与模型降级（机制与选型见「Think 三模式」小节）
- SignalBus — context / steering / event / escalate 四通道投递
- SubsystemSessionManager — ephemeral/persistent × global/agent/session 隔离
- AuditWriter / AuditReader — 运行审计
- BoundaryValidator — 能力边界与规格校验

## Think 三模式：机制与选型

`think.implementation` 决定「思考体」怎么执行。**`handler.ts` 只在 code/hybrid 模式被 loader 装配；llm 模式没有 handler**（`config.yaml` + `SUBSYSTEM.md` 即可运行）。

| 模式 | 执行机制 | 必需件 | handler.ts |
|------|---------|--------|-----------|
| `code` | 框架直接调用 `handler(input, deps)` 纯代码执行；要调 LLM 只能由 handler 自己经 `llmPort.chat()` 编排 | `think.handler` | ✅ 导出 `handler` |
| `llm` | 框架构建 Agent 跑 `agent.run()`：`systemPrompt` 驱动推理（可带工具），模型分级解析 + fallback 降级，输出走 JSON 提取 + 结构校验 | `think.systemPrompt` | ❌ 无需 handler |
| `hybrid` | 三段流水线：`preProcess(input)`（代码）→ 框架跑 LLM（同 llm 段）→ `postProcess(output)`（代码） | `systemPrompt` + `preProcess`/`postProcess` 至少一个 | ✅ 导出 `preProcess`/`postProcess` |

**怎么选（看判定逻辑的本质，不看"想不想有个文件"）**：

1. **语义判断**（分类、裁决、总结、抽取、相关性），素材可由触发侧拼装好 → **`llm`**。最薄、无代码载体；输出解析与失败兜底框架已带，不要为了"看起来需要个文件"配 handler。
2. **语义判断 + 代码钩子**（输入需裁剪拼装、输出需强校验/二次加工）→ **`hybrid`**。语义仍归 LLM，代码只做预/后处理。
3. **确定性规则/编排**（纯计算、查表、状态检查、多步代码流程），LLM 至多是可选工具 → **`code`**。handler 全权负责，按需经 `llmPort` 调模型。
4. **反例**：在 code handler 里堆正则/启发式去"判语义"（如按措辞猜意图）是错误抽象——语义残留交给 llm/hybrid 的 LLM，启发式只配做触发器/粗筛。

> 权威契约（SUBSYSTEM.md 生效方式、加载规则、config 字段）见 `docs/autonomous-subsystem.md`。

## 不做什么

- 不做多 Agent 编排（那是 multi-agent 的事）
- 不做主 Loop 执行（那是 Loop 层的事）
- 不做安全策略实现（那是 security 领域的事；子系统只声明 boundary，其中 `security` 字段当前为声明契约，运行时未做沙箱隔离）

## 依赖

- Core: loop/、primitives/、interfaces/
- Harness: memory（Steward 子系统经 runtimeInject 使用 MemoryStore）

## 文件说明

- types.ts — 五维模型类型
- loader.ts / runtime.ts / errors.ts
- sense/、think/、signal/、session/、audit/、boundary/
- index.ts — 统一导出

使用说明见 [docs/autonomous-subsystem.md](../../../docs/autonomous-subsystem.md)。
