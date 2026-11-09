# 插件系统

Octopi 插件是**受信任、在宿主进程内运行的扩展**。插件通过统一的版本化契约贡献 Tool、Command、后台 Service 和已声明 Hook；宿主在执行插件代码之前先完成包校验。

> **信任边界**：manifest 声明、`allowList` 和 `blockList` 用于安装决策与诊断，**不是沙箱**。进程内插件可以直接使用 Node.js API。ToolPolicy 和 EffectPolicy 约束经 Tool 接口发生的调用与效应，不能约束插件进程中的任意代码。不要安装不可信代码。

## 当前实现状态

本文描述插件 v1 契约：manifest-first 加载（P1）、per-Agent Plugin Tool 执行链（P2）、Plugin Command（P3）与类型化 Hook 执行面（P4）。

| 能力面 | 状态 |
|---|---|
| import 前的 manifest 校验 | 已实现 |
| import 前的显式启用 / allow / block 决策 | 已实现 |
| JSON Schema 配置校验 | 已实现 |
| 依赖、身份与贡献声明一致性校验 | 已实现 |
| 暂存注册与有效注册表原子发布 | 已实现 |
| Tool / Command / Service / Provider / Channel 贡献注册 | 已实现；声明集合与实际注册集合必须一致 |
| Tool 挂载、per-Agent allow/deny、执行与来源归因 | 已实现；`tools.allow` 为空不会暴露插件 Tool |
| Command 元数据、调用方准入与 Host `sessionOps` 授权 | 已实现；插件 SessionOp 必须与 manifest 声明一致 |
| Hook 执行语义 | 22 个 Hook 名已实现：类型化 Observe / Collect / Transform / Vote / Override 组合、Tool 与 Iteration 双阶段、协作式超时、逐调用审计 |
| Run / Tool / Iteration / Message / Compact / Session 归档 / Gateway 触发点 | 已接入真实生产路径 |
| Tool 审批投票（`before_tool_call` 的 `require_approval`） | 已接入 Host HITL 通道；`approve` / `approve_session` / `approve_always` 由引擎决策缓存记账；无审批通道时拒绝执行 |
| 后台服务 | 已实现：manifest 声明的 `registerService`，宿主负责启停、required 失败回滚、optional 失败产生 System Issue、逆序停止、协作式超时 |
| Provider 贡献（P5） | 已实现：`contributes.providers` + `registerProvider` 工厂，由 `models.providers[].plugin` 引用；维护中的真实示例插件 `examples/plugins/openai-compat-dialect` |
| Channel 贡献（P5b） | 已实现：`contributes.channels` + `registerChannel` 工厂，由 `channels[].plugin` 引用；维护中的真实示例插件 `examples/plugins/feishu-channel` |
| `before_install` Hook | 已声明但休眠——仓库尚无真实 Skill/Plugin 安装流程，没有接线任何触发点，也绝不伪造 |
| `session_end` Hook | 仅在真实归档导出并从热库删除后触发（需配置归档管理器）；普通删除或压缩不会冒充它 |
| `before_prompt_build` / `before_iteration` 快照 | 已实现；带预算和 pluginId 归因的快照随 turn envelope 的 `runtime_snapshot` 槽位（`before_prompt_build`）或当次请求视图（`before_iteration`）携带；绝不写入 system prompt |
| ContextEngine 注册 | 尚未进入稳定 v1 作者面 |
| 不可信代码隔离 / 热卸载 | 不支持 |

## 包结构

```text
my-plugin/
  octopi.plugin.json
  index.js             # 编译后的 ESM 入口；路径在 manifest 中显式声明
  package.json
```

Loader 扫描每个配置路径。路径可以是插件目录，也可以是包含插件目录的父目录。只有含 `octopi.plugin.json` 的目录才是候选插件。

## Manifest v1

```json
{
  "id": "acme.search",
  "apiVersion": "1",
  "version": "1.0.0",
  "name": "Acme Search",
  "description": "Search Acme",
  "entry": "./index.js",
  "enabledByDefault": true,
  "engine": { "octopi": ">=0.98.18 <1" },
  "configSchema": {
    "type": "object",
    "properties": { "region": { "type": "string", "enum": ["cn", "global"] } },
    "required": ["region"],
    "additionalProperties": false
  },
  "contributes": {
    "tools": ["acme_search"],
    "commands": [{ "name": "acme-status", "sessionOps": [] }],
    "services": ["acme-watcher"],
    "providers": ["acme-llm-gateway"],
    "channels": ["acme-im"],
    "hooks": ["message_received"]
  },
  "requiresPlugins": [],
  "legacyPluginIds": ["acme.legacy-search"]
}
```

- `apiVersion` 是插件契约版本；`engine.octopi` 是与已安装 engine 核对的 semver 范围。
- `entry` 必填。解析后的 realpath 必须仍在插件根目录内，包括符号链接解析之后。这是包校验，不是安全沙箱。
- manifest 是安装前的声明权威。`definePlugin` 只重复入口 `id`，用于身份一致性校验。
- `contributes` 声明入口必须实际注册的内容。未声明或缺失的 Tool、Command、Hook、Service 都会使该插件注册失败。
- `legacyPluginIds` 将旧配置 ID 映射到当前身份。新旧 ID 同时配置会报错。
- 未知 manifest 字段会被拒绝。旧草案中只有声明、没有消费者的字段不会成为静默功能开关。

配置 schema 支持本文展示的 JSON Schema 子集，包括 object/array/标量类型、required、enum、range、length、pattern、`additionalProperties` 和组合。非法或不受支持的 schema 会在 import 前失败。配置错误指出字段路径，不回显 secret 值。

## 入口与作者 API

```ts
import { definePlugin } from '@octopi-agent/engine/plugin-sdk/plugin-entry';

export default definePlugin({
  id: 'acme.search',
  register(api) {
    api.registerTool(
      {
        name: 'acme_search',
        description: 'Search Acme',
        parameters: {
          query: { type: 'string', description: 'Search query', required: true },
        },
        capabilities: ['egress'],
      },
      async (args, ctx) => {
        const region = api.pluginConfig.region;
        return search(args.query, { region, signal: ctx.abortSignal });
      },
    );

    api.registerCommand({
      name: 'acme-status',
      description: 'Show Acme service status',
      kind: 'control',
      risk: 'low',
      invocableBy: ['principal'],
      sessionOps: [],
      async handler() {
        return { status: 'ok', display: { type: 'text', text: 'Acme is ready' } };
      },
    });

    api.on('message_received', async (event) => {
      api.logger.info(`Message in ${event.sessionId}`);
    });
  },
});
```

`register` 只应声明贡献，不是任意外部副作用的事务。注册失败会丢弃暂存的 Tool/Command/Hook，但无法撤销插件已经进行的网络或文件系统副作用。外部资源应在明确的宿主生命周期扩展点启动。

- `api.pluginConfig` 是已通过校验的业务配置。
- `api.resolvePath(relativePath)` 在 ESM 中相对于插件根目录解析路径。
- Tool 的 `capabilities` 必填。含 `fs-write` 的 Tool 未显式声明时默认串行执行。
- `api.on` 按 22 个既有 Hook 名提供类型。`before_tool_call` 与 `before_iteration` 是双阶段事件，必须传 `{ phase: 'transform' | 'vote' }`（或使用 `api.onBeforeToolCall` / `api.onBeforeIteration` 辅助方法）；其余事件不得传 `phase`。声明不代表所有事件都已有生产触发点，见上方状态表（`before_install` 处于休眠）。
- `api.registerService` 暂存后台服务，且必须同时在 `contributes.services` 声明；启停生命周期由宿主管理（见「后台服务」）。
- `api.registerProvider` 暂存 Provider 工厂，且必须同时在 `contributes.providers` 声明；宿主按 `models.providers[].plugin` 引用逐实例化（见「Provider 贡献（P5）」）。
- `api.registerChannel` 暂存 Channel 工厂，且必须同时在 `contributes.channels` 声明；宿主按 `channels[].plugin` 引用逐实例化（见「Channel 贡献（P5b）」）。
- `api.getContributionInstance(kind, id)` 返回本插件被宿主服务中的 provider/channel 存活实例，恰好一个语义（见「贡献实例（P6-3）」）。
- `api.stateDir` / `api.ensureStateDir()` —— 每插件私有状态目录，0700 创建（chmod 失败经插件 logger 报告、目录保持文件系统默认——见「宿主存储原语（P6-4）」）。
- `api.secrets.get/set/delete` —— 宿主凭证金库上的每插件 secret 命名空间（AES-GCM、消费者绑定）；返回的明文绝不记录或持久化。
- ContextEngine 与媒体 Provider 注册方法，在各自具备完整生产消费者和生命周期契约之前，故意不开放。

## 插件 Command 与 Session 效应

manifest 声明一个 Command 可请求的完整 SessionOp 集合，并在 `registerCommand` 中重复相同集合；两者不一致会在发布前使注册失败。缺省或空的 `sessionOps` **不授予任何 Session 效应**。支持的操作名是 `abort_run`、`new_session`、`set_model`、`compact`、`set_preferred_agent`；最后一项仍为保留语义，v1 没有实际落地实现。

```json
{ "commands": [{ "name": "acme-status", "sessionOps": ["compact"] }] }
```

Host 从已挂载的有效贡献获得插件身份，不信任 handler 返回的字段。执行**任何** SessionOp 之前，Host 按该插件和 Command 核对有效 manifest。出现未知或未声明的操作时，整批拒绝：前面的操作也不执行，结果变为 `denied`，并向 `~/.octopi/audit/commands/YYYY-MM-DD.jsonl` 追加 `command_denied` 记录。记录包含 Session、Agent、插件、Principal、请求操作和被拒操作。审计写入失败时仍拒绝效应，并产生 `command.audit_failed` System Issue。该按日 JSONL 账本不是防篡改账本。

manifest 的 Command 声明包含 `name` 与 `sessionOps`，其他元数据由受信任插件的 `registerCommand` 提供。支持的 `kind` 只有 `control`（默认）与 `prompt`；`client` 在注册时拒绝，因为 v1 没有客户端效应契约。`kind`、`risk`、`args`、`preempt`、`invocableBy` 会原样保留到挂载。`risk` 只是目录元数据，**不代表已经接入 HITL 审批**。`invocableBy` 默认为 `['principal']`，是调用方类别检查，不是具体用户或 Session 角色 ACL。v1 只有 `principal`、`agent`、`service` 三类。host/user/timer Principal 映射为 `principal`；service/subsystem 映射为 `service`，各类别不隐式互相继承。插件贡献的来源不是调用方类别。`preempt` 只跳过活跃 Run 的 busy 检查，不授予任何 SessionOp 权限。

`newSessionId` 只能由 Host 在已授权的 `new_session` 后生成，handler 自报的值会被丢弃。Router 的候选身份包含 Command 名，因此同一插件的多个 Command 分别参与冲突裁决与注销，授权仍使用真实 pluginId。

`prompt` Command 可以返回 `enterLoop: true` 和非空 `messages`，但不能同时携带 SessionOp。`control` Command 不进入 Loop。已声明的效应仍需通过 Host 原有业务校验，可能因业务原因失败。禁用插件不会贡献可见或可执行的 Command。

## Hook 执行语义

每个 Hook 名属于一种组合类别，失败、取消和审计语义明确。handler 按 priority 顺序执行（同优先级按注册顺序）；`priority` 只决定执行顺序，永远不能推翻拒绝。

| 类别 | Hooks | 失败语义 |
|---|---|---|
| Observe | `agent_end`、`after_tool_call`、`message_received`、`message_sent`、`session_start`、`session_end`、`after_compaction`、`gateway_start`、`gateway_stop`、`after_iteration`、`loop_end` | fail-open：handler 抛错只记录，操作继续 |
| Collect | `before_prompt_build` | 逐贡献 fail-open：失败的收集器跳过并记录，有效贡献照常生效 |
| Transform | `before_model_resolve`、`agent_turn_prepare`、`before_agent_finalize` | fail-closed：handler 抛错中止 Run（工具级 `before_tool_call` Transform 抛错则拒绝该次调用、不执行任何内容）；不发布部分变换结果 |
| Vote | `before_agent_run`、`message_sending`、`before_compaction`、`before_install`，以及 `before_tool_call` / `before_iteration` 的 `vote` 阶段 | fail-closed：任一 `deny` 获胜；handler 抛错计为 `deny`；`before_tool_call` 之外的 `require_approval` 视为拒绝 |
| Override | `before_agent_reply` | 只允许一个所有者；多个所有者或失败都拒绝 Run |

- 双阶段事件先执行 `transform`，再以变换后的值执行 `vote`。对 `before_tool_call`，变换后的参数会重新经过工具自身校验和宿主安全检查才进入 Vote；审计同时保留原始参数、最终参数和修改者。被拒的工具调用不执行 handler，也不伪造 `after_tool_call`。
- 每次 handler 执行都有协作式超时（默认 30 秒，可通过 `timeoutMs` 或插件配置 `hooks.timeouts` 逐 Hook 覆盖）。handler 收到 `AbortSignal`；进程内代码无法被强制终止。
- 每次执行都会向按日审计（`~/.octopi/audit/hooks/YYYY-MM-DD.jsonl`）追加记录：pluginId、hook、阶段、结果、run/session/agent 身份和 Principal。该账本是诊断用途，不是防篡改账本；审计写入失败不改变操作结果。
- Run 级观察报告精确终态事实：`reason` 为 `completed | should_stop | aborted | error | denied`，`success` 仅在干净终态（`completed` 或 `should_stop`）为 true。策略拒绝在 Hook 观察中呈现为 `reason: 'denied'`，Core `agent_end` 事件仍保留兼容的 `error` 原因。
- `before_agent_reply`（Override）真正替代本次 Run 的模型回复；`before_agent_finalize` 只变换无工具调用的最终回复。两者都不得添加 `toolCalls`（不会有对应工具结果）。事件与持久化携带定稿后的回复；已流式推送到客户端的文本无法追回——需要完全控制回复的插件应使用 `before_agent_reply`。
- Iteration 的 model/thinking 变换只能选择宿主已配置的值——未知模型直接失败，不静默回退。选中的 thinking 级别进入 LLMRequest，内置适配器映射到各自原生参数（`reasoning_effort` / `thinking.budget_tokens`）；插件 Provider 自行决定映射（见「Provider 贡献（P5）」）。
- `before_prompt_build` 贡献随 turn envelope 的 `runtime_snapshot` 槽位与其他易变块一同携带：用户消息 write-once（原始文本永不改写、后续轮次永不重写，发给模型的内容即存储内容）。`before_iteration` 快照只投影到当次 LLM 请求视图。system prompt 永不受影响。

## 工具调用审批

`before_tool_call` 的 Vote 可以返回 `require_approval` 并携带 `approval` 请求。宿主展示既有的高风险审批卡片，审批结果直接裁决该 Vote：

- `approve` 只放行本次调用；`approve_session` 与 `approve_always` 由引擎决策缓存记账（分别按 Session、按 Agent 在进程生命周期内），同一工具在相应范围内不再重复询问。
- 超时、取消和人工拒绝是不同的拒绝来源，均如实保留在审计记录和拦截原因中；超时绝不会被记录成人工拒绝。
- 记账键是（通道，pluginId，工具名，会话/agent），不含参数。因此 `approve_session` 与 `approve_always` 会覆盖同插件策略下同一工具的后续参数变形（内置 `high_risk` 通道保持既有的工具名键）；参数敏感的工具应使用一次性批准。
- 未配置宿主审批通道时，`require_approval` 拒绝执行（fail-closed）。

## 后台服务

```jsonc
{ "contributes": { "services": ["acme-watcher"] } }
```

```ts
api.registerService({
  serviceId: 'acme-watcher',
  required: false,
  timeoutMs: 5000,
  start: async (signal) => { /* 绑定资源 */ },
  stop: async (signal) => { /* 释放资源 */ },
});
```

- 每个服务必须在 `contributes.services` 声明且只注册一次。跨插件 ID 冲突在 import 前拒绝；未声明或缺失的贡献在注册时被检出，插件进入有效注册表之前发布失败。
- `registerService` 只暂存服务，不产生副作用。宿主在开放 Channel 之前启动服务，并在关闭时按注册的逆序停止。
- `required: true` 的服务启动失败会回滚并阻止 Gateway 启动；`optional: true` 的失败产生 System Issue，Gateway 继续运行。
- `start`/`stop` 收到 `AbortSignal` 并受 `timeoutMs` 约束（协作式；进程内代码无法被强制杀死）。生命周期结果写入 Hook 审计账本。

## Provider 贡献（P5）

插件可以贡献 **Provider 工厂**——一个命名的构建器，宿主为每个 `models.providers` 条目调用它构造 Core `ModelProvider`。

```jsonc
// octopi.plugin.json
{ "contributes": { "providers": ["acme-llm-gateway"] } }
```

```ts
api.registerProvider('acme-llm-gateway', (context) => {
  // context: { providerName, baseUrl, apiKey, models, defaultModel?, timeoutMs?, options }
  return myModelProvider;
});
```

```jsonc
// octopi.json — 用 `plugin` 引用贡献（与 `api` 二选一）
{
  "models": {
    "providers": {
      "my-gateway": {
        "baseUrl": "https://llm-gateway.internal/v1",
        "apiKey": "${MY_GATEWAY_KEY}",
        "plugin": "acme-llm-gateway",
        "models": [{ "id": "kimi-k2", "reasoning": true, "contextWindow": 131072 }],
        "options": { "thinking": { "field": "enable_thinking", "mode": "boolean" } }
      }
    }
  }
}
```

- `plugin` 与 `api` 二选一——必须恰好设置其一。引用未知或已禁用的贡献 id 会让 provider 创建明确失败（fail closed）。
- 工厂在启动时和配置热替换时按配置实例调用（绝不在注册时调用）。贡献 id 跨插件全局唯一（同 services）；声明集合与实际注册集合必须一致。
- API Key 始终走凭证通道（`apiKey`，推荐 `${ENV_VAR}`；`""` = 无鉴权）。`options` 只放**非密钥**旋钮，原样透传由插件自行校验。
- `options` 会原样回显到 Web 控制台（`/config/models`）并原样落盘。**禁止在 `options` 里放任何凭据**（承载密钥的自定义鉴权头也应走 `apiKey`）；secret 感知的 options schema 作为后续扩展。
- Provider 生命周期由宿主管理：退役实例（配置热替换或删除）在固定**宽限窗口**（30 分钟，到期强制回收并告警）内继续服务——窗口不是逐请求排空（`ModelProvider` 契约没有 in-flight 计数）。进程关闭路径全量 dispose。`dispose()` 应释放 transport 并中止在途请求（含流式 body）。
- 内置 `api: "openai-completions"` / `"anthropic-messages"` 适配器已覆盖严格 OpenAI 兼容 / Anthropic 端点（自定义 `baseUrl`、可无鉴权）。只有内置覆盖不了的方言才需要 Provider 贡献——参见维护中的真实示例 `examples/plugins/openai-compat-dialect`（自定义鉴权头、extra body 字段、thinking 参数方言）。
- `LLMRequest.thinkingLevel` 在内置适配器映射为 `reasoning_effort`（openai）与 `thinking.budget_tokens`（anthropic）；插件 Provider 自行决定映射。内置 openai 适配器不探测端点是否认识 `reasoning_effort`——仅在设置了 `thinkingLevel` 时发送；不接受该参数的方言端点应使用 Provider 贡献。
- 插件 Provider 默认不参与 wire dump（`observability.llmRequestDump`），除非自行实现 `wireBodyFor(request, mode)`；装饰链会转发 `dispose`，生命周期保证在 dump 开启时同样成立。

## Channel 贡献（P5b）

插件可以贡献 **Channel 工厂**——一个命名的构建器，宿主为每个 `channels` 条目调用它构造 Gateway `ChannelAdapter`（消息传输面）。

```jsonc
// octopi.plugin.json
{ "contributes": { "channels": ["feishu"] } }
```

```ts
api.registerChannel('feishu', async (context) => {
  // context: { channelName, apiKey, options }
  return myChannelAdapter; // { name, start(handler), send(reply), stop() }
});
```

```jsonc
// octopi.json —— 通过 `plugin` 引用贡献（与 `type` 二选一）
{
  "channels": [
    {
      "plugin": "feishu",
      "apiKey": "${FEISHU_APP_SECRET}",
      "options": { "appId": "cli_xxx", "policy": { "dmMode": "allowlist", "dmAllowlist": ["ou_…"] } }
    }
  ],
  "session": { "dmScope": "per-conversation" }
}
```

- `plugin` 与 `type` 二选一恰好其一。`type: "http"` 选择内置 HTTP/WebSocket 通道；`plugin` 指向 channel 贡献。引用未注册/被禁用的贡献、或未知的内置 `type`，都在 daemon 启动时以真实原因失败（fail closed）。
- 工厂按 `channels` 条目在启动时调用（绝不在注册时）。贡献 id 全局唯一且兼作通道标签：宿主拒绝 `adapter.name` ≠ 贡献 id，`registerChannel` 拒绝重名，内置通道 id（`http`）为保留名。v1 每个 channel 贡献 id 只支持一个实例。
- 适配器契约即 Channel SPI（`start(handler)` 接收规范化 `ChannelMessage`，`send(reply)` 投递 `ChannelReply`，`stop()` 释放传输面）。宿主按 Gateway 生命周期驱动 `start`/`stop`：服务先于通道启动、通道按注册逆序停止。单个通道 `start()` 失败会记日志、上报 issue、best-effort `stop()`（因此 `stop()` **必须容忍在 `start()` 失败后被调用**）并移出路由表——启动继续而该通道缺席；仅当**全部**通道失败或内置 `http` 通道失败（HTTP/WS 监听器缺失时不得报 Ready）才以真实原因 `AggregateError` 终止启动。
- 适配器可实现可选的 `status()`（`{ state: 'running' | 'dormant' | 'degraded' | 'retiring', detail? }`）参与健康聚合：gateway `/health` 端点逐通道上报状态。未实现 `status()` 的适配器在 `start()` 成功后按 `running` 报告（start/stop 契约使"已启动"即真实缺省）；`status()` 抛错只降级该通道的健康项，不影响其余。
- 消息携带 `channel === adapter.name`；回复与命令短回复经同一适配器路由。`channelBindings` 以通道标签为键；`session.dmScope: "per-conversation"` 按会话聚合（群聊全员共享一个会话）。
- 通道等于让能触达它的人驱动一个带真实工具的 agent。超出个人使用的部署必须配置传输面自身的准入闸（如飞书示例的 `policy` 白名单）。
- `options` 原样落盘；**禁止在 `options` 里放任何凭据**（密钥走 `apiKey`）。`octopi.schema.json` 的 JSON Schema 无法表达 `type | plugin` 互斥（与 `models.providers[].api|plugin` 相同）；运行时强校验。
- 真实示例：`examples/plugins/feishu-channel`——飞书机器人，走官方 SDK 长连接（WebSocket），带 DM/群准入策略与 @ 检测。

## 贡献实例（P6-3）

工厂型贡献（providers、channels）暂存的是工厂；配置引用到它们时由宿主创建运行时实例。每个**被宿主验收**的实例都登记在按插件隔离的实例注册表中，插件通过窄接口
`api.getContributionInstance(kind, id)` 取回自己的存活实例——这是模块闭包桥（工厂与工具共享 `let adapter`）的官方替代：闭包在多实例化与退役后都会错位。

```js
api.registerChannel('weixin', async (context) => createWeixinChannelAdapter(context, {}));
api.registerTool({ name: 'weixin_pair', /* ... */ }, async () => {
  const adapter = api.getContributionInstance('channel', 'weixin');
  // TypeScript 作者：调用 SPI 之外的方法时转换到自己的适配器接口
  return adapter.pair();
});
```

契约：

- **种类**：仅 `'provider'` 与 `'channel'` —— 只有工厂型贡献的实例与其注册可分离。tools、commands、hooks、services 本身就是其注册。其他 kind 字符串会被真实错误拒绝（该 API 从纯 JS 也能调到）。
- **诞生**：实例在宿主**验收**工厂产物时登记（契约校验之后），注册表的 "live" 与宿主路由集一致。被拒绝的工厂产物永不入表；预构建后因配置应用中止而从未装机的实例也不入表（宿主会撤销其验收）。登记的对象是**工厂产物本身**：插件私有方法只存在于产物上。开启 `observability.llmRequestDump` 时宿主经装饰副本路由——副本只带 SPI 成员并把调用转发给产物（其 `dispose` 转发闭合退役链；验收先于装饰执行）。
- **退役**——两个触发点，都幂等：
  - 物理：实例的生命周期方法被调用——channel 是 `stop()`，provider 是 `dispose()`（provider 没有 dispose 时定义为退役标记）。在**发起**调用时记录，不论成败。
  - 逻辑：宿主停止路由到该实例——同贡献键与配置身份的新实例被验收（热更替换），或实例被摘出路由（provider 删除/配置重置即刻标记）。实例可能仍在为排空中的在途请求服务直到被 dispose——热更时 provider 的 dispose 由 gateway 宽限窗口延迟，但 lookup 在退役时（而非 dispose 时）即停止返回该实例。
  - 再次验收同一产物（单例工厂）会将其条目复活为 live。正常操作是宿主调用生命周期方法（停机、回滚、热更）；插件自己也可以调——方法就长在它自己的实例上。
- **恰好一个语义**：仅当恰好存在一个存活实例时查询成功，否则抛真实错误：
  - 从未实例化：`has no live instance (the Host has not instantiated it)`；
  - 已退役：`has no live instance (its instance was retired)`；
  - 多个同时存活：错误会列出实例标签——此时应在工厂闭包中按实例捕获句柄（每次工厂调用都可闭包自己的）。provider 的标签是 `models.providers` 配置键；channel 的标签是贡献 id（gateway 每个 channel id 最多一个实例）；
  - 不是本插件的贡献：跨插件查询不在 v1 契约内。
- 退役无法跟踪的实例（冻结/封闭对象）**不予登记**，宿主会显式告警；宿主自己的契约校验负责报告残缺适配器，注册表从不给对象打补丁。
- 声明的返回类型是 SPI 结构视图（`ModelProvider`、`PluginChannelAdapterLike`）。SPI 之外的插件自有方法（如 weixin 适配器的 `pair()`）运行时真实存在；TypeScript 作者可转换到自己的适配器接口。

## 宿主存储原语（P6-4）

插件从宿主获得两个存储原语——这是唯一受支持的持久化面；绝不写插件安装目录。

- **`api.stateDir`** —— 每插件私有状态目录（`OCTOPI_HOME/plugin-state/<id>`，`api.ensureStateDir()` 首次使用时以 0700 创建）。运行时状态（游标、会话文件）放这里。
- **`api.secrets`** —— 宿主凭证金库的 `get/set/delete`（`OCTOPI_HOME/credentials/credentials.db`，落盘 AES-GCM）。值存放在插件自己的命名空间（`plugin:<id>:<key>`），并绑定该插件为唯一可解析消费者（写入时撤销遗留的他人绑定）。`get` 返回的明文是短命的：绝不记录或持久化。**secret 不进状态文件、不进 options、不进日志。**
  前置条件：必须配置金库加密主密钥（`OCTOPI_CREDENTIALS_KEY` 或 `OCTOPI_CREDENTIALS_KEY_FILE`）——否则 `set` 抛真实错误。插件如需在此类失败下降级，必须显式降级（如 weixin 示例把 token 保留在状态文件 inline 形态并记录金库错误，而不是丢 token）。

```js
register(api) {
  const stateDir = await api.ensureStateDir(); // 0700
  await api.secrets.set('bot_token', token);   // 落盘加密
  const token = await api.secrets.get('bot_token');
}
```

- secret 键为 `[A-Za-z0-9._-]+`；空值以真实错误拒绝。元数据（名字、模式、时间戳）不含明文。
- manifest **`secretOptions`**（可选 `string[]`）声明 `options` 中哪些键是 secret（如配对码）。宿主在配置回显面（Web 控制台 `GET /config/models`）把这些值替换为与 `apiKey` 相同的 `RedactedSecret` 视图（`{configured, ref}`），绝不回显明文。回显占位符可安全回写：upsert 时声明键上的 `RedactedSecret` 形状值表示「客户端未改动」——保留存储值（与 `apiKey` 留空规则同义）。插件贡献不在有效注册表时宿主 fail-closed，整个 `options` 全量打码。范围说明：当前脱敏面只有 `models.providers` 回显——尚无 channel 配置回显端点，channel manifest 上的 `secretOptions` 是先行声明。

真实示例：`examples/plugins/weixin-clawbot` —— 运行时状态（`baseurl`、游标）在 `api.stateDir`，`bot_token` 在金库（`api.secrets`），并提供一次性 `migrateLegacyState()` 收编 P6-4 之前的单文件状态（内联 token 首次保存时移入金库）。

## 配置

```jsonc
{
  "plugins": {
    "loadPaths": ["~/.octopi/plugins"],
    "allowList": ["acme.search"],
    "blockList": [],
    "entries": {
      "acme.search": {
        "enabled": true,
        "config": { "region": "cn" }
      }
    }
  }
}
```

任何插件 import 之前，按以下顺序解析启停：

```text
blockList → allowList → entries[id].enabled → manifest.enabledByDefault → true
```

- `blockList` 优先。配置 `allowList` 后，未列出的插件禁用。
- `entries[id].enabled` 是唯一的逐插件启停设置。
- 只有 `config` **不会隐式启用**插件。未写 `enabled` 时采用 manifest 默认值，再回退为 `true`。
- 依赖必须自身合格。依赖不会自动启用插件，也不会绕过 allow/block。依赖禁用或失败时，依赖它的插件同样拒绝。
- 重复 ID、冲突的旧 ID 别名、重复声明的能力会被拒绝，不由扫描顺序决定保留谁。
- `loadPaths`、allow/block 和逐插件启停属于安全配置，修改需要重启并触发配置漂移保护；业务配置不会以明文复制到指纹诊断字段。

### 允许 Agent 使用插件 Tool

加载插件与向 Agent 暴露 Tool 是两个独立决策。插件 Tool **默认对所有 Agent 拒绝**，包括 `tools.allow` 为空或未配置时。按 Tool 名称显式允许，或显式选择 `*`：

```jsonc
{
  "agents": [
    {
      "id": "researcher",
      "model": { "provider": "openai", "model": "gpt-5.5" },
      "tools": { "allow": ["acme_search"] }
    },
    {
      "id": "writer",
      "model": { "provider": "openai", "model": "gpt-5.5" },
      "tools": { "allow": [] }
    }
  ]
}
```

`researcher` 可以看到并执行 `acme_search`；`writer` 不能。`tools.deny` 同时覆盖精确 allow 和 `allow: ["*"]`。builtin Tool 的既有行为不变：空 allow 仍允许未 deny 的 builtin Tool。

宿主把贡献挂载到每个 Agent 的 ToolBus，并按 Agent 策略过滤发给 LLM 的工具定义。ToolBus 直接执行和插件 handler 执行也会检查当前策略，因此“模型不可见”不是唯一授权检查。插件 Tool 不能静默覆盖 builtin 或已注册的 Tool；同名冲突会报错。

handler 收到标准 `ToolExecutionContext`，包括 `runId`、`sessionId`、`agentId` 和 `abortSignal`。取消是**协作式**的：handler 应在副作用边界检查 `abortSignal` 并停止。`definition.timeoutMs` 使用现有工具看门狗，但不能强制终止任意进程内代码。`tool.exec.end` 事件和持久化 ToolResult 中的来源为 `{ kind: "plugin", origin: pluginId, trustLevel: "third-party" }`。

ToolPolicy / EffectPolicy 仍约束经 Tool 接口发生的调用与效应。`trustLevel` 是诊断元数据，不是授权或沙箱。Agent 的 `tools` 配置在重启/重建时生效，不是每条消息可任意覆盖的授权入口。

### 迁移 `plugins.configs`

旧配置：

```json
{ "plugins": { "configs": { "acme.search": { "region": "cn" } } } }
```

会被报告为 `CFG013`，由 `loadConfig` 在内存中迁移，或由 `octopi doctor --fix` 写回为：

```json
{ "plugins": { "entries": { "acme.search": { "config": { "region": "cn" } } } } }
```

旧字段原本未接入默认 Gateway，因此迁移不会凭空补出 `enabled: true`。需要时请显式设置 `enabled`。新旧条目冲突会明确失败，不会静默选择一份。

## 加载与失败语义

```text
读取 manifest
→ 解析当前身份与旧 ID
→ 启停 / allow / block 决策
→ 依赖合格性与声明冲突规划
→ 解析入口、校验业务配置与 engine 范围
→ 只 import 合格入口
→ 暂存注册并核对声明
→ 发布宿主级有效贡献注册表
→ 在各自实现阶段挂载到消费者
```

插件失败后不会留下有效 Tool、Command、Service 或 Hook；其下游依赖也会拒绝。无关的有效插件仍可加载。宿主级注册表不等于 per-Agent ToolBus：注册表发布不代表每个 Agent 已挂载该 Tool。同理，已挂载也不代表已对模型暴露；Agent 的 `tools.allow` 决定最终发给 LLM 的工具定义和是否允许执行。

使用 `PluginManager.getDiagnostics()` 区分 `disabled`、`failed` 和 `registered`，并查看失败阶段与原因。默认 Gateway 启动时会输出未注册状态的诊断。

## 创建插件

```sh
octopi plugin init acme.search --dir ~/.octopi/plugins/acme.search
# 将 index.ts 编译为 index.js，安装依赖，然后配置并重启 Octopi。
```

脚手架使用与上文一致的 v1 manifest、`definePlugin` 和 Tool 声明契约。**注册不是 Tool 暴露**：启用插件后，还要把 Tool 名称加入目标 Agent 的 `tools.allow`（或显式选择 `*`），再重启/重建 Agent。
