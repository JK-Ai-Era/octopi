# openai-compat-dialect

Provider contribution (`openai-compat`) for OpenAI-compatible endpoints that need
**dialect tuning** the built-in `api: "openai-completions"` adapter intentionally
does not guess.

> When the endpoint speaks strict OpenAI-compatible protocol (standard
> `Authorization: Bearer` auth, no extra body fields), use the built-in
> `openai-completions` + `baseUrl` instead — no plugin needed. This plugin is
> only for endpoints that deviate.

## What it covers

| Gap | Option |
|---|---|
| Custom auth header (e.g. `X-Api-Key`) | `auth.header` + `auth.prefix` |
| Static extra headers | `extraHeaders` |
| Extra body fields (`enable_thinking`, `chat_template_kwargs`, …) | `extraBody` (merged **under** standard fields) |
| Thinking parameter dialect | `thinking` (`value` / `boolean` / `object` modes) |
| Non-standard reasoning field in responses | `reasoningField` (default `reasoning_content`) |
| Non-standard endpoint path | `path` (default `/chat/completions`) |

## Install

1. Copy this directory into your `plugins.loadPaths` (default `~/.octopi/plugins/`).
2. Enable it in `octopi.json`:

```json
{
  "plugins": {
    "entries": { "openai-compat-dialect": { "enabled": true } }
  },
  "models": {
    "providers": {
      "my-gateway": {
        "baseUrl": "https://llm-gateway.internal/v1",
        "apiKey": "${MY_GATEWAY_KEY}",
        "plugin": "openai-compat",
        "models": [{ "id": "kimi-k2", "reasoning": true, "contextWindow": 131072 }],
        "options": {
          "auth": { "header": "X-Api-Key" },
          "thinking": { "field": "enable_thinking", "mode": "boolean" },
          "extraBody": { "chat_template_kwargs": { "enable_thinking": true } }
        }
      }
    }
  }
}
```

`plugin: "openai-compat"` and `api: "openai-completions"` are mutually exclusive
(exactly one must be set). The API key always travels through the credential
channel (`apiKey`, `${ENV_VAR}` recommended) — never through `options`.
`options` is echoed verbatim to the Web console and written to disk as-is, so
**never put credentials there** (including "custom auth header" values).

## `options.thinking` modes

- `value` (default): send the thinking level string as the field value.
  `values` may override per level, e.g. `{ "high": "max" }`.
- `boolean`: send `true` when thinking is on (per-level `values` must be
  booleans). Off levels are omitted.
- `object`: send an object; default `{ "type": "enabled", "level": <level> }`,
  overridable per level via `values`.

`thinkingLevel: "off"` (or unset) sends nothing.

## Behavior contract

- `chat` / `stream` / `isAvailable` (GET `/models`) / `getModelInfo(s)` /
  `dispose` implement the Core `ModelProvider` contract.
- Models declaring `reasoning: false` reject explicit `thinkingLevel` requests
  (fail loud instead of silently dropping the parameter).
- `dispose()` aborts in-flight requests **including streaming bodies**; the host
  calls it at the end of a fixed grace window on config hot-replace (with a
  logged force-disposal — the window is not a per-request drain) and for every
  instance on shutdown. The request timeout is a connection timeout (until the
  response headers arrive); long streaming bodies are bounded by `dispose()` and
  run cancellation, not by that timer.
- Unknown `finish_reason` values map to `error` (never `stop`), so filtered or
  rejected answers cannot look successful.
