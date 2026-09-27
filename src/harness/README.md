# Harness — Layer 2: 产品域实现

按 **10 个产品域** 组织（域目录 = 限界上下文）；概念与计数权威见 [`docs/domains.md`](../../docs/domains.md)、[`docs/domains.yaml`](../../docs/domains.yaml)。

## 布局

```text
src/harness/
  governance/           # Control — Principal/Intent/Role/Policy/Credential/Quota
  session/              # Continuity — Session 聚合 / Discourse / Projection / tasks / history
  agent/                # Agent 模板 — building / persona / revision
  memory/               # Substrate — Memory / Cognition / Wisdom
  knowledge/            # Knowledge — 外生语料（含 catalog-types）
  activation/           # Activation — Trigger → Run
  run/                  # Execution — RunScope / runner / reliability / guard / budget / model
    agent/              #   Agent.run() 门面（E5 生产入口）
  context/              # Context — 八层装配 / Token / 窗口
    capabilities/       #   横切：summary / compact
  extension/            # Extension — plugin-ecosystem / execution-environment（含 toolIsolation）
  collaboration/        # Collaboration — multi-agent / orchestration / autonomous-subsystem
  observability/        # 横切：observer / diagnostics
  shared/               # 基建：types / events
  index.ts              # 层统一导出
```

## 依赖规则

- 只依赖 Core（Kernel）和 Loop，不依赖 Integration
- **域间只 import 对方 types / index 入口**，不共享内部状态
- 推荐运行入口：`harness/run/agent` 的 `Agent.run()`；不要手拼 `runAgentWithReliability`
- 新建/改名/删除目录必须同 PR 更新 `docs/domains.yaml`

## 产品域一览

| 域 | 目录 | 问题 |
|----|------|------|
| Governance | `governance/` | 谁能做什么？ |
| Session | `session/` | 连续性如何维持？ |
| Agent | `agent/` | 它是谁、怎么配？ |
| Memory | `memory/` | 它学到过什么？ |
| Knowledge | `knowledge/` | 世界上写着什么？ |
| Activation | `activation/` | 刺激如何变成 Run？ |
| Run | `run/` | 这一轮如何跑安全？ |
| Context | `context/` | 模型看见什么？ |
| Extension | `extension/` | 能力如何扩展？ |
| Collaboration | `collaboration/` | 多 Agent 如何协同？ |

横切/基建（不计数）：`observability/`、`context/capabilities/`、`shared/`
