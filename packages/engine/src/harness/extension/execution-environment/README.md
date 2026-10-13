# Execution Environment — 执行环境

> Layer: Layer 2  
> 规格权威：[`arch/tool-effect-policy.md`](../../../../../arch/tool-effect-policy.md)

沙箱管理、工具效应策略（ToolEffectPolicy）、turn 级 undo、资源限制、工作区生命周期。

**核心理念**：Agent 的工具效应必须可约束、可撤销、可配置——约束（Containment）与可撤销（Recoverability）是两根正交的轴。

## 职责

| 模块 | 职责 |
|------|------|
| `effect-policy.ts` | 运行模式预设（`workspace` / `project` / `host` / `untrusted`）→ 有效策略；`gateEffect` |
| `isolation.ts` | I5 工具 cwd 解析（`toolIsolation`：`none` / `session-subdir` / `session-lock`） |
| `undo-log.ts` | **P1** 文件 turn undo（即时生效 + 本轮 undo log）；`sessions/<sid>/undo/`；delete/rename；`meta.json` truncated |
| `undo-merge.ts` | 文本补丁逆放 / 二进制用户整文件优先 |
| `memory-undo.ts` | **P2** 记忆面 journal（`JournaledMemoryStore` + `memory.jsonl`）；steward 不进 turn 事务 |
| `shell-journal.ts` | **§5.6** shell 账本：roots before 快照 → diff → 同一 undo log；`not-reversed.json` |
| `resource-limits.ts` | **P5 / OP-17** 工具 `timeoutMs` 看门狗（`runWithToolLimits`） |
| `sandbox.ts` | ProcessSandbox（L1/L4 执行器；容器槽位未实现） |
| `workspace.ts` | FileWorkspace（快照/搜索；非 turn undo 主路径） |

## ToolEffectPolicy 速查

```jsonc
{
  "effectPolicy": {
    "mode": "host",           // 缺省 host（本机自动化）；严格场景用 workspace
    "transactionRoots": [],    // 额外可 undo 根
    "pathContainment": "strict", // L2：strict | soft | none
    "shellEscape": "deny",     // deny=拒 shell | confirm=host-gate | allow
    "shellJournal": "snapshot", // snapshot | off
    "undoLimit": { "maxEntries": 0, "maxBlobBytes": 0 },
    "processLimits": true,
    "commit": "auto",          // auto | manual
    "onClose": "commit",       // commit | discard（manual 下会话关闭）
    "effects": "engine"        // engine | host-gate（confirmEffect）
  }
}
```

**产品缺省 mode = host**（未配置 effectPolicy / 未写 mode 时）。下表为命名预设展开：

| mode | L2 | shellEscape | toolIsolation | onClose |
|------|----|-------------|---------------|---------|
| `workspace` | strict | **deny**（无 L4 时 fail-closed） | session-subdir | commit |
| `project` | strict | allow（编码需 shell） | session-subdir | commit |
| `host` | none | allow | none | commit |
| `untrusted` | strict | **deny** | session-subdir | **discard** |

**原理**：事务范围 ≈ 自动放行范围。文件/记忆写进 undo 可自动；shell / 根外效应按 `shellEscape` 与 `effects` 通道处置。无 L4 时无法「只禁 shell 越界」——`shellEscape: deny` 必须拒绝 shell 工具本身。

## Turn undo（P1/P2/§5.6）

- 即时生效 + `sessions/<sid>/undo/`（`log.jsonl` + `memory.jsonl` + `meta.json` + `not-reversed.json` + `blobs/<sha256>`）
- **编辑重发**（`truncateMessagesFrom`，仅 abortedTurn）→ 逆放 **agent** 效应；用户手改保留
- 文本 = 补丁逆放；二进制 = 用户整文件优先；delete/rename 逆序回放
- shell：`shellJournal=snapshot` 采 before 进同一 log；截断/无 roots 只进 `notReversed`
- commit（turn 结束 / 继续对话）→ 清 undo；`commit: manual` 时由 `onClose` 收尾
- knowledge **非事务**；steward 异步写 **不进** turn journal
- `file_write`/`file_edit` 不可写 `sessions/*/undo`（账本自防护）

## 不做什么

- 不做安全评估（那是 security 的事，但会接收安全策略的结果来决定隔离级别）
- 不做工具注册
- L4 容器/进程牢笼为 opt-in 槽位，未实现前不假装已提供

## 依赖

- 契约：`types.ts`（SandboxProvider / Workspace）+ `@octopi-agent/core` `ToolFileEffects` / `MemoryEffectJournal`
- Core: types/messages

## 文件说明

见上表；`index.ts` 统一导出。
