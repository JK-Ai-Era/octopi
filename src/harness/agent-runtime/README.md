# Agent Runtime — 激活宿主

> Layer: Layer 2  
> 设计：[arch/agent-runtime.md](../../../arch/agent-runtime.md)

把非用户刺激（Trigger）编译成 0..N 次受监督的 Run，按 Agent 身份路由。

## 职责

- AgentRuntime — 注册 RuntimeAgent / TriggerSource，dispatch Trigger
- ExplicitRouter — 显式 agentId / toAgents / fallback
- SessionRunnerDispatcher — 包装 SessionAwareRunner（模型 A）
- CoalesceBuffer — 同 session+key 窗口合批（非执行队列）
- Compiler — Trigger → Message（非 message 类型打 `metadata.source=runtime`；通道 user 消息不打）

## 不做什么

- 不实现协议 Source（Channel/Webhook 在 Integration）
- 不依赖 orchestration TaskScheduler
- 不实现第二套 session 执行队列（串行归 Runner 锁）
- 不扫描 Session.tasks 自动唤醒
- 不替代 RunGuard / Budget

## 依赖

- Core: types, primitives/event-bus
- Harness: runner.ts（仅 SessionRunnerDispatcher）

## 用法（P0）

```ts
import { AgentRuntime, ExplicitRouter, SessionRunnerDispatcher } from 'octopi/harness';

const runtime = new AgentRuntime({ router: new ExplicitRouter() });
runtime.registerAgent({
  agentId: 'assistant',
  dispatcher: new SessionRunnerDispatcher({ runner }),
});
await runtime.start();
const result = await runtime.dispatch({
  id: 'trg-1',
  type: 'manual',
  agentId: 'assistant',
  sessionId: 'assistant:main',
  payload: { kind: 'user_message', content: 'hello' },
});
```

Source `emit` 必须 fire-and-forget（禁止 await dispatch）。
