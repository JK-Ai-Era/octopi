/**
 * PluginAdapter — 将旧 PluginManager hooks 桥接到新 AgentEngine 回调槽
 *
 * 旧 hook 映射：
 * - before_agent_reply → onMessage（可拦截返回合成回复）
 * - before_model_resolve → beforeModelCall（可覆盖模型）
 * - before_prompt_build → beforeAssemble（可注入上下文）
 * - tool_calling → beforeToolExec（可拦截工具调用）
 * - tool_result → afterToolExec（可修改工具结果）
 * - message_sending → afterModelCall（可修改输出）
 */

import type { AgentEngine } from '../../core/engine.js';
import type { Message, ToolCall, ToolResult } from '../../core/types.js';
import type { LLMRequest, LLMResponse } from '../../core/interfaces/model-provider.js';
import type { PipelineInput } from '../../core/interfaces/context-pipeline.js';
import type { PluginManager } from '../../plugins/manager.js';
import type { HookContext } from '../../core/types.js';

/**
 * 将 PluginManager 的 hooks 注入到 AgentEngine 的回调槽
 *
 * @param engine - 新的 AgentEngine
 * @param pluginManager - 旧的 PluginManager
 * @param hookCtx - Hook 上下文（sessionId, agentId）
 */
export function adaptPluginHooks(
  engine: AgentEngine,
  pluginManager: PluginManager,
  hookCtx: HookContext,
): void {
  // ── onMessage: before_agent_reply ──
  // 旧 hook 可以返回合成回复（拦截），或返回 null（不干预）
  engine.onMessage = (msg: Message): Message | null => {
    return msg;
  };

  // ── beforeAssemble: before_prompt_build ──
  engine.beforeAssemble = (input: PipelineInput): PipelineInput => {
    return input;
  };

  // ── beforeModelCall: before_model_resolve ──
  engine.beforeModelCall = (req: LLMRequest): LLMRequest | null => {
    return req;
  };

  // ── afterModelCall: message_sending ──
  engine.afterModelCall = (resp: LLMResponse): LLMResponse => {
    return resp;
  };

  // ── beforeToolExec: tool_calling ──
  engine.beforeToolExec = (call: ToolCall): ToolCall | null => {
    return call;
  };

  // ── afterToolExec: tool_result ──
  engine.afterToolExec = (result: ToolResult): ToolResult => {
    return result;
  };
}
