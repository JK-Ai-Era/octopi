/**
 * ConfigAdminPort — 配置管理面写回端口（arch/config-hot-reload.md §2）
 *
 * gateway 只依赖本接口；文件实现（FileConfigService）在根包组合根注入。
 * 语义对齐 doctor --fix 写回先例：操作 raw（`${ENV}` 占位符原样保留）。
 *
 * @module
 */

/** 一次读取快照 */
export interface ConfigAdminSnapshot {
  /** raw JSON（未展开 `${ENV}`） */
  raw: Record<string, unknown>;
  /** 内容 hash（乐观锁，见 computeConfigHash） */
  hash: string;
}

/** 写回结果 */
export interface ConfigAdminWriteResult {
  /** 写后内容 hash（供后续编辑做乐观锁） */
  hash: string;
  /** 备份文件路径 */
  backupPath: string;
  /** 运行时会忽略的未知键路径（告警不阻断，UI 提供手动清理） */
  warnings: string[];
}

/** 并发编辑冲突（expectedHash 与盘上内容不一致） */
export class ConfigConflictError extends Error {
  /** 当前盘上内容 hash */
  readonly currentHash: string;

  /**
   * @param currentHash - 当前盘上内容 hash
   */
  constructor(currentHash: string) {
    super(`config conflict: file changed since read (current hash ${currentHash.slice(0, 12)}…)`);
    this.name = 'ConfigConflictError';
    this.currentHash = currentHash;
  }
}

/** 配置管理面写回端口 */
export interface ConfigAdminPort {
  /**
   * 读取当前盘上配置快照
   *
   * @returns raw 配置 + 内容 hash
   */
  read(): ConfigAdminSnapshot;

  /**
   * 写回配置：hash 比对（乐观锁）→ mutate → 全量校验 → 备份 → 原子写
   *
   * @param mutate - 就地修改 raw 的补丁函数
   * @param expectedHash - 调用方读到的 hash（乐观锁）
   * @returns 写后 hash + 备份路径
   * @throws {@link ConfigConflictError} 并发冲突；校验失败亦抛错且盘上内容不变
   */
  write(
    mutate: (raw: Record<string, unknown>) => void,
    expectedHash: string,
  ): Promise<ConfigAdminWriteResult>;

  /**
   * 列出配置备份（时间倒序；回滚 UI 用）
   *
   * @returns 备份清单；实现不支持时缺省空数组
   */
  listBackups?(): Array<{ path: string; mtimeMs: number; size: number }>;

  /**
   * 读备份内容（回滚源）
   *
   * @param backupPath - 备份路径
   * @returns 备份原文
   */
  readBackup?(backupPath: string): string;
}
