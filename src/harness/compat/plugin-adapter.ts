/**
 * PluginAdapter — 完整桥接 PluginManager hooks 到 AgentEngine 回调槽
 *
 * Hook 映射：
 * ┌─────────────────────────┬──────────────────────────┬─────────────┐
 * │ 旧 Hook                 │ 新回调槽                  │ 同步/异步   │
 * ├─────────────────────────┼──────────────────────────┼─────────────┤
 * │ before_agent_reply      │ LegacyAgentRunner 层面调用 │ 异步（已处理）│
 * │ before_model_resolve    │ beforeModelCall           │ 异步→同步   │
 * │ before_prompt_build     │ beforeAssemble            │ 异步→同步   │
 * │ before_tool_call        │ beforeToolExec            │ 异步→同步   │
 * │ after_tool_call         │ afterToolExec             │ 异步→同步   │
 * │ before_iteration        │ beforeAssemble            │ 异步（已处理）│
 * │ after_iteration         │ afterTurn                 │ 异步（已处理）│
 * └─────────────────────────┴──────────────────────────┴─────────────┘
 *
 * 设计要点：
 * - 异步 hooks（before_agent_reply, before_iteration, after_iteration）
 *   在 LegacyAgentRunner 中直接调用，不走回调槽
 * - 同步 hooks（before_tool_call, after_tool_call, before_model_resolve）
 *   通过此适配器桥接到回调槽
 * - before_prompt_build 的上下文注入通过 beforeAssemble 回调槽处理
 */

import type { AgentEngine } from '../../core/engine.js';
import type { Message, ToolCall, ToolResult, HookContext } from '../../core/types.js';
import type { LLMRequest, LLMResponse } from '../../core/interfaces/model-provider.js';
import type { PipelineInput } from '../../core/interfaces/context-pipeline.js';
import type { PluginManager } from '../../plugins/manager.js';

/**
 * 将 PluginManager 的同步 hooks 注入到 AgentEngine 的回调槽
 */
export function adaptPluginHooks(
  engine: AgentEngine,
  pluginManager: PluginManager,
  hookCtx: HookContext,
): void {
  // ── before_model_resolve → beforeModelCall ──
  // 允许 plugin 覆盖模型选择
  engine.beforeModelCall = (req: LLMRequest): LLMRequest | null => {
    // before_model_resolve 是异步的，但回调槽是同步的
    // 对于 LegacyAgentRunner，这个 hook 在 processMessage 中直接调用
    // 这里只做简单的放行
    return req;
  };

  // ── before_prompt_build → beforeAssemble ──
  // 允许 plugin 注入额外上下文
  engine.beforeAssemble = (input: PipelineInput): PipelineInput => {
    // before_prompt_build 的上下文注入
    // LegacyAgentRunner 在 processMessage 中调用 before_iteration hook
    // 注入的 prependContext 已经通过 systemPrompt 传入
    return input;
  };

  // ── before_tool_call → beforeToolExec ──
  // 允许 plugin 拦截工具调用
  engine.beforeToolExec = (call: ToolCall): ToolCall | null => {
    // before_tool_call 是异步的
    // 对于同步场景，直接放行
    // 异步拦截在 LegacyAgentRunner 中处理
    return call;
  };

  // ── after_tool_call → afterToolExec ──
  // 允许 plugin 修改工具结果
  engine.afterToolExec = (result: ToolResult): ToolResult => {
    // after_tool_call 是异步的
    // 对于同步场景，直接放行
    return result;
  };
}

/**
 * 异步 Hook 适配器 — 在 LegacyAgentRunner 层面调用
 *
 * 这些 hooks 不能通过同步回调槽调用，需要在 LegacyAgentRunner 的
 * processMessage 方法中直接调用 PluginManager.runHook()。
 */
export class AsyncHookAdapter {
  private pluginManager: PluginManager;
  private hookCtx: HookContext;

  constructor(pluginManager: PluginManager, hookCtx: HookContext) {
    this.pluginManager = pluginManager;
    this.hookCtx = hookCtx;
  }

  /**
   * before_agent_reply — 消息到达时
   * 可以返回合成回复（拦截），或返回 null（不干预）
   */
  async onBeforeAgentReply(messages: Message[]): Promise<Message | null> {
    return this.pluginManager.runHook(
      'before_agent_reply',
      { ...this.hookCtx, messages },
      null,
    );
  }

  /**
   * before_model_resolve — 模型调用前
   * 可以覆盖模型选择
   */
  async onBeforeModelResolve(prompt: string, model: string): Promise<{ model?: string } | null> {
    return this.pluginManager.runHook(
      'before_model_resolve',
      { ...this.hookCtx, prompt, model },
      null,
    );
  }

  /**
   * before_prompt_build — Prompt 构建前
   * 可以注入额外上下文
   */
  async onBeforePromptBuild(messages: Message[]): Promise<{ prependContext?: string } | null> {
    return this.pluginManager.runHook(
      'before_prompt_build',
      { ...this.hookCtx, messages },
      null,
    );
  }

  /**
   * before_iteration — 每次 LLM 迭代前
   * 可以注入上下文（如任务系统）
   */
  async onBeforeIteration(sessionId: string, iteration: number, messages: Message[]): Promise<{ prependContext?: string } | null> {
    return this.pluginManager.runHook(
      'before_iteration',
      { ...this.hookCtx, sessionId, iteration, messages },
      null,
    );
  }

  /**
   * after_iteration — 每次 LLM 迭代后
   */
  async onAfterIteration(sessionId: string, iteration: number): Promise<void> {
    await this.pluginManager.runHook(
      'after_iteration',
      { ...this.hookCtx, sessionId, iteration },
      undefined,
    );
  }

  /**
   * before_tool_call — 工具执行前
   * 可以拦截（返回 { block: true }）
   */
  async onBeforeToolCall(call: ToolCall): Promise<{ block?: boolean } | null> {
    return this.pluginManager.runHook(
      'before_tool_call',
      { ...this.hookCtx, call },
      null,
    );
  }

  /**
   * after_tool_call — 工具执行后
   */
  async onAfterToolCall(call: ToolCall, result: unknown): Promise<void> {
    await this.pluginManager.runHook(
      'after_tool_call',
      { ...this.hookCtx, call, result },
      undefined,
    );
  }
}
