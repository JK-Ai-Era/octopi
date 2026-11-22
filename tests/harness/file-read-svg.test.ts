/**
 * file_read SVG 双模式（P3）测试
 *
 * 覆盖 arch/file-read-image-view.md §2.2 + §5：
 * - SVG 嗅探（认内容不认扩展名；前导声明/DOCTYPE/注释跳过）
 * - view 双模式：auto/text → 源码即产物；render/both → resvg 光栅化
 * - SVG 非脚本安全：<script> 不执行、外部 http/file 引用不拉取（安全姿势固化）
 * - 成本闸：固有尺寸 maxPixels 拒绝、zoom 降采样、非法 SVG fail-loud
 * - 无 image 输入模型 → 指针 + 降级标注（不渲染）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createFileReadTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/builtin.js';
import {
  sniffSvg,
  probeSvgSize,
  renderSvgImage,
  DEFAULT_IMAGE_COST_GATE,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/image-view.js';
import type { ToolExecutionContext } from '@octopi-agent/core/types/tools.js';

// ── fixtures ──────────────────────────────────────────────────────────

let dir: string;

async function svgFixture(svg: string, name: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, svg, 'utf-8');
  return path;
}

function toolContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    sessionId: 's1',
    agentId: 'a1',
    messages: [],
    // P1 语义：能力声明缺省 = 纯文本——测试默认声明 vision
    modelInput: ['text', 'image'],
    fileEffects: {
      recordWrite: async () => {},
      recordDelete: async () => {},
    },
    memoryEffects: {
      recordWrite: async () => {},
      recordDelete: async () => {},
    },
    ...overrides,
  } as ToolExecutionContext;
}

async function readSvg(
  path: string,
  args: Record<string, unknown> = {},
  context: ToolExecutionContext = toolContext(),
): Promise<Record<string, unknown>> {
  const tool = createFileReadTool();
  return (await tool.handler({ path, ...args }, context)) as Record<string, unknown>;
}

/** 解码 contentBlocks[0] 的 PNG 并采样 (x,y) 像素 */
async function pixelAt(result: Record<string, unknown>, x: number, y: number): Promise<[number, number, number]> {
  const blocks = result.contentBlocks as { data: string; mimeType: string }[] | undefined;
  expect(blocks).toHaveLength(1);
  expect(blocks[0].mimeType).toBe('image/png');
  const png = Buffer.from(blocks[0].data, 'base64');
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const idx = (y * info.width + x) * info.channels;
  return [data[idx], data[idx + 1], data[idx + 2]];
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'file-read-svg-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ── 嗅探（认内容不认扩展名）──────────────────────────────────────────

describe('SVG 嗅探', () => {
  it('前导 XML 声明/DOCTYPE/注释后 <svg> → true', () => {
    const doc = `<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd">\n<!-- a comment -->\n<svg xmlns="http://www.w3.org/2000/svg"/>`;
    expect(sniffSvg(Buffer.from(doc))).toBe(true);
  });

  it('大小写不敏感；<svgfoo / HTML / 中段含 <svg → false', () => {
    expect(sniffSvg(Buffer.from('<SVG width="1"></SVG>'))).toBe(true);
    expect(sniffSvg(Buffer.from('<svgfoo bar="1"></svgfoo>'))).toBe(false);
    expect(sniffSvg(Buffer.from('<html><body><svg></svg></body></html>'))).toBe(false);
    expect(sniffSvg(Buffer.from('hello world\n<svg></svg>'))).toBe(false);
    expect(sniffSvg(Buffer.from('not svg at all'))).toBe(false);
  });
});

describe('SVG 尺寸探测', () => {
  it('width/height px 数值 → 直取；viewBox → 兜底', () => {
    expect(probeSvgSize('<svg width="40" height="30"></svg>')).toEqual({ width: 40, height: 30 });
    expect(probeSvgSize(`<svg width="40px" height="30px"></svg>`)).toEqual({ width: 40, height: 30 });
    expect(probeSvgSize('<svg viewBox="0 0 40 30"></svg>')).toEqual({ width: 40, height: 30 });
    expect(probeSvgSize('<svg viewBox="0,0,12.5,8.2"></svg>')).toEqual({ width: 13, height: 9 });
  });

  it('百分比/物理单位不换算 → 回退 viewBox；全无 → null', () => {
    expect(probeSvgSize('<svg width="50%" height="50%" viewBox="0 0 40 30"></svg>')).toEqual({
      width: 40,
      height: 30,
    });
    expect(probeSvgSize('<svg width="10pt" height="10pt"></svg>')).toBeNull();
    expect(probeSvgSize('<svg></svg>')).toBeNull();
  });
});

// ── view 双模式 ───────────────────────────────────────────────────────

describe('view 双模式：auto/text = 源码即产物', () => {
  const src = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';

  it('auto（缺省）与 text → 返回源码文本，不挂图', async () => {
    const p = await svgFixture(src, 'plain.svg');
    for (const args of [{}, { view: 'auto' }, { view: 'text' }]) {
      const res = await readSvg(p, args);
      expect(res.content).toContain('<rect');
      expect(res.contentBlocks).toBeUndefined();
    }
  });

  it('非法 view 在 SVG 上 fail-loud', async () => {
    const p = await svgFixture(src, 'badview.svg');
    await expect(readSvg(p, { view: 'foo' })).rejects.toThrow(/invalid view/);
  });
});

describe('view render/both → resvg 光栅化', () => {
  const src = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>';

  it('render → 挂 PNG 图，指针元信息齐', async () => {
    const p = await svgFixture(src, 'render.svg');
    const res = await readSvg(p, { view: 'render' });
    expect(res.kind).toBe('svg');
    expect(res.mimeType).toBe('image/svg+xml');
    expect(res.renderedMime).toBe('image/png');
    expect(res.attached).toBe(true);
    expect(res.width).toBe(20);
    expect(res.height).toBe(20);
    const [r, g, b] = await pixelAt(res, 10, 10);
    expect([r, g, b]).toEqual([255, 0, 0]);
  });

  it('both → 源码文本 + 挂图', async () => {
    const p = await svgFixture(src, 'both.svg');
    const res = await readSvg(p, { view: 'both' });
    expect(res.content).toContain('<rect');
    expect(res.attached).toBe(true);
    const [r] = await pixelAt(res, 10, 10);
    expect(r).toBe(255);
  });

  it('大 SVG zoom 降采样到长边 ≤ maxEdge', async () => {
    const big = '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1000"><rect width="2000" height="1000" fill="red"/></svg>';
    const p = await svgFixture(big, 'big.svg');
    const res = await readSvg(p, { view: 'render' });
    expect(res.resized).toBe(true);
    expect(res.width as number).toBeLessThanOrEqual(DEFAULT_IMAGE_COST_GATE.maxEdge);
    expect(res.height as number).toBeLessThanOrEqual(DEFAULT_IMAGE_COST_GATE.maxEdge);
  });
});

// ── 安全姿势固化（§2.2 禁止执行脚本/拉取外部引用）────────────────────

describe('非脚本渲染器安全姿势', () => {
  it('<script> 不执行：脚本改色不生效（像素仍为红色）', async () => {
    const src = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">
  <rect id="r" width="20" height="20" fill="red"/>
  <script>document.getElementById('r').setAttribute('fill','blue');</script>
</svg>`;
    const p = await svgFixture(src, 'script.svg');
    const res = await readSvg(p, { view: 'render' });
    const [r, g, b] = await pixelAt(res, 10, 10);
    expect([r, g, b]).toEqual([255, 0, 0]);
  });

  it('外部 http 引用不拉取：本地探针服务零请求', async () => {
    let hits = 0;
    const server: Server = createServer((_req, res) => {
      hits += 1;
      res.end('x');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const src = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="20" height="20">
  <rect width="20" height="20" fill="white"/>
  <image x="5" y="5" width="10" height="10" href="http://127.0.0.1:${port}/leak.png"/>
  <use xlink:href="http://127.0.0.1:${port}/leak.svg#x"/>
</svg>`;
      const p = await svgFixture(src, 'href-http.svg');
      const res = await readSvg(p, { view: 'render' });
      expect(res.attached).toBe(true);
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('外部文件引用不拉取：本地 PNG 未被加载（像素仍白）', async () => {
    const secret = join(dir, 'secret-green.png');
    await writeFile(
      secret,
      await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 255, b: 0 } } })
        .png()
        .toBuffer(),
    );
    const src = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">
  <rect width="20" height="20" fill="white"/>
  <image x="5" y="5" width="10" height="10" href="file://${secret}"/>
</svg>`;
    const p = await svgFixture(src, 'href-file.svg');
    const res = await readSvg(p, { view: 'render' });
    const [r, g, b] = await pixelAt(res, 10, 10);
    expect([r, g, b]).toEqual([255, 255, 255]);
  });
});

// ── 成本闸与降级 ─────────────────────────────────────────────────────

describe('成本闸与降级', () => {
  it('固有尺寸超 maxPixels → fail-loud 拒绝', async () => {
    const huge = '<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"><rect/></svg>';
    const p = await svgFixture(huge, 'huge.svg');
    await expect(readSvg(p, { view: 'render' })).rejects.toThrow(/image_too_large/);
  });

  it('尺寸无法确定 → fail-loud（不猜尺寸渲染）', async () => {
    const noSize = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>';
    const p = await svgFixture(noSize, 'nosize.svg');
    await expect(readSvg(p, { view: 'render' })).rejects.toThrow(/svg_probe_failed/);
  });

  it('非法 SVG（可嗅探但不可渲染）→ fail-loud 渲染错误', async () => {
    const broken = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect';
    const p = await svgFixture(broken, 'broken.svg');
    await expect(readSvg(p, { view: 'render' })).rejects.toThrow(/svg_render_failed/);
  });

  it('无 image 输入模型 → 不渲染，指针 + 降级标注', async () => {
    const src = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
    const p = await svgFixture(src, 'novision.svg');
    const res = await readSvg(p, { view: 'render' }, toolContext({ modelInput: ['text'] }));
    expect(res.attached).toBe(false);
    expect(res.contentBlocks).toBeUndefined();
    expect(String(res.note)).toContain('no image input');
  });

  it('both + 无 image 输入 → 源码文本仍在，不挂图', async () => {
    const src = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
    const p = await svgFixture(src, 'novision-both.svg');
    const res = await readSvg(p, { view: 'both' }, toolContext({ modelInput: ['text'] }));
    expect(res.content).toContain('<rect');
    expect(res.attached).toBe(false);
    expect(res.contentBlocks).toBeUndefined();
  });
});

// ── renderSvgImage 直接面 ────────────────────────────────────────────

describe('renderSvgImage（直接面）', () => {
  it('maxBytes 超限 → fail-loud（拒绝而非截断）', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>';
    await expect(
      renderSvgImage(Buffer.from(svg), { ...DEFAULT_IMAGE_COST_GATE, maxBytes: 10 }),
    ).rejects.toThrow(/image_too_large/);
  });
});

// ── 评审修复回归（both 失败降级 / 字段语义）───────────────────────────

describe('评审修复回归（SVG both）', () => {
  it('both 渲染失败不连坐源码：源码照常返回 + renderError 显式标注', async () => {
    const broken = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect';
    const p = await svgFixture(broken, 'broken-both.svg');
    const res = await readSvg(p, { view: 'both' });
    expect(res.content).toContain('<rect');
    expect(res.attached).toBe(false);
    expect(String(res.renderError)).toContain('svg_render_failed');
    expect(String(res.note)).toContain('render failed');
  });

  it('both 字段语义：源文件元信息不被渲染载荷覆盖（minor5）', async () => {
    const src =
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>';
    const p = await svgFixture(src, 'both-fields.svg');
    const res = await readSvg(p, { view: 'both' });
    expect(res.width).toBe(20); // 源尺寸
    expect(res.sizeBytes).toBe(src.length); // 源文件字节
    expect(res.renderedWidth).toBe(20);
    expect(res.renderedBytes).toBeGreaterThan(0);
    expect(res.renderedMime).toBe('image/png');
  });

  it('无视觉 render：note 指向 view=auto/text 拿源码（minor3）', async () => {
    const src = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
    const p = await svgFixture(src, 'novision-note.svg');
    const res = await readSvg(p, { view: 'render' }, toolContext({ modelInput: ['text'] }));
    expect(String(res.note)).toContain('view=auto/text for source');
  });
});
