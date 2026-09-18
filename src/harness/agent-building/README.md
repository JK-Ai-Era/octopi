# Agent Building — Agent 构建

组装 Agent 运行时：persona、tools、七层 ContextAssembler、子系统、配置桥接。

## 职责

- `AgentBuilder`：fluent 构建；`build({ mode: 'full' | 'core' })`
- `config-bridge`：从 `octopi.json` 装配 Provider / stores / constitution / subsystems
- `isSubsystemAllowed` / `discoverSubsystemSpecs`

## Memory 接线（redesign 后）

- 注入 `memoryStore` 后：`buildCore` 前用**同一实例**注册 `memory_store` / `memory_search`
- 同实例注入七层 `MemoryLayer` 与 `runtimeInject.memoryStore`
- **不再**存在 ETL 的 `MemoryExtractionWiring` / Bridge / PendingExtractor 句柄
- 旁路自动化走 `memory.steward.backfill` / `memory.steward.govern` 子系统（见 `docs/memory-system-redesign.md`）

## 返回值

```ts
const { agent, harness, runner, runtime, events, contextHealth } = await builder.build();
```

- `runtime`：SubsystemRuntime（若注册了子系统）
- **无** `memoryExtraction` 字段；历史 ETL API 已删除
