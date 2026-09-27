# Extension — 扩展与执行面

> 产品域（Extension 平面）｜问题：**能力如何扩展？工具在哪跑？**  
> 概念权威：[`docs/north-star.md`](../../../docs/north-star.md) ｜ 域地图：[`docs/domains.md`](../../../docs/domains.md)

## 拥有概念

Tool · Effect · Plugin · Skill · MCP · Sandbox · Workspace（工具 cwd）

## 模块

| 模块 | 职责 |
|------|------|
| `plugin-ecosystem/` | Plugin、Tool、Skill、MCP、命令（`/` 调用面） |
| `execution-environment/` | 沙箱、工作区生命周期、`isolation.ts`（toolIsolation cwd，I5） |

## 边界

- **不做**：风险**判定**（策略权威在 Governance/security）；会话语义（Session）
- **失败模式**：插件炸、工具踩盘、cwd 逃逸
- **I5**：效应面与认知面同等受策略约束；`workspace` **只**表示工具磁盘 cwd，不与 RunScope 混名
- 活系统当前态用 **Tool** 查询；文档语料用 **Knowledge**
