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

Apache-2.0 — see `LICENSE` and `NOTICE`.
