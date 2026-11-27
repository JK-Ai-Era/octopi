/**
 * R5 知识源 location 租户围栏（arch/multi-tenancy.md §9.1-19，大哥 2026-11-28 拍板）：
 * knowledge = 外部世界的信息——任意外部路径可引；运行时内部态（OCTOPI_HOME 树）整体
 * 禁入，唯一放行 workspace/<写者租户>/**；host 面/平台 admin 豁免。realpath 解析后判定
 * （防软链绕过）；登记面（gateway/registry 面）策略闸 + ingest 漂移闸双重校验。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertStableCanonicalLocation,
  isKnowledgeLocationAllowed,
  resolveCanonicalLocation,
} from '@octopi-agent/engine/harness/knowledge/location.js';

const prevHome = process.env.OCTOPI_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'octopi-fence-'));
  mkdirSync(join(home, 'sessions'), { recursive: true });
  mkdirSync(join(home, 'workspace', 'tenant-a', 'agent-x'), { recursive: true });
  mkdirSync(join(home, 'workspace', 'tenant-b'), { recursive: true });
  process.env.OCTOPI_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.OCTOPI_HOME;
  else process.env.OCTOPI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const USER_A = { tenantId: 'tenant-a', fenceExempt: false };
const ADMIN = { tenantId: 'tenant-a', fenceExempt: true };

describe('isKnowledgeLocationAllowed（R5 围栏单源）', () => {
  it('外部世界路径放行；内部态禁入；本租户 workspace 放行、他租户禁入', () => {
    const outside = mkdtempSync(join(tmpdir(), 'octopi-fence-out-'));
    try {
      expect(isKnowledgeLocationAllowed(USER_A, 'directory', join(outside, 'docs')).allowed).toBe(true);
      // 内部态整体禁入：会话/凭据/registry/配置
      for (const inner of ['sessions', 'credentials', 'registry.db', 'octopi.json']) {
        expect(isKnowledgeLocationAllowed(USER_A, 'directory', join(home, inner)).allowed).toBe(false);
      }
      // 本租户 workspace（含本租户其他 agent）放行；他租户禁入
      expect(
        isKnowledgeLocationAllowed(USER_A, 'directory', join(home, 'workspace', 'tenant-a', 'agent-x')).allowed,
      ).toBe(true);
      expect(
        isKnowledgeLocationAllowed(USER_A, 'directory', join(home, 'workspace', 'tenant-b')).allowed,
      ).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('realpath 解析后判定：软链指向内部态被拒（防绕过）', () => {
    const outside = mkdtempSync(join(tmpdir(), 'octopi-fence-link-'));
    try {
      const evil = join(outside, 'evil');
      symlinkSync(join(home, 'sessions'), evil);
      expect(isKnowledgeLocationAllowed(USER_A, 'directory', evil).allowed).toBe(false);
      // 豁免写者放行（运维口子）
      expect(isKnowledgeLocationAllowed(ADMIN, 'directory', evil).allowed).toBe(true);
      expect(isKnowledgeLocationAllowed(ADMIN, 'directory', join(home, 'credentials')).allowed).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('url/connector 不受围栏；不存在的叶子按最深存在前缀判定', () => {
    expect(isKnowledgeLocationAllowed(USER_A, 'url', 'https://example.com/x').allowed).toBe(true);
    expect(
      isKnowledgeLocationAllowed(USER_A, 'file', join(home, 'sessions', 'not-yet.jsonl')).allowed,
    ).toBe(false);
    const outside = mkdtempSync(join(tmpdir(), 'octopi-fence-leaf-'));
    try {
      expect(
        isKnowledgeLocationAllowed(USER_A, 'file', join(outside, 'later.md')).allowed,
      ).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('ingest 漂移闸（canonical 形态复检）', () => {
  it('resolveCanonicalLocation：登记后路径被软链换向 → 解析结果不再等于登记形态', () => {
    const outside = mkdtempSync(join(tmpdir(), 'octopi-fence-drift-'));
    try {
      const target = join(outside, 'docs');
      mkdirSync(target);
      writeFileSync(join(target, 'a.md'), 'hi');
      const canonical = resolveCanonicalLocation(target);
      expect(resolveCanonicalLocation(canonical)).toBe(canonical); // 幂等
      // 换向：docs 目录被替换成指向内部态的软链
      rmSync(target, { recursive: true, force: true });
      symlinkSync(join(home, 'sessions'), target);
      expect(resolveCanonicalLocation(canonical)).not.toBe(canonical); // 漂移信号
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('围栏判定的健壮性（独立评审 BLOCKER-2 / MINOR-8 / MAJOR-5）', () => {
  it.skipIf(process.platform === 'linux')(
    '大小写变体不得绕过围栏（macOS/Windows 大小写不敏感 FS，realpath 保留查询写法）',
    () => {
      const upper = home.toUpperCase();
      expect(isKnowledgeLocationAllowed(USER_A, 'directory', join(upper, 'sessions')).allowed).toBe(false);
      expect(isKnowledgeLocationAllowed(USER_A, 'directory', join(upper, 'SESSIONS', 'x.jsonl')).allowed).toBe(
        false,
      );
    },
  );

  it('只裁决不抛异常：非法路径返回 location_invalid（调用方按码映射 400）', () => {
    const verdict = isKnowledgeLocationAllowed(USER_A, 'directory', 'relative/path');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.code).toBe('location_invalid');
      expect(verdict.reason).toMatch(/absolute path/);
    }
  });

  it('写入形态闸：canonical 自洽原样返回；非 canonical（含判定后换向）拒', () => {
    const outside = mkdtempSync(join(tmpdir(), 'octopi-fence-stable-'));
    try {
      const real = resolveCanonicalLocation(join(outside, 'docs'));
      mkdirSync(real, { recursive: true });
      // 词法变体（`..` 尾段）= 非 canonical 形态 → 拒（同一形态规则也覆盖「判定后被换向」）
      const lexical = join(outside, 'x', '..', 'docs');
      expect(() => assertStableCanonicalLocation('directory', lexical)).toThrow(/location_must_be_canonical/);
      // canonical 自洽 → 原样返回（判定与落库同一字符串）
      expect(assertStableCanonicalLocation('directory', real)).toBe(real);
      // 不存在的尾段：词法自洽即放行（盘上是否存在由 ingest 负责）
      expect(assertStableCanonicalLocation('directory', '/nonexistent-octopi/docs')).toBe('/nonexistent-octopi/docs');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
