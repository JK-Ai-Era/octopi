/**
 * Execution Environment 接口定义
 *
 * @layer core — 定义执行环境的契约，由 harness/execution-environment/ 实现。
 */

// ── 沙箱配置 ──

/** 沙箱隔离级别 */
export type IsolationLevel = 'none' | 'process' | 'container';

/** 沙箱配置 */
export interface SandboxConfig {
  /** 隔离级别 */
  isolationLevel: IsolationLevel;
  /** 工作目录 */
  cwd?: string;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 资源限制 */
  limits?: ResourceLimits;
  /** 允许的网络访问（CIDR 或 hostname） */
  allowedNetwork?: string[];
  /** 允许的文件系统路径 */
  allowedPaths?: string[];
}

/** 资源限制 */
export interface ResourceLimits {
  /** 最大执行时间（毫秒） */
  timeoutMs?: number;
  /** 最大内存（字节） */
  maxMemoryBytes?: number;
  /** 最大输出大小（字节） */
  maxOutputBytes?: number;
  /** 最大 CPU 时间（毫秒） */
  maxCpuTimeMs?: number;
}

/** 资源使用统计 */
export interface ResourceUsage {
  /** 实际执行时间（毫秒） */
  elapsedMs: number;
  /** 内存使用峰值（字节，-1 表示未知） */
  peakMemoryBytes: number;
  /** CPU 时间（毫秒，-1 表示未知） */
  cpuTimeMs: number;
  /** 输出大小（字节） */
  outputBytes: number;
}

// ── 沙箱执行结果 ──

/** 沙箱执行结果 */
export interface SandboxResult {
  /** 退出码 */
  exitCode: number;
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 是否被沙箱终止（超时、OOM 等） */
  terminated: boolean;
  /** 终止原因 */
  terminateReason?: string;
  /** 资源使用统计 */
  usage: ResourceUsage;
}

// ── 沙箱提供者接口 ──

/**
 * SandboxProvider — 沙箱提供者接口
 *
 * 在隔离环境中执行命令。不同实现可以提供不同级别的隔离：
 * - none: 直接执行（开发模式）
 * - process: 进程级隔离（spawn + resource limits）
 * - container: 容器级隔离（Docker/firejail）
 */
export interface SandboxProvider {
  /** 隔离级别 */
  readonly level: IsolationLevel;

  /**
   * 在沙箱中执行命令
   */
  execute(command: string, config?: SandboxConfig): Promise<SandboxResult>;

  /**
   * 检查沙箱是否可用
   */
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
