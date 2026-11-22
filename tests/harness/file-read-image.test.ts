/**
 * file_read 图像查看（P2）测试
 *
 * 覆盖 arch/file-read-image-view.md §2.1/§2.2/§2.5：
 * - 魔数嗅探（伪装扩展名必须识别）
 * - 成本闸：降采样 + 上限 fail-loud（拒绝而非截断）
 * - view 三态（auto/text/both；render 对光栅等价 auto）
 * - 图像引用：result.imageRef 挂图 + 文本指针（零 base64）；信封已废除（遗留消毒见 stripLegacyRichContent）
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
  readImageRef,
  stripLegacyRichContent,
} from '@octopi-agent/engine/harness/context/tool-result-body.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import type { Message, ToolResult } from '@octopi-agent/core/types.js';
import type { ToolAttachmentStore, ToolExecutionContext } from '@octopi-agent/core/types/tools.js';

// ── fixtures ──────────────────────────────────────────────────────────

let dir: string;

/** 内存/落盘假附件存储（附件路线：字节入库、结果只放引用） */
function fakeAttachmentStore(): { store: ToolAttachmentStore; paths: Map<string, string> } {
  const paths = new Map<string, string>();
  let n = 0;
  return {
    paths,
    store: {
      async save(input: { name: string; mimeType: string; data: Uint8Array }): Promise<string> {
        const { mkdir } = await import('node:fs/promises');
        const id = `att-${++n}`;
        await mkdir(join(dir, 'attach-store'), { recursive: true });
        const abs = join(dir, 'attach-store', `${id}-${input.name}`);
        await writeFile(abs, Buffer.from(input.data));
        paths.set(id, abs);
        return id;
      },
      absolutePath(attachmentId: string): string {
        const p = paths.get(attachmentId);
        if (!p) throw new Error(`unknown attachment ${attachmentId}`);
        return p;
      },
    },
  };
}

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
    // 附件路线：默认给假附件存储（引用路线的前置）
    attachments: fakeAttachmentStore().store,
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

// ── 引用路线：序列化往返与零 base64（§0/§2.1）────────────────────────

describe('引用路线：序列化往返与零 base64（M1 钉）', () => {
  it('结果只放引用：JSON 往返后引用块不丢、全文零 base64', async () => {
    const p = await pngFixture(16, 16, 'roundtrip.png');
    const { readFile } = await import('node:fs/promises');
    const result = await readImage(p);
    // M1 钉：result 不携带图像字节（iVBOR = PNG base64 魔数）
    const json = JSON.stringify(result);
    expect(json).not.toContain('iVBOR');
    expect(json.length).toBeLessThan(4000);
    expect(result.imageRef).toBeTruthy();

    const messages: Message[] = [
      { role: 'tool', content: '', toolResults: [{ toolCallId: 'c1', name: 'file_read', result }], timestamp: Date.now() },
    ];
    const revived = JSON.parse(JSON.stringify(messages)) as Message[];
    const ref = readImageRef(revived[0].toolResults?.[0].result);
    expect(ref).not.toBeNull();
    const url = ref!.url;
    expect(url).toBeTruthy();
    // 引用可读回载荷（派生媒体区 = 字节唯一居所）
    expect((await readFile(url as string)).length).toBeGreaterThan(0);
    // 序列化往返不改变正文序列化行为（工具文本无 base64）
    expect(toolResultBody(revived[0].toolResults![0])).toBe(toolResultBody({ result }));
    expect(toolResultBody(revived[0].toolResults![0])).not.toContain('iVBOR');
  });

  it('遗留信封消毒（防泄漏闸，gateway conversation adapter 同源）', async () => {
    const p = await pngFixture(16, 16, 'projection.png');
    const res = await readImage(p);
    const stripped = stripLegacyRichContent(res) as Record<string, unknown>;
    expect(stripped.contentBlocks).toBeUndefined();
    expect(stripped.attached).toBe(true); // 指针元信息保留
    // v0.123.x 遗留 data 信封必须被剥离（防 base64 泄入展示/文本）
    const legacy = { content: 'ok', contentBlocks: [{ type: 'image', data: 'iVBORw0KGgo=' }] };
    expect((stripLegacyRichContent(legacy) as Record<string, unknown>).contentBlocks).toBeUndefined();
    // 无遗留字段原样返回同一引用（避免无谓分配）
    const plain = { content: 'hello' };
    expect(stripLegacyRichContent(plain)).toBe(plain);
  });

  it('无附件端口（库路径）→ 显式降级指针，不塞字节', async () => {
    const p = await pngFixture(60, 60, 'nostore.png');
    const result = await readImage(p, {}, toolContext({ attachments: undefined }));
    expect(result.attached).toBe(false);
    expect(result.imageRef).toBeUndefined();
    expect(String(result.note)).toContain('attachment store unavailable');
    expect(JSON.stringify(result)).not.toContain('iVBOR');
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
    expect(gated.bytes.length).toBeGreaterThan(0);
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
    expect(result.imageRef).toBeTruthy();
  });

  it('text：只回元信息，不挂图', async () => {
    const p = await pngFixture(300, 200, 'text-view.png');
    const result = await readImage(p, { view: 'text' });
    expect(result.attached).toBe(false);
    expect(result.imageRef).toBeUndefined();
    expect(result.width).toBe(300);
    expect(String(result.note)).toContain('metadata only');
  });

  it('both：元信息 + 挂图', async () => {
    const p = await pngFixture(120, 90, 'both.png');
    const result = await readImage(p, { view: 'both' });
    expect(result.attached).toBe(true);
    expect(result.imageRef).toBeTruthy();
  });

  it('render 对光栅图等价 auto（SVG render 归 P3）', async () => {
    const p = await pngFixture(50, 50, 'render.png');
    const result = await readImage(p, { view: 'render' });
    expect(result.attached).toBe(true);
    expect(result.imageRef).toBeTruthy();
  });

  it('非法 view → fail-loud', async () => {
    const p = await pngFixture(10, 10, 'bad-view.png');
    await expect(readImage(p, { view: 'bogus' })).rejects.toThrow(/invalid view/);
  });

  it('模型无 image 输入 → 只回指针+元信息（不挂图不白烧）', async () => {
    const p = await pngFixture(200, 100, 'novision.png');
    const result = await readImage(p, {}, toolContext({ modelInput: ['text'] }));
    expect(result.attached).toBe(false);
    expect(result.imageRef).toBeUndefined();
    expect(String(result.note)).toContain('no image input');
  });

  it('文本文件走文本路不受 view 影响', async () => {
    const p = join(dir, 'plain.txt');
    await writeFile(p, 'hello\nworld\n');
    const result = await readImage(p);
    expect(result.content).toBe('hello\nworld\n');
    expect(result.imageRef).toBeUndefined();
  });
});

// ── toolResultBody 遗留信封消毒（防 base64 入 tool 文本）──────────────

describe('toolResultBody 遗留信封消毒', () => {
  it('v0.123.x 遗留 contentBlocks 不进文本序列化', () => {
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

  it('无遗留字段结果序列化不变', () => {
    const tr: ToolResult = { toolCallId: 't1', name: 'file_read', result: { content: 'hi', totalLines: 1 } };
    expect(toolResultBody(tr)).toBe(JSON.stringify(tr.result));
  });

  it('readImageRef 只认 imageRef（信封读口已废除）', () => {
    expect(readImageRef(null)).toBeNull();
    expect(readImageRef({ imageRef: 'no' })).toBeNull();
    expect(readImageRef({ contentBlocks: [{ type: 'image' }] })).toBeNull(); // 遗留信封不作数
    expect(readImageRef({ imageRef: { url: '/x' } })).toEqual({ url: '/x' });
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
    imageRef: { data: 'aGVsbG8=', mimeType: 'image/png', alt: 'a.png' },
  };

  it('imageRef → wire image_url（有能力模型；data 形态为水合后视图形状）', async () => {
    const view = await viewOf([toolMessage(imageResult)], ['text', 'image']);
    expect(view).toContain('image_url');
    expect(view).toContain('data:image/png;base64,aGVsbG8=');
    expect(view).toContain('/shots/a.png');
  });

  it('tool 文本指针不含 base64（载荷只走图像通道）', async () => {
    const view = await viewOf([toolMessage(imageResult)], ['text', 'image']);
    const parsed = JSON.parse(view) as Array<{ role: string; content: unknown }>;
    const toolText = String(parsed.find((m) => m.role === 'tool')?.content ?? '');
    expect(toolText).not.toContain('aGVsbG8=');
    // 图像载荷只出现在图像通道（image_url data URL）
    expect(view).toContain('data:image/png;base64,');
  });

  it('纯文本模型 → imageRef 降级为文字（含原因标注）', async () => {
    const view = await viewOf([toolMessage(imageResult)], ['text']);
    expect(view).not.toContain('image_url');
    expect(view).not.toContain('aGVsbG8=');
    expect(view).toContain('no image input');
  });

  it('无引用的工具结果不受影响', async () => {
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
    expect(res.imageRef).toBeUndefined();
    expect(String(res.note)).toContain('bmp decode not supported');
    expect(res.width).toBe(8);
  });

  it('无缩放且体积在闸内：原样放行（字节级不变，不重编码）', async () => {
    const { readFile } = await import('node:fs/promises');
    const p = await pngFixture(50, 50, 'passthrough.png');
    const original = await readFile(p);
    const gated = await applyImageCostGate(original, 'png', DEFAULT_IMAGE_COST_GATE);
    expect(gated.resized).toBe(false);
    expect(gated.bytes.equals(original)).toBe(true);
  });

  it('噪点 PNG 超 maxBytes：WebP 兜底转码而非报错（M4）', async () => {
    const noise = Buffer.alloc(1600 * 1200 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 1103515245 + 12345) & 0xff;
    const png = await sharp(noise, { raw: { width: 1600, height: 1200, channels: 3 } }).png().toBuffer();
    const gated = await applyImageCostGate(png, 'png', DEFAULT_IMAGE_COST_GATE);
    expect(gated.resized).toBe(true);
    expect(gated.mimeType).toBe('image/webp');
    expect(String(gated.note)).toContain('transcoded to webp');
    expect(gated.sizeBytes).toBeLessThanOrEqual(DEFAULT_IMAGE_COST_GATE.maxBytes);
  });

  it('纯文本文件 + 非法 view → fail-loud（不再静默忽略，minor2）', async () => {
    const p = join(dir, 'plain.txt');
    await writeFile(p, 'hello');
    await expect(readImage(p, { view: 'foo' })).rejects.toThrow(/invalid view/);
  });
});
