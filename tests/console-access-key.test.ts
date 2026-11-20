/**
 * 控制台准入密钥原语回归：CLI 与 Web 向导共用同一判定，四种状态各锚一条。
 *
 * 重点边界：
 * - `${VAR}` 必须按 daemon 同源口径展开（字面占位符粘进登录页必然失败）
 * - 解析不出时只能指向变量名，绝不返回假钥
 * - 这是 channels[type=http].apiKey（控制台准入），与 LLM provider key 无关
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConsoleAccessKey } from '../packages/engine/src/config-admin/console-access-key.js';

const tempDirs: string[] = [];

/** 写一份临时配置，返回其路径 */
function writeConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'octopi-console-key-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'octopi.json');
  writeFileSync(configPath, content, 'utf8');
  return configPath;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('readConsoleAccessKey', () => {
  it('明文 apiKey → key（value 可直接填登录页）', () => {
    const configPath = writeConfig(
      JSON.stringify({ channels: [{ type: 'http', port: 18180, apiKey: 'random-32-bytes' }] }),
    );
    expect(readConsoleAccessKey(configPath)).toEqual({
      kind: 'key',
      value: 'random-32-bytes',
      source: 'random-32-bytes',
    });
  });

  it('${VAR} 按 daemon 口径展开并保留 source（登录页要生效值，不是占位符）', () => {
    vi.stubEnv('OCTOPI_TEST_CONSOLE_KEY', 'resolved-value');
    const configPath = writeConfig(
      JSON.stringify({ channels: [{ type: 'http', apiKey: '${OCTOPI_TEST_CONSOLE_KEY}' }] }),
    );
    const r = readConsoleAccessKey(configPath);
    vi.unstubAllEnvs();
    expect(r).toEqual({
      kind: 'key',
      value: 'resolved-value',
      source: '${OCTOPI_TEST_CONSOLE_KEY}',
    });
  });

  it('${VAR} 解析不出 → env-ref（只指变量名，不返回假钥）', () => {
    const configPath = writeConfig(
      JSON.stringify({ channels: [{ type: 'http', apiKey: '${OCTOPI_TEST_CONSOLE_MISSING}' }] }),
    );
    expect(readConsoleAccessKey(configPath)).toEqual({
      kind: 'env-ref',
      ref: '${OCTOPI_TEST_CONSOLE_MISSING}',
    });
  });

  it('无 channels / 无 apiKey → none（无鉴权模式）', () => {
    expect(readConsoleAccessKey(writeConfig('{"models":{}}'))).toEqual({ kind: 'none' });
    expect(readConsoleAccessKey(writeConfig('{"channels":[]}'))).toEqual({ kind: 'none' });
  });

  it('只认 type=http 的那条（别的 channel 的 apiKey 不是控制台密钥）', () => {
    const configPath = writeConfig(
      JSON.stringify({ channels: [{ type: 'weixin', apiKey: 'not-console' }] }),
    );
    expect(readConsoleAccessKey(configPath).kind).toBe('none');
  });

  it('配置缺失/损坏 → unreadable（不抛错、不谎报密钥）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'octopi-console-key-'));
    tempDirs.push(dir);
    expect(readConsoleAccessKey(join(dir, 'nope.json'))).toEqual({ kind: 'unreadable' });
    expect(readConsoleAccessKey(writeConfig('not json'))).toEqual({ kind: 'unreadable' });
  });
});
