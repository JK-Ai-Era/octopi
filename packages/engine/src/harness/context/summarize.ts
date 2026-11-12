/**
 * ProviderSummarize — 用 ModelProvider 实现 SummarizeFunction
 *
 * 供 ContextEngine 的 LLM 摘要压缩路径使用。
 * 默认产品路径在未显式 `.summarize()` 时自动挂接（见 AgentBuilder）。
 */

import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { LLMMessage } from '@octopi-agent/core/interfaces/model-provider.js';
import type { SummarizeFunction } from './types.js';

export interface CreateProviderSummarizeOptions {
  /** 指定模型名（provider.defaultModel 之外） */
  model?: string;
  /** 摘要温度（默认 0.3，偏确定性） */
  temperature?: number;
  /** 模型实际输出上限（评审 F6）：摘要硬顶的源头钳制，防大窗口下 0.1×W 顶穿 max_output_tokens */
  maxOutputTokens?: number;
}

/**
 * 创建基于 ModelProvider 的摘要函数
 *
 * @param provider - 用于调用的模型提供者
 * @param options - 模型名与温度
 * @returns SummarizeFunction；调用失败向上抛出，由 compact 能力机械降级阶梯兜底
 */
export function createProviderSummarize(
  provider: ModelProvider,
  options?: CreateProviderSummarizeOptions,
): SummarizeFunction {
  return async (messages: LLMMessage[], opts) => {
    const response = await provider.chat({
      messages,
      model: options?.model,
      // 摘要请求带会话同形工具面：前缀缓存是 tools → system → messages，缺 tools 会整段冷 prefill。
      // 不带 toolChoice（2026-11-13 实测）：'none' 在部分 provider（DeepSeek 系）会让服务端
      // 把 tools 从 prompt 渲染中剔除，反而落到另一个缓存空间、前缀零重叠。「禁止调用」由
      // 摘要指令 + summarize_tool_call_emitted fail-loud 守卫承担，不依赖 provider 的软提示。
      ...(opts?.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      // 未显式配置即不发送：由模型配置（ModelInfo.temperature）或服务端默认决定
      temperature: options?.temperature,
      // P3：run 中止 / 摘要超时都靠这个 signal 取消在飞请求（provider 侧 fetch 已接 signal）
      ...(opts?.signal ? { signal: opts.signal } : {}),
      // 源头钳制（评审 F6）：三条摘要路径（manual/proactive/overflow）共用本闭包，
      // 硬顶不得越过模型实际输出上限，否则窗口钳制在大窗口下仍会顶穿被 provider 400
      maxTokens:
        options?.maxOutputTokens && options.maxOutputTokens > 0
          ? Math.min(opts?.maxTokens ?? options.maxOutputTokens, options.maxOutputTokens)
          : opts?.maxTokens,
    });
    // usage 回传（2026-11-08 outputTokens 真值）：摘要产物体量的真值通道，
    // 供压缩计量以真值替代估算（契约见 SummarizeFunction.onUsage）
    if (response.usage && response.usage.outputTokens > 0) {
      opts?.onUsage?.({ outputTokens: response.usage.outputTokens });
    }
    // 撞 max_tokens 的摘要 = 半截交接书（2026-11-12 评审 MAJ-2）。压缩常在会话最满时
    // 触发，窗口钳制会把 max_tokens 压到刚好放得下，撞顶概率不低；把它当成功会让
    // "## Open items" 段凭空消失且无人知晓——本次带工具面后输出上限进一步被挤压，必须
    // fail loud 交 onSummarizeFail 显式降级，禁止静默半截（capabilities/compact 的既有红线）。
    if (response.finishReason === 'length') {
      throw new Error('summarize_output_truncated: provider stopped at max_tokens');
    }
    // 工具面为重放缓存前缀而完整发送，摘要轮本不该产生 tool_call（指令已明确要求纯文本）。
    // 不带 toolChoice 约束后，本守卫是唯一硬防线：若 provider 仍冒 tool_call，正文就不是
    // 摘要——宁可失败，交 onSummarizeFail 显式降级（禁止静默半截/错型产物）。
    if (response.toolCalls && response.toolCalls.length > 0) {
      throw new Error('summarize_tool_call_emitted: summary turn produced a tool call');
    }
    return response.content;
  };
}

/**
 * 从 model level 映射中挑摘要用 provider
 *
 * 优先级：mini → standard → 传入的 fallbackProvider（通常是主模型）
 *
 * @param providers - 可用 provider 映射
 * @param levelMap - models.level 配置（primary 为 provider/model）
 * @param fallbackProvider - 兜底 provider
 * @returns 选中的 provider + 建议模型名
 */
export function pickSummarizeProvider(
  providers: Map<string, ModelProvider>,
  levelMap: Record<string, { primary: string; fallback?: string[] }> | undefined,
  fallbackProvider: ModelProvider,
): { provider: ModelProvider; model?: string } {
  for (const levelName of ['mini', 'standard'] as const) {
    const primary = levelMap?.[levelName]?.primary;
    if (!primary) continue;
    const slash = primary.indexOf('/');
    if (slash <= 0) continue;
    const providerName = primary.slice(0, slash);
    const model = primary.slice(slash + 1);
    const provider = providers.get(providerName);
    if (provider) return { provider, model };
  }
  return { provider: fallbackProvider };
}
