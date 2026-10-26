/**
 * 运维审计账本（ops P2，`arch/ops-privileged-mode.md` §5 P2 / §7）
 *
 * 提权（P3）的前置条件：碰过什么必须可查。本模块提供：
 * - **hash 链 JSONL 账本**（`OpsAuditJournal`）：追加即锚定前条 hash，事后可验证
 *   改写/插入/中间截断（`verify()`）；**尾部截断与整文件删除无法本地自证**——那需要
 *   外部见证（P5 外送的计数/尾 hash 锚点）。这是 T0 档的「防篡改」上限（同 uid 进程
 *   可写账本所在目录），真正不可抵赖靠 P5 外送，见规格原则 8。
 * - **事件词表**：`ops.command.executed`（统一动作记录）/ `ops.system_path.write`
 *   （效应 root 之外的写入）/ `ops.policy.degraded` / `ops.config.security_changed`
 *   / `ops.jail.state`。
 * - **`ToolFileEffects` 包装器**：文件效应写口集中拦截 roots 外写入（覆盖全部经
 *   fileEffects 的文件工具写口）。**shell 的 roots 外写入不在其内**：shell 账本只
 *   清点 roots，任意命令的写盘面无法穷举追踪——`jail: none`（unconfined）命令以
 *   `jail.unconfined: true` 声明「写入未入账」；根因追踪属 P5/增强。
 *
 * 只追加不修改；写失败向上抛（调用方决定降级），绝不静默丢账。
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import type { ToolFileEffects } from '@octopi-agent/core/types/tools.js';

/** 审计事件词表（§7） */
export type OpsAuditEvent =
  | 'ops.jail.state'
  | 'ops.command.executed'
  | 'ops.system_path.write'
  | 'ops.policy.degraded'
  | 'ops.config.security_changed'
  | 'ops.escalation.requested'
  | 'ops.escalation.denied'
  | 'ops.privileged.exec'
  | 'ops.kill_switch.tripped';

/** 账本条目（hash 链节点） */
export interface OpsAuditEntry {
  /** 从 1 起单调递增 */
  seq: number;
  /** epoch ms */
  ts: number;
  event: OpsAuditEvent;
  data: Record<string, unknown>;
  /** 前一条 hash；首条为 `GENESIS_HASH` */
  prevHash: string;
  /** sha256(canonical({seq,ts,event,data,prevHash})) */
  hash: string;
}

/** 链首哨兵 */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * 规范化 JSON（对象键排序）——hash 输入必须与键序无关。
 *
 * @param value - 任意 JSON 兼容值
 * @returns 稳定序列化文本
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * 计算账目 hash（链的唯一真相源）。
 *
 * @param entry - 不含 hash 的条目字段
 * @returns sha256 十六进制
 */
export function computeOpsAuditEntryHash(entry: Omit<OpsAuditEntry, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(entry)).digest('hex');
}

/**
 * 验证一段链（整文件或任意连续片段）。
 *
 * @param entries - 按 seq 升序的条目
 * @returns ok 或首个断裂点
 */
export function verifyOpsAuditChain(
  entries: readonly OpsAuditEntry[],
): { ok: true; entries: number } | { ok: false; entries: number; brokenAtSeq: number; reason: string } {
  let prevHash = GENESIS_HASH;
  let prevSeq = 0;
  const allowedKeys = ['data', 'event', 'hash', 'prevHash', 'seq', 'ts'];
  for (const entry of entries) {
    // 附加字段不受 hash 保护——读取方不得信任；有即判断裂（防「加字段伪造」）
    const keys = Object.keys(entry).sort();
    if (keys.join(',') !== allowedKeys.join(',')) {
      return { ok: false, entries: entries.length, brokenAtSeq: entry.seq, reason: 'extra_fields' };
    }
    if (entry.seq !== prevSeq + 1) {
      return { ok: false, entries: entries.length, brokenAtSeq: entry.seq, reason: 'seq_gap' };
    }
    if (entry.prevHash !== prevHash) {
      return { ok: false, entries: entries.length, brokenAtSeq: entry.seq, reason: 'prev_hash_mismatch' };
    }
    const expected = computeOpsAuditEntryHash({
      seq: entry.seq,
      ts: entry.ts,
      event: entry.event,
      data: entry.data,
      prevHash: entry.prevHash,
    });
    if (expected !== entry.hash) {
      return { ok: false, entries: entries.length, brokenAtSeq: entry.seq, reason: 'hash_mismatch' };
    }
    prevHash = entry.hash;
    prevSeq = entry.seq;
  }
  return { ok: true, entries: entries.length };
}

/**
 * 读回账本全文（供验证/查询）。
 *
 * **只有 ENOENT 是合法空账**（尚未建账）；其余读失败抛 `ops_audit_unreadable`、
 * 坏行抛 `ops_audit_corrupt`——把读失败当空账会静默重链并把账本写坏（评审实证）。
 *
 * @param path - 账本文件路径
 * @returns 条目（按写入序）；文件不存在返回空数组
 * @throws `ops_audit_unreadable` / `ops_audit_corrupt`
 */
export function readOpsAuditEntries(path: string): OpsAuditEntry[] {
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return [];
    throw new Error(
      `ops_audit_unreadable: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const entries: OpsAuditEntry[] = [];
  let lineNo = 0;
  for (const line of body.split('\n')) {
    lineNo += 1;
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line) as OpsAuditEntry);
    } catch {
      // 半行（崩溃/写断电）或外部损坏：拒绝当正常读，绝不静默跳行
      throw new Error(`ops_audit_corrupt: unparseable line ${lineNo} in ${path}`);
    }
  }
  return entries;
}

/** 账本追加结果 */
export interface OpsAuditAppendResult {
  entry: OpsAuditEntry;
  /** tail 衔接被验证过（追加即轻校验） */
  tailVerified: boolean;
}

/**
 * 运维审计账本（append-only JSONL + hash 链）。
 *
 * 追加为同步写（`appendFileSync`）：审计语义优先于吞吐，且顺序天然确定。
 * 启动/首次追加时回读尾条衔接 `seq/prevHash`；尾部不可解析 → 抛
 * `ops_audit_corrupt`（**拒绝续链**——静默重链会把篡改洗成新链）。
 */
export class OpsAuditJournal {
  private readonly path: string;
  private tail: { seq: number; hash: string } | undefined;

  /**
   * @param options - `path` 为账本 JSONL 绝对路径
   */
  constructor(options: { path: string }) {
    this.path = options.path;
  }

  /** 账本路径（诊断/测试用） */
  get filePath(): string {
    return this.path;
  }

  private bootstrapTail(): { seq: number; hash: string } {
    if (this.tail) return this.tail;
    let entries: OpsAuditEntry[];
    try {
      entries = readOpsAuditEntries(this.path);
    } catch (err) {
      // 读失败/坏行一律拒绝续链（静默重链会把篡改洗成新链）；附上类型码
      throw err instanceof Error && err.message.startsWith('ops_audit_')
        ? err
        : new Error(`ops_audit_corrupt: ${err instanceof Error ? err.message : String(err)}`);
    }
    const last = entries.at(-1);
    if (!last) {
      this.tail = { seq: 0, hash: GENESIS_HASH };
      return this.tail;
    }
    // 尾条必须能自证：hash 对不上 = 文件被动过，拒绝把新账接上去
    const expected = computeOpsAuditEntryHash({
      seq: last.seq,
      ts: last.ts,
      event: last.event,
      data: last.data,
      prevHash: last.prevHash,
    });
    if (expected !== last.hash) {
      throw new Error(`ops_audit_corrupt: tail entry hash mismatch at seq ${last.seq} (${this.path})`);
    }
    this.tail = { seq: last.seq, hash: last.hash };
    return this.tail;
  }

  /**
   * 追加一条账目。
   *
   * @param event - 事件名（§7 词表）
   * @param data - 事件载荷（键序无关，hash 走 canonicalJson）
   * @returns 落盘的账目
   */
  append(event: OpsAuditEvent, data: Record<string, unknown>): OpsAuditEntry {
    const tail = this.bootstrapTail();
    // 载荷先 JSON 归一：hash 口径必须与落盘字节一致（Date 等对象若不归一，
    // verify 会对未篡改的账报 hash_mismatch——评审实证的假告警）
    const normalized = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
    const body = {
      seq: tail.seq + 1,
      ts: Date.now(),
      event,
      data: normalized,
      prevHash: tail.hash,
    };
    const entry: OpsAuditEntry = { ...body, hash: computeOpsAuditEntryHash(body) };
    mkdirSync(dirname(this.path), { recursive: true });
    // 耐久写（fsync）：一次崩溃/磁盘满留半行会让账本拒绝续链（fail-loud），
    // 但那是人工修复成本——先把半行概率压到最低
    const fd = openSync(this.path, 'a');
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.tail = { seq: entry.seq, hash: entry.hash };
    return entry;
  }

  /**
   * 全链验证（追加只验尾；中段篡改靠本方法）。
   *
   * @returns ok 或首个断裂点
   */
  verify(): ReturnType<typeof verifyOpsAuditChain> {
    // 读不到/坏行也是「验不过」的一种——返回结论而不是把异常抛给调用方
    let entries: OpsAuditEntry[];
    try {
      entries = readOpsAuditEntries(this.path);
    } catch (err) {
      return {
        ok: false,
        entries: 0,
        brokenAtSeq: -1,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    return verifyOpsAuditChain(entries);
  }
}

/**
 * 工具上下文回传的事件输入（core 契约 shape）
 */
export interface OpsEventInput {
  event: OpsAuditEvent;
  data: Record<string, unknown>;
}

/**
 * 审计外送信封（P5 唯一不可抵赖档，原则 8）。
 *
 * 本地账本的 hash 链防「改写/插入」，但**尾部截断与整文件删除本地无法自证**——
 * 那需要外部见证。外送档把每条账目（连同链证据）推到宿主可达的收口
 * （宿主侧文件 / HTTP），宿主按 `count`（= 账本 seq）查缺、用 `entry` 原样重验链：
 *
 * - `count`：单调递增账目序号——外送流缺号 = 丢账可查；
 * - `tailHash`：本条落链后的尾锚点——与宿主已收最后一条对得上才叫连续；
 * - `entry`：账目原样（含 `prevHash`/`hash`，`verifyOpsAuditChain` 可直接重放）。
 */
export interface OpsAuditExportEnvelope {
  count: number;
  tailHash: string;
  entry: OpsAuditEntry;
  /** 外送时刻（epoch ms；账目 `ts` 是发生时刻，两者都留） */
  forwardedAt: number;
}

/** 外送收口（append-only） */
export interface OpsAuditExportSink {
  forward(envelope: OpsAuditExportEnvelope): void;
}

/**
 * 文件外送收口：宿主侧 append-only JSONL（每行一个信封）。
 *
 * 路径应放在 **agent 可写面之外**（`~/.octopi` 在 host 模式的可写面内——放那里
 * 等于没外送）。写失败向上抛，由调用方降级申报，绝不静默丢外送。
 */
export class OpsAuditFileExportSink implements OpsAuditExportSink {
  private readonly path: string;

  /**
   * @param options.path - 外送文件绝对路径（宿主侧，agent 不可写）
   */
  constructor(options: { path: string }) {
    this.path = options.path;
  }

  /** 外送文件路径（诊断用） */
  get filePath(): string {
    return this.path;
  }

  /** @inheritdoc */
  forward(envelope: OpsAuditExportEnvelope): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, 'a');
    try {
      writeSync(fd, `${JSON.stringify(envelope)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

/**
 * `ToolFileEffects` 装饰器：效应 root 之外的写入统一入 `ops.system_path.write`。
 *
 * 单点覆盖全部文件工具与 shell 账本（它们都经 `fileEffects` 写口），不逐工具打补丁。
 * 记账失败不影响业务写（与 §5.6 记账同策略），但会抛给调用方的降级通道。
 */
export class OpsAuditedFileEffects implements ToolFileEffects {
  private readonly inner: ToolFileEffects;
  private readonly roots: readonly string[];
  private readonly record: (event: OpsAuditEvent, data: Record<string, unknown>) => void;

  /**
   * @param inner - 被装饰的真实效应 journal
   * @param options.roots - 效应 root（root 内写入不记 system_path 账）
   * @param options.record - 账目回传（通常进 OpsAuditJournal）
   */
  constructor(
    inner: ToolFileEffects,
    options: {
      roots: readonly string[];
      record: (event: OpsAuditEvent, data: Record<string, unknown>) => void;
    },
  ) {
    this.inner = inner;
    this.roots = options.roots;
    this.record = options.record;
  }

  private underRoots(path: string): boolean {
    // resolve + sep 感知；win32 大小写不敏感卷按 toLowerCase 口径（对齐 isPathAllowed）
    const norm = (p: string): string =>
      process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
    const target = norm(path);
    return this.roots.some((root) => {
      const base = norm(root);
      return target === base || target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
    });
  }

  private noteWrite(op: string, path: string, fromPath?: string): void {
    // 经 fileEffects 写口的写入本身是 undo 账在管（before/after 都在 TurnFileUndoLog，
    // 含 root 外路径）——本账目只是「越权写告警」的可见层，不虚报可逆性
    const outside = [path, fromPath].filter((p): p is string => p !== undefined && !this.underRoots(p));
    if (outside.length === 0) return;
    this.record('ops.system_path.write', {
      op,
      path,
      ...(fromPath !== undefined ? { fromPath } : {}),
      outsideRoots: outside,
    });
  }

  /** @inheritdoc */
  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await this.inner.writeFile(path, data);
    this.noteWrite('writeFile', path);
  }

  /** @inheritdoc */
  async appendFile(path: string, data: string | Uint8Array): Promise<void> {
    await this.inner.appendFile(path, data);
    this.noteWrite('appendFile', path);
  }

  /** @inheritdoc */
  async recordDelete(path: string, before: string | Uint8Array): Promise<void> {
    await this.inner.recordDelete(path, before);
    this.noteWrite('recordDelete', path);
  }

  /** @inheritdoc */
  async recordCreate(path: string, after?: string | Uint8Array): Promise<void> {
    await this.inner.recordCreate(path, after);
    this.noteWrite('recordCreate', path);
  }

  /** @inheritdoc */
  async recordRename(from: string, to: string): Promise<void> {
    await this.inner.recordRename(from, to);
    // mv 进 root = root 外文件消失：from 端也要入账
    this.noteWrite('recordRename', to, from);
  }

  /** @inheritdoc */
  async recordOverwrite(path: string, before: string | Uint8Array, after?: string | Uint8Array): Promise<void> {
    await this.inner.recordOverwrite(path, before, after);
    this.noteWrite('recordOverwrite', path);
  }

  /** @inheritdoc */
  async noteNotReversed(payload: Parameters<ToolFileEffects['noteNotReversed']>[0]): Promise<void> {
    await this.inner.noteNotReversed(payload);
  }
}
