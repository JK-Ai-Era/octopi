/**
 * FileConfigService — octopi.json 文件写回实现（arch/config-hot-reload.md §2）
 *
 * 职责：乐观锁 hash 比对 → mutate → 写前全量校验（与 loadConfig 同规）→
 * 备份 → 原子写（tmp + rename）。进程内写操作串行（单队列），防止
 * 并发 API 请求交错写。操作 raw，`${ENV}` 占位符原样保留（同 doctor --fix）。
 *
 * @module
 */
import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { computeConfigHash } from '@octopi-agent/engine/config-admin/patch.js';
import {
  ConfigConflictError,
  type ConfigAdminPort,
  type ConfigAdminSnapshot,
  type ConfigAdminWriteResult,
} from '@octopi-agent/engine/config-admin/port.js';
import { expandEnvPlaceholders, applyConfigMigrations } from './config.js';
import { validateConfigOrThrow } from './config-schema.js';
import { detectUnknownConfigKeys } from './config-schema/unknown-keys.js';
import { getOctopiHome } from './init.js';

/** FileConfigService 构造选项 */
export interface FileConfigServiceOptions {
  /** 配置文件路径（缺省按 loadConfig 同一查找规则解析） */
  configPath?: string;
}

export class FileConfigService implements ConfigAdminPort {
  private readonly configPath: string;
  /** 进程内写串行队列（尾部链式 Promise） */
  private writeQueue: Promise<unknown> = Promise.resolve();

  /**
   * @param options - 构造选项；configPath 缺省时按 loadConfig 查找规则解析
   */
  constructor(options: FileConfigServiceOptions = {}) {
    this.configPath = resolve(options.configPath ?? resolveConfigPath());
  }

  /** 配置文件绝对路径 */
  get path(): string {
    return this.configPath;
  }

  /**
   * 列出配置备份（`octopi.json.bak.<ts>`，按时间倒序）
   *
   * @returns 备份清单（路径 / 修改时间 / 大小）
   */
  listBackups(): Array<{ path: string; mtimeMs: number; size: number }> {
    const dir = dirname(this.configPath);
    const prefix = `${basename(this.configPath)}.bak.`;
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.startsWith(prefix))
      .map((e) => {
        const p = join(dir, e.name);
        const st = statSync(p);
        return { path: p, mtimeMs: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /**
   * 读备份内容（回滚源）
   *
   * @param backupPath - 备份路径（必须在配置目录内且是 `.bak.` 备份文件，防 symlink 逃逸）
   * @returns 备份原文
   * @throws 路径越界 / 非备份文件 / 不存在时抛错
   */
  readBackup(backupPath: string): string {
    const dir = realpathSync(resolve(dirname(this.configPath)));
    const resolved = realpathSync(resolve(backupPath)); // 解析 symlink（#3）
    if (resolved !== dir && !resolved.startsWith(dir + sep)) {
      throw new Error(`backup outside config dir: ${backupPath}`);
    }
    const prefix = `${basename(this.configPath)}.bak.`;
    if (!basename(resolved).startsWith(prefix)) {
      throw new Error(`not a config backup file: ${backupPath}`);
    }
    return readFileSync(resolved, 'utf-8');
  }

  /**
   * 读取当前盘上配置快照（raw + hash）
   *
   * @returns raw 配置 + 内容 hash
   */
  read(): ConfigAdminSnapshot {
    const text = readFileSync(this.configPath, 'utf-8');
    return {
      raw: JSON.parse(text) as Record<string, unknown>,
      hash: computeConfigHash(text),
    };
  }

  /**
   * 写回配置（乐观锁 + 写前全量校验 + 备份 + 原子写；进程内串行）
   *
   * @param mutate - 就地修改 raw 的补丁函数
   * @param expectedHash - 调用方读到的 hash
   * @returns 写后 hash + 备份路径
   * @throws {@link ConfigConflictError} 并发冲突；校验失败抛错且盘上内容不变
   */
  write(
    mutate: (raw: Record<string, unknown>) => void,
    expectedHash: string,
  ): Promise<ConfigAdminWriteResult> {
    const run = this.writeQueue.then(() => this.writeNow(mutate, expectedHash));
    // 失败不毒化队列：后续写仍可执行
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  /** 单次写流程（已在队列内） */
  private async writeNow(
    mutate: (raw: Record<string, unknown>) => void,
    expectedHash: string,
  ): Promise<ConfigAdminWriteResult> {
    const text = readFileSync(this.configPath, 'utf-8');
    const currentHash = computeConfigHash(text);
    if (currentHash !== expectedHash) {
      throw new ConfigConflictError(currentHash);
    }

    const raw = JSON.parse(text) as Record<string, unknown>;
    mutate(raw);
    const outText = `${JSON.stringify(raw, null, 2)}\n`;

    // 写前全量校验：与 loadConfig 同一管线（展开 → 迁移 → Zod + 交叉校验），
    // 保证写下去的配置一定能启动；失败即中止，盘上内容不变。
    // 未知键 fail-loud（P3）：Zod 会静默 strip typo，这里显式拒绝（对 raw 检查，占位符形态照常识别）。
    const expanded = expandEnvPlaceholders(outText);
    const parsed = JSON.parse(expanded) as Record<string, unknown>;
    applyConfigMigrations(parsed);
    // 未知键（P3 拍板方案3）：**告警不阻断**——warnings 随结果上抛，UI 提供手动
    // 「清理无效键」；阻断会误伤与该键无关的编辑。校验仍拦结构性错误。
    const warnings = detectUnknownConfigKeys(raw);
    validateConfigOrThrow(parsed);

    const backupPath = `${this.configPath}.bak.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    copyFileSync(this.configPath, backupPath);

    // tmp + rename 原子写：保留原文件权限（配置含密钥，chmod 0600 不被降级）+ fsync
    const { mode } = statSync(this.configPath);
    const tmpPath = join(dirname(this.configPath), `.octopi.json.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`);
    const fd = openSync(tmpPath, 'w', mode);
    try {
      writeFileSync(fd, outText, 'utf-8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, this.configPath);

    return { hash: computeConfigHash(outText), backupPath, warnings };
  }
}

/**
 * 按 loadConfig 同一查找规则解析配置文件路径（不读文件、不打日志）
 *
 * @returns 配置文件绝对路径
 * @throws 找不到配置文件时抛错（与 loadConfig 同一错误提示）
 */
export function resolveConfigPath(): string {
  // 查找优先级与 loadConfig 一致：./octopi.json → OCTOPI_HOME/octopi.json
  if (existsSync(resolve('./octopi.json'))) return resolve('./octopi.json');
  const homeConfig = resolve(getOctopiHome(), 'octopi.json');
  if (existsSync(homeConfig)) return homeConfig;
  throw new Error(`Config file not found: ${homeConfig}`);
}
