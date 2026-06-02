/**
 * Tool Preflight Plugin — 示例 plugin
 *
 * 演示新的 plugin 系统用法：
 * - definePluginEntry() 创建 plugin
 * - api.on() 注册 hook（支持 priority）
 * - 拦截语义（return 非 null 中断链）
 *
 * 此 plugin 在 tool 调用前进行预检查：
 * - 被阻止的 tool 直接 block
 * - 需要审批的 tool 返回 approval 请求
 * - 其他 tool 放行
 */

import { definePluginEntry } from '../../../src/plugins/entry.js';

export default definePluginEntry({
  id: 'tool-preflight',
  name: 'Tool Preflight',
  description: '拦截并验证 tool 调用，支持 approval 机制',

  register(api) {
    const config = api.pluginConfig;
    const blockedTools = (config.blockedTools as string[]) ?? [];
    const requireApprovalFor = (config.requireApprovalFor as string[]) ?? [];

    // before_tool_call — 拦截语义
    // priority: 50 — 在默认 priority 0 之前执行
    api.on('before_tool_call', async (event: any) => {
      const toolName = event.toolName;

      // 被阻止的 tool
      if (blockedTools.includes(toolName)) {
        api.logger.warn(`Blocked tool call: ${toolName}`);
        return {
          block: true,
          blockReason: `Tool "${toolName}" is blocked by policy`,
        };
      }

      // 需要审批的 tool
      if (requireApprovalFor.includes(toolName)) {
        api.logger.info(`Requiring approval for tool: ${toolName}`);
        return {
          requireApproval: {
            title: `Approve tool: ${toolName}`,
            description: `Tool "${toolName}" requires user approval before execution`,
            severity: 'warning',
            timeoutMs: 30000,
            timeoutBehavior: 'deny',
          },
        };
      }

      // 放行（返回 null 表示不拦截）
      return null;
    }, { priority: 50 });

    // after_tool_call — 观察语义（所有 plugin 都执行）
    api.on('after_tool_call', async (event: any) => {
      const { call, result } = event;
      if (result.isError) {
        api.logger.warn(`Tool "${call.toolName}" failed: ${result.content}`);
      }
    });

    // gateway_start — 服务生命周期
    api.on('gateway_start', async () => {
      api.logger.info('Tool Preflight plugin initialized');
      api.logger.info(`Blocked tools: ${blockedTools.join(', ') || 'none'}`);
      api.logger.info(`Approval required: ${requireApprovalFor.join(', ') || 'none'}`);
    });

    api.logger.info('Tool Preflight plugin registered');
  },
});
