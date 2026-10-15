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

- **配置**：`effectPolicy`（顶层或 `agents[].effectPolicy`）注入 Runner；缺省 `host`（本机自动化；严格场景显式 `workspace`）
- **confirmEffect**：`effects: "host-gate"` 时非事务效应交宿主；Gateway 默认接 `ask_user`，可覆盖
- **编辑重发**：`POST /sessions/:id/messages/truncate` → 仅接受 `abortedTurn.userMessageIndex`；逆放本轮 agent 效应（文件/记忆/shell），返回 `fileEffects`（含 `notReversed`/`truncated`）
- **会话关闭**：`deleteSession` / `stop()` 按 `effectPolicy.onClose`（`commit` | `discard`）收残留 turn undo；`onClose` 可 per-agent
- **doctor**：启动时 `scanOrphanUndo` 扫残留 `sessions/*/undo`

详见 `@octopi-agent/engine` 与对外文档 `docs/process-isolation.md`。

Part of [Octopi](https://github.com/JK-Ai-Era/octopi). Apache-2.0 — see `LICENSE` and `NOTICE`.
