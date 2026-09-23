/**
 * Builtin 命令 — 对齐 tools/builtin.ts：内置提供者，不另起能力域。
 *
 * handler 只返回 sessionOps；Host（Gateway）负责落地。
 */

import type { IssueRegistry } from '../../diagnostics/registry.js';
import type {
  CommandContext,
  CommandDefinition,
  CommandResult,
  SessionReadView,
} from './types.js';

export interface BuiltinHost {
  hasActiveRun(sessionId: string, agentId: string): boolean;
  currentModel(sessionId: string, agentId: string): string | undefined;
  listModels(): Array<{ id: string; description?: string }>;
  listIssues(): Array<{
    id: string;
    severity: string;
    title: string;
    detail: string;
    domain: string;
    status: string;
  }>;
  listCatalogNames(): Array<{ name: string; description: string; usage?: string; source: string }>;
}

export function createBuiltinCommands(host: BuiltinHost): CommandDefinition[] {
  const help: CommandDefinition = {
    name: 'help',
    description: 'Show available commands',
    usage: '/help',
    kind: 'control',
    source: 'builtin',
    risk: 'low',
    async execute(_ctx: CommandContext): Promise<CommandResult> {
      const items = host.listCatalogNames();
      const lines: string[] = ['### Available commands', ''];
      for (const item of items) {
        const usage = item.usage ?? `/${item.name}`;
        lines.push(`- \`${usage}\` — ${item.description}`);
      }
      return {
        status: 'ok',
        display: { type: 'markdown', text: lines.join('\n') },
      };
    },
  };

  const stop: CommandDefinition = {
    name: 'stop',
    description: 'Stop the active run (works in any channel)',
    usage: '/stop',
    kind: 'control',
    source: 'builtin',
    risk: 'low',
    preempt: true,
    invocableBy: ['principal'],
    async execute(ctx: CommandContext): Promise<CommandResult> {
      const active = ctx.view.hasActiveRun || host.hasActiveRun(ctx.sessionId, ctx.agentId);
      return {
        status: 'ok',
        display: {
          type: 'text',
          text: active ? '已停止当前任务。' : '当前没有正在运行的任务。',
        },
        // 始终下发 abort_run（runtime.abort 幂等），避免 hasActiveRun 竞态漏杀
        sessionOps: [{ op: 'abort_run', reason: 'user_stop' }],
        effects: [{ kind: 'abort_run', summary: active ? 'aborted' : 'noop' }],
      };
    },
  };

  const newSession: CommandDefinition = {
    name: 'new',
    description: 'Start a new session',
    usage: '/new',
    kind: 'control',
    source: 'builtin',
    risk: 'low',
    async execute(_ctx: CommandContext): Promise<CommandResult> {
      return {
        status: 'ok',
        display: { type: 'text', text: '🆕 New session started.' },
        sessionOps: [{ op: 'new_session' }],
        effects: [{ kind: 'new_session', summary: 'requested' }],
      };
    },
  };

  const model: CommandDefinition = {
    name: 'model',
    description: 'Show or switch model',
    usage: '/model [name]',
    kind: 'control',
    source: 'builtin',
    risk: 'low',
    args: [{ name: 'name', description: 'Model id', required: false }],
    async execute(ctx: CommandContext): Promise<CommandResult> {
      const current = ctx.view.model ?? host.currentModel(ctx.sessionId, ctx.agentId);
      if (ctx.args.length === 0) {
        const models = host.listModels();
        const lines: string[] = [
          `**Current model:** \`${current ?? '(default)'}\``,
          '',
          '### Available models',
          '',
        ];
        for (const m of models) {
          lines.push(
            m.description
              ? `- \`${m.id}\` — ${m.description}`
              : `- \`${m.id}\``,
          );
        }
        lines.push('', `Usage: \`/model <name>\``);
        return {
          status: 'ok',
          display: { type: 'markdown', text: lines.join('\n') },
        };
      }
      const next = ctx.args[0];
      return {
        status: 'ok',
        display: {
          type: 'markdown',
          text: `✅ Model switched to: \`${next}\``,
        },
        sessionOps: [{ op: 'set_model', model: next }],
        effects: [{ kind: 'set_model', summary: next }],
      };
    },
  };

  const status: CommandDefinition = {
    name: 'status',
    description: 'Show current session status',
    usage: '/status',
    kind: 'control',
    source: 'builtin',
    risk: 'low',
    async execute(ctx: CommandContext): Promise<CommandResult> {
      const view: SessionReadView = ctx.view;
      const model = view.model ?? host.currentModel(ctx.sessionId, ctx.agentId);
      const text = [
        '### Session status',
        '',
        `- **Session:** \`${view.sessionId}\``,
        `- **Agent:** \`${view.agentId}\``,
        `- **Model:** \`${model ?? '(default)'}\``,
        `- **Run:** ${view.hasActiveRun ? 'active' : 'idle'}`,
      ].join('\n');
      return { status: 'ok', display: { type: 'markdown', text } };
    },
  };

  const issues: CommandDefinition = {
    name: 'issues',
    description: 'List open system issues',
    usage: '/issues',
    kind: 'control',
    source: 'builtin',
    risk: 'low',
    async execute(_ctx: CommandContext): Promise<CommandResult> {
      const list = host.listIssues().filter((i) => i.status === 'open');
      if (list.length === 0) {
        return {
          status: 'ok',
          display: { type: 'markdown', text: '没有未处理的系统问题。' },
        };
      }
      const lines: string[] = [`### Open issues (${list.length})`, ''];
      for (const issue of list) {
        lines.push(`- **[${issue.severity}]** ${issue.title}`);
        if (issue.detail) {
          lines.push(`  ${issue.detail.replace(/\n/g, '  \n  ')}`);
        }
      }
      return {
        status: 'ok',
        display: { type: 'markdown', text: lines.join('\n'), data: list },
      };
    },
  };

  return [help, stop, newSession, model, status, issues];
}

/** UI 本地命令目录项（执行仍在 Client，文案与 catalog 同源） */
export function createClientCatalogCommand(): CommandDefinition {
  return {
    name: 'clear',
    description: 'Clear screen (client-side)',
    usage: '/clear',
    kind: 'client',
    source: 'builtin',
    risk: 'low',
    async execute(): Promise<CommandResult> {
      return {
        status: 'ok',
        display: { type: 'text', text: 'cleared' },
      };
    },
  };
}

/** 供 Gateway 装配 BuiltinHost.listIssues */
export function issuesFromRegistry(registry: IssueRegistry): BuiltinHost['listIssues'] {
  return () =>
    registry.list({ status: 'open' }).map((i) => ({
      id: i.id,
      severity: i.severity,
      title: i.title,
      detail: i.detail,
      domain: i.domain,
      status: i.status,
    }));
}
