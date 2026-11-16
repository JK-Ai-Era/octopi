import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 主题对比度回归锚（批 3-3 审计收编）：语义色板在两主题下必须全过 WCAG
 * （正文 ≥4.5:1、UI/大字 ≥3:1）。色值调整必须重跑本矩阵，不得弱化阈值。
 */

const css = readFileSync(join(__dirname, '../packages/webui/src/styles.css'), 'utf8');

function parseVars(marker: string): Record<string, string> {
  const idx = css.indexOf(marker);
  expect(idx, `styles.css 缺少变量块 ${marker}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  const vars: Record<string, string> = {};
  for (const m of css.slice(open + 1, close).matchAll(/(--(?:color|syntax)-[\w-]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
    vars[m[1]] = m[2];
  }
  return vars;
}

function lum(hex: string): number {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function ratio(a: string, b: string): number {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const light = parseVars(':root {');
const dark = parseVars(":root[data-theme='dark']");
const CODE_BG = '#0b1020'; // .md-code-block 恒暗底

describe('主题对比度（WCAG）', () => {
  const textBgs = ['--color-bg', '--color-surface', '--color-surface-2', '--color-surface-3'];
  const textPairs: Array<[string, string, number]> = [];
  for (const fg of ['--color-text', '--color-muted', '--color-ok', '--color-warn', '--color-error', '--color-info', '--color-accent-text']) {
    for (const bg of textBgs) textPairs.push([fg, bg, 4.5]);
  }
  for (const [fg, bg] of [['--color-ok', '--color-ok-bg'], ['--color-warn', '--color-warn-bg'], ['--color-error', '--color-error-bg'], ['--color-info', '--color-info-bg']]) {
    textPairs.push([fg, bg, 4.5]);
  }
  textPairs.push(['--color-text-invert', '--color-primary', 4.5]);
  for (const ui of ['--color-primary', '--color-focus', '--color-star', '--color-border-strong']) {
    for (const bg of textBgs) textPairs.push([ui, bg, 3]);
  }

  for (const [themeName, vars] of [['light', light], ['dark', dark]] as const) {
    for (const [fg, bg, min] of textPairs) {
      it(`${themeName} ${fg} on ${bg} >= ${min}`, () => {
        const f = vars[fg] ?? light[fg];
        const b = vars[bg] ?? light[bg];
        expect(f, `${themeName} 缺变量 ${fg}`).toBeTruthy();
        expect(b, `${themeName} 缺变量 ${bg}`).toBeTruthy();
        expect(ratio(f, b)).toBeGreaterThanOrEqual(min);
      });
    }
  }

  it('代码块恒暗底：正文与语法色全过 4.5:1（双主题同值）', () => {
    for (const fg of ['--color-on-dark', '--syntax-comment', '--syntax-keyword', '--syntax-string', '--syntax-title', '--syntax-attr', '--syntax-builtin']) {
      const f = light[fg];
      expect(f, `缺恒暗底色 ${fg}`).toBeTruthy();
      expect(ratio(f, CODE_BG), `${fg} 在代码块底上对比不足`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('语法色板双主题同值（不得随主题漂移——恒暗底不随主题变）', () => {
    for (const key of Object.keys(light).filter((k) => k.startsWith('--syntax-'))) {
      expect(dark[key] ?? light[key], `${key} 暗色覆盖了恒暗底色板`).toBe(light[key]);
    }
  });
});
