# Autonomous Subsystem — 自主子系统

> Layer: Layer 2

独立于主 Agent Loop 之外、为解决特定问题而自主运行的子系统框架。

**五维模型**：Sense + Think + Act + Signal + Boundary。

**与 Multi-Agent 的边界**：Autonomous Subsystem 管「子系统如何感知、思考并回写主系统」；Multi-Agent 管「多个 Agent 实例如何协作」。二者正交。

## 职责

- SubsystemRuntime — 核心运行时
- SubsystemLoader — 子系统目录加载（config.yaml + SUBSYSTEM.md + handler.ts）
- SenseEngine / MetricsStore — 条件触发、冷却期、循环防护
- ThinkExecutor / ModelResolver — code / llm / hybrid 执行与模型降级
- SignalBus — context / steering / event / escalate 四通道投递
- SubsystemSessionManager — ephemeral/persistent × global/agent/session 隔离
- AuditWriter / AuditReader — 运行审计
- BoundaryValidator — 能力边界与规格校验

## 不做什么

- 不做多 Agent 编排（那是 multi-agent 的事）
- 不做主 Loop 执行（那是 Loop 层的事）
- 不做安全策略实现（那是 security 领域的事；子系统只声明 boundary）

## 依赖

- Core: loop/、primitives/、interfaces/
- Harness: memory/extraction（桥接示例）

## 文件说明

- types.ts — 五维模型类型
- loader.ts / runtime.ts / errors.ts
- sense/、think/、signal/、session/、audit/、boundary/
- index.ts — 统一导出

使用说明见 [docs/autonomous-subsystem.md](../../../docs/autonomous-subsystem.md)。
