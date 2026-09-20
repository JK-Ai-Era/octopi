# 已知问题

> 最后更新：2026-09-26（Phase G/H 验收对齐）

## 同 Agent 多 Session 抢占共享 Agent 上下文（I1 已落地）

**状态：** Run 物理 **I1 已实现**（v0.35.0）→ 架构宪法 **`docs/north-star.md`**

`SessionAwareRunner` 不再把共享 `Agent.context` 当会话工作区；每 Run 使用私有 `AgentContext` + `RunScope` ALS。锁仍按 `sessionId`。同 Agent 多 Session 并发的 **消息串味** 已由回归测试覆盖。

## 工具效应面 I5（最小集已落地）

**状态：** Phase B **v0.36.0** 配置 + cwd 解析 + 双 Session 路径隔离测试。

`octopi.json` 顶层字段 **`toolIsolation`**：

| 值 | 行为 |
|----|------|
| `none`（**默认**） | 多 Session 共享 `agent.workspace`（向后兼容） |
| `session-subdir` | 工具 cwd = `<workspace>/<sessionId>/` |
| `session-lock` | 路径仍共享；并发安全依赖 Runner **sessionId 锁**（E1） |

多 Session 并发写文件时，宿主应显式配置 `toolIsolation: "session-subdir"`。

## Session 一等数据 / Compact / ACL / Switch（Phase C–F + 评审修复）

| 阶段 | 版本 | 内容 |
|------|------|------|
| C | v0.37.0 | 双键 store + `primaryAgentId` + `Message.agentId` 归因；目录未迁 |
| D | v0.38.0 | compact 与 run **共 session 锁**；键 `(sessionId, agentId)` |
| E | v0.39.0 | 五角色 ACL + `authorizeRun`；配置 `sessionAcl`；**无角色 DB** |
| F | v0.40.0 | `preferredAgentId` ≠ primary；handoff host-only + `admin_handoff`；Principal 字段位 |
| 修复 | v0.42.0 | Jsonl 完整持久化 model-2 状态；Gateway **共享** SessionLease；session-subdir 路径消毒；`canHandoff` 策略门控；compact/reset 边角；**Runner handle 可注入 ACL**（Gateway 已接线） |

**运行时 ACL（v0.42.0+ / v0.43.0）：**

- Gateway **默认**注入 `SessionAclService` + **进程内共享** `SessionLease` 到全部 Runner（**非 opt-in 兼容性变化**）。
- `handle` 在 run 前 `authorizeRun`：primary 自动 owner；非 primary 无绑定 → `engine.error`；effective 交集含 `agents[].maxSessionRights`（E6 L1）。
- handoff：`primaryAgentId` 迁移；旧 primary 的 `owner` **降级 specialist**；`session.agentId`（双键）不变。
- `preferredOnly`（默认 true）：`switch(mode=handoff)` 需要 `intent=admin_handoff`。
- `filterHistory` / `appendRunAudit` / 业务 grant 仍供宿主调用；**双键存储下 guest 仍可能 load 不到同一 Session 对象**（见下）。

**仍开放：** 分布式 Session Lease 实现；Session 目录从 `agents/<id>/sessions/` 解耦（guest/handoff 跨 agent 读史）；工具 capability 收紧；角色 DB/控制台；Quota 经济层。

## KnowledgeStage（已关闭）

**状态：** 已解决

旧 `harness/knowledge/stage.ts` 的 `KnowledgeStage` 依赖已删除的 ContextPipeline Stage 接口。现已由 `harness/context/knowledge/` 的 `KnowledgeContextEngine` 取代。

## 旧配置字段 `supervisor`

**状态：** 有意不兼容 + 已告警 + 可 doctor 修复

`octopi.json` 中的 `supervisor` 字段在 v0.20.0 起改名为 `runGuard`。`octopi doctor --fix` 会将其改写为 `runGuard`。
