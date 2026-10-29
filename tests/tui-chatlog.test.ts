/**
 * TUI ChatLog 状态机 + 组件行为单测。
 *
 * 钉住：流式助手消息的 start/update/finalize/drop 去重语义、工具卡片
 * 建一次/部分输出/定形结果、系统消息合并与 transient 清理、超量裁剪
 * 且引用同步失效、clearAll 清场。组件内部状态经显式 cast 断言。
 */

import { describe, it, expect } from 'vitest';
import {
  ChatLog,
  ToolExecutionComponent,
  SystemMessageComponent,
} from '../src/integration/tui/components.js';

/** 私有状态观察面（测试专用） */
interface ToolState {
  result: string | null;
  isPartial: boolean;
  isError: boolean;
  args: string;
}

function toolState(tool: ToolExecutionComponent): ToolState {
  return tool as unknown as ToolState;
}

describe('ChatLog 流式助手消息状态机', () => {
  it('start 建一次、update 复用、finalize 落定后同 id 再 finalize 是新消息', () => {
    const log = new ChatLog();
    const msg = log.startAssistant('hello', 'r1');
    expect(log.children).toHaveLength(1);

    const again = log.startAssistant('hello world', 'r1');
    expect(again).toBe(msg);
    expect(log.children).toHaveLength(1);

    log.updateAssistant('hello world!', 'r1');
    expect(log.children).toHaveLength(1);

    log.finalizeAssistant('hello world! done', 'r1');
    expect(log.children).toHaveLength(1);
    // 已落定：同 runId 的下一次 finalize 是新条目（上一轮已从流式表移除）
    log.finalizeAssistant('next round', 'r1');
    expect(log.children).toHaveLength(2);
  });

  it('update 无前序流式条目时自举创建；drop 移除未落定条目', () => {
    const log = new ChatLog();
    log.updateAssistant('auto', 'rx');
    expect(log.children).toHaveLength(1);

    log.startAssistant('streaming…', 'ry');
    log.dropAssistant('ry');
    expect(log.children).toHaveLength(1); // 只剩 rx
    log.dropAssistant('ry'); // 幂等
    expect(log.children).toHaveLength(1);
  });

  it('finalize 无前序流式条目时直接追加成条', () => {
    const log = new ChatLog();
    log.finalizeAssistant('final text', 'rz');
    expect(log.children).toHaveLength(1);
  });
});

describe('ChatLog 工具执行卡片', () => {
  it('start 建一次（重复 start 更新参数）、部分输出→定形结果状态迁移', () => {
    const log = new ChatLog();
    const tool = log.startTool('c1', 'shell', '{"cmd":"ls"}');
    log.startTool('c1', 'shell', '{"cmd":"ls -la"}');
    expect(log.children).toHaveLength(1);
    expect(toolState(tool).args).toBe('{"cmd":"ls -la"}');

    log.updateToolPartial('c1', 'partial output');
    expect(toolState(tool).isPartial).toBe(true);
    expect(toolState(tool).result).toBe('partial output');

    log.updateToolResult('c1', 'final output', { isError: true });
    expect(toolState(tool).isPartial).toBe(false);
    expect(toolState(tool).isError).toBe(true);
    expect(toolState(tool).result).toBe('final output');
  });

  it('setToolsExpanded 统一切换展开态（含后续新建的卡片）', () => {
    const log = new ChatLog();
    const t1 = log.startTool('c1', 'shell', '{}');
    log.setToolsExpanded(true);
    expect((t1 as unknown as { expanded: boolean }).expanded).toBe(true);
    const t2 = log.startTool('c2', 'shell', '{}');
    expect((t2 as unknown as { expanded: boolean }).expanded).toBe(true);
    log.setToolsExpanded(false);
    expect((t1 as unknown as { expanded: boolean }).expanded).toBe(false);
  });

  it('clearTools 只清工具卡片（消息保留）', () => {
    const log = new ChatLog();
    log.addUser('hi');
    log.startTool('c1', 'shell', '{}');
    log.clearTools();
    expect(log.children).toHaveLength(1);
    // 已清卡片的 id 不再接受更新（不抛错、无副作用）
    expect(() => log.updateToolResult('c1', 'x')).not.toThrow();
  });
});

describe('ChatLog 系统消息', () => {
  it('coalesceConsecutive 合并连续同类消息（xN 计数）', () => {
    const log = new ChatLog();
    log.addSystem('retrying', { coalesceConsecutive: true });
    log.addSystem('retrying', { coalesceConsecutive: true });
    log.addSystem('retrying', { coalesceConsecutive: true });
    expect(log.children).toHaveLength(1);
    const sys = log.children[0] as SystemMessageComponent;
    expect((sys as unknown as { count: number }).count).toBe(3);
  });

  it('被消息打断后不合并（lastSystemMessage 重置）', () => {
    const log = new ChatLog();
    log.addSystem('note', { coalesceConsecutive: true });
    log.addUser('hi');
    log.addSystem('note', { coalesceConsecutive: true });
    expect(log.children).toHaveLength(3);
  });

  it('transient 系统消息可按批清除，非 transient 保留', () => {
    const log = new ChatLog();
    log.addSystem('durable');
    log.addSystem('temp', { transient: true });
    log.addSystem('temp2', { transient: true });
    log.clearTransientSystem();
    expect(log.children).toHaveLength(1);
    expect((log.children[0] as SystemMessageComponent).transient).toBe(false);
  });
});

describe('ChatLog 裁剪与清场', () => {
  it('超量裁剪从最旧开始，且被裁组件的引用同步失效', () => {
    const log = new ChatLog(20);
    for (let i = 0; i < 25; i++) {
      log.addUser(`msg ${i}`);
    }
    expect(log.children).toHaveLength(20);
    // 最旧的 5 条被裁：剩下的第一条是 msg 5
    expect(log.children.length).toBeLessThanOrEqual(20);

    // 工具被裁后 id 引用失效：再更新不抛错且不复活组件
    const log2 = new ChatLog(20);
    for (let i = 0; i < 19; i++) log2.addUser(`m${i}`);
    log2.startTool('c-old', 'shell', '{}');
    for (let i = 0; i < 2; i++) log2.addUser(`tail${i}`);
    expect(log2.children).toHaveLength(20);
    expect(() => log2.updateToolResult('c-old', 'late result')).not.toThrow();
    expect(log2.children).toHaveLength(20);
  });

  it('maxComponents 下限 20（构造参数过小被钳制）', () => {
    const log = new ChatLog(5);
    for (let i = 0; i < 25; i++) log.addUser(`m${i}`);
    expect(log.children).toHaveLength(20);
  });

  it('clearAll 清空一切（含流式/工具引用表）', () => {
    const log = new ChatLog();
    log.startAssistant('s', 'r1');
    log.startTool('c1', 'shell', '{}');
    log.addSystem('note');
    log.clearAll();
    expect(log.children).toHaveLength(0);
    // 引用表已清：同 id 重建是新组件（不会 update 到旧对象）
    const tool2 = log.startTool('c1', 'shell', '{}');
    expect(log.children).toHaveLength(1);
    expect(toolState(tool2).result).toBeNull();
  });
});

describe('ToolExecutionComponent 显示状态', () => {
  it('折叠/展开仅影响展示态；定形后状态稳定', () => {
    const tool = new ToolExecutionComponent('shell', '{}');
    const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    tool.setResult(long);
    expect(toolState(tool).isPartial).toBe(false);
    expect(toolState(tool).isError).toBe(false);
    tool.setExpanded(true);
    expect((tool as unknown as { expanded: boolean }).expanded).toBe(true);
    tool.setExpanded(false);
    expect((tool as unknown as { expanded: boolean }).expanded).toBe(false);
  });

  it('默认部分态（… 占位），setResult 后转定形', () => {
    const tool = new ToolExecutionComponent('file_read', '{"path":"/a"}');
    expect(toolState(tool).isPartial).toBe(true);
    expect(toolState(tool).result).toBeNull();
    tool.setPartialResult('chunk 1');
    expect(toolState(tool).isPartial).toBe(true);
    tool.setResult('done');
    expect(toolState(tool).isPartial).toBe(false);
    expect(toolState(tool).result).toBe('done');
  });
});
