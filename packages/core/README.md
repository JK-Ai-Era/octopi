# @octopi-agent/core

Octopi **Core** — pure execution loop (`agentLoop`) + Kernel contracts (Layer 0–1).

```sh
npm i @octopi-agent/core
```

```ts
import { agentLoop } from '@octopi-agent/core/loop';
// Kernel ports: ModelProvider, SessionStore, SecurityGuard, …
```

- Zero product strategy; no Session/Memory/Gateway/UI.
- Part of the [Octopi](https://github.com/JK-Ai-Era/octopi) package family (`@octopi-agent/*`).

Apache-2.0 — see `LICENSE` and `NOTICE`.
