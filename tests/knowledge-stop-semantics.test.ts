/**
 * `KnowledgeServiceProcessHandle.stop()` 的完成语义：**等到子进程真的退出**才 resolve。
 *
 * 为什么值得一条测试：通道断连（= 宿主硬死）后子进程按设计继续服务并持有 SQLite 写者锁。
 * 旧实现走 disconnected 分支时 `kill('SIGTERM')` 后立刻 resolve，调用方以为「已停止」就去
 * 清临时目录——Windows 上删除仍被打开的文件直接 EPERM（症状就是
 * tests/knowledge-lock-forensics.test.ts 的 afterAll 报错；Linux 因为可以 unlink 打开中的
 * 文件而掩盖了它）。
 *
 * 断言方式是最直接的那个：stop() 返回后，子进程必须已经 exit（exitCode/signalCode 非空）。
 * 若有人把实现改回「发信号就返回」，本测试立刻红。
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startKnowledgeServiceProcess } from '../packages/engine/src/harness/knowledge/start-service-process.js';

describe('knowledge child stop() 完成语义', () => {
  it('通道断连后 stop() 仍等到子进程退出（不是发个信号就返回）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'octopi-stop-semantics-'));
    const handle = await startKnowledgeServiceProcess({
      dbPath: join(home, 'knowledge.db'),
      tokens: [],
      port: 0,
      startTimeoutMs: 20_000,
    });
    try {
      // 等价于宿主硬死：OS 断 IPC
      handle.child.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(handle.child.exitCode).toBeNull(); // 断连不自杀（by design）

      await handle.stop();

      // 核心断言：stop 返回那一刻进程已经没了
      expect(handle.child.exitCode !== null || handle.child.signalCode !== null).toBe(true);
    } finally {
      // stop 已收尸，目录必须可删（Windows 上若还有句柄会 EPERM）。
      // 清理失败不能掩盖上面的断言结果：本块只报告清理自身的失败。
      try {
        rmSync(home, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[knowledge-stop-semantics] temp cleanup failed: ${String(err)}`);
      }
    }
  }, 40_000);
});
