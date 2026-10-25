/**
 * Execution Environment interface contracts
 *
 * @layer harness/extension/execution-environment
 */

import type { ProcessIsolationProfile } from './process-isolation.js';

// ── Sandbox config ──

/** Legacy coarse isolation level (prefer ProcessIsolationProfile) */
export type IsolationLevel = 'none' | 'process' | 'container';

/** Sandbox config */
export interface SandboxConfig {
  /** Requested isolation level (legacy knob) */
  isolationLevel?: IsolationLevel;
  /** Working directory */
  cwd?: string;
  /**
   * Explicit environment. Merged on top of the scrubbed allowlist.
   * Never spreads `process.env` — secrets must not ride along.
   */
  env?: Record<string, string>;
  /** Resource limits */
  limits?: ResourceLimits;
  /**
   * Network posture for jail backends (bwrap / Seatbelt).
   * Default when omitted: `deny` (D4-c). `allowlist` is interface-only this release
   * and is enforced as `deny` with an honest note.
   */
  networkPolicy?: 'open' | 'deny' | 'allowlist';
  /**
   * Absolute roots the jail may read/write (bind mounts / Seatbelt write-allow).
   * Falls back to `[cwd]` when omitted. Not a substitute for L2 path policy.
   */
  allowRoots?: string[];
  /**
   * D7: when true (untrusted / L4-required), jail backend must actually apply.
   * Setup failure throws instead of falling back to supervised spawn.
   */
  requireJail?: boolean;
  /**
   * Allow `$HOME` writes inside the jail (project/host only per 2b).
   * tmpdir and, on POSIX, shared `/tmp` + `/var/tmp` are always writable (2a);
   * tmp writes are not journaled (2c notReversed).
   */
  homeWrite?: boolean;
  /** Run-level hook for execute-time degradation (falls back to isolation.notes). */
  noteSecurityDegraded?: (reason: string) => void;
  /** Abort in-flight execution */
  signal?: AbortSignal;
}

/** Resource limits */
export interface ResourceLimits {
  /** Max wall time (ms) */
  timeoutMs?: number;
  /** Max memory (bytes) */
  maxMemoryBytes?: number;
  /** Max captured output (bytes) */
  maxOutputBytes?: number;
  /** Max CPU time (ms) */
  maxCpuTimeMs?: number;
}

/** Resource usage */
export interface ResourceUsage {
  /** Elapsed wall time (ms) */
  elapsedMs: number;
  /** Peak memory (bytes, -1 unknown) */
  peakMemoryBytes: number;
  /** CPU time (ms, -1 unknown) */
  cpuTimeMs: number;
  /** Output size (bytes) */
  outputBytes: number;
}

// ── Sandbox result ──

/** Sandbox execution result */
export interface SandboxResult {
  /** Exit code */
  exitCode: number;
  /** stdout */
  stdout: string;
  /** stderr */
  stderr: string;
  /** Terminated by sandbox (timeout, OOM, output cap) */
  terminated: boolean;
  /** Terminate reason */
  terminateReason?: string;
  /** Resource usage */
  usage: ResourceUsage;
  /** Honest isolation actually applied for this run */
  isolation: ProcessIsolationProfile;
  /** Structured diagnostics; absent when the run explained itself */
  diagnostics?: SandboxDiagnostics;
}

/**
 * Structured, machine-readable diagnostics for a sandboxed run.
 *
 * Hints exist so a caller can self-correct on the next attempt instead of
 * re-discovering a sandbox invariant (mirrors `file_search` diagnostics).
 */
export interface SandboxDiagnostics {
  /** Actionable self-correction hints, one line each */
  hints?: string[];
}

// ── Sandbox provider ──

/**
 * SandboxProvider — execute commands under an isolation profile.
 * Implementations must report real capabilities via `isolation` / `probe()`.
 */
export interface SandboxProvider {
  /** Legacy coarse level */
  readonly level: IsolationLevel;

  /** Honest isolation profile for this provider */
  probe(): Promise<ProcessIsolationProfile>;

  /**
   * Execute a shell command line (platform shell) under isolation.
   */
  execute(command: string, config?: SandboxConfig): Promise<SandboxResult>;

  /**
   * Execute an argv vector (preferred — no shell string parsing).
   */
  executeArgv?(argv: string[], config?: SandboxConfig): Promise<SandboxResult>;

  /** Whether this provider can run on the current host */
  isAvailable(): Promise<boolean>;
}

// ── 工作区接口 ──

/** 工作区配置 */
export interface WorkspaceConfig {
  /** 工作区根目录 */
  root: string;
  /** 是否启用 git */
  enableGit?: boolean;
  /** 文件监视 */
  watch?: boolean;
}

/** 工作区快照 */
export interface WorkspaceSnapshot {
  /** 快照 ID */
  id: string;
  /** 创建时间 */
  createdAt: number;
  /** 工作区根目录 */
  root: string;
  /** git commit hash（如果启用 git） */
  commitHash?: string;
}

/**
 * Workspace — 工作区接口
 *
 * 管理 agent 的文件系统工作区。支持：
 * - 创建/销毁工作区
 * - 快照/回滚
 * - 文件操作（search、glob、diff）
 */
export interface Workspace {
  /** 工作区根目录 */
  readonly root: string;

  /**
   * 创建快照
   */
  snapshot(): Promise<WorkspaceSnapshot>;

  /**
   * 回滚到快照
   */
  restore(snapshot: WorkspaceSnapshot): Promise<void>;

  /**
   * 搜索文件内容
   */
  search(pattern: string, options?: SearchOptions): Promise<FileMatch[]>;

  /**
   * Glob 文件匹配
   */
  glob(pattern: string): Promise<string[]>;

  /**
   * 文件 diff
   */
  diff(filePath: string): Promise<string>;

  /**
   * 销毁工作区
   */
  destroy(): Promise<void>;
}

// ── 文件操作类型 ──

/** 搜索选项 */
export interface SearchOptions {
  /** 文件名 glob 过滤 */
  include?: string;
  /** 排除 glob */
  exclude?: string;
  /** 最大结果数 */
  limit?: number;
  /** 是否区分大小写 */
  caseSensitive?: boolean;
}

/** 文件匹配结果 */
export interface FileMatch {
  /** 文件路径 */
  path: string;
  /** 匹配行号 */
  line: number;
  /** 匹配行内容 */
  content: string;
  /** 匹配位置 */
  column?: number;
}
