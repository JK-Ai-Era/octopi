/**
 * 附件图像水合（附件路线 wire 面）测试
 *
 * 覆盖 arch/file-read-image-view.md §0/§2.1 的引用路线 + M1-B 评审加固：
 * - hydrateAttachmentImages：url 形态 ImageBlock → data 形态（真坐标 containment）
 * - B2 回归：目录符号链接逃逸必须拒绝（词法前缀可绕，实测）
 * - 越界 / 缺失 / 非图像 → 不水合 + **原因标注**（wire 降级文字带因，M6）
 * - 模型无图像能力 / 结果已老化 → 直接跳过（不读盘，M4）
 * - 克隆式变换 + memo：不改传入消息
 * - wire 端到端：file_read → createToolAttachmentStore → assemble → image_url data 形态
 * - M3：摘要路径（buildRequestView）与主请求同形水合
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFile, mkdtemp, rm, mkdir, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { hydrateAttachmentImages } from '@octopi-agent/engine/harness/session/attachments/hydrate.js';
import { createToolAttachmentStore } from '@octopi-agent/engine/harness/session/attachments/service.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import { createFileReadTool } from '@octopi-agent/engine/harness/extension/plugin-ecosystem/tools/builtin.js';
import type { Message } from '@octopi-agent/core/types.js';

let root: string; // sessionsDir
let imgPath: string; // <root>/<sid>/attachments/a.png
let outsideDir: string;
const SID = 's1';

function opts(extra?: Record<string, unknown>): Parameters<typeof hydrateAttachmentImages>[1] {
  const attRoot = join(root, SID, 'attachments');
  const derivedRoot = join(root, SID, 'derived');
  return { roots: [attRoot, derivedRoot], derivedRoot, modelInput: ['text', 'image'], ...extra };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'attach-hydrate-'));
  outsideDir = await mkdtemp(join(tmpdir(), 'attach-outside-'));
  await mkdir(join(root, SID, 'attachments'), { recursive: true });
  imgPath = join(root, SID, 'attachments', 'a.png');
  await writeFile(
    imgPath,
    await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer(),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

type LooseBlock = { type?: string; data?: string; url?: string; note?: string; [key: string]: unknown };

function userImageMessage(url: string): Message {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      { type: 'image', url, mimeType: 'image/png', alt: 'a.png' },
    ],
  } as unknown as Message;
}

function toolEnvelopeMessage(result: unknown, toolCallId = 'c1'): Message {
  return {
    role: 'tool',
    content: '',
    toolResults: [{ toolCallId, name: 'file_read', result }],
    timestamp: Date.now(),
  } as unknown as Message;
}

describe('hydrateAttachmentImages', () => {
  it('root 内 url 形态 → data 形态（字节与文件一致；原文不动）', async () => {
    const msgs = [userImageMessage(imgPath)];
    const out = await hydrateAttachmentImages(msgs, opts());
    const blocks = out[0].content as unknown as LooseBlock[];
    expect(blocks[1].data).toBeTruthy();
    expect(blocks[1].url).toBe(imgPath);
    expect(out[0]).not.toBe(msgs[0]);
    expect(((msgs[0].content as unknown as LooseBlock[])[1]).data).toBeUndefined();
  });

  it('B2 回归：目录符号链接逃逸必须拒绝（真坐标 containment）', async () => {
    const outsideImg = join(outsideDir, 'secret.png');
    await writeFile(
      outsideImg,
      await sharp({ create: { width: 4, height: 4, channels: 3, background: '#0f0' } }).png().toBuffer(),
    );
    const linkDir = join(root, SID, 'attachments', 'linkdir');
    await rm(linkDir, { recursive: true, force: true });
    await symlink(outsideDir, linkDir, 'dir');
    const evilUrl = join(linkDir, 'secret.png');
    const out = await hydrateAttachmentImages([userImageMessage(evilUrl)], opts());
    const blocks = out[0].content as unknown as LooseBlock[];
    expect(blocks[1].data).toBeUndefined();
    expect(blocks[1].note).toContain('outside attachment roots');
  });

  it('越界 / 缺失 / 非图像 → 不水合 + 原因标注（M6）', async () => {
    const outside = join(outsideDir, `not-under-${Date.now()}.png`);
    const missing = join(root, SID, 'attachments', 'gone.png');
    const notImage = join(root, SID, 'attachments', 'note.txt');
    await writeFile(notImage, 'hello');
    const msgs = [userImageMessage(outside), userImageMessage(missing), userImageMessage(notImage)];
    const out = await hydrateAttachmentImages(msgs, opts());
    for (const m of out) {
      const blocks = m.content as unknown as LooseBlock[];
      expect(blocks[1].data).toBeUndefined();
      expect(blocks[1].note).toBeTruthy(); // 降级文字可带因
    }
  });

  it('data / 远程形态原样通过（同引用）', async () => {
    const dataBlock: Message = {
      role: 'user',
      content: [
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        { type: 'image', url: 'https://example.com/x.png' },
      ],
    } as unknown as Message;
    const out = await hydrateAttachmentImages([dataBlock], opts());
    expect(out[0]).toBe(dataBlock);
  });

  it('模型无图像能力 → 整批跳过（不读盘，M4）', async () => {
    const msgs = [userImageMessage(imgPath)];
    const out = await hydrateAttachmentImages(msgs, opts({ modelInput: ['text'] }));
    expect(out[0]).toBe(msgs[0]);
  });

  it('已老化结果的信封块跳过（M4）', async () => {
    const result = {
      kind: 'image',
      contentBlocks: [{ type: 'image', url: imgPath, mimeType: 'image/png', alt: 'a.png' }],
    };
    const out = await hydrateAttachmentImages([toolEnvelopeMessage(result)], opts({
      agedToolCallIds: new Set(['c1']),
    }));
    const blocks = (out[0].toolResults![0].result as { contentBlocks: LooseBlock[] }).contentBlocks;
    expect(blocks[0].data).toBeUndefined();
  });

  it('信封块水合：result.contentBlocks url → data，且原 result 不动', async () => {
    const result = {
      kind: 'image',
      path: imgPath,
      contentBlocks: [{ type: 'image', url: imgPath, mimeType: 'image/png', alt: 'a.png' }],
    };
    const msgs = [toolEnvelopeMessage(result)];
    const out = await hydrateAttachmentImages(msgs, opts());
    const blocks = (out[0].toolResults![0].result as { contentBlocks: LooseBlock[] }).contentBlocks;
    expect(blocks[0].data).toBeTruthy();
    expect((result.contentBlocks[0] as unknown as { data?: string }).data).toBeUndefined();
  });
});

describe('wire 端到端（file_read → 真派生存储 → assemble）', () => {
  it('引用路线全链：file_read 入库 → 水合 → image_url data 形态', async () => {
    // file_read 读一张「用户上传区」图（成本闸后入库 derived/）
    const store = createToolAttachmentStore({ sessionsDir: root, sessionId: SID });
    const tool = createFileReadTool();
    const res = (await tool.handler(
      { path: imgPath },
      {
        sessionId: SID,
        agentId: 'a1',
        messages: [],
        modelInput: ['text', 'image'],
        attachments: store,
        fileEffects: { recordWrite: async () => {}, recordDelete: async () => {} },
        memoryEffects: { recordWrite: async () => {}, recordDelete: async () => {} },
      } as never,
    )) as Record<string, unknown>;
    expect(res.attachmentId).toBeTruthy();
    // 零 base64：结果只放引用
    expect(JSON.stringify(res)).not.toContain('iVBOR');

    const engine = new DefaultContextEngine({ imageAttachRoot: root });
    const out = await engine.assemble({
      sessionId: SID,
      systemPrompt: 'sys',
      tools: [],
      messages: [toolEnvelopeMessage(res)],
      modelInput: ['text', 'image'],
    });
    const view = JSON.stringify(out.messages);
    expect(view).toContain('image_url');
    expect(view).toContain('data:image/png;base64,');
  });

  it('用户附件图 → wire image_url data 形态（同一水合实现）', async () => {
    const engine = new DefaultContextEngine({ imageAttachRoot: root });
    const out = await engine.assemble({
      sessionId: SID,
      systemPrompt: 'sys',
      tools: [],
      messages: [userImageMessage(imgPath)],
      modelInput: ['text', 'image'],
    });
    expect(JSON.stringify(out.messages)).toContain('data:image/png;base64,');
  });

  it('无 imageAttachRoot → 不水合（url 形态降级文字指针）', async () => {
    const engine = new DefaultContextEngine();
    const out = await engine.assemble({
      sessionId: SID,
      systemPrompt: 'sys',
      tools: [],
      messages: [userImageMessage(imgPath)],
      modelInput: ['text', 'image'],
    });
    const view = JSON.stringify(out.messages);
    expect(view).not.toContain('data:image/png;base64,');
    expect(view).toContain('[image:');
  });
});

describe('createToolAttachmentStore（派生媒体内容寻址，B1/M5）', () => {
  it('同字节天然去重（幂等），id = sha256 + 载荷扩展名', async () => {
    const store = createToolAttachmentStore({ sessionsDir: root, sessionId: 's-dedup' });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const id1 = await store.save({ name: 'whatever.dat', mimeType: 'image/png', data: bytes });
    const id2 = await store.save({ name: 'other-name.png', mimeType: 'image/png', data: bytes });
    expect(id1).toBe(id2); // 内容寻址：与源文件名/扩展名无关
    expect(id1.endsWith('.png')).toBe(true); // 扩展名按载荷 MIME
    const abs = store.absolutePath(id1);
    expect(Buffer.from(await readFile(abs))).toEqual(Buffer.from(bytes));
  });

  it('absolutePath 拒绝穿越 id（containment）', () => {
    const store = createToolAttachmentStore({ sessionsDir: root, sessionId: 's-dedup' });
    expect(() => store.absolutePath('../attachments/.manifest.json')).toThrow(/invalid attachment id/);
  });

  it('不占用户附件配额：连续 20 次 save 不失败（对比 manifest 8 张上限）', async () => {
    const store = createToolAttachmentStore({ sessionsDir: root, sessionId: 's-quota' });
    for (let i = 0; i < 20; i++) {
      await store.save({ name: `img${i}.png`, mimeType: 'image/png', data: new Uint8Array([i, 1, 2]) });
    }
  });
});
