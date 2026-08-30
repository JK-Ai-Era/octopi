# Web — Octopi Web Runtime / WebUI

第一版 Web Runtime 骨架，用于通过浏览器接入 Gateway。

## 模块

| 目录 | 职责 |
|------|------|
| `api/` | Web API Router（REST 骨架） |
| `sdk/` | Web Protocol SDK（REST + WS + 连接状态机） |
| `runtime/` | Web Runtime Store（会话、聊天、工具、inspector 状态层） |

## 当前定位

- 作为 Gateway 的另一类客户端
- 优先覆盖：连接、agents、sessions、messages、abort、approvals、memory
- 不直接替代 TUI，而是提供浏览器侧的交互运行时

## 关联设计

- `docs/web-runtime-design.md`
- `docs/web-conversation-model-design.md`
