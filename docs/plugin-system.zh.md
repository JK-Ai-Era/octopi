# 插件系统

Octopi 插件是**受信任、在宿主进程内运行的扩展**。插件通过统一的版本化契约贡献 Tool、Command 和已声明 Hook；宿主在执行插件代码之前先完成包校验。

> **信任边界**：manifest 声明、`allowList` 和 `blockList` 用于安装决策与诊断，**不是沙箱**。进程内插件可以直接使用 Node.js API。ToolPolicy 和 EffectPolicy 约束经 Tool 接口发生的调用与效应，不能约束插件进程中的任意代码。不要安装不可信代码。

## 当前实现状态

本文描述插件 v1 P1 已交付的 manifest-first 加载基础。

| 能力面 | 状态 |
|---|---|
| import 前的 manifest 校验 | 已实现 |
| import 前的显式启用 / allow / block 决策 | 已实现 |
| JSON Schema 配置校验 | 已实现 |
| 依赖、身份与贡献声明一致性校验 | 已实现 |
| 暂存注册与有效注册表原子发布 | 已实现 |
| Tool / Command 贡献注册 | 已实现 |
| Tool 挂载到 per-Agent ToolBus | 下一阶段；仅注册不代表 Tool 已对 LLM 暴露 |
| Command 元数据与 Host `sessionOps` 授权 | 下一阶段；现有桥接行为不是完整授权模型 |
| Hook 执行语义 | 保留现有 message/gateway-stop 触发点；类型化组合和其余触发点后续实现 |
| Provider / Channel / ContextEngine 注册 | 尚未进入稳定 v1 作者面 |
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
    "hooks": ["message_received"]
  },
  "requiresPlugins": [],
  "legacyPluginIds": ["acme.legacy-search"]
}
```

- `apiVersion` 是插件契约版本；`engine.octopi` 是与已安装 engine 核对的 semver 范围。
- `entry` 必填。解析后的 realpath 必须仍在插件根目录内，包括符号链接解析之后。这是包校验，不是安全沙箱。
- manifest 是安装前的声明权威。`definePlugin` 只重复入口 `id`，用于身份一致性校验。
- `contributes` 声明入口必须实际注册的内容。未声明或缺失的 Tool、Command、Hook 都会使该插件注册失败。
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
- `api.on` 按 22 个既有 Hook 名提供类型。声明不代表所有事件都已有生产触发点，见上方状态表。
- Provider、Channel、ContextEngine、媒体 Provider 与后台服务注册方法，在各自具备完整生产消费者和生命周期契约之前，故意不开放。

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

插件失败后不会留下有效 Tool、Command 或 Hook；其下游依赖也会拒绝。无关的有效插件仍可加载。宿主级注册表不等于 per-Agent ToolBus：注册表发布不代表每个 Agent 已挂载该 Tool。

使用 `PluginManager.getDiagnostics()` 区分 `disabled`、`failed` 和 `registered`，并查看失败阶段与原因。默认 Gateway 启动时会输出未注册状态的诊断。

## 创建插件

```sh
octopi plugin init acme.search --dir ~/.octopi/plugins/acme.search
# 将 index.ts 编译为 index.js，安装依赖，然后配置并重启 Octopi。
```

脚手架使用与上文一致的 v1 manifest、`definePlugin` 和 Tool 声明契约。**注册不是 Tool 暴露**：Agent 挂载和 allow/deny 行为将在 Tool 集成阶段交付。
