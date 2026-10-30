/**
 * ops P2 运维审计测试：hash 链账本 / 统一动作记录契约 / 越权写入入账 / 安全配置漂移。
 * 规格：arch/ops-privileged-mode.md §5 P2 / §7。
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OpsAuditJournal,
  OpsAuditedFileEffects,
  canonicalJson,
  computeOpsAuditEntryHash,
  verifyOpsAuditChain,
  readOpsAuditEntries,
  type OpsAuditEvent,
} from '@octopi-agent/engine/harness/extension/execution-environment/ops-audit.js';
import {
  computeSecurityConfigFingerprint,
  createFileSecurityIntegrity,
  createSecurityIntegrityGuard,
  diffSecurityConfigFingerprint,
  extractSecurityConfigSlice,
  EFFECT_POLICY_HOT_BLOCKED_KEYS,
} from '@octopi-agent/engine/harness/agent/config-integrity.js';
import { computeConfigHash } from '@octopi-agent/engine/config-admin/patch.js';
import type { ToolFileEffects } from '@octopi-agent/core/types/tools.js';

const tmp = mkdtempSync(join(tmpdir(), 'ops-audit-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('hash 链账本', () => {
  it('追加即接链：seq 递增、prevHash 衔接、verify 全绿', () => {
    const journal = new OpsAuditJournal({ path: join(tmp, 'chain.jsonl') });
    journal.append('ops.jail.state', { intent: 'none', authorized: true });
    journal.append('ops.command.executed', { argv: ['echo'], exitCode: 0 });
    const entries = readOpsAuditEntries(journal.filePath);
    expect(entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(entries[0]?.prevHash).toBe('0'.repeat(64));
    expect(entries[1]?.prevHash).toBe(entries[0]?.hash);
    expect(journal.verify().ok).toBe(true);
  });

  it('续链：新实例从尾条接 seq（bootstrapTail 成功分支）', () => {
    const path = join(tmp, 'resume.jsonl');
    new OpsAuditJournal({ path }).append('ops.jail.state', { v: 1 });
    new OpsAuditJournal({ path }).append('ops.jail.state', { v: 2 });
    const entries = readOpsAuditEntries(path);
    expect(entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(entries[1]?.prevHash).toBe(entries[0]?.hash);
    expect(verifyOpsAuditChain(entries).ok).toBe(true);
  });

  it('canonicalJson 与键序无关；载荷先归一（Date 不引发假告警）', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    const base = { seq: 1, ts: 1, event: 'ops.jail.state' as OpsAuditEvent, prevHash: 'x' };
    const h1 = computeOpsAuditEntryHash({ ...base, data: { a: 1, b: 2 } });
    const h2 = computeOpsAuditEntryHash({ ...base, data: { b: 2, a: 1 } });
    expect(h1).toBe(h2);

    const path = join(tmp, 'dates.jsonl');
    const journal = new OpsAuditJournal({ path });
    journal.append('ops.command.executed', { at: new Date('2026-01-01T00:00:00Z'), n: 1 });
    // 落盘是 ISO 串、hash 口径必须一致（评审实证的假告警路径）
    expect(journal.verify().ok).toBe(true);
  });

  it('中段篡改/删行/附加字段被 verify 抓住', () => {
    const path = join(tmp, 'tamper.jsonl');
    const journal = new OpsAuditJournal({ path });
    journal.append('ops.jail.state', { v: 1 });
    journal.append('ops.jail.state', { v: 2 });
    journal.append('ops.jail.state', { v: 3 });
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);

    const doctored = [...lines];
    const mid = JSON.parse(doctored[1]!) as Record<string, unknown>;
    (mid.data as { v: number }).v = 999;
    doctored[1] = JSON.stringify(mid);
    writeFileSync(path, doctored.join('\n') + '\n');
    expect(verifyOpsAuditChain(readOpsAuditEntries(path))).toMatchObject({
      ok: false,
      brokenAtSeq: 2,
      reason: 'hash_mismatch',
    });

    writeFileSync(path, [lines[0], lines[2]].join('\n') + '\n');
    expect(verifyOpsAuditChain(readOpsAuditEntries(path))).toMatchObject({
      ok: false,
      brokenAtSeq: 3,
      reason: 'seq_gap',
    });

    // 附加字段不受 hash 保护——有即判裂（防「加字段伪造」）
    const injected = JSON.parse(lines[0]!) as Record<string, unknown>;
    injected.approvedBy = 'host';
    writeFileSync(path, JSON.stringify(injected) + '\n');
    expect(verifyOpsAuditChain(readOpsAuditEntries(path))).toMatchObject({
      ok: false,
      brokenAtSeq: 1,
      reason: 'extra_fields',
    });

    // 尾部截断：链自洽但变短——本地无法自证，需 P5 外部见证（已知上限）
    writeFileSync(path, lines[0]! + '\n');
    expect(verifyOpsAuditChain(readOpsAuditEntries(path)).ok).toBe(true);
  });

  it('尾条被改写后拒绝续链（ops_audit_corrupt，不静默重链）', () => {
    const path = join(tmp, 'corrupt.jsonl');
    const journal = new OpsAuditJournal({ path });
    journal.append('ops.jail.state', { v: 1 });
    const line = readFileSync(path, 'utf8').trim();
    const bad = JSON.parse(line) as Record<string, unknown>;
    (bad.data as { v: number }).v = 42;
    writeFileSync(path, JSON.stringify(bad) + '\n');
    const fresh = new OpsAuditJournal({ path });
    expect(() => fresh.append('ops.jail.state', { v: 2 })).toThrow(/ops_audit_corrupt/);
  });

  it('半行（崩溃残留）：读抛 ops_audit_corrupt、verify 返回 broken 不抛、拒绝续链', () => {
    const path = join(tmp, 'halfline.jsonl');
    const journal = new OpsAuditJournal({ path });
    journal.append('ops.jail.state', { v: 1 });
    appendFileSync(path, '{"seq":2,"ts":1,"ev'); // 崩溃残留半行
    expect(() => readOpsAuditEntries(path)).toThrow(/ops_audit_corrupt/);
    const fresh = new OpsAuditJournal({ path });
    expect(fresh.verify()).toMatchObject({ ok: false, reason: expect.stringContaining('ops_audit_corrupt') });
    expect(() => fresh.append('ops.jail.state', { v: 2 })).toThrow(/ops_audit_corrupt/);
  });

  it('读失败≠空账：不可读文件拒绝续链（不把账本写坏）', () => {
    const path = join(tmp, 'unreadable.jsonl');
    const journal = new OpsAuditJournal({ path });
    journal.append('ops.jail.state', { v: 1 });
    chmodSync(path, 0o000);
    try {
      const fresh = new OpsAuditJournal({ path });
      // root 用户可读一切——仅在真读不到时断言（普通 uid 下才触发 EACCES）
      let thrown: Error | undefined;
      try {
        fresh.append('ops.jail.state', { v: 2 });
      } catch (err) {
        thrown = err as Error;
      }
      if (thrown) {
        expect(thrown.message).toMatch(/ops_audit_(unreadable|corrupt)/);
      }
    } finally {
      chmodSync(path, 0o600);
    }
    // 关键断言：读失败后没有从 GENESIS 续链把文件写坏（仍是 1 条）
    expect(readOpsAuditEntries(path).length).toBe(1);
  });

  it('账本目录不存在时自动建', () => {
    const journal = new OpsAuditJournal({ path: join(tmp, 'nested', 'deep', 'ops.jsonl') });
    journal.append('ops.policy.degraded', { degradation: ['no_process_jail'] });
    expect(readOpsAuditEntries(journal.filePath)).toHaveLength(1);
  });
});

/** 内存版 ToolFileEffects（被装饰的存储缝；业务写不落盘） */
function fakeEffects(written: string[]): ToolFileEffects {
  return {
    writeFile: async (path) => void written.push(`write:${path}`),
    appendFile: async (path) => void written.push(`append:${path}`),
    recordDelete: async (path) => void written.push(`delete:${path}`),
    recordCreate: async (path) => void written.push(`create:${path}`),
    recordRename: async (_from, to) => void written.push(`rename:${to}`),
    recordOverwrite: async (path) => void written.push(`overwrite:${path}`),
    noteNotReversed: async () => void written.push('notReversed'),
  };
}

describe('OpsAuditedFileEffects：roots 外写入入账', () => {
  it('root 内写入不入账；root 外逐条入账（rename 双端、前缀边界 /ws vs /ws-x）', async () => {
    const written: string[] = [];
    const records: Array<{ event: string; data: Record<string, unknown> }> = [];
    const wrapped = new OpsAuditedFileEffects(fakeEffects(written), {
      roots: ['/ws', '/ws-2'],
      record: (event, data) => records.push({ event, data }),
    });

    await wrapped.writeFile('/ws/a.txt', 'x');
    await wrapped.writeFile('/etc/hosts', 'y');
    await wrapped.recordCreate('/ws-2/new');
    await wrapped.recordRename('/etc/old', '/etc/new');
    await wrapped.recordDelete('/var/lib/k', 'z');
    await wrapped.writeFile('/ws-x/outside', 'q');

    // 业务写照常落 inner（undo 语义不被装饰器破坏）
    expect(written).toEqual([
      'write:/ws/a.txt',
      'write:/etc/hosts',
      'create:/ws-2/new',
      'rename:/etc/new',
      'delete:/var/lib/k',
      'write:/ws-x/outside',
    ]);
    expect(records.every((r) => r.event === 'ops.system_path.write')).toBe(true);
    // root 内写入零记录；root 外 4 笔（rename 双端合一账）
    expect(records.map((r) => r.data.path)).toEqual(['/etc/hosts', '/etc/new', '/var/lib/k', '/ws-x/outside']);
    // rename 双端：from 端消失也要申报
    expect(records[1]?.data.fromPath).toBe('/etc/old');
    expect(records[1]?.data.outsideRoots).toEqual(['/etc/new', '/etc/old']);
  });
});

describe('安全配置指纹与漂移（§8.4）', () => {
  const baseSlice = {
    effectPolicy: { mode: 'host', jail: 'none', privilegedAck: 'ok', opsAudit: 'on' },
    security: { enforce: 'block' as const },
  };

  it('指纹与键序无关；安全字段变化 → changed 精确到字段名', () => {
    const a = computeSecurityConfigFingerprint(baseSlice);
    const b = computeSecurityConfigFingerprint({
      effectPolicy: { opsAudit: 'on', privilegedAck: 'ok', jail: 'none', mode: 'host' },
      security: { enforce: 'block' },
    });
    expect(a.fingerprint).toBe(b.fingerprint);

    const drifted = computeSecurityConfigFingerprint({
      ...baseSlice,
      effectPolicy: { ...baseSlice.effectPolicy, jail: 'auto' },
    });
    expect(diffSecurityConfigFingerprint(a, drifted)).toMatchObject({
      ok: false,
      changed: ['effectPolicy.jail'],
      currentFingerprint: drifted.fingerprint,
    });
  });

  it('per-agent effectPolicy 覆盖也是安全面：改单 agent 的 jail → 漂移', () => {
    const fileA = JSON.stringify({
      effectPolicy: { mode: 'host' },
      agents: [{ id: 'a1', effectPolicy: { jail: 'require' } }],
    });
    const anchor = computeSecurityConfigFingerprint(extractSecurityConfigSlice(fileA));
    const fileB = JSON.stringify({
      effectPolicy: { mode: 'host' },
      agents: [{ id: 'a1', effectPolicy: { jail: 'none', privilegedAck: 'x' } }],
    });
    const drift = diffSecurityConfigFingerprint(
      anchor,
      computeSecurityConfigFingerprint(extractSecurityConfigSlice(fileB)),
    );
    expect(drift.ok).toBe(false);
    expect(drift.changed).toContain('agents');
  });

  it('文件复核器：改安全字段 → 拒；只改非安全字段 → ok；文件消失 → 拒', () => {
    const path = join(tmp, 'octopi.json');
    writeFileSync(
      path,
      JSON.stringify({ effectPolicy: { mode: 'host', jail: 'require' }, budgetPolicy: { maxIterations: 5 } }),
    );
    const anchor = computeSecurityConfigFingerprint(extractSecurityConfigSlice(readFileSync(path, 'utf8')));
    const recheck = createFileSecurityIntegrity({ configPath: path, anchor });
    expect(recheck().ok).toBe(true);

    // 非安全字段（budgetPolicy）改动不应触发
    writeFileSync(
      path,
      JSON.stringify({ effectPolicy: { mode: 'host', jail: 'require' }, budgetPolicy: { maxIterations: 9 } }),
    );
    expect(recheck().ok).toBe(true);

    writeFileSync(
      path,
      JSON.stringify({ effectPolicy: { mode: 'host', jail: 'none', privilegedAck: 'x' }, budgetPolicy: { maxIterations: 9 } }),
    );
    const drift = recheck();
    expect(drift.ok).toBe(false);
    expect(drift.changed).toContain('effectPolicy.jail');
    expect(drift.changed).toContain('effectPolicy.privilegedAck');
    expect(drift.currentFingerprint).not.toBe(anchor.fingerprint);

    unlinkSync(path);
    const unreadable = recheck();
    expect(unreadable.ok).toBe(false);
    expect(unreadable.changed[0]).toContain('config unreadable');
    expect(unreadable.currentFingerprint).toBe('<unreadable>');
  });
});

describe('可重锚定守卫（console 受控写署名确认，§8.4「WebUI 署名通道」）', () => {
  it('受控写后漂移 → reattest 重锚定 → recheck 恢复 ok；fingerprint 为活视图', () => {
    const path = join(tmp, 'guard-octopi.json');
    writeFileSync(path, JSON.stringify({ agents: [{ id: 'a1', effectPolicy: { mode: 'workspace' } }] }));
    const guard = createSecurityIntegrityGuard({ configPath: path });
    const bootFingerprint = guard.fingerprint;
    expect(guard.recheck().ok).toBe(true);

    // 模拟 console 受控写：新增 agent（agents 切面变化）
    writeFileSync(
      path,
      JSON.stringify({
        agents: [
          { id: 'a1', effectPolicy: { mode: 'workspace' } },
          { id: 'a2', effectPolicy: { mode: 'project' } },
        ],
      }),
    );
    const drift = guard.recheck();
    expect(drift.ok).toBe(false);
    expect(drift.changed).toContain('agents');

    const result = guard.reattest();
    expect(result.previousFingerprint).toBe(bootFingerprint);
    expect(result.changed).toContain('agents');
    expect(guard.fingerprint).toBe(result.fingerprint);
    expect(guard.fingerprint).not.toBe(bootFingerprint);
    expect(guard.recheck().ok).toBe(true);
  });

  it('连续 reattest：previousFingerprint 滚动为上次锚', () => {
    const path = join(tmp, 'guard-reattest-chain.json');
    writeFileSync(path, JSON.stringify({ agents: [{ id: 'a1' }] }));
    const guard = createSecurityIntegrityGuard({ configPath: path });
    writeFileSync(path, JSON.stringify({ agents: [{ id: 'a1' }, { id: 'a2' }] }));
    const first = guard.reattest();
    writeFileSync(path, JSON.stringify({ agents: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] }));
    const second = guard.reattest();
    expect(second.previousFingerprint).toBe(first.fingerprint);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it('reattest 时文件不可读：抛错且锚不换（fail-closed 保持）', () => {
    const path = join(tmp, 'guard-unreadable.json');
    writeFileSync(path, JSON.stringify({ agents: [{ id: 'a1' }] }));
    const guard = createSecurityIntegrityGuard({ configPath: path });
    const boot = guard.fingerprint;
    unlinkSync(path);
    expect(() => guard.reattest()).toThrow();
    expect(guard.fingerprint).toBe(boot);
  });

  it('M1-TOCTOU：expectHash 与盘上现状不符 → 拒绝重锚（锚不换，fail-closed）', () => {
    const path = join(tmp, 'guard-toctou.json');
    const v1 = JSON.stringify({ agents: [{ id: 'a1' }] });
    writeFileSync(path, v1);
    const guard = createSecurityIntegrityGuard({ configPath: path });
    const boot = guard.fingerprint;

    // console 写盘后、reattest 前有第三方写入（agents 段被改）
    writeFileSync(path, JSON.stringify({ agents: [{ id: 'a1', effectPolicy: { mode: 'host' } }] }));
    // 调用方手里仍是**它自己那次写**的 hash（v1）
    const myWriteHash = computeConfigHash(v1);
    expect(() => guard.reattest({ expectHash: myWriteHash, allowedChanged: ['agents'] })).toThrow(
      /changed on disk since the console write/,
    );
    expect(guard.fingerprint).toBe(boot);
    // 守卫仍判漂移（第三方改动未被署名）
    expect(guard.recheck().ok).toBe(false);
  });

  it('M1-白洗：本次写范围外的安全字段变化 → 拒绝重锚（既存篡改不被无关写洗白）', () => {
    const path = join(tmp, 'guard-whitewash.json');
    // agent 先直改顶层 effectPolicy（自提权面），此刻已漂移
    const tampered = JSON.stringify({
      effectPolicy: { mode: 'host', jail: 'none' },
      agents: [{ id: 'a1' }],
    });
    writeFileSync(path, tampered);
    const guard = createSecurityIntegrityGuard({ configPath: path });
    // 从启动锚（未篡改）开始：模拟 boot 后被改
    const path2 = join(tmp, 'guard-whitewash2.json');
    writeFileSync(path2, JSON.stringify({ effectPolicy: { mode: 'host' }, agents: [{ id: 'a1' }] }));
    const guard2 = createSecurityIntegrityGuard({ configPath: path2 });
    const boot2 = guard2.fingerprint;

    // 篡改 effectPolicy.jail（范围外）
    const afterTamper = JSON.stringify({
      effectPolicy: { mode: 'host', jail: 'none' },
      agents: [{ id: 'a1' }],
    });
    writeFileSync(path2, afterTamper);
    // 一次**只声明改 agents**的 console 写：hash 与盘上一致（模拟 TOCTOU 已过），
    // 但 changed 含范围外的 effectPolicy.jail → 必须拒绝，不能把篡改一起署名
    expect(() =>
      guard2.reattest({ expectHash: computeConfigHash(afterTamper), allowedChanged: ['agents'] }),
    ).toThrow(/outside this write's scope changed/);
    expect(guard2.fingerprint).toBe(boot2);
    void guard;
  });

  it('M1-放行：hash 一致 + changed ⊆ 白名单 → 重锚成功', () => {
    const path = join(tmp, 'guard-allow.json');
    writeFileSync(path, JSON.stringify({ agents: [{ id: 'a1' }] }));
    const guard = createSecurityIntegrityGuard({ configPath: path });
    const boot = guard.fingerprint;

    const afterWrite = JSON.stringify({ agents: [{ id: 'a1' }, { id: 'a2' }] });
    writeFileSync(path, afterWrite);
    const result = guard.reattest({
      expectHash: computeConfigHash(afterWrite),
      allowedChanged: ['agents'],
    });
    expect(result.changed).toEqual(['agents']);
    expect(guard.fingerprint).toBe(result.fingerprint);
    expect(guard.fingerprint).not.toBe(boot);
    expect(guard.recheck().ok).toBe(true);
  });

  it('EFFECT_POLICY_HOT_BLOCKED_KEYS：§4.3.1 明列安全闸在禁区；普通旋钮可热改（判据锁）', () => {
    // WebUI「安全组」四选一 = mode，必须能热改（否则新建 agent 向导失效）
    expect(EFFECT_POLICY_HOT_BLOCKED_KEYS).not.toContain('mode');
    // §4.3.1 明列的安全闸 + ops P4 减速带全部在禁区
    for (const key of [
      'jail',
      'onJailUnavailable',
      'privilegedAck',
      'escalation',
      'effects',
      'opsAudit',
      'dangerousCommands',
    ]) {
      expect(EFFECT_POLICY_HOT_BLOCKED_KEYS).toContain(key);
    }
    // 普通配置旋钮（虽在指纹内）允许热改——#5 锚测试依赖 shellEscape 保留语义
    for (const key of ['shellEscape', 'untrustedAdmission', 'pathContainment', 'network']) {
      expect(EFFECT_POLICY_HOT_BLOCKED_KEYS).not.toContain(key);
    }
  });
});
