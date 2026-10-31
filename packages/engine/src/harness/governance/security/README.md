# Security — 安全

> Layer: Layer 2

工具调用风险评估、Shell 命令解析、安全降级、安全智能体。

**核心理念**：分界线是"确定性 vs 非确定性"。规则引擎处理已知风险，安全智能体处理灰色地带。

## 职责

- DefaultSecurityGuard — 硬边界 + 始终接线的 RiskPolicy + Input/Output 检查
- DefaultToolCallRiskPolicy — 规则引擎（操作+目标组合风险评估）
- ShellParser — Shell 命令解析（双引擎：tree-sitter 主引擎 + fallback 字符串回退）
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
- shell-parser.ts — Shell 解析入口（引擎分发 + 回退；`parseShellCommand` 签名稳定）
- shell-parser-treesitter.ts — 主引擎：web-tree-sitter + vendored tree-sitter-bash.wasm（`vendor/`）
- shell-parser-fallback.ts — 回退引擎：纯字符串解析（初始化失败或语法树含 ERROR 时启用，标记 `uncertain`）
- shell-parser-shared.ts — 两个引擎共用的常量与拆壳/合并/转义
- degradation.ts — 降级策略
- safety-agent-spec.ts — 安全智能体规格
- capability-enforcer.ts — 信任分级
- index.ts — 统一导出

**装配要求**：tree-sitter 主引擎需在首次评估前 `await initShellParser()`
（`AgentBuilder.build()` / `wireAgentBuilder()` 已内置）。绕过 builder 自装配
SecurityGuard 的嵌入方必须自行调用，否则静默使用 fallback 回退引擎
（`getShellParserEngine()` 可查当前引擎）。

**回退引擎定位**：`shell-parser-fallback.ts` 是**长期保留的降级防线**（不是待退役
代码）——主引擎缺席或解析报错时，硬边界探测（灾难删/下载执行/清盘）仍需输入。
冻结维护：只修缺陷，不扩特性。退役条件（满足其一再议，删除时解析失败语义降为
`uncertain` → unknown 通道）：① 解析入口支持注入 wasm 字节（覆盖 edge/打包器
场景）且初始化失败改为 fail-loud；② 运行时契约收窄为「仅 Node 宿主」且初始化
失败可观测信号上线后零失败观察期通过。
