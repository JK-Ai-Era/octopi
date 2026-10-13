# @octopi-agent/engine

Octopi **Engine** — Harness 10 product domains + library integrations (providers, storage, MCP, observability, web-search) + built-in subsystems. Embeddable `Agent.run()` runtime.

```sh
npm i @octopi-agent/engine
```

```ts
import { AgentBuilder, Agent } from '@octopi-agent/engine';

const { agent, runner } = await new AgentBuilder()
  .model(/* ModelProvider */)
  .persona('./my-agent')
  .build();
```

| Need | Import |
|------|--------|
| Runtime / Harness | `@octopi-agent/engine` |
| Plugin SDK | `@octopi-agent/engine/plugin-sdk/plugin-entry` |
| Kernel | `@octopi-agent/core` |

Does **not** include CLI, Gateway process plane, or Web UI. See [octopi](https://github.com/JK-Ai-Era/octopi).

## ToolEffectPolicy（工具效应策略）

约束 / 可撤销 / 资源限制一体（宪法 Reserved 位 `ToolEffectPolicy`）。配置 `effectPolicy`（顶层或 `agents[]`）：

```jsonc
{
  "effectPolicy": {
    "mode": "project",        // workspace | project | host | untrusted；缺省 workspace
    "pathContainment": "strict",
    "shellEscape": "allow",   // deny | confirm | allow
    "commit": "auto",
    "effects": "host-gate",   // 交宿主 confirmEffect
    "transactionRoots": ["/data/extra"]
  }
}
```

要点：

- **Turn undo**：工具写即时落盘 + `sessions/<sid>/undo/`；编辑重发逆放 agent 效应（文件 + 记忆）
- **L2 路径包含**：`strict` 下工具路径必须落在 workspace/`transactionRoots` 内
- **host-gate**：`builder.confirmEffect(fn)`；事务内自动放行，非事务交宿主
- **L1**：`definition.timeoutMs` 在 ToolBus / Loop 工具路径强制

详见 `harness/extension/execution-environment/README.md` 与仓库内 `arch/tool-effect-policy.md`。

```ts
await new AgentBuilder()
  .workspace('/srv/agent-ws')
  .effectPolicy({ mode: 'project', shellEscape: 'allow' })
  .confirmEffect(async (intent) => (intent.kind === 'shell' ? 'allow' : 'deny'))
  .build();
```

Apache-2.0 — see `LICENSE` and `NOTICE`.
