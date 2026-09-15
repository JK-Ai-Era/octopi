# Agent — 运行时门面

> Layer: Layer 2

Harness 层的可运行 Agent 门面。

**核心理念**：Loop 只有 `agentLoop` 纯函数；「能 run 的 Agent」住在 Harness，以便 `run()` 自带可靠性包装，且不违反外→内依赖。

## 职责

- 持有 `AgentContext`（messages / tools / systemPrompt）
- 持有 `AgentLoopConfig` 与 `ReliabilityHarness`
- **`run(signal?, harnessOverride?)` = `runAgentWithReliability`** — 唯一推荐运行入口

## 不做什么

- 不实现 Loop 协议（在 `loop/agent-loop.ts`）
- 不做具体安全/预算/RunGuard 策略（由 harness 装备注入）

## 依赖

- Loop: AgentContext、AgentLoopConfig、AgentLoopEvent
- Harness: reliability/run-agent、reliability/harness-events

## 用法

```ts
const agent = new Agent({ model, systemPrompt, tools, harness });
for await (const event of agent.run(signal)) {
  // event: HarnessLoopEvent
}
```

Builder 组装路径会在 build 时 `agent.setHarness(harness)`；Runner 使用 `agent.run()`。
