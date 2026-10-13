# @octopi-agent/gateway

Octopi **Gateway** — HTTP/WS process plane, channel adapters, and Web runtime (API + SDK + store).

```sh
npm i @octopi-agent/gateway
```

```ts
import { Gateway, HttpChannelAdapter, OctopiClient } from '@octopi-agent/gateway';
```

Depends on `@octopi-agent/engine`. Built-in subsystems and strategies stay in engine.

## ToolEffectPolicy 接线（Gateway 侧）

- **配置**：`effectPolicy`（顶层或 `agents[].effectPolicy`）注入 Runner；缺省 `workspace`（最严，shell `deny`）
- **confirmEffect**：`effects: "host-gate"` 时非事务效应交宿主；Gateway 默认接 `ask_user`，可覆盖
- **编辑重发**：`POST /sessions/:id/messages/truncate` → 逆放本轮 agent 文件/记忆效应（用户手改保留）
- **会话关闭**：`deleteSession` / `stop()` 按 `effectPolicy.onClose`（`commit` | `discard`）收残留 turn undo

详见 `@octopi-agent/engine` 与仓库 `arch/tool-effect-policy.md`。

Part of [Octopi](https://github.com/JK-Ai-Era/octopi). Apache-2.0 — see `LICENSE` and `NOTICE`.
