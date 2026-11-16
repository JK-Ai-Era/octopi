import { describe, expect, it } from 'vitest';
import {
  classifyError,
  classifyErrorKind,
  classifyToolErrorKind,
  probeErrorCopy,
  runtimeErrorCopy,
  securityBlockedCopy,
} from '../packages/engine/src/config-admin/error-copy.js';

describe('错误分类与文案单源（批 3-2 四份单源化；本批域×档）', () => {
  it('classifyErrorKind：七类码全覆盖（含 context 与 server 兜底）', () => {
    expect(classifyErrorKind('401 unauthorized')).toBe('auth');
    expect(classifyErrorKind('ECONNREFUSED')).toBe('network');
    expect(classifyErrorKind('getaddrinfo ENOTFOUND')).toBe('network');
    expect(classifyErrorKind('model gpt-x not found')).toBe('model');
    expect(classifyErrorKind('context length exceeded maximum')).toBe('context');
    expect(classifyErrorKind('something exploded')).toBe('server');
  });

  it('classifyErrorKind：timeout / rate_limit 新码（原落 server 兜底）', () => {
    expect(classifyErrorKind('429 Too Many Requests')).toBe('rate_limit');
    expect(classifyErrorKind('rate limit exceeded, retry later')).toBe('rate_limit');
    expect(classifyErrorKind('quota exceeded')).toBe('rate_limit');
    expect(classifyErrorKind('Request timed out after 30000ms')).toBe('timeout');
    expect(classifyErrorKind('ETIMEDOUT')).toBe('timeout'); // 语义归超时，不再是 network
    expect(classifyErrorKind('deadline exceeded')).toBe('timeout');
  });

  it('classifyToolErrorKind：blocked 覆盖真实 violation 文本（beforeToolCall 阻断无前缀）', () => {
    // 修前死分支：真实阻断文本是 violation description，不带 'Blocked by SecurityGuard:' 前缀
    expect(classifyToolErrorKind('工具 "shell" download pipe to interpreter (remote code execution)')).toBe('blocked');
    expect(classifyToolErrorKind('工具 "file_write" 删除保护路径: "/"')).toBe('blocked');
    expect(classifyToolErrorKind('Blocked by SecurityGuard: detected prompt injection')).toBe('blocked');
  });

  it('classifyToolErrorKind：internal 只认堆栈+octopi 包内路径（用户脚本 stderr 不升级）', () => {
    expect(classifyToolErrorKind('TypeError: x is not a function\n    at run (/x/packages/engine/src/run.ts:1:1)')).toBe('internal');
    // 用户脚本的 stderr 堆栈是执行失败（模型可自救），不是工具内部异常
    expect(classifyToolErrorKind('TypeError: x is not a function\n    at foo (a.ts:1:1)')).toBe('failed');
    expect(classifyToolErrorKind('ENOENT: no such file or directory')).toBe('failed');
    expect(classifyToolErrorKind('Command failed with exit code 1')).toBe('failed');
  });

  it('classifyErrorKind：跨 provider 上下文长度措辞归 context（复用 core 单源）', () => {
    // Anthropic 措辞（旧实现落 server → 吓人支持卡）
    expect(classifyErrorKind('prompt is too long: 213706 tokens > 200000 maximum')).toBe('context');
    // Gemini 措辞
    expect(classifyErrorKind('The input token count exceeds the maximum number of tokens allowed')).toBe('context');
    // 429 词边界：行号/端口不误命中
    expect(classifyErrorKind('line 4290 in config')).toBe('server');
  });

  it('classifyError 域分流：处置档按域×码决定', () => {
    // provider：server 兜底 → support；其余 → user-action
    expect(classifyError('something exploded', 'provider').level).toBe('support');
    expect(classifyError('401 unauthorized', 'provider').level).toBe('user-action');
    expect(classifyError('429', 'provider').level).toBe('user-action');
    // tool：可自救 → self-heal；内部异常 → support
    expect(classifyError('ENOENT', 'tool').level).toBe('self-heal');
    expect(classifyError('Blocked by SecurityGuard: x', 'tool').level).toBe('self-heal');
    expect(classifyError('RangeError: x\n    at run (/x/packages/engine/src/run.ts:1:1)', 'tool').level).toBe('support');
    // app：操作失败 → user-action
    expect(classifyError('boom', 'app').level).toBe('user-action');
    expect(classifyError('boom', 'app').copy.title).not.toContain('模型服务');
  });

  it('securityBlockedCopy：审计语 → 人话（按 violation 形态映射）', () => {
    expect(securityBlockedCopy('工具 "shell" download pipe to interpreter (remote code execution)').title).toContain('远程代码');
    expect(securityBlockedCopy('工具 "shell" disk wipe: mkfs.ext4').title).toContain('磁盘');
    expect(securityBlockedCopy('工具 "file_write" 删除保护路径: "/"').title).toContain('保护路径');
    expect(securityBlockedCopy('Blocked by SecurityGuard: detected prompt injection: "x"').title).toContain('提示注入');
    expect(securityBlockedCopy('something else').title).toContain('拦截');
  });

  it('文案表：双语非空；probe 语境无 context（探针不会上下文超限）', () => {
    for (const lang of ['zh', 'en'] as const) {
      for (const kind of ['auth', 'network', 'timeout', 'rate_limit', 'model', 'context', 'server'] as const) {
        const copy = runtimeErrorCopy(kind, lang);
        expect(copy.title.length).toBeGreaterThan(0);
        expect(copy.detail.length).toBeGreaterThan(0);
      }
      for (const kind of ['auth', 'network', 'timeout', 'rate_limit', 'model', 'server'] as const) {
        const copy = probeErrorCopy(kind, lang);
        expect(copy.title.length).toBeGreaterThan(0);
        expect(copy.detail.length).toBeGreaterThan(0);
      }
    }
  });

  it('probe 与 run 语境分表（同码不同语境文案：向导有「上一步」，对话流有「设置」）', () => {
    const probe = probeErrorCopy('auth', 'zh');
    const runtime = runtimeErrorCopy('auth', 'zh');
    expect(probe.title).not.toBe(runtime.title);
  });
});
