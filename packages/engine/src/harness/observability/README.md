# Observability — 观测（横切能力，不计入产品域）

调试 / 指标 / Issue 注册。**不是**合规流水（Audit 在 Session 域 Discourse 路径）。

| 模块 | 职责 |
|------|------|
| `observer/` | Run Observatory：ObserverHub + Run 投影；配置 `observer.level`（缺省 off） |
| `diagnostics/` | Issue 注册表（多域写入） |

与 Core Telemetry `Observer`（配置键 `observability`）同属观测领域、实现分离。见 [`docs/observer-domain.md`](../../../docs/observer-domain.md)。
