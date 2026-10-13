# @octopi-agent/core

Octopi **Core** — pure execution loop (`agentLoop`) + Kernel contracts (Layer 0–1).

```sh
npm i @octopi-agent/core
```

```ts
import { agentLoop } from '@octopi-agent/core/loop';
// Kernel ports: ModelProvider, SessionStore, SecurityGuard, …
// ToolEffectPolicy L3 ports: ToolFileEffects, MemoryEffectJournal (types/tools)
```

- Zero product strategy; no Session/Memory/Gateway/UI.
- `ToolExecutionContext` carries file/memory effect ports + path containment / confirmEffect (filled by Harness Runner).
- Part of the [Octopi](https://github.com/JK-Ai-Era/octopi) package family (`@octopi-agent/*`).

Apache-2.0 — see `LICENSE` and `NOTICE`.
