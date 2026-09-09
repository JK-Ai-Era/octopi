# 自主子系统 — 开发者指南

> 本文档面向子系统作者，说明如何正确使用本轮新增/修正的能力点。

---

## 1. 子系统目录结构

```
subsystems/my-subsystem/
├── config.yaml           # 运行时配置（必需）
├── SUBSYSTEM.md          # LLM 认知指令（llm/hybrid 模式必需）
├── handler.ts            # 代码逻辑（code/hybrid 模式必需）
├── references/           # 参考知识（可选）
└── scripts/              # 辅助脚本（可选）
```

子系统可从以下位置加载（按优先级，同名覆盖）：

| 位置 | 作用域 | 谁管理 |
|------|--------|--------|
| `<project>/.octopi/subsystems/` | 项目级 | 项目团队 |
| `~/.octopi/subsystems/` | 用户级 | 用户个人 |
| `<octopi-bundle>/subsystems/` | 框架级 | octopi 团队 |
| `node_modules/@octopi/subsystem-*` | npm | npm 包 |
| `node_modules/octopi-subsystem-*` | npm | 社区包 |

---

## 2. 显式必填字段

以下三个字段在 `config.yaml` 中**必须显式声明**，缺失会导致加载失败：

```yaml
# 必填
act:
  mode: none | block | modify | inject

signal:
  severity: info | advisory | warning | critical
  channel: [event, context, steering, escalate]

boundary:
  visibility: isolated | structured | partial | full
  authority: observe | suggest | act | override
  security: sandboxed | trusted | privileged
```

框架不会为这三个字段提供默认值。这是设计约束——子系统的能力边界必须显式声明。

---

## 3. 信号通道（signal.channel）

`signal.channel` 决定信号如何投递到主系统。框架严格按配置路由，不再仅按 action 推断：

| 通道 | 语义 | 时序 |
|------|------|------|
| `context` | 注入为上下文信息 | 下一次 LLM 调用前生效 |
| `steering` | 注入为引导消息 | 当前轮次立即生效 |
| `event` | 通过 EventBus 广播 | 异步，其他子系统可监听 |
| `escalate` | 请求主系统介入 | 当前轮次优先处理 |

示例：

```yaml
signal:
  severity: advisory
  channel: [context, event]   # 信号同时注入上下文 + 广播事件
```

---

## 4. 生命周期约束（lifecycle）

```yaml
lifecycle:
  maxDurationMs: 15000        # 超时中断（毫秒），超时后审计记录 status=timeout
  maxTokens: 10000            # token 预算上限（基于输入输出体积估算）
  maxConcurrent: 1            # 最大并发实例数
  degradeOn: timeout | error | both   # 降级策略
```

- `maxDurationMs`：code handler 也会被 AbortSignal 打断，不仅限于 LLM 模式。
- `degradeOn`：决定中断时是否发送信号。`timeout` 时不发送（子系统未完成，无有效信号）；`error`/`both` 时发送中断信号。
- `maxTokens`：运行时基于输入/输出 JSON 体积估算 token 消耗，超出预算时按 `degradeOn` 策略处理。

---

## 5. 条件触发（condition / conditionRef）

### 5.1 声明式 condition

```yaml
sense:
  source: eventBus
  filter:
    events: [iteration.end]
    condition: "turn.count % 10 === 0"
```

- 变量名映射到 `ctx.metrics[key]`，由主循环注入。
- 支持多变量、点号分隔的 key（如 `sessionLifecycle === 'recent'`）。
- 与 `conditionRef` **互斥**。

### 5.2 代码引用 conditionRef

```yaml
sense:
  source: eventBus
  filter:
    events: [session.lifecycle.updated]
    conditionRef: "./handler.ts:shouldExtract"
```

- 格式：`<modulePath>:<exportName>`
- 函数签名：`(ctx: SenseContext) => boolean | Promise<boolean>`
- 框架会动态 import 并缓存首次加载结果。
- 与 `condition` **互斥**。

---

## 6. 循环防护（emits 声明）

### 6.1 为什么需要 emits

子系统通过 EventBus 信号互相触发时，可能形成循环：A → B → A。框架在注册时做静态检测。

### 6.2 声明方式

```yaml
sense:
  filter:
    events: [session.lifecycle.updated]
    emits: [memory.extracted]     # 该子系统可能产生的事件类型
```

或在顶层声明（优先级更高）：

```yaml
emits: [memory.extracted]
sense:
  filter:
    events: [session.lifecycle.updated]
```

### 6.3 通配符

LLM 驱动的子系统无法静态确定产出事件，使用通配符：

```yaml
emits: ["*"]   # 框架假设可能产生任何事件（保守处理）
```

### 6.4 检测行为

- 注册时构建 emits → listen 依赖图。
- 发现循环则拒绝注册并返回错误路径。
- 三层叠加防护：静态检测（启动时）+ 深度限制（运行时，默认 5）+ 冷却期（单个子系统，默认 5 秒）。

---

## 7. 自定义工具（tools.definitions）

### 7.1 四种模式

```yaml
tools:
  mode: none | subset | full | custom
```

| 模式 | 语义 |
|------|------|
| `none` | 无工具（默认） |
| `subset` | 从主 Agent 工具集中选子集（需 `names`） |
| `full` | 继承主 Agent 全部工具 |
| `custom` | 完全自定义工具集（需 `definitions`） |

### 7.2 通过代码注册

```typescript
import { SubsystemRuntime } from 'octopi/harness';

runtime.register({
  id: 'my-sub',
  // ...
  tools: {
    mode: 'custom',
    definitions: [
      {
        definition: {
          name: 'analyze',
          description: '分析内容',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: '输入文本' },
            },
            required: ['text'],
          },
        },
        handler: async (args, ctx) => {
          return { result: `analyzed: ${args.text}` };
        },
      },
    ],
  },
});
```

### 7.3 通过 YAML 声明

```yaml
tools:
  mode: custom
  definitions:
    - name: analyze
      description: "分析内容"
      parameters:
        type: object
        properties:
          text:
            type: string
            description: "输入文本"
        required: [text]
```

> **注意**：YAML 声明的 definitions 不含运行时 handler。如果 LLM 调用了该工具，会抛出 "does not have a runtime handler" 错误。完整的 custom tool 需要通过代码注册，或在 `scripts/` 中提供可执行脚本。

---

## 8. npm 子系统分发

### 8.1 命名规范

- 官方：`@octopi/subsystem-<name>`
- 社区：`octopi-subsystem-<name>`

### 8.2 包结构

```
@octopi/subsystem-safety-guard/
├── package.json          # name: "@octopi/subsystem-safety-guard"
├── config.yaml
├── SUBSYSTEM.md
├── handler.ts
└── references/
```

### 8.3 使用方式

```sh
npm install @octopi/subsystem-safety-guard
```

框架在启动时自动扫描 `node_modules/` 下符合命名规范的包，与项目级/用户级/框架级子系统合并加载。

---

## 9. 会话隔离与销毁

```yaml
session:
  mode: ephemeral | persistent
  scope: global | agent | session
  ttl: "24h"
```

| scope | 语义 |
|-------|------|
| `global` | 所有 Agent、所有 Session 共享一个持久会话 |
| `agent` | 同一 Agent 跨 Session 共享 |
| `session` | 每个主 Session 独立 |

`session.scope=session` 的子系统会话会在主会话结束时（收到 `session.ended` 事件）自动清理，避免跨会话污染。

---

## 10. 审计记录

每次执行都会写入审计记录（无论成功失败），路径：

```
~/.octopi/audit/[agentId/]<subsystemId>/<date>.jsonl
```

关键字段：

| 字段 | 说明 |
|------|------|
| `status` | `success / failed / timeout / degraded` |
| `input` | 子系统输入快照 |
| `output` | 子系统输出（失败时可能为空） |
| `signals` | 发出的信号列表 |
| `acts` | 执行的直接行动列表 |
| `tokenUsage` | token 消耗（成功路径基于输入输出体积估算） |
| `durationMs` | 执行时长 |
| `sessionKey` | 会话标识 |

