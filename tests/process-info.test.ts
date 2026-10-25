/**
 * 引擎侧进程只读诊断（ops P1）测试
 *
 * 解析器与行走链是纯函数，用固定夹具测（跨平台可跑）；
 * 真实枚举用「自进程可见 或 如实降级」的双分支断言（agent 牢笼内 ps 必败是固有限制，
 * 不允许出现恒红用例）。「笼外宿主进程可见」由引擎侧读取保证，需真机验证。
 */

import { describe, test, expect } from 'vitest';
import {
  buildAncestorChain,
  firstExecutableFromLsof,
  getAncestorPidChain,
  listProcesses,
  parseCpuTimeToMs,
  parsePowerShellProcessTable,
  parseProcPidEntry,
  parsePsProcessTable,
  resolveProcessImage,
  selectProcesses,
  type ProcessInfoEntry,
} from '@octopi-agent/engine/harness/extension/execution-environment/process-info.js';
import { createProcessListTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/process-tools.js';

const entry = (over: Partial<ProcessInfoEntry>): ProcessInfoEntry => ({
  pid: 1,
  ppid: 0,
  command: 'init',
  rssBytes: null,
  cpuTimeMs: null,
  threads: null,
  ...over,
});

describe('parsePsProcessTable', () => {
  test('parses the thcount table with command spacing preserved', () => {
    const out = ['  123   456   1024  0:01.23  5 /bin/zsh -l', '  200     1  2048  1-02:03:04  12 /usr/libexec/thing --flag'].join('\n');
    const parsed = parsePsProcessTable(out, true);
    expect(parsed.skipped).toBe(0);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toEqual({
      pid: 123,
      ppid: 456,
      command: '/bin/zsh -l',
      rssBytes: 1024 * 1024,
      cpuTimeMs: 1230,
      threads: 5,
    });
    expect(parsed.entries[1]?.pid).toBe(200);
    expect(parsed.entries[1]?.cpuTimeMs).toBe(((1 * 24 + 2) * 3600 + 3 * 60 + 4) * 1000);
    expect(parsed.entries[1]?.threads).toBe(12);
  });

  test('parses the no-thcount table and keeps inner spacing of command', () => {
    const parsed = parsePsProcessTable('  7  8  9  1:02  /usr/bin/env  node   x', false);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toEqual({
      pid: 7,
      ppid: 8,
      command: '/usr/bin/env  node   x',
      rssBytes: 9 * 1024,
      cpuTimeMs: 62_000,
      threads: null,
    });
    expect(parsed.skipped).toBe(0);
  });

  test('counts unparseable lines instead of dropping them silently', () => {
    const out = ['junk line', '  1  0  2  0:00  init', 'also junk'].join('\n');
    const parsed = parsePsProcessTable(out, false);
    expect(parsed.entries).toHaveLength(1);
    // 丢行必须留账（warning 行与坏数据行不可分辨 → 一律申报不全）
    expect(parsed.skipped).toBe(2);
  });
});

describe('parseCpuTimeToMs', () => {
  test('mm:ss / hh:mm:ss / dd-hh:mm:ss with fraction', () => {
    expect(parseCpuTimeToMs('0:05')).toBe(5000);
    expect(parseCpuTimeToMs('1:02:03')).toBe(3_723_000);
    expect(parseCpuTimeToMs('2-03:04:05')).toBe(((2 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000);
    expect(parseCpuTimeToMs('0:01.5')).toBe(1500);
    expect(parseCpuTimeToMs('nonsense')).toBeNull();
  });
});

describe('parseProcPidEntry', () => {
  // comm 带空格和括号是 /proc/stat 的经典解析陷阱：必须取首 ( 与最后一个 ) 之间。
  // stat 的 ppid(=100) 与 status 的 PPid(=999) 刻意不同值：锁住 ppid 取自 stat。
  const stat = '1234 (my app (beta)) S 100 1234 1234 0 -1 4194304 100 0 0 0 150 250 0 0 20 0 3 0 12345 1000000 500';
  const status = ['Name:\tmy app (beta)', 'State:\tS (sleeping)', 'PPid:\t999', 'VmRSS:\t  2048 kB', 'Threads:\t3'].join('\n');

  test('assembles entry from stat/status/cmdline (ppid from stat field 4)', () => {
    const parsed = parseProcPidEntry(1234, stat, status, Buffer.from('/usr/bin/my app\0--flag\0'));
    expect(parsed).toEqual({
      pid: 1234,
      ppid: 100,
      command: '/usr/bin/my app --flag',
      rssBytes: 2048 * 1024,
      cpuTimeMs: (150 + 250) * 10,
      threads: 3,
    });
  });

  test('kernel thread: empty cmdline falls back to Name, missing VmRSS is null', () => {
    const parsed = parseProcPidEntry(2, '2 (kthreadd) S 0 0 0 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 10 0 0', 'Name:\tkthreadd\nThreads:\t1', Buffer.alloc(0));
    expect(parsed.command).toBe('kthreadd');
    expect(parsed.rssBytes).toBeNull();
    expect(parsed.threads).toBe(1);
  });
});

describe('parsePowerShellProcessTable', () => {
  test('parses tab-separated CIM rows and rejoins commands containing tabs', () => {
    const out = [
      '123\t456\t1024\t50000\t150000\t7\tC:\\Program Files\\app.exe --x',
      '9\t0\t0\t0\t0\t1\tmulti\tpart',
      'broken-row',
    ].join('\r\n');
    const parsed = parsePowerShellProcessTable(out);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.skipped).toBe(1);
    expect(parsed.entries[0]).toEqual({
      pid: 123,
      ppid: 456,
      command: 'C:\\Program Files\\app.exe --x',
      rssBytes: 1024,
      cpuTimeMs: 20,
      threads: 7,
    });
    expect(parsed.entries[1]?.command).toBe('multi\tpart');
  });
});

describe('firstExecutableFromLsof', () => {
  test('takes the image, not dyld', () => {
    const output = ['p79654', 'ftxt', 'n/bin/bash', 'ftxt', 'n/usr/lib/dyld'].join('\n');
    expect(firstExecutableFromLsof(output)).toBe('/bin/bash');
  });

  test('returns null when nothing matched', () => {
    expect(firstExecutableFromLsof('')).toBeNull();
    expect(firstExecutableFromLsof('p123\n')).toBeNull();
    expect(firstExecutableFromLsof('p123\nftxt\nn\n')).toBeNull();
  });
});

describe('buildAncestorChain', () => {
  test('walks to the topmost ancestor, root-first, pid last', () => {
    const map = new Map<number, number | null>([[1, 0], [100, 1], [1234, 100]]);
    expect(buildAncestorChain(map, 1234)).toEqual({ chain: [1, 100, 1234], complete: true });
  });

  test('missing link marks the chain incomplete but keeps known ancestors', () => {
    const map = new Map<number, number | null>([[1234, 100]]);
    expect(buildAncestorChain(map, 1234)).toEqual({ chain: [100, 1234], complete: false });
  });

  test('ppid cycle stops and is reported incomplete', () => {
    const map = new Map<number, number | null>([[1, 2], [2, 1]]);
    const built = buildAncestorChain(map, 2);
    expect(built.complete).toBe(false);
    expect(built.chain.at(-1)).toBe(2);
    expect(new Set(built.chain).size).toBe(built.chain.length);
  });

  test('unknown pid yields just itself, incomplete', () => {
    expect(buildAncestorChain(new Map(), 42)).toEqual({ chain: [42], complete: false });
  });
});

describe('selectProcesses', () => {
  const fixtures: ProcessInfoEntry[] = [
    entry({ pid: 30, command: '/usr/bin/Node server.js', rssBytes: 300 }),
    entry({ pid: 10, command: '/bin/zsh', rssBytes: 100 }),
    entry({ pid: 20, command: '/usr/sbin/nginx: master', rssBytes: 200 }),
  ];

  test('pids filter is honored', () => {
    const sel = selectProcesses(fixtures, { pids: [10, 20] });
    expect(sel.selected.map((p) => p.pid)).toEqual([10, 20]);
    expect(sel.total).toBe(3);
    expect(sel.matched).toBe(2);
  });

  test('nameContains is case-insensitive on the command line', () => {
    const sel = selectProcesses(fixtures, { nameContains: 'NODE' });
    expect(sel.selected.map((p) => p.pid)).toEqual([30]);
    expect(sel.matched).toBe(1);
  });

  test('sort by rss desc then limit truncates honestly', () => {
    const sel = selectProcesses(fixtures, { sort: 'rss', limit: 2 });
    expect(sel.selected.map((p) => p.pid)).toEqual([30, 20]);
    expect(sel.truncated).toBe(true);
    expect(sel.matched).toBe(3);
  });

  test('default sort is pid ascending', () => {
    const sel = selectProcesses(fixtures);
    expect(sel.selected.map((p) => p.pid)).toEqual([10, 20, 30]);
    expect(sel.truncated).toBe(false);
  });
});

describe('live enumeration (jail-resilient)', () => {
  test('self is visible, or the listing degrades honestly (never empty-success)', async () => {
    const listed = await listProcesses();
    const self = listed.processes.find((p) => p.pid === process.pid);
    if (self) {
      expect(listed.complete).toBe(true);
      if (typeof process.ppid === 'number' && process.ppid > 0) {
        expect(self.ppid).toBe(process.ppid);
      }
    } else {
      // agent 牢笼内 darwin ps 被拒（setuid exec 是 OS 不变量）：必须降级 + 留痕
      expect(listed.complete).toBe(false);
      expect(listed.notes.length).toBeGreaterThan(0);
    }
  });

  test('ancestor chain ends at self; complete chains walk past the seed', async () => {
    const built = await getAncestorPidChain(process.pid);
    expect(built.chain.at(-1)).toBe(process.pid);
    if (typeof process.ppid === 'number' && process.ppid > 0) {
      expect(built.chain).toContain(process.ppid);
    }
    if (built.complete) {
      // 链完整 = 真实行走链工作（self+ppid 种子之上还有祖先，正常进程必到 init）
      expect(built.chain.length).toBeGreaterThan(2);
    } else {
      // 断链/降级必须有出处说明（唯一例外：pid 复用环，实测几乎不可见）
      expect(built.notes.length).toBeGreaterThan(0);
    }
  });

  test('resolveProcessImage resolves the caller pid on non-win32', async () => {
    if (process.platform === 'win32') return;
    const image = await resolveProcessImage(process.pid);
    expect(image).toBeTruthy();
  });
});

describe('process_list tool contract', () => {
  const tool = createProcessListTool();

  test('rejects invalid params loudly', async () => {
    await expect(tool.handler({ pid: -1 }, undefined as never)).rejects.toThrow(/pid/);
    await expect(tool.handler({ pid: 1, limit: 5 }, undefined as never)).rejects.toThrow(/cannot be combined/);
    await expect(tool.handler({ pids: [1, -2] }, undefined as never)).rejects.toThrow(/pids/);
    await expect(tool.handler({ nameContains: 123 }, undefined as never)).rejects.toThrow(/nameContains/);
    await expect(tool.handler({ sort: 'cpu' }, undefined as never)).rejects.toThrow(/sort/);
    await expect(tool.handler({ limit: 0 }, undefined as never)).rejects.toThrow(/limit/);
    await expect(tool.handler({ pid: true }, undefined as never)).rejects.toThrow(/pid/);
  });

  test('pid mode returns entry + ancestor chain shape', async () => {
    const result = (await tool.handler({ pid: process.pid }, undefined as never)) as Record<string, unknown>;
    expect(result.source).toBeTruthy();
    expect(typeof result.chainComplete).toBe('boolean');
    expect(Array.isArray(result.ancestors)).toBe(true);
    const ancestors = result.ancestors as Array<{ pid: number }>;
    expect(ancestors.at(-1)?.pid).toBe(process.pid);
    if (result.process) {
      expect((result.process as { pid: number }).pid).toBe(process.pid);
    } else {
      // 来源降级时 process 允许为 null，但 notes 必须解释
      expect((result.notes as string[]).length).toBeGreaterThan(0);
    }
  });

  test('list mode returns entries with matched/total/truncated accounting', async () => {
    const result = (await tool.handler({ limit: 5 }, undefined as never)) as Record<string, unknown>;
    expect(Array.isArray(result.processes)).toBe(true);
    expect((result.processes as unknown[]).length).toBeLessThanOrEqual(5);
    expect(typeof result.total).toBe('number');
    expect(typeof result.matched).toBe('number');
    expect(typeof result.truncated).toBe('boolean');
  });

  test('pids filter flows through the tool', async () => {
    const result = (await tool.handler({ pids: [process.pid] }, undefined as never)) as Record<string, unknown>;
    const processes = result.processes as Array<{ pid: number }>;
    expect(processes.every((p) => p.pid === process.pid)).toBe(true);
  });

  test('tool is tagged host-read (stripped on the reduced surface)', () => {
    expect(tool.definition.capabilities).toEqual(['host-read']);
  });
});
