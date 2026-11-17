/**
 * Windows 上的**意图断言**：POSIX 权限位断言在这些平台只能跳过，但"写入方是否请求了
 * 0600"是可以验证的意图，且这才是跨平台真正共有的部分。
 *
 * 为什么需要这一层：本仓库没有 CI，Windows 是事实上的唯一执行环境；只写
 * `it.skipIf(!POSIX_FILE_MODE)` 会让这些安全属性在实际开发回路里零验证。
 *
 * 做法与 `tests/run-serve-boot-mode.test.ts` 同源：`vi.mock('node:fs')` 透传真实实现、
 * 只记录调用实参——有人删掉 `mode: 0o600`，Windows 上也会红。
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const { writeEnvLine } = await import('../packages/engine/src/config-admin/onboarding-apply.js');
const { POSIX_FILE_MODE } = await import('../packages/engine/src/file-mode.js');

describe('秘密文件的权限意图（平台无关）', () => {
  it('writeEnvLine 请求 0600 写入 .env', () => {
    const home = mkdtempSync(join(tmpdir(), 'octopi-mode-intent-'));
    try {
      const before = captured.writes.length;
      writeEnvLine(home, 'SECRET_KEY=v');
      const write = captured.writes[before];
      if (!write) throw new Error('writeFileSync 未被调用（未走真实连线）');
      expect(write.options?.mode).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // 这条用例的存在本身就是记录：无 POSIX 位语义的平台里，上面的意图断言是该属性的
  // 唯一覆盖（真实权限位断言在那些平台上只能 skip）。
  it.runIf(!POSIX_FILE_MODE)('该平台无 POSIX 权限位，故上面的意图断言是唯一覆盖', () => {
    expect(POSIX_FILE_MODE).toBe(false);
  });
});
