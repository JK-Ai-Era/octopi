/**
 * 会话内 `/xxx` 命令契约（Intent Ingress 调用面）
 *
 * 归属：plugin-ecosystem/commands（调用面，与 tools/ 对偶）。
 * 效应经 sessionOps 由 Host 落地；handler 不直接改 session/model（I1/I6）。
 */

export type CommandKind = 'client' | 'control' | 'prompt';
export type CommandSource = 'builtin' | 'plugin' | 'user' | 'skill';
export type CommandRisk = 'low' | 'medium' | 'high';
export type CommandInvoker = 'principal' | 'agent' | 'plugin';

export type SessionOp =
  | { op: 'abort_run'; reason?: string }
  | { op: 'new_session' }
  | { op: 'set_model'; model: string }
  | { op: 'compact' }
  | { op: 'set_preferred_agent'; agentId: string };

export interface PrincipalRef {
  actorId?: string;
  actorType?: 'host' | 'user' | 'agent' | 'service' | 'timer' | 'subsystem';
  tenantId?: string;
}

export interface SessionReadView {
  sessionId: string;
  agentId: string;
  model?: string;
  hasActiveRun: boolean;
}

export interface CommandContext {
  sessionId: string;
  agentId: string;
  principal: PrincipalRef;
  args: string[];
  raw: string;
  readonly view: SessionReadView;
}

export interface DisplayPayload {
  type: 'text' | 'markdown' | 'json';
  text: string;
  data?: unknown;
}

export interface CommandEffect {
  kind: string;
  summary: string;
}

export interface CommandResult {
  status: 'ok' | 'error' | 'denied' | 'aborted';
  display: DisplayPayload;
  enterLoop?: boolean;
  messages?: Array<{ role: 'user' | 'system'; content: string; metadata?: Record<string, unknown> }>;
  sessionOps?: SessionOp[];
  effects?: CommandEffect[];
  /** 关联 System Issue（冲突/拒绝时） */
  issueId?: string;
  /** new_session 后由 Host 回填 */
  newSessionId?: string;
}

export interface ExpandedMessages {
  messages: Array<{ role: 'user' | 'system'; content: string; metadata?: Record<string, unknown> }>;
}

export interface ArgSpec {
  name: string;
  description?: string;
  required?: boolean;
  variadic?: boolean;
}

export interface CommandDefinition {
  name: string;
  description: string;
  usage?: string;
  kind: CommandKind;
  source: CommandSource;
  args?: ArgSpec[];
  risk?: CommandRisk;
  invocableBy?: CommandInvoker[];
  /** Run 在途时仍立刻裁决（默认 false；builtin 仅 /stop） */
  preempt?: boolean;
  execute(ctx: CommandContext): Promise<CommandResult>;
  expand?(ctx: CommandContext): Promise<ExpandedMessages>;
}

export interface CommandCatalogItem {
  name: string;
  display: string;
  description: string;
  usage?: string;
  kind: CommandKind;
  source: CommandSource;
  args?: ArgSpec[];
  risk?: CommandRisk;
  preempt?: boolean;
  issueIds?: string[];
}

export type ConflictPolicy = 'reserved' | 'reject-all' | 'prefer-source' | 'same-source';

export interface CommandConflictCandidate {
  source: CommandSource;
  ref: string;
  action: 'registered' | 'rejected' | 'shadowed';
}

export interface CommandConflict {
  name: string;
  candidates: CommandConflictCandidate[];
  policy: ConflictPolicy;
}

export type CommandRegisterResult =
  | { ok: true; definition: CommandDefinition }
  | { ok: false; reason: 'invalid_name' | 'conflict' | 'duplicate'; conflict?: CommandConflict };
