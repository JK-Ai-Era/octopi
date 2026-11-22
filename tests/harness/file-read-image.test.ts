/**
 * file_read 图像查看（P2）测试
 *
 * 覆盖 arch/file-read-image-view.md §2.1/§2.2/§2.5：
 * - 魔数嗅探（伪装扩展名必须识别）
 * - 成本闸：降采样 + 上限 fail-loud（拒绝而非截断）
 * - view 三态（auto/text/both；render 对光栅等价 auto）
 * - 富内容信封：result.contentBlocks 挂图 + 文本指针；toolResultBody 剥离防 base64 入文本
 * - convertMessage tool 分派：信封块 → wire 图像（能力判据复用 P1 落点）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createFileReadTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/builtin.js';
import {
  sniffRaster,
  probeRasterSize,
  applyImageCostGate,
  DEFAULT_IMAGE_COST_GATE,
} from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/image-view.js';
import {
  toolResultBody,
  extractContentBlocks,
  stripContentBlocks,
} from '@octopi-agent/engine/harness/context/tool-result-body.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import type { Message, ToolResult } from '@octopi-agent/core/types.js';
import type { ToolExecutionContext } from '@octopi-agent/core/types/tools.js';

// ── fixtures ──────────────────────────────────────────────────────────

let dir: string;

async function pngFixture(width: number, height: number, name: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
  }).png().toBuffer());
  return path;
}

function toolContext(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    sessionId: 's1',
    agentId: 'a1',
    messages: [],
    // P1 语义：能力声明缺省 = 纯文本（file_read 不挂图）——测试默认声明 vision
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

async function readImage(
  path: string,
  args: Record<string, unknown> = {},
  context: ToolExecutionContext = toolContext(),
): Promise<Record<string, unknown>> {
  const tool = createFileReadTool();
  return (await tool.handler({ path, ...args }, context)) as Record<string, unknown>;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'file-read-image-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ── 重放一致：序列化往返（§5）────────────────────────────────────────

describe('图像块序列化往返（session jsonl 持久面）', () => {
  it('Message JSON 往返后信封块不丢不变', async () => {
    const p = await pngFixture(16, 16, 'roundtrip.png');
    const res = await readImage(p);
    const messages: Message[] = [
      { role: 'tool', content: '', toolResults: [{ toolCallId: 'c1', name: 'file_read', result: res }] },
    ];
    const revived = JSON.parse(JSON.stringify(messages)) as Message[];
    const blocks = extractContentBlocks(revived[0].toolResults?.[0].result);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('image');
    expect((blocks[0] as { data: string }).data).toBe(
      (res.contentBlocks as { data: string }[])[0].data,
    );
    // 序列化往返不改变正文剥离行为（base64 永不入 tool 文本）
    expect(toolResultBody(revived[0].toolResults![0])).toBe(toolResultBody({ result: res }));
    expect(toolResultBody(revived[0].toolResults![0])).not.toContain(
      (res.contentBlocks as { data: string }[])[0].data,
    );
  });

  it('展示投影剥离信封（gateway conversation adapter 同源）', async () => {
    const p = await pngFixture(16, 16, 'projection.png');
    const res = await readImage(p);
    const stripped = stripContentBlocks(res) as Record<string, unknown>;
    expect(stripped.contentBlocks).toBeUndefined();
    expect(stripped.attached).toBe(true); // 指针元信息保留
    // 无信封结果原样返回同一引用（避免无谓分配）
    const plain = { content: 'hello' };
    expect(stripContentBlocks(plain)).toBe(plain);
  });
});

describe('魔数嗅探（认内容不认扩展名）', () => {
  it('PNG 字节 + .txt 扩展名 → 识别为 png', async () => {
    const p = await pngFixture(10, 10, 'disguised.txt');
    const { readFile } = await import('node:fs/promises');
    expect(sniffRaster(await readFile(p))).toBe('png');
  });

  it('JPEG/GIF/WebP/BMP 魔数可识别', async () => {
    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).gif().toBuffer();
    const webp = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).webp().toBuffer();
    const bmp = Buffer.alloc(30);
    bmp.write('BM', 0, 'ascii');
    bmp.writeUInt32LE(40, 14); // 合法 DIB 头尺寸（嗅探加固后纯 'BM'+零填充不再算 BMP）
    expect(sniffRaster(jpeg)).toBe('jpeg');
    expect(sniffRaster(gif)).toBe('gif');
    expect(sniffRaster(webp)).toBe('webp');
    expect(sniffRaster(bmp)).toBe('bmp');
  });

  it('文本/未知内容 → null（走文本路）', () => {
    expect(sniffRaster(Buffer.from('# hello world\n'))).toBeNull();
    expect(sniffRaster(Buffer.alloc(64))).toBeNull();
  });

  it('尺寸探测与 sharp 一致', async () => {
    const { readFile } = await import('node:fs/promises');
    const p = await pngFixture(37, 19, 'probe.png');
    const size = probeRasterSize(await readFile(p), 'png');
    expect(size).toEqual({ width: 37, height: 19 });
  });
});

// ── 成本闸 ────────────────────────────────────────────────────────────

describe('成本闸：降采样 + 上限 fail-loud', () => {
  it('大图降采样到长边 ≤ maxEdge', async () => {
    const { readFile } = await import('node:fs/promises');
    const p = await pngFixture(2000, 1000, 'big.png');
    const gated = await applyImageCostGate(await readFile(p), 'png', DEFAULT_IMAGE_COST_GATE);
    expect(gated.resized).toBe(true);
    expect(Math.max(gated.width, gated.height)).toBeLessThanOrEqual(DEFAULT_IMAGE_COST_GATE.maxEdge);
    expect(gated.sizeBytes).toBeLessThanOrEqual(DEFAULT_IMAGE_COST_GATE.maxBytes);
    expect(gated.block.data).toBeTruthy();
  });

  it('小图不放大（withoutEnlargement）', async () => {
    const { readFile } = await import('node:fs/promises');
    const p = await pngFixture(64, 32, 'small.png');
    const gated = await applyImageCostGate(await readFile(p), 'png', DEFAULT_IMAGE_COST_GATE);
    expect(gated.resized).toBe(false);
    expect(gated.width).toBe(64);
    expect(gated.height).toBe(32);
  });

  it('编码后超 maxBytes → fail-loud 抛错（拒绝而非截断）', async () => {
    const { readFile } = await import('node:fs/promises');
    const p = await pngFixture(800, 800, 'over.png');
    await expect(
      applyImageCostGate(await readFile(p), 'png', { ...DEFAULT_IMAGE_COST_GATE, maxBytes: 100 }),
    ).rejects.toThrow(/image_too_large.*maxBytes/s);
  });

  it('超 maxPixels → 解码前拒绝（解压炸弹防线）', async () => {
    const { readFile } = await import('node:fs/promises');
    const p = await pngFixture(100, 100, 'pixels.png');
    await expect(
      applyImageCostGate(await readFile(p), 'png', { ...DEFAULT_IMAGE_COST_GATE, maxPixels: 10 }),
    ).rejects.toThrow(/image_too_large|pixel/i);
  });
});

// ── file_read 图像分支：view 三态 + 信封 ──────────────────────────────

describe('file_read 图像分支', () => {
  it('auto（缺省）：挂图 + 文本指针', async () => {
    const p = await pngFixture(300, 200, 'auto.png');
    const result = await readImage(p);
    expect(result.kind).toBe('image');
    expect(result.attached).toBe(true);
    expect(result.mimeType).toBe('image/png');
    expect(result.width).toBe(300);
    expect(result.height).toBe(200);
    const blocks = extractContentBlocks(result);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('image');
  });

  it('text：只回元信息，不挂图', async () => {
    const p = await pngFixture(300, 200, 'text-view.png');
    const result = await readImage(p, { view: 'text' });
    expect(result.attached).toBe(false);
    expect(extractContentBlocks(result)).toHaveLength(0);
    expect(result.width).toBe(300);
    expect(String(result.note)).toContain('metadata only');
  });

  it('both：元信息 + 挂图', async () => {
    const p = await pngFixture(120, 90, 'both.png');
    const result = await readImage(p, { view: 'both' });
    expect(result.attached).toBe(true);
    expect(extractContentBlocks(result)).toHaveLength(1);
  });

  it('render 对光栅图等价 auto（SVG render 归 P3）', async () => {
    const p = await pngFixture(50, 50, 'render.png');
    const result = await readImage(p, { view: 'render' });
    expect(result.attached).toBe(true);
    expect(extractContentBlocks(result)).toHaveLength(1);
  });

  it('非法 view → fail-loud', async () => {
    const p = await pngFixture(10, 10, 'bad-view.png');
    await expect(readImage(p, { view: 'bogus' })).rejects.toThrow(/invalid view/);
  });

  it('模型无 image 输入 → 只回指针+元信息（不挂图不白烧）', async () => {
    const p = await pngFixture(200, 100, 'novision.png');
    const result = await readImage(p, {}, toolContext({ modelInput: ['text'] }));
    expect(result.attached).toBe(false);
    expect(extractContentBlocks(result)).toHaveLength(0);
    expect(String(result.note)).toContain('no image input');
  });

  it('文本文件走文本路不受 view 影响', async () => {
    const p = join(dir, 'plain.txt');
    await writeFile(p, 'hello\nworld\n');
    const result = await readImage(p);
    expect(result.content).toBe('hello\nworld\n');
    expect(extractContentBlocks(result)).toHaveLength(0);
  });
});

// ── 信封剥离（防 base64 入 tool 文本） ────────────────────────────────

describe('toolResultBody 信封剥离', () => {
  it('contentBlocks 不进文本序列化', () => {
    const tr: ToolResult = {
      toolCallId: 't1',
      name: 'file_read',
      result: {
        kind: 'image',
        path: '/x.png',
        contentBlocks: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      },
    };
    const body = toolResultBody(tr);
    expect(body).not.toContain('aGVsbG8=');
    expect(body).not.toContain('contentBlocks');
    expect(body).toContain('/x.png');
  });

  it('无信封结果序列化不变', () => {
    const tr: ToolResult = { toolCallId: 't1', name: 'file_read', result: { content: 'hi', totalLines: 1 } };
    expect(toolResultBody(tr)).toBe(JSON.stringify(tr.result));
  });

  it('extractContentBlocks 只认信封', () => {
    expect(extractContentBlocks(null)).toEqual([]);
    expect(extractContentBlocks({ contentBlocks: 'no' })).toEqual([]);
    expect(extractContentBlocks({ contentBlocks: [{ type: 'image' }, { notype: 1 }] })).toEqual([
      { type: 'image' },
    ]);
  });
});

// ── convertMessage tool 分派（信封 → wire 图像） ──────────────────────

describe('convertMessage 工具富内容分派', () => {
  function toolMessage(result: unknown): Message {
    return {
      role: 'tool',
      content: '',
      toolResults: [{ toolCallId: 'c1', name: 'file_read', result }],
      timestamp: Date.now(),
    };
  }

  async function viewOf(messages: Message[], modelInput?: Array<'text' | 'image' | 'audio' | 'video'>): Promise<string> {
    const engine = new DefaultContextEngine();
    const out = await engine.assemble({
      sessionId: 's',
      systemPrompt: 'sys',
      tools: [],
      messages,
      ...(modelInput ? { modelInput } : {}),
    });
    return JSON.stringify(out.messages);
  }

  const imageResult = {
    kind: 'image',
    path: '/shots/a.png',
    attached: true,
    contentBlocks: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', alt: 'a.png' }],
  };

  it('信封块 → wire image_url（有能力模型）', async () => {
    const view = await viewOf([toolMessage(imageResult)], ['text', 'image']);
    expect(view).toContain('image_url');
    expect(view).toContain('data:image/png;base64,aGVsbG8=');
    expect(view).toContain('/shots/a.png');
  });

  it('tool 文本指针不含 base64', async () => {
    const view = await viewOf([toolMessage(imageResult)], ['text', 'image']);
    expect(view).not.toContain('contentBlocks');
  });

  it('纯文本模型 → 信封降级为文字（含原因标注）', async () => {
    const view = await viewOf([toolMessage(imageResult)], ['text']);
    expect(view).not.toContain('image_url');
    expect(view).not.toContain('aGVsbG8=');
    expect(view).toContain('no image input');
  });

  it('无信封的工具结果不受影响', async () => {
    const view = await viewOf([toolMessage({ content: 'plain', totalLines: 3 })], ['text', 'image']);
    expect(view).toContain('plain');
    expect(view).not.toContain('image_url');
  });
});

// ── 评审修复回归（M3/M4/minor1/2）─────────────────────────────────────

describe('评审修复回归（光栅）', () => {
  it('BMP 嗅探加固：合法 DIB 头识别，垃圾头/文本不误判', () => {
    const realBmp = Buffer.alloc(64);
    realBmp.write('BM', 0, 'ascii');
    realBmp.writeUInt32LE(40, 14); // DIB 头尺寸 40（BITMAPINFOHEADER）
    expect(sniffRaster(realBmp)).toBe('bmp');
    expect(sniffRaster(Buffer.concat([Buffer.from('BM'), Buffer.alloc(30)]))).toBeNull();
    expect(sniffRaster(Buffer.from('BM is my initials'))).toBeNull();
  });

  it('BMP + vision：显式降级元信息指针（解码器不支持，不硬错不静默）', async () => {
    const bmp = Buffer.alloc(64);
    bmp.write('BM', 0, 'ascii');
    bmp.writeUInt32LE(40, 14);
    bmp.writeUInt32LE(8, 18);
    bmp.writeInt32LE(8, 22);
    const p = join(dir, 'degrade.bmp');
    await writeFile(p, bmp);
    const res = await readImage(p);
    expect(res.attached).toBe(false);
    expect(res.contentBlocks).toBeUndefined();
    expect(String(res.note)).toContain('bmp decode not supported');
    expect(res.width).toBe(8);
  });

  it('无缩放且体积在闸内：原样放行（字节级不变，不重编码）', async () => {
    const { readFile } = await import('node:fs/promises');
    const p = await pngFixture(50, 50, 'passthrough.png');
    const original = await readFile(p);
    const gated = await applyImageCostGate(original, 'png', DEFAULT_IMAGE_COST_GATE);
    expect(gated.resized).toBe(false);
    expect(Buffer.from(gated.block.data, 'base64').equals(original)).toBe(true);
  });

  it('噪点 PNG 超 maxBytes：WebP 兜底转码而非报错（M4）', async () => {
    const noise = Buffer.alloc(1600 * 1200 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 1103515245 + 12345) & 0xff;
    const png = await sharp(noise, { raw: { width: 1600, height: 1200, channels: 3 } }).png().toBuffer();
    const gated = await applyImageCostGate(png, 'png', DEFAULT_IMAGE_COST_GATE);
    expect(gated.resized).toBe(true);
    expect(gated.block.mimeType).toBe('image/webp');
    expect(String(gated.note)).toContain('transcoded to webp');
    expect(gated.sizeBytes).toBeLessThanOrEqual(DEFAULT_IMAGE_COST_GATE.maxBytes);
  });

  it('纯文本文件 + 非法 view → fail-loud（不再静默忽略，minor2）', async () => {
    const p = join(dir, 'plain.txt');
    await writeFile(p, 'hello');
    await expect(readImage(p, { view: 'foo' })).rejects.toThrow(/invalid view/);
  });
});
