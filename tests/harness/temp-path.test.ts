/**
 * temp-path 单一来源分类 + capability-enforcer 加固 + degradation 跨平台临时判定
 */
import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DefaultEventBus } from '@octopi-agent/core/primitives/event-bus.js';
import {
  currentUserHome,
  isTempPath,
  resetTempPathCache,
} from '@octopi-agent/engine/harness/governance/security/temp-path.js';
import {
  CapabilityEnforcer,
  PluginTrustLevel,
} from '@octopi-agent/engine/harness/governance/security/capability-enforcer.js';
import { suggestDegradation } from '@octopi-agent/engine/harness/governance/security/degradation.js';

describe('isTempPath — 临时目录分类（单一来源）', () => {
  it('POSIX 共享临时与 macOS 规范（realpath）双形态', () => {
    expect(isTempPath('/tmp/a.txt')).toBe(true);
    expect(isTempPath('/tmp')).toBe(true);
    expect(isTempPath('/private/tmp/a.txt')).toBe(true);
    expect(isTempPath('/var/tmp/a.txt')).toBe(true);
    expect(isTempPath('/private/var/tmp/a.txt')).toBe(true);
  });

  it('段边界防假命中；非临时路径不误判', () => {
    expect(isTempPath('/tmpdir/a.txt')).toBe(false);
    expect(isTempPath('/etc/passwd')).toBe(false);
    expect(isTempPath('/Users/me/notes.md')).toBe(false);
  });

  it('Windows 临时区（大小写不敏感、分隔符归一）', () => {
    expect(isTempPath('C:\\Windows\\Temp\\x')).toBe(true);
    expect(isTempPath('c:/windows/temp/x')).toBe(true);
    // AppData 静态回退覆盖「当前用户」（与实现共用 currentUserHome 单一来源）
    const home = currentUserHome().replace(/\//g, '\\');
    expect(isTempPath(`${home}\\AppData\\Local\\Temp\\x`)).toBe(true);
    expect(isTempPath('C:\\Windows\\System32\\x')).toBe(false);
    expect(isTempPath('C:\\Program Files\\x')).toBe(false);
  });

  it('os.tmpdir() 生效值即临时（macOS TMPDIR=/var/folders/…）', () => {
    expect(isTempPath(join(tmpdir(), 'x'))).toBe(true);
    resetTempPathCache();
  });

  it('env fixture：USERPROFILE 显式设定的语义（不依赖测试宿主的环境）', () => {
    const prevUP = process.env.USERPROFILE;
    const prevHome = process.env.HOME;
    try {
      process.env.USERPROFILE = 'C:\\Users\\fixture';
      delete process.env.HOME;
      resetTempPathCache();
      expect(isTempPath('C:\\Users\\fixture\\AppData\\Local\\Temp\\x')).toBe(true);
      expect(isTempPath('C:\\Users\\fixture\\Documents\\x')).toBe(false);
    } finally {
      if (prevUP === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUP;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      resetTempPathCache();
    }
  });
});

describe('temp-path 缓存与 env 兜底', () => {
  it('env 变更须 resetTempPathCache 后生效，还原后失效', () => {
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = '/custom-temp-dir';
    try {
      resetTempPathCache();
      expect(isTempPath('/custom-temp-dir/x')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prev;
      resetTempPathCache();
    }
    expect(isTempPath('/custom-temp-dir/x')).toBe(false);
  });
});

describe('CapabilityEnforcer.checkPathAccess — 加固', () => {
  const bus = new DefaultEventBus();

  it('sandbox：临时目录放行，穿越与非临时拒绝', () => {
    const enf = new CapabilityEnforcer(bus);
    enf.registerPlugin('p-sandbox', PluginTrustLevel.THIRD_PARTY); // filesystem: 'sandbox'

    // 平台中立：一律用 tmpdir() 构造，不硬编码 /tmp（避免 Windows 假红）
    expect(enf.checkPathAccess('p-sandbox', join(tmpdir(), 'a.txt')).allowed).toBe(true);
    // 旧实现 `startsWith('/tmp/')` 不折叠 `..`——穿越洞必须堵死
    expect(enf.checkPathAccess('p-sandbox', join(tmpdir(), '..', 'evil.txt')).allowed).toBe(false);
    expect(enf.checkPathAccess('p-sandbox', resolve(tmpdir(), '..', 'elsewhere', 'x')).allowed).toBe(false);
    // 相对路径无从锚定 → fail-closed（旧实现按 cwd 解析会越权）
    expect(enf.checkPathAccess('p-sandbox', 'a.txt').allowed).toBe(false);
  });

  it('workspace：根未知 fail-closed，根已知做包含判定', () => {
    const enf = new CapabilityEnforcer(bus);
    enf.registerPlugin('p-ws', PluginTrustLevel.OFFICIAL); // filesystem: 'workspace'
    const root = join(tmpdir(), 'ws-root');
    const inside = join(root, 'src', 'a.ts');

    // 旧实现「无 .. 即放行」会放行 /etc/passwd——根未知必须 fail-closed
    const noRoot = enf.checkPathAccess('p-ws', inside);
    expect(noRoot.allowed).toBe(false);
    expect(noRoot.allowed === false && noRoot.reason).toContain('workspace root unknown');

    expect(enf.checkPathAccess('p-ws', inside, { workspaceRoot: root }).allowed).toBe(true);
    // 相对路径锚定 workspace root（不锚进程 cwd）
    expect(enf.checkPathAccess('p-ws', 'src/a.ts', { workspaceRoot: root }).allowed).toBe(true);
    expect(enf.checkPathAccess('p-ws', root, { workspaceRoot: root }).allowed).toBe(true);
    expect(
      enf.checkPathAccess('p-ws', join(tmpdir(), 'elsewhere', 'b.ts'), { workspaceRoot: root }).allowed,
    ).toBe(false);
    expect(enf.checkPathAccess('p-ws', join(root, '..', 'evil.ts'), { workspaceRoot: root }).allowed).toBe(false);
  });

  it('none / 未注册：拒绝', () => {
    const enf = new CapabilityEnforcer(bus);
    enf.registerPlugin('p-none', PluginTrustLevel.UNTRUSTED); // filesystem: 'none'
    expect(enf.checkPathAccess('p-none', join(tmpdir(), 'a.txt')).allowed).toBe(false);
    expect(enf.checkPathAccess('p-ghost', join(tmpdir(), 'a.txt')).allowed).toBe(false);
  });
});

describe('degradation — 临时目录判定跨平台', () => {
  it('rm 临时目录不建议降级；非临时才建议 trash', () => {
    expect(suggestDegradation('rm -rf /tmp/scratch-x')).toBeNull();
    expect(suggestDegradation('rm -rf /var/tmp/scratch-x')).toBeNull();
    const alt = suggestDegradation('rm -rf ~/notes');
    expect(alt).not.toBeNull();
    expect(alt?.command).toContain('trash');
  });

  it('重定向覆盖：临时目录免提示，绝对路径非临时提示备份', () => {
    expect(suggestDegradation('echo hi > /tmp/scratch-x')).toBeNull();
    const alt = suggestDegradation('echo hi > /etc/hosts');
    expect(alt).not.toBeNull();
    expect(alt?.description).toContain('备份');
  });
});
