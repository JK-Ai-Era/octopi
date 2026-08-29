# Integration — Layer 3: 外部适配

对接外部系统。只做适配转换，不做业务逻辑决策。

## 模块

| 模块 | 职责 |
|------|------|
| `providers/` | LLM Provider（OpenAI、Anthropic） |
| `storage/` | 存储后端（JSONL、SQLite、Memory） |
| `observability/` | 可观测性（Trace、Metrics、Exporters） |
| `gateway/` | 网关 |
| `protocols/` | 协议适配（HTTP） |
| `tui/` | 终端 UI |
| `mcp/` | MCP SDK Client |
| `types/` | Integration 层类型 |

## 依赖规则

- 依赖 Core、Loop、Harness
- 不做业务逻辑决策
- 不定义接口（接口在 Core）
