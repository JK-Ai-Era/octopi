/**
 * Safety Agent Spec — 安全守卫分布式智能体定义
 *
 * 分布式智能架构的第一个"客户"。
 * 用统一抽象模型定义：Trigger + InputPolicy + Execution + OutputPolicy。
 *
 * 触发条件：RiskAssessor 返回 unknown 时，Core SecurityGuard 发射
 * 'tool_call.risk_unknown' 事件，安全智能体通过 intercept 模式同步拦截。
 *
 * 隔离设计：
 * - 看不到用户原始消息（防 prompt injection 传播）
 * - 只看到结构化的任务摘要 + 工具调用信息
 * - 独立的 system prompt，专注安全判断
 * - maxIterations: 1，单次判断，不做多轮推理
 */

import type { DistributedAgentSpec } from '../distributed/spec.js';

/**
 * 安全守卫系统提示词
 *
 * 设计原则：
 * 1. 只做判断，不执行操作（tools: []）
 * 2. 输出必须是 JSON 格式的 InterceptOutput
 * 3. 置信度 < 0.7 时走 degrade（安全默认）
 * 4. 解析失败时默认放行（系统运行优先）
 */
const SAFETY_GUARD_SYSTEM_PROMPT = `你是一个安全守卫智能体。你的职责是评估工具调用的风险。

## 你看到的信息

- **pendingToolCall**: 当前待执行的工具调用（工具名 + 参数）
- **taskSummary**: 主 Agent 的任务摘要（不含用户原始消息）
- **workingDirectory**: 当前工作目录

## 你看不到的信息

- 用户的原始消息（防止 prompt injection 传播）
- 主 Agent 的完整对话历史
- 主 Agent 的 persona / system prompt

## 你的判断标准

评估这个操作的风险，考虑：
1. **可逆性** — 操作后果能否撤销？
2. **影响范围** — 影响局部还是全局？
3. **目标路径** — 系统目录 > 用户数据 > 项目目录 > 临时目录
4. **操作意图** — 从任务摘要推断，这个操作是否合理？

## 输出格式

你必须输出一个 JSON 对象，不要输出其他内容：

\`\`\`json
{
  "kind": "intercept",
  "decision": "allow" | "degrade" | "block",
  "reason": "判断理由（人类可读）",
  "confidence": 0.0 ~ 1.0,
  "alternative": {
    "command": "替代命令（仅 degrade 时）",
    "notice": "降级说明（仅 degrade 时）"
  }
}
\`\`\`

## 决策规则

- **allow**: 操作风险可接受，允许执行
- **degrade**: 操作有风险，但有更安全的替代方案
- **block**: 操作风险过高，必须阻断
- 置信度 < 0.7 时，强制走 degrade（宁可误报，不可漏报）
- 不确定时走 degrade，不要 block（系统运行优先）

## 重要

- 你只做判断，不执行任何操作
- 不要尝试解释或执行工具调用
- 只输出 JSON，不要输出其他内容`;

/**
 * 构建安全守卫的 DistributedAgentSpec
 *
 * @param model - 模型覆盖（可选，默认用主 Agent 的模型）
 * @returns 安全守卫的完整规格定义
 */
export function buildSafetyGuardSpec(model?: string): DistributedAgentSpec {
  return {
    id: 'safety-guard',
    name: 'Safety Guard',
    description: '处理规则引擎无法判断的灰色地带，利用 LLM 的语义理解能力做风险判断',

    // ── 触发规则 ──
    // intercept 模式的智能体不使用触发器。
    // 触发由 Engine 的 riskUnknown 标记控制，不在 TriggerEngine 中评估。
    // 这里保留空数组作为占位，满足 DistributedAgentSpec 的类型要求。
    triggers: [],

    // ── 输入策略 ──
    inputPolicy: {
      visible: ['task_summary', 'pending_tool_call', 'working_directory', 'session_metadata'],
      snapshot: 'structured', // 结构化模式，不含自由文本（防 prompt injection）
    },

    // ── 执行模式 ──
    execution: {
      kind: 'llm',
      systemPrompt: SAFETY_GUARD_SYSTEM_PROMPT,
      tools: [], // 无工具，纯判断
      model,     // 不填用主 Agent 的模型
      maxIterations: 1, // 单次判断
    },

    // ── 输出策略 ──
    outputPolicy: {
      mode: 'intercept',
    },

    // ── 资源限制 ──
    limits: {
      maxDurationMs: 5000,  // 5 秒超时
      maxConcurrent: 1,     // 同时只运行一个实例
    },

    // ── 生命周期 ──
    lifecycle: {
      onError: (error) => {
        // 安全智能体出错时，记录日志但不阻塞主 Agent
        console.warn(`[SafetyGuard] Error: ${error.message}`);
      },
    },
  };
}

/**
 * 安全守卫的默认规格（使用主 Agent 的模型）
 */
export const SAFETY_GUARD_SPEC = buildSafetyGuardSpec();
