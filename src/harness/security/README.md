# Security — 安全

> Layer: Layer 2

工具调用风险评估、Shell 命令解析、安全降级、安全智能体。

**核心理念**：分界线是"确定性 vs 非确定性"。规则引擎处理已知风险，安全智能体处理灰色地带。

## 职责

- DefaultSecurityGuard — 五层防护实现（Input/Output/Tool/Output/Behavior）
- DefaultToolCallRiskPolicy — 规则引擎（操作+目标组合风险评估）
- ShellParser — Shell 命令解析器（4 层：拆分→识别→重定向→Wrapper）
- Degradation — 6 种降级策略
- SafetyAgentSpec — 安全智能体规格
- CapabilityEnforcer — 信任分级

## 不做什么

- 不做工具执行
- 不做上下文管理
- 安全守卫接口定义在 Core 层

## 依赖

- Core: interfaces/security-guard、types/messages

## 文件说明

- default-security-guard.ts — 五层防护（~600 行）
- default-risk-policy.ts — 风险规则引擎
- risk-evaluator.ts — 操作+目标组合评估
- shell-parser.ts — Shell 命令解析
- degradation.ts — 降级策略
- safety-agent-spec.ts — 安全智能体规格
- capability-enforcer.ts — 信任分级
- policy.ts — 安全策略预设
- index.ts — 统一导出
