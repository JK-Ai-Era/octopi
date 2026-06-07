/**
 * CommandPlugin — 会话内斜杠命令系统
 *
 * 在消息进入 Agent Loop 之前拦截以 `/` 开头的命令。
 * 通过 Plugin Hook (message_received) 注入，不需要修改 Core 层。
 *
 * 用法：
 * ```ts
 * const commands = new CommandPlugin();
 * commands.register('new', { description: 'Start a new session', handler: ... });
 * commands.register('model', { description: 'Switch model', handler: ... });
 *
 * // 挂载到 PluginManager
 * pluginManager.load(commands.asPlugin());
 * ```
 *
 * 扩展：任何 Plugin 都可以注册命令，CommandPlugin 只是协调者。
 */

import type { PluginEntryConfig } from '../plugins/loader.js';

// ── 类型定义 ──

/** 命令上下文（传给 handler） */
export interface CommandContext {
  /** 当前 session ID */
  sessionId: string;
  /** Agent ID */
  agentId: string;
  /** 命令参数（/model gpt-4 → args = ['gpt-4']） */
  args: string[];
  /** 原始消息内容 */
  rawMessage: string;
}

/** 命令定义 */
export interface CommandDefinition {
  /** 命令描述（用于 /help） */
  description: string;
  /** 用法示例（如 '/model <name>'） */
  usage?: string;
  /** 命令 handler */
  handler: (ctx: CommandContext) => Promise<CommandResult>;
}

/** 命令执行结果 */
export interface CommandResult {
  /** 是否成功 */
  success: boolean;
  /** 响应内容（显示给用户） */
  message: string;
  /** 是否需要进入 Agent Loop（默认 false） */
  passthrough?: boolean;
}

// ── 命令注册表 ──

/** 默认命令 */
const BUILTIN_COMMANDS: Record<string, { description: string; usage: string }> = {
  '/new': { description: 'Start a new session (clear context)', usage: '/new' },
  '/help': { description: 'Show available commands', usage: '/help' },
  '/model': { description: 'Switch model (e.g. /model gpt-4)', usage: '/model <name>' },
  '/status': { description: 'Show current session status', usage: '/status' },
};

// ── CommandPlugin ──

export class CommandPlugin {
  private commands = new Map<string, CommandDefinition>();
  private sessionIdRef: { current: string };
  private currentModelRef: { current: string };
  private onNewSession?: () => string;

  constructor(opts: {
    /** 外部 session ID 引用（可变） */
    sessionIdRef: { current: string };
    /** 当前模型引用（可变） */
    currentModelRef: { current: string };
    /** 创建新 session 的回调 */
    onNewSession?: () => string;
  }) {
    this.sessionIdRef = opts.sessionIdRef;
    this.currentModelRef = opts.currentModelRef;
    this.onNewSession = opts.onNewSession;

    // 注册内置命令
    this.registerBuiltins();
  }

  /** 注册命令 */
  register(name: string, def: CommandDefinition): void {
    const key = name.startsWith('/') ? name : `/${name}`;
    this.commands.set(key, def);
  }

  /** 尝试处理命令，返回 null 表示不是命令 */
  async tryExecute(message: string, sessionId: string, agentId: string): Promise<CommandResult | null> {
    const trimmed = message.trim();
    if (!trimmed.startsWith('/')) return null;

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    const def = this.commands.get(cmd);
    if (!def) {
      return {
        success: false,
        message: `Unknown command: ${cmd}. Type /help for available commands.`,
      };
    }

    return def.handler({
      sessionId,
      agentId,
      args,
      rawMessage: trimmed,
    });
  }

  /** 获取所有命令（用于 /help） */
  getCommands(): Map<string, CommandDefinition> {
    return this.commands;
  }

  /** 注册内置命令 */
  private registerBuiltins(): void {
    // /new — 新会话
    this.register('/new', {
      description: 'Start a new session (clear context)',
      handler: async () => {
        if (this.onNewSession) {
          const newId = this.onNewSession();
          this.sessionIdRef.current = newId;
        }
        return { success: true, message: '🆕 New session started.' };
      },
    });

    // /help — 帮助
    this.register('/help', {
      description: 'Show available commands',
      handler: async () => {
        const lines = ['Available commands:\n'];
        for (const [name, def] of this.commands) {
          const usage = def.usage ?? name;
          lines.push(`  ${usage.padEnd(25)} ${def.description}`);
        }
        return { success: true, message: lines.join('\n') };
      },
    });

    // /model — 切换模型
    this.register('/model', {
      description: 'Switch model (e.g. /model gpt-4)',
      usage: '/model <name>',
      handler: async (ctx) => {
        if (ctx.args.length === 0) {
          return {
            success: true,
            message: `Current model: ${this.currentModelRef.current}\nUsage: /model <name>`,
          };
        }
        const newModel = ctx.args[0];
        this.currentModelRef.current = newModel;
        return { success: true, message: `✅ Model switched to: ${newModel}` };
      },
    });

    // /status — 状态
    this.register('/status', {
      description: 'Show current session status',
      handler: async () => {
        return {
          success: true,
          message: [
            `Session: ${this.sessionIdRef.current}`,
            `Model: ${this.currentModelRef.current}`,
          ].join('\n'),
        };
      },
    });
  }
}
