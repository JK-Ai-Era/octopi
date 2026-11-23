/**
 * 会话封存包（bundle）—— USTAR tar + gzip 单文件容器
 *
 * 布局（设计定稿 arch/session-archive-recycle.md §3.1）：
 *   manifest.json          —— 必须为**第一个**条目（readBundleManifest 只需解压流开头）
 *   <会话数据文件树>        —— staging 目录内容原样入包（相对路径为条目名）
 *
 * 实现约束：依赖树无 tar/zip 库且不为此加依赖 —— 自写最小 USTAR 写入/读取器
 * （`tar tzf` 可交叉验证）。两遍文件读：第一遍算 sha256（manifest 置首必须先有摘要），
 * 第二遍流式入包；不把大附件整读进内存。
 *
 * @module
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

/** USTAR 块大小 */
const BLOCK = 512;

/** 封存包内 manifest 条目名 */
export const BUNDLE_MANIFEST_NAME = 'manifest.json';

/** 封存包格式版本 */
export const BUNDLE_FORMAT = 1;

/** 入包文件清单条目 */
export interface BundleFileEntry {
  /** 包内相对路径（POSIX 分隔符） */
  path: string;
  /** 字节数 */
  bytes: number;
  /** sha256 hex */
  sha256: string;
}

/** 封存包 manifest（bundle 内第一个条目；注册表 manifest_json 缓存其摘要） */
export interface BundleManifest {
  format: typeof BUNDLE_FORMAT;
  sessionId: string;
  tenantId?: string;
  agentId: string;
  title: string;
  lifecycle?: string;
  endedAt?: number;
  sealedAt: number;
  sealedBy: 'manual' | 'trash' | 'auto';
  state: 'archived' | 'trashed';
  /** 到期销毁时间；null = 永久（手动归档） */
  purgeAt: number | null;
  parentSessionId?: string;
  /** 级联组 id（单会话 = 自身 id）；组内共进退 */
  groupSealId: string;
  /** 热库元索引原始条目（恢复回填：createdAt/channelId 等非 state 权威字段不丢） */
  metaRaw?: unknown;
  /** 逐文件清单（恢复后逐文件核对） */
  files: BundleFileEntry[];
  /** schedules.db 行快照（恢复时回插） */
  schedules: unknown[];
  /** 可检索附件的 knowledge source 映射（恢复时重登记） */
  knowledgeSources: Array<{ sourceId: string; attachmentFile?: string }>;
  stats: {
    messageCount: number;
    attachmentCount: number;
    /** 入包文件总字节 */
    bytes: number;
  };
}

/** packBundle 的 manifest 输入（format/files/stats 由打包过程填充） */
export type BundleManifestInput = Omit<BundleManifest, 'format' | 'files' | 'stats'> & {
  stats?: Partial<BundleManifest['stats']>;
};

// ── USTAR 头 ──

/**
 * 写八进制字段（高位字节序 ASCII；定长补 NUL）
 *
 * @param value - 数值
 * @param width - 字段宽度
 * @returns 定长 buffer
 */
function octal(value: number, width: number): Buffer {
  if (value >= 8 ** (width - 1)) {
    // USTAR 八进制定长溢出：不静默回绕（tar 收尾数字除外的变体这里不支持），fail loud
    throw new Error(`bundle: value ${value} overflows octal field (width ${width})`);
  }
  const s = value.toString(8).padStart(width - 1, '0');
  return Buffer.from(s + '\0', 'ascii');
}

/**
 * 构造单条 USTAR 头（含校验和）
 *
 * @param name - 条目路径（≤100 字节，超出由调用方走 prefix 分裂或 GNU LongLink）
 * @param size - 正文长度
 * @param mtimeMs - 修改时间（毫秒）
 * @param typeflag - '0' 文件 / '5' 目录 / 'L' GNU LongLink
 * @returns 512 字节头
 */
function tarHeader(name: string, size: number, mtimeMs: number, typeflag: string): Buffer {
  const h = Buffer.alloc(BLOCK);
  const nameBytes = Buffer.from(name, 'utf-8');
  if (nameBytes.length > 100) {
    throw new Error(`bundle: entry name too long for plain header (${nameBytes.length} bytes): ${name}`);
  }
  nameBytes.copy(h, 0);
  octal(0o644, 8).copy(h, 100); // mode
  octal(0, 8).copy(h, 108); // uid
  octal(0, 8).copy(h, 116); // gid
  octal(size, 12).copy(h, 124);
  octal(Math.floor(mtimeMs / 1000), 12).copy(h, 136);
  h.write('        ', 148, 8, 'ascii'); // 校验和占位（8 空格）
  h.write(typeflag, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  // 校验和 = 全头字节之和（占位按空格计）
  let sum = 0;
  for (const b of h) sum += b;
  const chk = sum.toString(8).padStart(6, '0');
  h.write(chk + '\0 ', 148, 8, 'ascii');
  return h;
}

/**
 * USTAR 名称字段编码：≤100 直写；否则按 '/' 边界分裂 prefix/name；
 * 仍放不下走 GNU LongLink（'L' 条目，正文=真实名）。
 *
 * @param name - 条目路径（POSIX 分隔符）
 * @returns 前置条目（LongLink 时）与正式头构造参数
 */
function encodeEntryName(name: string): {
  longLink?: { name: string; body: Buffer };
  name: string;
  prefix: string;
} {
  const nameBytes = Buffer.from(name, 'utf-8');
  if (nameBytes.length <= 100) return { name, prefix: '' };
  // prefix 分裂：name 段 ≤100、prefix 段 ≤155，且必须在 '/' 边界
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== '/') continue;
    const prefix = name.slice(0, i);
    const tail = name.slice(i + 1);
    if (
      Buffer.byteLength(tail, 'utf-8') <= 100 &&
      Buffer.byteLength(prefix, 'utf-8') <= 155
    ) {
      return { name: tail, prefix };
    }
  }
  // GNU LongLink：真实名进 'L' 条目正文；正式头名截断占位（读方以 L 条目为准）
  const body = Buffer.concat([Buffer.from(name, 'utf-8'), Buffer.from([0])]);
  return { longLink: { name: '././@LongLink', body }, name: truncateUtf8(name, 100), prefix: '' };
}

/** 按 UTF-8 字节边界截断（不劈开多字节字符） */
function truncateUtf8(s: string, maxBytes: number): string {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i)!;
    const len = cp > 0xffff ? 4 : cp > 0x7ff ? 3 : cp > 0x7f ? 2 : 1;
    if (bytes + len > maxBytes) return s.slice(0, i);
    bytes += len;
    if (len === 4) i++;
  }
  return s;
}

/**
 * 生成条目（头 + 正文 + 512 对齐填充）的 buffer 序列
 *
 * @param entryName - 条目路径
 * @param size - 正文长度
 * @param mtimeMs - 修改时间
 * @param bodySource - 正文来源（'empty' / buffer / 流）
 */
async function* emitEntry(
  entryName: string,
  size: number,
  mtimeMs: number,
  bodySource: { kind: 'empty' } | { kind: 'buffer'; data: Buffer } | { kind: 'stream'; absPath: string },
): AsyncGenerator<Buffer> {
  const enc = encodeEntryName(entryName);
  if (enc.longLink) {
    yield tarHeader(enc.longLink.name, enc.longLink.body.length, mtimeMs, 'L');
    yield enc.longLink.body;
    yield padding(enc.longLink.body.length);
  }
  const h = tarHeader(enc.name, size, mtimeMs, '0');
  if (enc.prefix) h.write(enc.prefix, 345, Math.min(155, Buffer.byteLength(enc.prefix, 'utf-8')), 'utf-8');
  yield h;
  if (bodySource.kind === 'buffer') {
    yield bodySource.data;
  } else if (bodySource.kind === 'stream') {
    for await (const chunk of createReadStream(bodySource.absPath)) {
      yield chunk as Buffer;
    }
  }
  yield padding(size);
}

/** 对齐填充（size 已对齐时为空 buffer） */
function padding(size: number): Buffer {
  const rem = size % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem);
}

// ── 目录遍历 ──

/**
 * 递归收集目录下所有文件（排序保证确定性）
 *
 * @param root - 根目录
 * @param base - 递归基址（相对路径计算用）
 * @returns { 相对 POSIX 路径, 绝对路径, 字节数, mtimeMs } 列表
 */
async function collectFiles(
  root: string,
  base = root,
): Promise<Array<{ rel: string; abs: string; bytes: number; mtimeMs: number }>> {
  const out: Array<{ rel: string; abs: string; bytes: number; mtimeMs: number }> = [];
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const abs = join(root, e.name);
    if (e.isDirectory()) {
      out.push(...(await collectFiles(abs, base)));
    } else if (e.isFile()) {
      const st = await stat(abs);
      const rel = relative(base, abs).split(sep).join('/');
      out.push({ rel, abs, bytes: st.size, mtimeMs: st.mtimeMs });
    } else {
      // symlink/FIFO/socket 等：不入包也无法序列化 —— 静默丢弃=数据丢失，fail loud
      throw new Error(`bundle: unsupported entry type in staging: ${abs}`);
    }
  }
  return out;
}

/**
 * 流式计算文件 sha256
 *
 * @param absPath - 文件绝对路径
 * @returns hex 摘要
 */
async function hashFile(absPath: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(absPath)) {
    h.update(chunk as Buffer);
  }
  return h.digest('hex');
}

// ── 公开 API ──

/**
 * 打包 staging 目录为封存包（.tmp + rename 原子落位）
 *
 * 两遍文件读：先算全部摘要（manifest 置首），再流式入包。staging 内容原样入包，
 * 相对路径即条目名；manifest.json 不得与 staging 文件重名（保序置首，冲突直接报错）。
 *
 * @param input.stagingDir - 待封存目录（打完由调用方清理）
 * @param input.outPath - 目标 .tar.gz 路径
 * @param input.manifest - manifest 输入（files/stats 由本函数填充）
 * @returns 完整 manifest（含 files/stats）
 * @throws staging 不存在 / manifest.json 与 staging 文件重名 / 写盘失败
 */
export async function packBundle(input: {
  stagingDir: string;
  outPath: string;
  manifest: BundleManifestInput;
}): Promise<BundleManifest> {
  const files = await collectFiles(input.stagingDir);
  if (files.some((f) => f.rel === BUNDLE_MANIFEST_NAME)) {
    throw new Error(`bundle: staging file collides with reserved "${BUNDLE_MANIFEST_NAME}"`);
  }
  const entries: BundleFileEntry[] = [];
  for (const f of files) {
    entries.push({ path: f.rel, bytes: f.bytes, sha256: await hashFile(f.abs) });
  }
  const manifest: BundleManifest = {
    ...input.manifest,
    format: BUNDLE_FORMAT,
    files: entries,
    stats: {
      messageCount: input.manifest.stats?.messageCount ?? 0,
      attachmentCount: input.manifest.stats?.attachmentCount ?? 0,
      bytes: entries.reduce((acc, e) => acc + e.bytes, 0),
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 1), 'utf-8');

  await mkdir(dirname(input.outPath), { recursive: true });
  const tmpPath = `${input.outPath}.tmp`;
  const mtime = Date.now();
  async function* stream(): AsyncGenerator<Buffer> {
    yield* emitEntry(BUNDLE_MANIFEST_NAME, manifestBytes.length, mtime, {
      kind: 'buffer',
      data: manifestBytes,
    });
    for (const f of files) {
      yield* emitEntry(f.rel, f.bytes, f.mtimeMs, { kind: 'stream', absPath: f.abs });
    }
    yield Buffer.alloc(BLOCK * 2); // 结束标记
  }
  await pipeline(Readable.from(stream()), createGzip(), createWriteStream(tmpPath));
  await rename(tmpPath, input.outPath);
  return manifest;
}

// ── 解包侧：字节源 ──

/** gunzip 流之上的精确读取器（tar 按块解析需要） */
class ByteSource {
  private buf: Buffer = Buffer.alloc(0);
  private done = false;

  constructor(private readonly iter: AsyncIterator<Buffer>) {}

  /** 提前收工（早退路径释放文件/gunzip 句柄） */
  async close(): Promise<void> {
    await this.iter.return?.(undefined);
  }

  /**
   * 精确读取 n 字节
   *
   * @param n - 字节数
   * @returns n 字节；流尽返回 null（半截数据抛错——包损坏 fail loud）
   */
  async read(n: number): Promise<Buffer | null> {
    while (this.buf.length < n) {
      if (this.done) break;
      const next = await this.iter.next();
      if (next.done) {
        this.done = true;
        break;
      }
      this.buf = this.buf.length === 0 ? next.value : Buffer.concat([this.buf, next.value]);
    }
    if (this.buf.length === 0) return null;
    if (this.buf.length < n) {
      throw new Error('bundle: truncated archive (unexpected EOF)');
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
}

/** USTAR 头解析结果 */
interface TarEntryHeader {
  name: string;
  prefix: string;
  size: number;
  typeflag: string;
}

/**
 * 解析 512 字节 USTAR 头（校验和验损坏）
 *
 * @param block - 512 字节
 * @returns 条目头；全零块返回 null（结束）
 */
function parseHeader(block: Buffer): TarEntryHeader | null {
  if (block.every((b) => b === 0)) return null;
  // 校验和复核：头字节逐字节和（chksum 字段按空格计）
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  }
  const stored = parseInt(block.subarray(148, 154).toString('ascii'), 8);
  if (!Number.isFinite(stored) || stored !== sum) {
    throw new Error('bundle: header checksum mismatch (corrupted archive)');
  }
  const str = (from: number, to: number): string =>
    block.subarray(from, to).toString('utf-8').replace(/\0.*$/, '');
  const num = (from: number, to: number): number => {
    const raw = block.subarray(from, to).toString('ascii').replace(/\0.*$/, '').trim();
    return raw === '' ? 0 : parseInt(raw, 8);
  };
  return {
    name: str(0, 100),
    prefix: str(345, 500),
    size: num(124, 136),
    typeflag: block.subarray(156, 157).toString('ascii'),
  };
}

/** 条目名安全归一：拒绝对路径与 `..` 逃逸（解包目标目录之外的写入一律拒绝） */
function safeEntryName(name: string): string {
  const norm = name.replace(/\\/g, '/').replace(/^\.\//, '');
  if (norm.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(norm)) {
    throw new Error(`bundle: unsafe entry path rejected: ${name}`);
  }
  return norm;
}

/**
 * 只读 manifest（解压流开头即可，manifest 置首）
 *
 * @param bundlePath - 封存包路径
 * @returns manifest
 * @throws 非本格式 / manifest 缺失或损坏
 */
export async function readBundleManifest(bundlePath: string): Promise<BundleManifest> {
  const src = new ByteSource(gunzipIterator(bundlePath));
  try {
    let longName: string | undefined;
    for (;;) {
      const head = await src.read(BLOCK);
      if (!head) throw new Error('bundle: manifest entry missing');
      const h = parseHeader(head);
      if (!h) throw new Error('bundle: manifest entry missing');
      const name = longName ?? (h.prefix ? `${h.prefix}/${h.name}` : h.name);
      longName = undefined;
      if (h.typeflag === 'L') {
        const body = await src.read(Math.ceil(h.size / BLOCK) * BLOCK);
        if (!body) throw new Error('bundle: truncated long-name entry');
        longName = body.subarray(0, h.size).toString('utf-8').replace(/\0.*$/, '');
        continue;
      }
      const body = await src.read(Math.ceil(h.size / BLOCK) * BLOCK);
      if (!body) throw new Error(`bundle: truncated entry "${name}"`);
      if (safeEntryName(name) === BUNDLE_MANIFEST_NAME) {
        return JSON.parse(body.subarray(0, h.size).toString('utf-8')) as BundleManifest;
      }
      // 非置首（外造包）：继续向后找，manifest 迟到也接受
    }
  } finally {
    await src.close();
  }
}

/** gunzip 读迭代器（文件流 → gunzip；早退销毁两端） */
function gunzipIterator(bundlePath: string): AsyncGenerator<Buffer> {
  return (async function* () {
    const gunzip = createGunzip();
    const file = createReadStream(bundlePath);
    file.on('error', (err) => gunzip.destroy(err));
    file.pipe(gunzip);
    try {
      for await (const chunk of gunzip) {
        yield chunk as Buffer;
      }
    } finally {
      file.destroy();
      gunzip.destroy();
    }
  })();
}

/**
 * 解包并逐文件校验 sha256（manifest 全覆盖：清单外条目=损坏，报错）
 *
 * @param bundlePath - 封存包路径
 * @param destDir - 解包目标目录（自动创建）
 * @returns manifest
 * @throws 校验失败 / 条目越界 / 清单不一致 —— 部分已解文件保留在 destDir（fail loud，调用方可整目录重来）
 */
export async function unpackBundle(bundlePath: string, destDir: string): Promise<BundleManifest> {
  const src = new ByteSource(gunzipIterator(bundlePath));
  let manifest: BundleManifest | null = null;
  let longName: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const head = await src.read(BLOCK);
    if (!head) break;
    const h = parseHeader(head);
    if (!h) break; // 结束标记
    const name = longName ?? (h.prefix ? `${h.prefix}/${h.name}` : h.name);
    longName = undefined;
    if (h.typeflag === 'L') {
      const body = await src.read(Math.ceil(h.size / BLOCK) * BLOCK);
      if (!body) throw new Error('bundle: truncated long-name entry');
      longName = body.subarray(0, h.size).toString('utf-8').replace(/\0.*$/, '');
      continue;
    }
    const padded = Math.ceil(h.size / BLOCK) * BLOCK;
    const rel = safeEntryName(name);
    if (rel === BUNDLE_MANIFEST_NAME) {
      const body = await src.read(padded);
      if (!body) throw new Error('bundle: truncated manifest');
      manifest = JSON.parse(body.subarray(0, h.size).toString('utf-8')) as BundleManifest;
      continue;
    }
    if (!manifest) throw new Error('bundle: manifest must be the first entry');
    const expected = manifest.files.find((f) => f.path === rel);
    if (!expected) throw new Error(`bundle: entry not in manifest: ${rel}`);
    const abs = join(destDir, ...rel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    const hash = createHash('sha256');
    let written = 0;
    let remaining = h.size;
    {
      const ws = createWriteStream(abs);
      try {
        while (remaining > 0) {
          const chunk = await src.read(Math.min(remaining, 1024 * 256));
          if (!chunk) throw new Error(`bundle: truncated entry "${rel}"`);
          hash.update(chunk);
          written += chunk.length;
          remaining -= chunk.length;
          if (!ws.write(chunk)) {
            await new Promise((resolve) => ws.once('drain', resolve));
          }
        }
        // 丢弃对齐填充
        if (h.size % BLOCK !== 0) await src.read(BLOCK - (h.size % BLOCK));
        await new Promise<void>((resolve, reject) => {
          ws.end((err?: Error | null) => (err ? reject(err) : resolve()));
        });
      } catch (err) {
        ws.destroy();
        throw err;
      }
    }
    if (written !== expected.bytes) {
      throw new Error(`bundle: size mismatch for "${rel}" (${written} != ${expected.bytes})`);
    }
    const digest = hash.digest('hex');
    if (digest !== expected.sha256) {
      throw new Error(`bundle: sha256 mismatch for "${rel}"`);
    }
    seen.add(rel);
  }
  if (!manifest) throw new Error('bundle: manifest missing');
  for (const f of manifest.files) {
    if (!seen.has(f.path)) throw new Error(`bundle: missing entry "${f.path}"`);
  }
  return manifest;
}

/**
 * 删除封存包（.tmp 残片一并清）
 *
 * @param bundlePath - 封存包路径
 */
export async function removeBundle(bundlePath: string): Promise<void> {
  await rm(bundlePath, { force: true });
  await rm(`${bundlePath}.tmp`, { force: true });
}
