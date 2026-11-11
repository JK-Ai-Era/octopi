/**
 * OP-KNOW-LOCK 撞锁取证（service-topology-p1.md §10，V6）：
 * knowledge-serve-child 按设计独立于 gateway 生命周期（IPC 断连继续服务，单独部署计划）。
 * 取证问题：gateway 硬死（IPC 断）后 child 存活占写者锁，重启后 manageLocal 再拉起
 * 是否撞锁循环？
 *
 * 演练语义（不真杀 gateway）：`child.disconnect()` = 硬死时 OS 断 IPC 的等价事件。
 * 本测试钉**实测行为**；取证结论写入 OP-KNOW-LOCK 后再定接管设计（勿凭空实现）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startKnowledgeServiceProcess } from '../packages/engine/src/harness/knowledge/start-service-process.js';
import type { KnowledgeServiceProcessHandle } from '../packages/engine/src/harness/knowledge/start-service-process.js';

let home: string;
const handles: KnowledgeServiceProcessHandle[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'octopi-lock-forensics-'));
});

afterAll(async () => {
  for (const h of handles) {
    await h.stop().catch(() => undefined);
  }
  rmSync(home, { recursive: true, force: true });
});

describe('V6 OP-KNOW-LOCK 撞锁取证（模拟 gateway 硬死）', () => {
  it('IPC 断连后 child 按设计继续服务（单独部署语义）', async () => {
    const h1 = await startKnowledgeServiceProcess({
      dbPath: join(home, 'knowledge.db'),
      tokens: [],
      port: 0,
      startTimeoutMs: 15_000,
    });
    handles.push(h1);
    expect(h1.port).toBeGreaterThan(0);

    const lockPath = join(home, 'knowledge.db.writer.lock');
    expect(existsSync(lockPath)).toBe(true); // 写者锁已生成

    // 模拟 gateway 硬死：OS 关闭 IPC 通道
    h1.child.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 300));
    // 取证点 A：child 是否仍活（by design「断连时 HTTP 仍服务」）
    expect(h1.child.exitCode).toBeNull();
  }, 30_000);

  it('取证点 B：占锁存活下再拉起同库实例的行为（撞锁 or 接管）', async () => {
    const lockPath = join(home, 'knowledge.db.writer.lock');
    const holder = JSON.parse(readFileSync(lockPath, 'utf8')) as { holderPid: number };

    // 第二进程拉起（= gateway 重启后 manageLocal 再 fork）
    // MIN-12 修复：钉实测行为（撞锁拒绝）——行为若变（接管落地）测试即红，届时更新锚
    await expect(
      startKnowledgeServiceProcess({
        dbPath: join(home, 'knowledge.db'),
        tokens: [],
        port: 0,
        startTimeoutMs: 15_000,
      }),
    ).rejects.toThrow(/already locked/i);
    console.log(`[V6 forensics] holderPid=${String(holder.holderPid)} — collision pinned`);
  }, 30_000);
});
