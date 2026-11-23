/**
 * 会话封存包（bundle）—— USTAR+gzip 往返、校验与损坏检测
 *
 * - pack/unpack 往返：文本/二进制/空文件/长文件名（GNU LongLink）/多级目录
 * - manifest 置首 + readBundleManifest 只读开头
 * - sha256 篡改检测、缺条目检测、路径逃逸拒绝
 * - 外部 tar 交叉可读性（`tar tzf`，平台有 tar 时才跑）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  packBundle,
  unpackBundle,
  readBundleManifest,
  removeBundle,
  BUNDLE_MANIFEST_NAME,
  type BundleManifestInput,
} from '@octopi-agent/engine/integration/storage/archives/bundle.js';

const execFileAsync = promisify(execFile);

let root: string;
let staging: string;
let out: string;

function manifestInput(overrides: Partial<BundleManifestInput> = {}): BundleManifestInput {
  return {
    sessionId: 's1',
    agentId: 'a1',
    title: '测试会话',
    sealedAt: 1700000000000,
    sealedBy: 'trash',
    state: 'trashed',
    purgeAt: 1702592000000,
    groupSealId: 's1',
    schedules: [{ id: 'sch1', sessionId: 's1' }],
    knowledgeSources: [{ sourceId: 'src1', attachmentFile: 'attachments/a.bin' }],
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'octopi-bundle-'));
  staging = join(root, 'staging');
  out = join(root, 'out', 's1.tar.gz');
  await mkdir(join(staging, 'attachments', 'sub'), { recursive: true });
  await writeFile(join(staging, 's1.jsonl'), '{"m":1}\n{"m":2}\n');
  await writeFile(join(staging, 's1.state.json'), '{"tasks":[]}');
  await writeFile(join(staging, 'attachments', 'a.bin'), Buffer.from([0, 1, 2, 255, 254]));
  await writeFile(join(staging, 'attachments', 'sub', 'empty.txt'), '');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('packBundle / unpackBundle 往返', () => {
  it('完整往返：内容、清单、统计一致', async () => {
    const manifest = await packBundle({ stagingDir: staging, outPath: out, manifest: manifestInput() });
    expect(manifest.files.map((f) => f.path).sort()).toEqual([
      'attachments/a.bin',
      'attachments/sub/empty.txt',
      's1.jsonl',
      's1.state.json',
    ]);
    expect(manifest.stats.bytes).toBeGreaterThan(0);
    expect(manifest.format).toBe(1);

    const dest = join(root, 'restore');
    const got = await unpackBundle(out, dest);
    expect(got.sessionId).toBe('s1');
    expect(await readFile(join(dest, 's1.jsonl'), 'utf-8')).toBe('{"m":1}\n{"m":2}\n');
    expect(await readFile(join(dest, 'attachments', 'a.bin'))).toEqual(
      Buffer.from([0, 1, 2, 255, 254]),
    );
    expect(await readFile(join(dest, 'attachments', 'sub', 'empty.txt'), 'utf-8')).toBe('');
  });

  it('manifest 置首：readBundleManifest 无需解完全包', async () => {
    await packBundle({ stagingDir: staging, outPath: out, manifest: manifestInput() });
    const m = await readBundleManifest(out);
    expect(m.sessionId).toBe('s1');
    expect(m.schedules).toEqual([{ id: 'sch1', sessionId: 's1' }]);
    expect(m.knowledgeSources).toEqual([{ sourceId: 'src1', attachmentFile: 'attachments/a.bin' }]);
    expect(m.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
  });

  it('长文件名走 GNU LongLink，仍可往返', async () => {
    const longName = 'attachments/' + '长'.repeat(80) + '-report.pdf';
    await writeFile(join(staging, longName), 'long-name-content');
    const manifest = await packBundle({ stagingDir: staging, outPath: out, manifest: manifestInput() });
    expect(manifest.files.some((f) => f.path === longName)).toBe(true);
    const dest = join(root, 'restore');
    await unpackBundle(out, dest);
    expect(await readFile(join(dest, longName), 'utf-8')).toBe('long-name-content');
  });

  it('removeBundle 清包与 .tmp 残片', async () => {
    await packBundle({ stagingDir: staging, outPath: out, manifest: manifestInput() });
    await writeFile(`${out}.tmp`, 'residue');
    await removeBundle(out);
    await expect(readFile(out)).rejects.toThrow();
    await expect(readFile(`${out}.tmp`)).rejects.toThrow();
  });

  it('staging 与保留条目名冲突时拒绝（manifest.json 不可被用户文件冒名）', async () => {
    await writeFile(join(staging, BUNDLE_MANIFEST_NAME), '{}');
    await expect(
      packBundle({ stagingDir: staging, outPath: out, manifest: manifestInput() }),
    ).rejects.toThrow(/reserved/);
  });

  it('外部 tar 可列条目（USTAR 兼容）', async () => {
    await packBundle({ stagingDir: staging, outPath: out, manifest: manifestInput() });
    try {
      const { stdout } = await execFileAsync('tar', ['tzf', out]);
      const lines = stdout.trim().split('\n');
      expect(lines).toContain(BUNDLE_MANIFEST_NAME);
      expect(lines).toContain('s1.jsonl');
    } catch (err) {
      // 平台无 tar 命令则跳过（交叉验证是加分项，不是契约）
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  });
});

describe('损坏检测（fail loud）', () => {
  /** 手写极小 USTAR 包（仅测试夹具用）：entries=[manifest 优先] → gzip */
  async function handcraft(
    manifestJson: string,
    entries: Array<{ name: string; body: Buffer }>,
  ): Promise<string> {
    const { createGzip } = await import('node:zlib');
    const { createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    const { Readable } = await import('node:stream');
    const BLOCK = 512;
    const header = (name: string, size: number): Buffer => {
      const h = Buffer.alloc(BLOCK);
      h.write(name, 0, 100, 'utf-8');
      h.write('0000644\0', 100, 8, 'ascii');
      h.write('0000000\0', 108, 8, 'ascii');
      h.write('0000000\0', 116, 8, 'ascii');
      h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
      h.write('00000000000\0', 136, 12, 'ascii');
      h.write('        ', 148, 8, 'ascii');
      h.write('0', 156, 1, 'ascii');
      h.write('ustar\0', 257, 6, 'ascii');
      h.write('00', 263, 2, 'ascii');
      let sum = 0;
      for (const b of h) sum += b;
      h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      return h;
    };
    const pad = (n: number): Buffer => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);
    async function* stream(): AsyncGenerator<Buffer> {
      const manifestBytes = Buffer.from(manifestJson, 'utf-8');
      yield header('manifest.json', manifestBytes.length);
      yield manifestBytes;
      yield pad(manifestBytes.length);
      for (const e of entries) {
        yield header(e.name, e.body.length);
        yield e.body;
        yield pad(e.body.length);
      }
      yield Buffer.alloc(BLOCK * 2);
    }
    const p = join(root, `hand-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`);
    await pipeline(Readable.from(stream()), createGzip(), createWriteStream(p));
    return p;
  }

  it('正文篡改 → sha256 mismatch', async () => {
    await packBundle({ stagingDir: staging, outPath: out, manifest: manifestInput() });
    const raw = await readFile(out);
    // 翻转 gzip 流中部一字节（压到包体里必然破坏某个条目或流本身）
    raw[Math.floor(raw.length / 2)] ^= 0xff;
    await writeFile(out, raw);
    await expect(unpackBundle(out, join(root, 'x'))).rejects.toThrow();
  });

  it('manifest 声称的文件在包内缺失 → 报错', async () => {
    const manifest = await packBundle({ stagingDir: staging, outPath: out, manifest: manifestInput() });
    // 只保留一个真实条目，但 manifest 仍声称全部文件
    const one = manifest.files[0]!;
    const body = await readFile(join(staging, one.path));
    const path = await handcraft(JSON.stringify(manifest), [{ name: one.path, body }]);
    await expect(unpackBundle(path, join(root, 'x'))).rejects.toThrow(/missing entry/);
  });

  it('包内条目不在 manifest → 报错', async () => {
    const manifest = await packBundle({ stagingDir: staging, outPath: out, manifest: manifestInput() });
    const one = manifest.files[0]!;
    const body = await readFile(join(staging, one.path));
    const path = await handcraft(JSON.stringify(manifest), [
      { name: one.path, body },
      { name: 'evil.txt', body: Buffer.from('x') },
    ]);
    await expect(unpackBundle(path, join(root, 'x'))).rejects.toThrow(/not in manifest/);
  });

  it('条目 sha256 与 manifest 不符 → 报错', async () => {
    const manifest = await packBundle({ stagingDir: staging, outPath: out, manifest: manifestInput() });
    const one = manifest.files[0]!;
    const path = await handcraft(JSON.stringify(manifest), [
      { name: one.path, body: Buffer.from('ABCDE') }, // 等长异内容 → 精确落 sha256 分支
    ]);
    await expect(unpackBundle(path, join(root, 'x'))).rejects.toThrow(/sha256 mismatch/);
  });

  it('路径逃逸条目拒绝（../ 与绝对路径）', async () => {
    const manifest = await packBundle({ stagingDir: staging, outPath: out, manifest: manifestInput() });
    const body = Buffer.from('evil');
    for (const name of ['../escape.txt', '/abs.txt']) {
      const m = { ...manifest, files: [...manifest.files, { path: name, bytes: body.length, sha256: 'x' }] };
      const path = await handcraft(JSON.stringify(m), [{ name, body }]);
      await expect(unpackBundle(path, join(root, 'x'))).rejects.toThrow(/unsafe entry path/);
    }
  });

  it('包被截断 → truncated 报错', async () => {
    await packBundle({ stagingDir: staging, outPath: out, manifest: manifestInput() });
    const raw = await readFile(out);
    await writeFile(out, raw.subarray(0, Math.floor(raw.length * 0.6)));
    await expect(unpackBundle(out, join(root, 'x'))).rejects.toThrow();
  });

  it('空 staging 可打（无附件的边角会话）', async () => {
    const empty = join(root, 'empty-staging');
    await mkdir(empty, { recursive: true });
    const m = await packBundle({
      stagingDir: empty,
      outPath: join(root, 'empty.tar.gz'),
      manifest: manifestInput(),
    });
    expect(m.files).toEqual([]);
    expect(m.stats.bytes).toBe(0);
  });
});
