/**
 * context-slice — evidence 锚定 ±N 窗口切片
 */

import { describe, it, expect } from 'vitest';
import {
  extractContextSlice,
  DEFAULT_CONTEXT_WINDOW_MESSAGES,
} from '@octopi-agent/engine/harness/memory/context-slice.js';

function msg(role: string, content: unknown, metadata?: Record<string, unknown>) {
  return { role, content, timestamp: 0, ...(metadata ? { metadata } : {}) };
}

describe('extractContextSlice', () => {
  it('锚定最长命中片段并截 ±N 窗口', () => {
    const messages = [
      msg('user', '第一条消息谈天气'),
      msg('assistant', '第二条回应天气'),
      msg('user', '我们拍板：会话租约用 sessionId 级互斥锁实现'),
      msg('assistant', '好的，租约按 sessionId 互斥'),
      msg('user', '第五条继续别的议题'),
      msg('assistant', '第六条收尾'),
    ];
    const evidence = '大哥拍板原话：「会话租约用 sessionId 级互斥锁实现…」；落于 arch 文档。';
    const slice = extractContextSlice({ messages, evidence, windowMessages: 1 });
    expect(slice).toContain('[user] 我们拍板：会话租约用 sessionId 级互斥锁实现');
    expect(slice).toContain('[assistant] 第二条回应天气');
    expect(slice).toContain('[assistant] 好的，租约按 sessionId 互斥');
    expect(slice).not.toContain('第一条消息谈天气');
    expect(slice).not.toContain('第五条继续别的议题');
  });

  it('缺省窗口为 DEFAULT_CONTEXT_WINDOW_MESSAGES', () => {
    const messages = [
      msg('user', '甲甲甲甲甲甲甲甲'),
      msg('user', '乙乙乙乙乙乙乙乙'),
      msg('user', '丙丙丙丙丙丙丙丙锚点句在这里的完整原句'),
      msg('user', '丁丁丁丁丁丁丁丁'),
      msg('user', '戊戊戊戊戊戊戊戊'),
    ];
    const slice = extractContextSlice({ messages, evidence: '丙丙丙丙丙丙丙丙锚点句在这里的完整原句' });
    for (const expectText of ['甲甲', '乙乙', '丙丙', '丁丁', '戊戊']) {
      expect(slice).toContain(expectText);
    }
    expect(DEFAULT_CONTEXT_WINDOW_MESSAGES).toBe(2);
  });

  it('引号差异不影响命中（剥引号后匹配）', () => {
    const messages = [msg('user', '他说「用配置文件来控制部署」并继续讨论')];
    const slice = extractContextSlice({ messages, evidence: '原话：“用配置文件来控制部署”' });
    expect(slice).toContain('用配置文件来控制部署');
  });

  it('同长命中取最后一次出现（贴近记忆产生时的活跃语境）', () => {
    const messages = [
      msg('user', '早期讨论：降级标记词汇表定为文本形'),
      msg('user', '中期闲聊若干'),
      msg('user', '最终确认：降级标记词汇表定为文本形'),
      msg('assistant', '记下了'),
    ];
    const slice = extractContextSlice({ messages, evidence: '降级标记词汇表定为文本形', windowMessages: 1 });
    expect(slice).toContain('最终确认');
    expect(slice).toContain('记下了');
    expect(slice).not.toContain('早期讨论');
  });

  it('引擎载体插槽不入语境也不占窗口（isEngineCarrierSource 单源）', () => {
    const messages = [
      msg('user', '实质发言甲甲甲甲甲甲甲甲'),
      msg('user', '[runtime snapshot 伪消息]', { source: 'runtimeSnapshot' }),
      msg('user', '<turn_end id="t1"/>', { source: 'turnEnd' }),
      msg('user', '引擎提示词 wrap-up 通知', { source: 'engineHint' }),
      msg('user', '运行停止说明预算裁决', { source: 'runStopped' }),
      msg('assistant', '锚点回答乙乙乙乙乙乙乙乙'),
    ];
    const slice = extractContextSlice({ messages, evidence: '锚点回答乙乙乙乙乙乙乙乙', windowMessages: 3 });
    expect(slice).toContain('实质发言甲甲甲甲甲甲甲甲');
    expect(slice).not.toContain('runtime snapshot');
    expect(slice).not.toContain('turn_end');
    expect(slice).not.toContain('引擎提示词');
    expect(slice).not.toContain('运行停止说明');
  });

  it('tool/命令输出文本可作语境与锚点（evidence 可引用工具输出）', () => {
    const messages = [
      msg('user', '看一下 arch 文档里的清单'),
      msg('tool', 'arch/NEXT-STEPS.md: 未完成项若干'),
      msg('assistant', '读完了，NEXT-STEPS 有三条待办'),
    ];
    const slice = extractContextSlice({ messages, evidence: 'arch/NEXT-STEPS.md: 未完成项若干', windowMessages: 1 });
    expect(slice).toContain('[tool] arch/NEXT-STEPS.md: 未完成项若干');
    expect(slice).toContain('看一下 arch 文档里的清单');
    expect(slice).toContain('读完了');
  });

  it('ContentBlock[] 只取文本块；纯 tool_use 消息不算实质消息', () => {
    const messages = [
      msg('user', [{ type: 'text', text: '结论：会话租约归 session 管' }, { type: 'tool_use', id: 'x', name: 'file_read', input: { path: 'secret' } }]),
      msg('assistant', [{ type: 'tool_use', id: 'y', name: 'shell', input: { command: 'rm -rf' } }]),
    ];
    const slice = extractContextSlice({ messages, evidence: '结论：会话租约归 session 管', windowMessages: 1 });
    expect(slice).toContain('会话租约归 session 管');
    expect(slice).not.toContain('secret');
    expect(slice).not.toContain('rm -rf');
  });

  it('无锚点返回空串（禁止用无关窗口冒充语境）', () => {
    const messages = [msg('user', '完全无关的内容')];
    expect(extractContextSlice({ messages, evidence: '另一处的原话片段足够长' })).toBe('');
  });

  it('tool 文本经 toolResults/toolCalls 侧写可锚定（content 为空也行）', () => {
    const messages = [
      msg('assistant', '确认一下部署方案'),
      {
        role: 'tool',
        content: '',
        timestamp: 0,
        toolResults: [
          { toolCallId: 'c1', name: 'ask_user', purpose: '拍板验证方式', result: { answer: '都不动，等下次自然运行验证' }, durationMs: 100 },
        ],
      },
      msg('user', '好的就等自然运行'),
    ];
    const slice = extractContextSlice({
      messages,
      evidence: 'ask_user 答案：「等下次自然运行验证」',
      windowMessages: 1,
    });
    expect(slice).toContain('ask_user');
    expect(slice).toContain('都不动，等下次自然运行验证');
    expect(slice).toContain('确认一下部署方案');
    expect(slice).toContain('好的就等自然运行');
  });

  it('assistant 的 toolCalls 参数文本可锚定', () => {
    const messages = [
      msg('user', '前置讨论若干内容'),
      {
        role: 'assistant',
        content: '我来查一下',
        timestamp: 0,
        toolCalls: [{ id: 'c2', name: 'file_read', arguments: { path: 'arch/NEXT-STEPS.md' } }],
      },
      msg('user', '后续讨论若干内容'),
    ];
    const slice = extractContextSlice({ messages, evidence: '读取了「arch/NEXT-STEPS.md」的清单', windowMessages: 1 });
    expect(slice).toContain('arch/NEXT-STEPS.md');
    expect(slice).toContain('前置讨论若干内容');
    expect(slice).toContain('后续讨论若干内容');
  });

  it('相邻引文按引号括号边界拆开，不粘连成跨引文片段', () => {
    const messages = [
      msg('user', '前文话题甲甲甲甲甲甲'),
      { role: 'tool', content: '', timestamp: 0, toolResults: [{ name: 'ask_user', result: { answer: '都不动，等下次自然运行验证' } }] },
      msg('user', '我手动重启了'),
    ];
    const evidence = '原话：「都不动，等下次自然运行验证」（补充「我手动重启了」）';
    const slice = extractContextSlice({ messages, evidence, windowMessages: 1 });
    expect(slice).toContain('都不动，等下次自然运行验证');
    expect(slice).toContain('我手动重启了');
  });

  it('含 CJK 的 6 字引文可锚定，纯拉丁仍需 ≥8', () => {
    const messages = [msg('user', '他说我手动重启了然后继续')];
    expect(extractContextSlice({ messages, evidence: '记录：「我手动重启了」' })).toContain('我手动重启了');
    expect(extractContextSlice({ messages: [msg('user', 'the test ran fine')], evidence: 'quote: the tes' })).toBe('');
  });

  it('过短 evidence 片段不锚定（防误锚阈值）', () => {
    const messages = [msg('user', '短句在这里')];
    expect(extractContextSlice({ messages, evidence: '租约' })).toBe('');
  });

  it('空 evidence / 空消息返回空串', () => {
    const messages = [msg('user', '任意内容任意内容任意内容')];
    expect(extractContextSlice({ messages, evidence: '' })).toBe('');
    expect(extractContextSlice({ messages: [], evidence: '任意内容任意内容任意内容' })).toBe('');
  });

  it('窗口在序列两端钳制', () => {
    const messages = [
      msg('user', '锚点在开头位置出现了'),
      msg('assistant', '后一条'),
    ];
    const slice = extractContextSlice({ messages, evidence: '锚点在开头位置出现了', windowMessages: 3 });
    expect(slice).toContain('锚点在开头位置出现了');
    expect(slice).toContain('后一条');
  });

  it('截断以锚点为中心：邻居被裁，锚点文本保留', () => {
    const long = '长'.repeat(500);
    const messages = [
      msg('user', long),
      msg('assistant', '锚点语句在这条短消息里'),
      msg('user', long),
    ];
    const slice = extractContextSlice({ messages, evidence: '锚点语句在这条短消息里', windowMessages: 1, maxChars: 200 });
    expect(slice).toContain('锚点语句在这条短消息里');
    expect(slice).toContain('[octopi:elided');
    expect(slice.length).toBeLessThan(400);
    expect(slice).not.toContain(long);
  });

  it('锚点行自身超预算时保头尾并带 elision 标记', () => {
    const long = '长'.repeat(500);
    const messages = [
      msg('user', `${long}五百字长文的锚点文本在此`),
      msg('user', long),
    ];
    const slice = extractContextSlice({ messages, evidence: '五百字长文的锚点文本在此', windowMessages: 5, maxChars: 200 });
    expect(slice).toContain('[octopi:elided');
    expect(slice.length).toBeLessThan(400);
  });
});
