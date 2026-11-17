/**
 * boot 文件的 0600 意图断言（平台无关）。
 *
 * 背景：`tests/run-remote-backend.test.ts` 里那条 `statSync(...).mode & 0o777 === 0o600`
 * 在 Windows 上必然失败——NTFS 走 ACL，Node 的 `writeFileSync(mode)` 不映射 POSIX 位，
 * stat 一律报 0666 形态。那条断言因此改为仅 POSIX 运行。
 *
 * 但「boot 文件含 provider apiKey + loopback token，必须同机他用户不可读」是安全属性，
 * 不能在开发者主平台上零验证。这里锁**意图**：`writeRunServeBoot` 必须真的把
 * `mode: 0o600` 交给 `writeFileSync`。有人删掉 mode 时，Windows 上也会红。
 *
 * 这条不替代真实权限校验：POSIX 上仍由 run-remote-backend.test.ts 的 stat 断言覆盖；
 * Windows 上的真实保护面是用户目录 ACL，本测不覆盖（见 CHANGELOG 已知限制）。
 */

import { describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const captured = vi.hoisted(() => ({
  writes: [] as Array<{ path: string; options: Record<string, unknown> | undefined }>,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (path: string, data: string, options?: Record<string, unknown>) => {
      captured.writes.push({ path: String(path), options });
      return actual.writeFileSync(path, data, options as never);
    },
  };
});

const { writeRunServeBoot } = await import(
  '@octopi-agent/gateway/gateway/remote-run-backend.js'
);

describe('writeRunServeBoot 的 0600 意图', () => {
  it('把 mode: 0o600 交给 writeFileSync（平台无关）', () => {
    const before = captured.writes.length;
    const p = join(tmpdir(), `boot-mode-intent-${randomUUID()}.json`);
    try {
      writeRunServeBoot(p, '{"secret":true}');
      const write = captured.writes[before];
      if (!write) throw new Error('writeFileSync 未被调用（未走真实连线）');
      expect(write.path).toBe(p);
      expect(write.options?.mode).toBe(0o600);
      expect(write.options?.encoding).toBe('utf8');
    } finally {
      // rmSync 来自 mock 的 ...actual 展开，是真实实现
      rmSync(p, { force: true });
    }
  });
});
