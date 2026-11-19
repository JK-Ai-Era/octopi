/**
 * 高权限 init 声明落盘（services 步的启动前知情确认）：
 * 顶层 effectPolicy.privilegedAck 读写、既有字段保留、校验 fail-loud 不写坏文件。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readTopLevelPrivilegedAck,
  writePrivilegedAckDeclaration,
} from '../src/cli/wizard/onboarding.js';

describe('privilegedAck 声明读写', () => {
  let home: string;
  let configPath: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'octopi-privack-'));
    configPath = join(home, 'octopi.json');
    // 脚手架同款配置（init 生成物）：声明写入必须能落进真实形态的配置
    const { generateDefaultConfig } = await import('../src/init.js');
    const base = generateDefaultConfig(home) as Record<string, unknown>;
    base.language = 'zh';
    writeFileSync(configPath, JSON.stringify(base, null, 2), 'utf8');
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('写入声明只补 privilegedAck，既有 effectPolicy 字段与顶层键保留', () => {
    writePrivilegedAckDeclaration(configPath, 'user-confirmed-at-init-2026-11-20T00:00:00Z');
    const merged = JSON.parse(readFileSync(configPath, 'utf8')) as {
      effectPolicy: Record<string, unknown>;
      language: string;
    };
    expect(merged.effectPolicy.privilegedAck).toBe('user-confirmed-at-init-2026-11-20T00:00:00Z');
    expect(merged.effectPolicy.mode).toBe('project');
    expect(merged.language).toBe('zh');
  });

  it('读取声明：已写可读回；未写/缺文件/损坏返回 undefined（按未声明处理）', () => {
    expect(readTopLevelPrivilegedAck(configPath)).toBeUndefined();
    writePrivilegedAckDeclaration(configPath, 'user-confirmed-at-init-x');
    expect(readTopLevelPrivilegedAck(configPath)).toBe('user-confirmed-at-init-x');
    expect(readTopLevelPrivilegedAck(join(home, 'missing.json'))).toBeUndefined();
    writeFileSync(configPath, '{ broken json', 'utf8');
    expect(readTopLevelPrivilegedAck(configPath)).toBeUndefined();
  });

  it('agent 块内的 privilegedAck 不是 elevated 声明面（只认顶层）', () => {
    const base = JSON.parse(readFileSync(configPath, 'utf8')) as { agents: Array<Record<string, unknown>> };
    base.agents[0].effectPolicy = { privilegedAck: 'agent-scope-only' };
    writeFileSync(configPath, JSON.stringify(base), 'utf8');
    expect(readTopLevelPrivilegedAck(configPath)).toBeUndefined();
  });

  it('落盘前 schema 校验 fail-loud：校验拒绝时不写盘、原文不变', () => {
    const before = readFileSync(configPath, 'utf8');
    expect(() => {
      // 空串违反 schema 的 min(1)：写入函数必须在落盘前拒绝
      writePrivilegedAckDeclaration(configPath, '');
    }).toThrow();
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});
