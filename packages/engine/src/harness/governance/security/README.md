# Security — 安全

> Layer: Layer 2

工具调用风险评估、Shell 命令解析、安全降级、安全智能体。

**核心理念**：分界线是"确定性 vs 非确定性"。规则引擎处理已知风险，安全智能体处理灰色地带。

## 职责

- DefaultSecurityGuard — 硬边界 + 始终接线的 RiskPolicy + Input/Output 检查
- DefaultToolCallRiskPolicy — 规则引擎（操作+目标组合风险评估）
- ShellParser — Shell 命令解析器（4 层：拆分→识别→重定向→Wrapper）
- Degradation — 6 种降级策略
- SafetyAgentSpec — 安全智能体规格
- CapabilityEnforcer — 信任分级

## 分层（安全不可绕过）

1. **硬边界**（永远执行，不受 `enforce` 影响）：未注册工具、路径遍历、`allowedPaths` 越界、下载并执行（任意解释器）、PowerShell IEX 摇篮、反弹 shell、格式化/清盘、递归删根/系统保护路径、`file_delete` 删保护路径
2. **ToolCallRiskPolicy**（永远接线）：模糊/有争议操作分档
3. **可配置**：`enforce: block|audit`、`allowedPaths`、`injectionSensitivity` — 无总开关

不透明载荷（`file_write.content` 等）不做 shell 元字符扫描：写入路径无 shell 解释面。

## 不做什么

- 不做工具执行
- 不做上下文管理
- 安全守卫接口定义在 Core 层
- **不管「跑飞」**：连续同工具 / 错误循环 / 无进展归 **RunGuard**；`checkBehavior` 只保留高危工具组合等攻击形态，主路径不调用

## 依赖

- Core: interfaces/security-guard、types/messages

## 文件说明

- default-security-guard.ts — 硬边界 + RiskPolicy 接线 + Input/Output
- default-risk-policy.ts — 风险规则引擎
- risk-evaluator.ts — 操作+目标组合评估 + 硬边界探测（灾难删/下载执行/清盘）
- shell-parser.ts — Shell 命令解析
- degradation.ts — 降级策略
- safety-agent-spec.ts — 安全智能体规格
- capability-enforcer.ts — 信任分级
- index.ts — 统一导出
