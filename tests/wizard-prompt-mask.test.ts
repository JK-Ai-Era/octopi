/**
 * wizard-prompt-mask — 隐藏输入 '*' 占位回显帧渲染回归（createMaskedEcho）。
 *
 * 覆盖：键入逐字占位、粘贴成串、Enter 吞掉、控制转义吞掉、rl 整行重绘（退格/
 * 方向键/Ctrl-U）整帧重画、换行帧上移重画、自定义重绘前缀。
 * 合成序列取自 PTY 实证（Node 24 回显字节流），分类边界见 prompt.ts 注释。
 */
import { describe, it, expect } from 'vitest';
import { createMaskedEcho } from '../src/cli/wizard/prompt.js';

function collect(): { out: string[]; write: (s: string) => void } {
  const out: string[] = [];
  return { out, write: (s: string) => out.push(s) };
}

describe('createMaskedEcho', () => {
  it('键入逐字占位：每字符输出一个 *，长度同步', () => {
    const { out, write } = collect();
    const echo = createMaskedEcho('P: ', write);
    echo.absorb('a');
    echo.absorb('b');
    expect(out).toEqual(['*', '*']);
    expect(echo.length).toBe(2);
  });

  it('粘贴成串：一条写入按字符数成串占位', () => {
    const { out, write } = collect();
    const echo = createMaskedEcho('P: ', write);
    echo.absorb('sk-pasted-KEY-123');
    expect(out).toEqual(['*****************']);
    expect(echo.length).toBe(17);
  });

  it('Enter 与空写入被吞掉：不出帧、不计长', () => {
    const { out, write } = collect();
    const echo = createMaskedEcho('P: ', write);
    echo.absorb('ab');
    echo.absorb('\r\n');
    echo.absorb('');
    expect(out).toEqual(['**']);
    expect(echo.length).toBe(2);
  });

  it('光标/擦除转义吞掉不转发', () => {
    const { out, write } = collect();
    const echo = createMaskedEcho('P: ', write);
    echo.absorb('ab');
    echo.absorb('\x1b[1G');
    echo.absorb('\x1b[0J');
    expect(out).toEqual(['**']);
  });

  it('rl 整行重绘（退格/方向键）：整帧重画，长度按重绘内容重算', () => {
    const { out, write } = collect();
    const echo = createMaskedEcho('P: ', write);
    echo.absorb('abcd');
    out.length = 0;
    echo.absorb('\x1b[1G'); // 退格触发重绘前的光标转义
    echo.absorb('\x1b[0J');
    echo.absorb('> abc'); // rl 默认 prompt '> ' + 行内容
    expect(out).toEqual(['\r\x1b[0JP: ***']);
    expect(echo.length).toBe(3);
  });

  it('Ctrl-U 清行重绘：帧归零', () => {
    const { out, write } = collect();
    const echo = createMaskedEcho('P: ', write);
    echo.absorb('abcd');
    out.length = 0;
    echo.absorb('\x1b[1G');
    echo.absorb('\x1b[0J');
    echo.absorb('> '); // 清行后行内容为空
    expect(out).toEqual(['\r\x1b[0JP: ']);
    expect(echo.length).toBe(0);
  });

  it('换行帧重画：先上移到帧首行再清（\\r 回不到上一行）', () => {
    const { out, write } = collect();
    // 3 列提示 + 12 占位 = 15 列 @10 列宽 → 2 行
    const echo = createMaskedEcho('P: ', write, { columns: () => 10 });
    for (const ch of 'abcdefghijkl') echo.absorb(ch);
    expect(out.at(-1)).toBe('*');
    out.length = 0;
    echo.absorb('\x1b[1G');
    echo.absorb('\x1b[0J');
    echo.absorb('> abcdefghij'); // 退格后剩 10 字符
    expect(out).toEqual(['\r\x1b[1A\x1b[0JP: **********']);
    expect(echo.length).toBe(10);
  });

  it('重绘前缀跟 rl prompt 走（非缺省 "> " 不失配）', () => {
    const { out, write } = collect();
    const echo = createMaskedEcho('P: ', write, { redrawPrefix: 'X: ' });
    echo.absorb('abcd');
    out.length = 0;
    echo.absorb('\x1b[1G');
    echo.absorb('X: ab');
    expect(out).toEqual(['\r\x1b[0JP: **']);
    expect(echo.length).toBe(2);
  });

  it('多字节字符（CJK/emoji）按码点计占位', () => {
    const { out, write } = collect();
    const echo = createMaskedEcho('P: ', write);
    echo.absorb('密码🐙'); // 3 个码点（emoji 是代理对）
    expect(out).toEqual(['***']);
    expect(echo.length).toBe(3);
  });
});
