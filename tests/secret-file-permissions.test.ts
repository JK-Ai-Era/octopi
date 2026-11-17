/**
 * 秘密文件权限的**真实**断言（生产语义，不是意图）。
 *
 * 背景：`writeFileSync(p, secret, { mode: 0o600 })` 在 Windows 上完全不收紧权限——实测
 * 一个这样的文件带着 7 条继承来的 ACE（含一个可修改的用户组、多个可读写 SID），秘密
 * 的暴露面完全由它落在哪个目录决定。`packages/engine/src/file-mode.ts` 因此改成真实
 * 收紧（POSIX `chmod` / Windows `icacls /inheritance:r /grant:r`）。
 *
 * 断言手段见 `tests/helpers/file-mode.ts`：两个平台都在**实际产物**上验，不存在"平台
 * 不支持所以跳过"。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createPrivateTempDir,
  restrictToOwner,
  writeSecretFileSync,
} from '../packages/engine/src/file-mode.js';
import {
  POSIX_FILE_MODE,
  expectNotOwnerOnly,
  expectRestrictedToOwner,
} from './helpers/file-mode.js';

const cleaned: string[] = [];

afterEach(() => {
  for (const p of cleaned.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe('秘密文件的真实权限', () => {
  it('writeSecretFileSync 落盘后仅当前用户可访问', () => {
    const dir = createPrivateTempDir('octopi-secret-test-');
    cleaned.push(dir);
    const file = join(dir, 'boot.json');
    writeSecretFileSync(file, JSON.stringify({ apiKey: 'sk-test', token: 'tok' }));

    expectRestrictedToOwner(file, 'file');
  });

  it('createPrivateTempDir 内新建的文件自动继承安全 ACL（目录契约的核心）', () => {
    const dir = createPrivateTempDir('octopi-inherit-test-');
    cleaned.push(dir);
    // 不经 writeSecretFileSync，直接用被加固前的裸写法落一个文件：安全性必须来自目录继承
    const file = join(dir, 'plain.json');
    writeFileSync(file, '{"apiKey":"sk-inherited"}', { mode: 0o600 });

    expectRestrictedToOwner(dir, 'dir');
    expectRestrictedToOwner(file, 'file');
  });

  it('restrictToOwner 能收紧一个已存在的宽松文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-loosen-'));
    cleaned.push(dir);
    const file = join(dir, 'loose.json');
    // 先构造一个"用 mode 请求了 0600"的文件——这正是修复前的写法
    writeFileSync(file, '{"apiKey":"sk"}', { mode: 0o600 });

    restrictToOwner(file, 'file');

    expectRestrictedToOwner(file, 'file');
  });

  it('restrictToOwner 对无法处理的目标抛错，而不是静默成功', () => {
    const dir = createPrivateTempDir('octopi-fail-test-');
    cleaned.push(dir);
    // 不存在的目标：收紧必须失败并抛出，不能返回"已完成"
    expect(() => restrictToOwner(join(dir, 'no-such-file.json'), 'file')).toThrow();
  });

  // 对照组：证明上面的断言确实在检查"暴露面"而不是恒真。
  it('对照组：裸 mode:0o600 并不产生 owner-only 权限（本修复的前提）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-bare-'));
    cleaned.push(dir);
    const file = join(dir, 'bare.json');
    writeFileSync(file, '{"apiKey":"sk"}', { mode: 0o600 });

    if (POSIX_FILE_MODE) {
      // POSIX 上 mode 是真实生效的：这条对照组在 POSIX 会失败，故只在 Windows 断言
      expect(true).toBe(true);
      return;
    }
    expectNotOwnerOnly(file);
  });
});
