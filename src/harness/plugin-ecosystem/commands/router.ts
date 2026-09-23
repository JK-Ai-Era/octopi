/**
 * CommandRouter — 命令注册 / 冲突裁决 / 执行
 *
 * 冲突策略（§6.0）：
 * - 保留名：非 builtin 不得占用（可选 allowReservedOverride + prefer-source 显式胜出）
 * - 同 (source, ref) 重复注册 = upsert（skill 热重载安全）
 * - 同名多候选（≥2）= reject-all：无一 active，候选保留至收敛到 1
 * - 永不因 reject-all 删除已注册 builtin
 * - Run 在途：仅 preempt 命令立即执行（默认仅 /stop）
 */

import type { IssueRegistry } from '../../diagnostics/registry.js';
import type {
  CommandCatalogItem,
  CommandConflict,
  CommandConflictCandidate,
  CommandContext,
  CommandDefinition,
  CommandRegisterResult,
  CommandResult,
  CommandSource,
  ConflictPolicy,
  DisplayPayload,
  PrincipalRef,
  SessionOp,
  SessionReadView,
} from './types.js';
import { parseCommand, normalizeCommandName, unescapeLiteralSlash } from './parse.js';

export interface CommandRouterOptions {
  issueRegistry?: IssueRegistry;
  conflictPolicy?: ConflictPolicy;
  /** 显式允许覆盖保留名的名单（部署配置，禁止来自 SKILL.md） */
  allowReservedOverride?: string[];
  sourcePriority?: CommandSource[];
}

export interface ExecuteCommandInput {
  content: string;
  sessionId: string;
  agentId: string;
  principal?: PrincipalRef;
  view: SessionReadView;
}

export type ExecuteCommandOutcome =
  | { kind: 'not_command'; content: string }
  | {
      kind: 'command';
      result: CommandResult;
      definition?: CommandDefinition;
      conflict?: CommandConflict;
    };

const DEFAULT_PRIORITY: CommandSource[] = ['builtin', 'plugin', 'user', 'skill'];

interface Entry {
  definition: CommandDefinition;
  ref: string;
  name: string;
}

function candidateKey(source: CommandSource, ref: string): string {
  return source + '\0' + ref;
}

export class CommandRouter {
  /** 全部候选（含冲突中未激活的） */
  private candidates = new Map<string, Entry>();
  /** 当前唯一激活定义 */
  private entries = new Map<string, Entry>();
  private reserved = new Set<string>();
  private conflicts = new Map<string, CommandConflict>();
  private issueRegistry?: IssueRegistry;
  private conflictPolicy: ConflictPolicy;
  private allowReservedOverride: Set<string>;
  private sourcePriority: CommandSource[];

  constructor(options: CommandRouterOptions = {}) {
    this.issueRegistry = options.issueRegistry;
    this.conflictPolicy = options.conflictPolicy ?? 'reject-all';
    this.allowReservedOverride = new Set(options.allowReservedOverride ?? []);
    this.sourcePriority = options.sourcePriority ?? DEFAULT_PRIORITY;
  }

  /**
   * 注册命令。同 (source, ref) 为 upsert；按 name 候选数重算 active。
   */
  register(definition: CommandDefinition, ref?: string): CommandRegisterResult {
    const name = normalizeCommandName(definition.name);
    if (!name) {
      return { ok: false, reason: 'invalid_name' };
    }

    const sourceRef = ref ?? definition.source;
    const normalized: CommandDefinition = { ...definition, name };

    if (
      this.reserved.has(name) &&
      definition.source !== 'builtin' &&
      !this.allowReservedOverride.has(name)
    ) {
      const conflict = this.mergeConflict(
        name,
        [
          { source: 'builtin', ref: 'builtin', action: 'registered' },
          { source: definition.source, ref: sourceRef, action: 'rejected' },
        ],
        'reserved',
      );
      this.rejectName(
        name,
        conflict,
        `命令 /${name} 未加载`,
        `保留名 /${name} 不可被 ${definition.source}（${sourceRef}）占用。`,
        `commands:command.reserved_denied:${name}`,
      );
      return { ok: false, reason: 'conflict', conflict };
    }

    this.candidates.set(candidateKey(definition.source, sourceRef), {
      definition: normalized,
      ref: sourceRef,
      name,
    });
    return this.recompute(name);
  }

  /** 按 (source, ref) 注销候选并重算 */
  unregister(source: CommandSource, ref: string, name: string): void {
    this.candidates.delete(candidateKey(source, ref));
    this.recompute(normalizeCommandName(name) ?? name);
  }

  get(name: string): CommandDefinition | null {
    const key = normalizeCommandName(name);
    if (!key) return null;
    return this.entries.get(key)?.definition ?? null;
  }

  listDefinitions(): CommandDefinition[] {
    return Array.from(this.entries.values()).map((e) => e.definition);
  }

  listCatalog(_filter?: { agentId?: string; sessionId?: string }): CommandCatalogItem[] {
    return this.listDefinitions().map((d) => ({
      name: d.name,
      display: `/${d.name}`,
      description: d.description,
      usage: d.usage,
      kind: d.kind,
      source: d.source,
      args: d.args,
      risk: d.risk,
      preempt: d.preempt,
      issueIds: this.conflicts.has(d.name)
        ? [this.issueIdForConflict(this.conflicts.get(d.name)!)]
        : undefined,
    }));
  }

  listConflicts(): CommandConflict[] {
    return Array.from(this.conflicts.values());
  }

  async execute(input: ExecuteCommandInput): Promise<ExecuteCommandOutcome> {
    const parsed = parseCommand(input.content);
    if (!parsed) {
      return { kind: 'not_command', content: unescapeLiteralSlash(input.content) };
    }

    const principal = input.principal ?? { actorType: 'user' as const };
    const ctx: CommandContext = {
      sessionId: input.sessionId,
      agentId: input.agentId,
      principal,
      args: parsed.args,
      raw: parsed.raw,
      view: input.view,
    };

    const conflict = this.conflicts.get(parsed.name);
    if (conflict && !this.entries.has(parsed.name)) {
      return {
        kind: 'command',
        conflict,
        result: {
          status: 'error',
          display: textDisplay(
            `命令 /${parsed.name} 未加载（冲突已拒绝）。请查看 /issues。`,
          ),
          issueId: this.issueIdForConflict(conflict),
          effects: [{ kind: 'command_rejected', summary: `/${parsed.name} conflict` }],
        },
      };
    }

    const entry = this.entries.get(parsed.name);
    if (!entry) {
      return {
        kind: 'command',
        result: {
          status: 'error',
          display: textDisplay(`未知命令：/${parsed.name}。输入 /help 查看可用命令。`),
          effects: [{ kind: 'command_unknown', summary: parsed.name }],
        },
      };
    }

    const def = entry.definition;
    if (!this.isInvokedBy(def, principal)) {
      return {
        kind: 'command',
        definition: def,
        result: {
          status: 'denied',
          display: textDisplay(`命令 /${def.name} 不允许当前调用方使用。`),
        },
      };
    }

    // Run 在途：仅 preempt（默认仅 /stop）可立即执行
    if (input.view.hasActiveRun && def.preempt !== true) {
      return {
        kind: 'command',
        definition: def,
        result: {
          status: 'error',
          display: textDisplay('Agent 正在运行——可发送 /stop 中止后再试。'),
          effects: [{ kind: 'command_busy', summary: def.name }],
        },
      };
    }

    try {
      if (def.kind === 'prompt' && def.expand) {
        const expanded = await def.expand(ctx);
        return {
          kind: 'command',
          definition: def,
          result: {
            status: 'ok',
            display: textDisplay(`已展开 /${def.name}`),
            enterLoop: true,
            messages: expanded.messages,
            effects: [{ kind: 'command_expand', summary: def.name }],
          },
        };
      }
      const result = await def.execute(ctx);
      return { kind: 'command', definition: def, result };
    } catch (err) {
      return {
        kind: 'command',
        definition: def,
        result: {
          status: 'error',
          display: textDisplay(
            `命令 /${def.name} 执行失败：${err instanceof Error ? err.message : String(err)}`,
          ),
        },
      };
    }
  }

  private recompute(name: string): CommandRegisterResult {
    const list = Array.from(this.candidates.values()).filter((e) => e.name === name);

    if (list.length === 0) {
      this.entries.delete(name);
      this.conflicts.delete(name);
      this.resolveIssues(name);
      return { ok: false, reason: 'invalid_name' };
    }

    const builtins = list.filter((e) => e.definition.source === 'builtin');

    // 保留名：reject-all 永不抹掉 builtin
    if (this.reserved.has(name) && builtins.length > 0) {
      if (this.allowReservedOverride.has(name) && this.conflictPolicy === 'prefer-source') {
        const best = list.reduce((a, b) =>
          this.higherSource(a.definition.source, b.definition.source) ? a : b,
        );
        this.activate(name, best, list);
        return { ok: true, definition: best.definition };
      }
      const winner = builtins[0];
      this.activate(name, winner, list);
      return { ok: true, definition: winner.definition };
    }

    if (list.length === 1) {
      const only = list[0];
      if (this.reserved.has(name) && only.definition.source !== 'builtin') {
        return { ok: false, reason: 'conflict' };
      }
      this.activate(name, only, list);
      return { ok: true, definition: only.definition };
    }

    // prefer-source：同优先级仍 reject-all
    if (this.conflictPolicy === 'prefer-source') {
      const sorted = [...list].sort(
        (a, b) =>
          this.sourcePriority.indexOf(a.definition.source) -
          this.sourcePriority.indexOf(b.definition.source),
      );
      const winner = sorted[0];
      const ties = sorted.filter((e) => e.definition.source === winner.definition.source);
      if (ties.length === 1) {
        this.activate(name, winner, list);
        return { ok: true, definition: winner.definition };
      }
    }

    // reject-all：有 builtin 则保住 builtin，否则无 active；候选粘性保留
    if (builtins.length > 0) {
      this.activate(name, builtins[0], list);
      return { ok: true, definition: builtins[0].definition };
    }

    this.entries.delete(name);
    const conflict = this.mergeConflict(
      name,
      list.map((e) => ({
        source: e.definition.source,
        ref: e.ref,
        action: 'rejected' as const,
      })),
      'reject-all',
    );
    this.rejectName(
      name,
      conflict,
      `命令 /${name} 未加载`,
      `同名冲突（reject-all）：${list.map((e) => `${e.definition.source}(${e.ref})`).join('、')} 均被拒绝。请改名或删除一侧后重载。`,
    );
    return { ok: false, reason: 'conflict', conflict };
  }

  private activate(name: string, winner: Entry, list: Entry[]): void {
    this.entries.set(name, winner);
    if (winner.definition.source === 'builtin') this.reserved.add(name);
    if (list.length === 1) {
      this.conflicts.delete(name);
      this.resolveIssues(name);
      return;
    }
    const conflict = this.mergeConflict(
      name,
      list.map((e) => ({
        source: e.definition.source,
        ref: e.ref,
        action:
          e.ref === winner.ref && e.definition.source === winner.definition.source
            ? ('registered' as const)
            : ('shadowed' as const),
      })),
      this.conflictPolicy === 'prefer-source' ? 'prefer-source' : 'reject-all',
    );
    this.conflicts.set(name, conflict);
  }

  private resolveIssues(name: string): void {
    this.issueRegistry?.resolve(`commands:command.conflict:${name}`);
    this.issueRegistry?.resolve(`commands:command.reserved_denied:${name}`);
  }

  private issueIdForConflict(conflict: CommandConflict): string {
    return conflict.policy === 'reserved'
      ? `commands:command.reserved_denied:${conflict.name}`
      : `commands:command.conflict:${conflict.name}`;
  }

  private isInvokedBy(def: CommandDefinition, principal: PrincipalRef): boolean {
    const allowed = def.invocableBy ?? ['principal'];
    const actorType = principal.actorType ?? 'user';
    if (actorType === 'agent') return allowed.includes('agent');
    if (actorType === 'service' || actorType === 'subsystem') {
      return allowed.includes('plugin') || allowed.includes('principal');
    }
    return allowed.includes('principal');
  }

  private higherSource(a: CommandSource, b: CommandSource): boolean {
    return this.sourcePriority.indexOf(a) <= this.sourcePriority.indexOf(b);
  }

  private mergeConflict(
    name: string,
    candidates: CommandConflictCandidate[],
    policy: ConflictPolicy,
  ): CommandConflict {
    const conflict: CommandConflict = { name, candidates, policy };
    this.conflicts.set(name, conflict);
    return conflict;
  }

  private rejectName(
    name: string,
    conflict: CommandConflict,
    title: string,
    detail: string,
    issueId?: string,
  ): void {
    this.conflicts.set(name, conflict);
    this.issueRegistry?.report({
      id: issueId ?? this.issueIdForConflict(conflict),
      domain: 'commands',
      code: conflict.policy === 'reserved' ? 'command.reserved_denied' : 'command.conflict',
      severity: conflict.policy === 'reserved' ? 'error' : 'warning',
      title,
      detail,
      refs: conflict.candidates.map((c) => ({
        label: `${c.source}: ${c.ref}`,
        path: c.ref.includes('/') ? c.ref : undefined,
        skillId: c.source === 'skill' ? c.ref : undefined,
        pluginId: c.source === 'plugin' ? c.ref : undefined,
      })),
      actions: [{ id: 'doctor', label: '运行诊断' }],
    });
  }
}

function textDisplay(text: string): DisplayPayload {
  return { type: 'text', text };
}

export type { CommandResult, SessionOp };
