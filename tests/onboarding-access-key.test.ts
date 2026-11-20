/**
 * 初始化收尾亮钥回归锚：随机 apiKey 必须在最后一步打出来并指路登录页，
 * 新用户不必去翻配置文件。边界：${VAR} 引用按 daemon 同源展开后再生效；
 * 无钥/解析不出时明说，不指路一个不存在的密钥；同一配置只打印一次（早退出口共用）。
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { printConsoleAccessInfo } from '../src/cli/wizard/onboarding.js';

/** 本次测试创建的临时目录（afterAll 统一清理，NIT：不留垃圾） */
const tempDirs: string[] = [];

/** 捕获 console.log 全部输出 */
function captureLogs(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, 'log')
    .mockImplementation((...args: unknown[]) => lines.push(args.map(String).join(' ')));
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

function writeConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'octopi-init-key-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'octopi.json');
  writeFileSync(configPath, content, 'utf8');
  return configPath;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('printConsoleAccessInfo', () => {
  it('展示 channels[type=http].apiKey 并指路配置文件与登录页', () => {
    const configPath = writeConfig(
      JSON.stringify({ channels: [{ type: 'http', port: 18180, apiKey: 'secret-key-123' }] }),
    );
    const out = captureLogs(() => printConsoleAccessInfo(configPath, true)).join('\n');
    expect(out).toContain('secret-key-123');
    expect(out).toContain(configPath);
    expect(out).toContain('访问密钥');
    expect(out).toContain('channels[type=http].apiKey');
  });

  it('英文文案同套信息', () => {
    const configPath = writeConfig(
      JSON.stringify({ channels: [{ type: 'http', port: 18180, apiKey: 'secret-key-123' }] }),
    );
    const out = captureLogs(() => printConsoleAccessInfo(configPath, false)).join('\n');
    expect(out).toContain('secret-key-123');
    expect(out).toContain('Access key');
    expect(out).toContain(configPath);
  });

  it('${VAR} 引用按 loadConfig 同源展开后打印生效值，并注明解析来源', () => {
    vi.stubEnv('OCTOPI_TEST_WIZ_KEY', 'resolved-key-456');
    const configPath = writeConfig(
      JSON.stringify({ channels: [{ type: 'http', port: 18180, apiKey: '${OCTOPI_TEST_WIZ_KEY}' }] }),
    );
    const out = captureLogs(() => printConsoleAccessInfo(configPath, true)).join('\n');
    vi.unstubAllEnvs();
    expect(out).toContain('resolved-key-456');
    expect(out).toContain('（已从环境变量解析：${OCTOPI_TEST_WIZ_KEY}）');
    // 密钥行本身必须是生效值，不能是字面占位符
    expect(out).toContain('🔑 访问密钥（请复制保存）：\n   resolved-key-456');
  });

  it('env 引用解析不出：明说来源与处置，不打印假钥', () => {
    const configPath = writeConfig(
      JSON.stringify({ channels: [{ type: 'http', port: 18180, apiKey: '${OCTOPI_TEST_WIZ_MISSING}' }] }),
    );
    const out = captureLogs(() => printConsoleAccessInfo(configPath, true)).join('\n');
    expect(out).toContain('OCTOPI_TEST_WIZ_MISSING');
    expect(out).toContain('环境变量');
    expect(out).not.toContain('🔑');
  });

  it('配置无 apiKey：明说无鉴权，不指路不存在的密钥', () => {
    const configPath = writeConfig(JSON.stringify({ channels: [{ type: 'http', port: 18180 }] }));
    const out = captureLogs(() => printConsoleAccessInfo(configPath, true)).join('\n');
    expect(out).toContain('无鉴权');
    expect(out).not.toContain('🔑');
    expect(out).not.toContain('密钥在配置文件里');
  });

  it('配置损坏不炸：仍指路配置文件位置（不谎报密钥）', () => {
    const configPath = writeConfig('not json');
    const out = captureLogs(() => printConsoleAccessInfo(configPath, true)).join('\n');
    expect(out).toContain(configPath);
    expect(out).not.toContain('🔑');
  });

  it('同一配置路径只打印一次（first-chat 与早退出口共用收尾）', () => {
    const configPath = writeConfig(
      JSON.stringify({ channels: [{ type: 'http', port: 18180, apiKey: 'once-key' }] }),
    );
    const first = captureLogs(() => printConsoleAccessInfo(configPath, true));
    const second = captureLogs(() => printConsoleAccessInfo(configPath, true));
    expect(first.join('\n')).toContain('once-key');
    expect(second).toHaveLength(0);
  });
});
