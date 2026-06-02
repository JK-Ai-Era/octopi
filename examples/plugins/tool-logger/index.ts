/**
 * Tool Logger Plugin — 示例 plugin
 *
 * 演示观察语义 hook（所有 plugin 都执行，不拦截）：
 * - message_received: 记录收到的消息
 * - before_tool_call: 记录 tool 调用
 * - after_tool_call: 记录 tool 结果
 * - message_sending: 记录发送的回复
 */

import { definePluginEntry } from '../../../src/plugins/entry.js';

export default definePluginEntry({
  id: 'tool-logger',
  name: 'Tool Logger',
  description: '记录所有 tool 调用和消息事件',

  register(api) {
    const config = api.pluginConfig;
    const logLevel = (config.logLevel as string) ?? 'info';

    const shouldLog = (level: string): boolean => {
      const levels = ['debug', 'info', 'warn', 'error'];
      return levels.indexOf(level) >= levels.indexOf(logLevel);
    };

    // message_received — 观察语义
    api.on('message_received', async (event: any) => {
      if (shouldLog('info')) {
        api.logger.info(`[message_received] ${event.message.userId}: ${event.message.text?.slice(0, 100)}`);
      }
    });

    // before_tool_call — 观察语义（不拦截，只记录）
    api.on('before_tool_call', async (event: any) => {
      if (shouldLog('debug')) {
        api.logger.debug(`[before_tool_call] ${event.toolName}(${JSON.stringify(event.params).slice(0, 200)})`);
      }
    }, { priority: -10 }); // 低优先级，确保在其他 plugin 之后执行

    // after_tool_call — 观察语义
    api.on('after_tool_call', async (event: any) => {
      if (shouldLog('info')) {
        const status = event.result.isError ? 'ERROR' : 'OK';
        api.logger.info(`[after_tool_call] ${event.call.toolName} → ${status}`);
      }
    });

    // message_sending — 观察语义
    api.on('message_sending', async (event: any) => {
      if (shouldLog('info')) {
        api.logger.info(`[message_sending] ${event.reply.text?.slice(0, 100)}`);
      }
    });

    // session_start — 会话生命周期
    api.on('session_start', async (event: any) => {
      api.logger.info(`[session_start] Session ${event.sessionId} started for agent ${event.agentId}`);
    });

    // session_end — 会话生命周期
    api.on('session_end', async (event: any) => {
      api.logger.info(`[session_end] Session ${event.sessionId} ended: ${event.reason}`);
    });

    api.logger.info('Tool Logger plugin registered');
  },
});
