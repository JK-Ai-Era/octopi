/**
 * 错误卡分类回归（批 2-3 / §5d；本批域×档）：classifyFlowError 三域装配 ——
 * provider：auth/network/model → user-action + 出路；timeout/rate_limit → user-action（等）；
 * context → 压缩指引；server 兜底 → support 级 + 诊断 ID + raw 折叠。
 * tool：failed/blocked → self-heal（不进卡）；internal → support。
 * app：操作失败 → user-action（不出现「模型服务」字样）。
 */

import { describe, expect, it } from 'vitest';
import { classifyFlowError, makeDiagnosticId } from '../packages/webui/src/components/error-classify';

describe('classifyFlowError（provider 域）', () => {
  it('auth 错误 → user-action + 去设置出路', () => {
    const e = classifyFlowError('401 Unauthorized: invalid api key', 'provider', () => {});
    expect(e.level).toBe('user-action');
    expect(e.title).toContain('密钥');
    expect(e.action?.label).toBe('去设置');
    expect(e.raw).toBe('401 Unauthorized: invalid api key'); // user-action 级带 raw（技术细节折叠，评审 Minor4）
  });

  it('network 错误 → user-action + 连不上模型服务', () => {
    const e = classifyFlowError('fetch failed: ECONNREFUSED 127.0.0.1:11434', 'provider');
    expect(e.level).toBe('user-action');
    expect(e.title).toContain('连不上');
  });

  it('model 错误 → user-action + 换模型指引', () => {
    const e = classifyFlowError('model "qwen9" not found', 'provider');
    expect(e.level).toBe('user-action');
    expect(e.title).toContain('模型');
  });

  it('context 超限 → user-action + 压缩指引', () => {
    const e = classifyFlowError('context length exceeded maximum', 'provider');
    expect(e.level).toBe('user-action');
    expect(e.detail).toContain('压缩');
    expect(e.action).toBeUndefined(); // 出路是压缩/新会话，不是设置
  });

  it('timeout → user-action（响应超时，不是吓人支持卡）', () => {
    const e = classifyFlowError('Request timed out after 30000ms', 'provider');
    expect(e.level).toBe('user-action');
    expect(e.title).toContain('超时');
    expect(e.action).toBeUndefined();
  });

  it('rate_limit → user-action（限流可等，不是吓人支持卡）', () => {
    const e = classifyFlowError('429 Too Many Requests: rate limit exceeded', 'provider');
    expect(e.level).toBe('user-action');
    expect(e.title).toContain('频繁');
    expect(e.action).toBeUndefined();
  });

  it('未知错误 → support 级 + 诊断 ID + raw 保留（折叠不默认展示）', () => {
    const e = classifyFlowError('upstream exploded: boom', 'provider');
    expect(e.level).toBe('support');
    expect(e.diagnosticId).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(e.raw).toBe('upstream exploded: boom');
    expect(e.action).toBeUndefined();
  });
});

describe('classifyFlowError（tool 域：可自救不进卡）', () => {
  it('工具执行失败（参数/路径/exit≠0）→ self-heal，无诊断 ID', () => {
    const e = classifyFlowError('ENOENT: no such file or directory, open \'/x/y.txt\'', 'tool');
    expect(e.level).toBe('self-heal');
    expect(e.diagnosticId).toBeUndefined();
    expect(e.raw).toBeUndefined();
  });

  it('守卫拦截 → self-heal（模型换方案即可）', () => {
    const e = classifyFlowError('Blocked by SecurityGuard: 检测到可能的 prompt injection', 'tool');
    expect(e.level).toBe('self-heal');
    expect(e.title).toContain('拦截');
  });

  it('工具内部异常（堆栈+octopi 包内路径）→ support + 诊断 ID', () => {
    const e = classifyFlowError('TypeError: x is not a function\n    at run (/x/packages/engine/src/run.ts:1:1)', 'tool');
    expect(e.level).toBe('support');
    expect(e.diagnosticId).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(e.raw).toContain('TypeError');
  });
});

describe('classifyFlowError（app 域：会话操作错误）', () => {
  it('操作失败 → user-action，文案不出现「模型服务」', () => {
    const e = classifyFlowError('rename failed: disk full', 'app');
    expect(e.level).toBe('user-action');
    expect(e.title).not.toContain('模型服务');
    expect(e.title).toContain('操作失败');
  });
});

describe('诊断 ID', () => {
  it('形态稳定（时间序-随机尾、可复制）', () => {
    expect(makeDiagnosticId()).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });
});
