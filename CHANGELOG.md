## v0.36.0 (2026-09-26)

### feat(harness): I5 工具效应面最小集 — `toolIsolation`

工具 cwd 不再只能共享 `agent.workspace`；可按 Session 策略解析。

**薄决策：**

| 项 | 选定 |
|----|------|
| **配置字段** | 顶层 `toolIsolation` |
| **枚举** | `'none' \| 'session-subdir' \| 'session-lock'` |
| **默认值** | **`'none'`**（向后兼容） |
| session-subdir | `cwd = join(RunConfig.cwd ?? agent.workspace, sessionId)`；目录名经 `toSessionFileName` 消毒 |
| session-lock | 路径共享；依赖 Runner sessionId 锁（E1），不路径隔离 |

- **新增** `src/harness/tool-effect/isolation.ts`：`ToolIsolationMode` / `DEFAULT_TOOL_ISOLATION` / `resolveToolIsolationCwd`

**非目标：** 完整 capability 模型、分布式文件锁。

## v0.35.6 (2026-09-26)

### docs: 新 Session 开发入口与八层存储稿

- 内部 `arch/NEXT-STEPS.md` 开工入口；`docs/AGENTS.md` 指向宪法
