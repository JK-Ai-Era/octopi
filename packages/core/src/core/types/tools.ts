/**
 * 工具系统类型
 *
 * 工具定义、执行上下文、处理函数、注册记录。
 *
 * `ToolParameter` 保留字段用于参数校验：类型、必填、枚举、范围、长度、正则，以及嵌套对象与数组。
 */

/** 工具来源 */
export interface ToolSource {
  /** 来源类型 */
  kind: 'builtin' | 'plugin' | 'mcp' | 'subsystem' | 'custom';
  /** 来源标识（plugin ID / MCP server ID / subsystem ID） */
  origin: string;
  /** 信任级别 */
  trustLevel: 'builtin' | 'official' | 'third-party' | 'untrusted';
}

/** 工具参数定义 */
export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
  enum?: Array<string | number>;
  properties?: Record<string, ToolParameter>;
  items?: ToolParameter;
  default?: unknown;
  /** 数值参数最小值（inclusive） */
  minimum?: number;
  /** 数值参数最大值（inclusive） */
  maximum?: number;
  /** 字符串最小长度 */
  minLength?: number;
  /** 字符串最大长度 */
  maxLength?: number;
  /** 字符串正则表达式（无首尾斜杠） */
  pattern?: string;
  /** 数组最少元素数 */
  minItems?: number;
  /** 数组最多元素数 */
  maxItems?: number;
}

/** 工具定义 */
/**
 * Capability tags on a tool. Security policy (reduced tool surface) keys off
 * these, never off display names (D5-a).
 */
export type ToolCapability =
  | 'exec'
  | 'egress'
  | 'send'
  | 'dynamic-code'
  | 'fs-read'
  | 'fs-write'
  | 'memory';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  /** What this tool can do. Required for plugins; builtins are tagged. */
  capabilities?: ToolCapability[];
  permissions?: string[];
  requiresConfirmation?: boolean;
  timeoutMs?: number;
  /** 工具版本 */
  version?: string;
  /** 是否已废弃 */
  deprecated?: boolean;
  /** 废弃说明 */
  deprecatedMessage?: string;
}

/**
 * 工具文件效应写入口（ToolEffectPolicy L3 / I5）。
 *
 * 实现必须在落盘前记 undo，使「编辑重发」可逆放本轮工具文件效应。
 * 禁止提供“只写不记”的旁路实现——回滚能力不得可选。
 */
export interface ToolFileEffects {
  /** 覆盖/新建写入（整文件字节） */
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  /** 追加写入 */
  appendFile(path: string, data: string | Uint8Array): Promise<void>;
  /** 删除前记 before（shell rm / mv）；discard 恢复 */
  recordDelete(path: string, before: string | Uint8Array): Promise<void>;
  /** 标记新建（零 before）；discard 删除 */
  recordCreate(path: string, after?: string | Uint8Array): Promise<void>;
  /** 重命名记账（delete+create） */
  recordRename(from: string, to: string): Promise<void>;
  /** 显式 before/after 的覆盖记账（shell diff）；first before 不被覆盖 */
  recordOverwrite(path: string, before: string | Uint8Array, after?: string | Uint8Array): Promise<void>;
  /** 不可逆效应清单（§5.6）；写入 undo/not-reversed.json，不进 log.jsonl */
  noteNotReversed(payload: {
    reason: 'inventory_only' | 'budget_truncated' | 'no_roots' | 'shell_journal_off';
    created?: string[];
    modified?: string[];
    deleted?: string[];
  }): Promise<void>;
}

/** 记忆面效应域（ToolEffectPolicy L3；knowledge 不在此列） */
export type MemoryEffectDomain = 'memory' | 'cognition' | 'wisdom';

/**
 * 记忆面效应 journal（ToolEffectPolicy L3）。
 *
 * 在 store 写口前记 before/身份，供编辑重发逆放。steward 异步写不进本轮 journal。
 */
export interface MemoryEffectJournal {
  /** INSERT 逆放 = 按 id 删除 */
  recordInsert(domain: MemoryEffectDomain, id: string): Promise<void>;
  /** UPDATE/softDelete 等：逆放 = 恢复 before */
  recordUpdate(domain: MemoryEffectDomain, id: string, before: unknown): Promise<void>;
  /** 硬删除：逆放 = 恢复 before 整行 */
  recordDelete(domain: MemoryEffectDomain, id: string, before: unknown): Promise<void>;
}

/** 工具执行上下文 */
export interface ToolExecutionContext {
  sessionId: string;
  agentId: string;
  messages: import('./messages.js').Message[];
  abortSignal?: AbortSignal;
  cwd?: string;
  /**
   * 只读会话附件根（OP-15）：file 系工具可读，不可写。
   * 路径解析优先命中这些 root；见 arch/knowledge-session-attachments.md §7。
   */
  attachmentRoots?: string[];
  /**
   * 文件效应写入口（L3 undo）。文件写工具必须经此落盘。
   * 由 Runner 注入 TurnFileUndoLog；缺失时文件写工具必须拒绝执行。
   */
  fileEffects: ToolFileEffects;
  /**
   * 记忆面效应 journal（L3）。memory 写工具/装饰器经此记账。
   * 由 Runner 注入；缺失时记忆写必须拒绝执行（禁止静默免记）。
   */
  memoryEffects: MemoryEffectJournal;
  /** L2 允许根（effectPolicy）；省略 = 不限制 */
  pathRoots?: string[];
  /**
   * Session turn-undo roots (`sessions/<sid>/undo`) that tools must not write.
   * Injected by the Runner via `resolveSessionUndoPaths`. When present, guards
   * compare real path prefixes; when absent, tools use a path-segment fallback.
   */
  undoRoots?: string[];
  /** Jail network posture (D4-c). Defaults from effect mode: host/project open, workspace/untrusted deny. */
  networkPolicy?: 'open' | 'deny' | 'allowlist';
  /**
   * Credential binding strict mode (SEC-3c). true = empty bindings cannot resolve.
   * Set for untrusted runs / credentials.requireBindings config.
   */
  requireCredentialBindings?: boolean;
  /** D7: refuse supervised fallback when the process jail cannot be applied. */
  requireJail?: boolean;
  /** Allow $HOME writes in jail (project/host). */
  homeWrite?: boolean;
  /** Execute-time degradation hook (run-level securityDegraded). */
  noteSecurityDegraded?: (reason: string) => void;
  /** L2 级别 */
  pathContainment?: 'strict' | 'soft' | 'none';
  /**
   * host-gate 效应确认（P4）。effects=host-gate 时非事务效应必须经此。
   * 由 Runner 注入宿主回调；缺失时非事务效应拒绝执行。
   */
  confirmEffect?: (intent: {
    kind: 'file.write' | 'shell' | 'memory.write' | 'other';
    path?: string;
    mode?: string;
    transactional?: boolean;
    command?: string;
    cwd?: string;
    domain?: string;
    description?: string;
  }) => Promise<'allow' | 'deny'>;
  /** P4：engine | host-gate */
  effectChannel?: 'engine' | 'host-gate';
  /** L1：false 时不启用 timeoutMs 看门狗 */
  processLimits?: boolean;
  /** shell 工具策略（deny=拒绝 shell；无 L4 时不能「只禁越界」） */
  shellEscape?: 'deny' | 'confirm' | 'allow';
  /** shell 记账深度（§5.6） */
  shellJournal?: 'snapshot' | 'off';
  /** shell 快照预算；缺省不限 */
  shellJournalLimit?: { maxFiles?: number; maxBytes?: number; maxFileSize?: number };
}

/** 工具处理函数 */
export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<unknown>;

/** 已注册的工具 */
export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
  /** 工具来源（用于权限控制和可观测性） */
  source?: ToolSource;
}
