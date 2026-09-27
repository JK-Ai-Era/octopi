# Governance — 治理控制

> 产品域（Control 平面）｜问题：**谁能做什么？**  
> 概念权威：[`docs/north-star.md`](../../../docs/north-star.md) ｜ 域地图：[`docs/domains.md`](../../../docs/domains.md)

## 拥有概念

Principal · Intent · RoleDefinition · RoleBinding · Policy · Approval · Credential · Quota

## 模块

| 模块 | 职责 |
|------|------|
| `session-acl/` | 角色目录（五角色出厂）、grant/revoke、`authorizeRun`、`switch(preferred\|handoff)`（E6/I3） |
| `security/` | 硬边界 + RiskPolicy（安全不可绕过）；Shell 解析、降级策略 |
| `human-in-the-loop/` | 审批请求、审批策略、决策缓存 |
| `credentials/` | 凭证保险库（crypto/db/store）；Knowledge 外源 `authRef` 落点 |
| `accounting/` | UsageLedger + SessionLedger 用量账本 |

## 边界

- **不做**：业务 NLU（I6）；人级 IAM（归 Host）；垂直流程引擎
- **失败模式**：授权错误、越权、密钥泄露
- 角色有效权限 = `L0 ∩ role.max ∩ Agent.maxSessionRights ∩ 绑定覆盖`（E6）

## 依赖

只 import 其它域 **types**；不持有 Session/Discourse 权威数据。
