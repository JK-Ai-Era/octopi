/**
 * 图像能力门控（P1）测试
 *
 * 覆盖 arch/file-read-image-view.md §2.3：
 * - `modelAcceptsInput` 唯一判据出口（缺省 = 纯文本）
 * - `convertMessage` 图像降级判据 =「数据形态 ∧ 模型能力」
 *
 * 行为而非实现：断言请求视图里图像块的形态（image_url vs 文字指针）。
 */

import { describe, it, expect } from 'vitest';
import { modelAcceptsInput } from '@octopi-agent/core/types.js';
import type { Message, ModelInputType } from '@octopi-agent/core/types.js';
import { DefaultContextEngine } from '@octopi-agent/engine/harness/context/default-context-engine.js';
import type { AssembleParams } from '@octopi-agent/engine/harness/context/types.js';

function makeParams(overrides: Partial<AssembleParams> & { messages: Message[] }): AssembleParams {
  return {
    sessionId: 'test-session',
    systemPrompt: 'You are helpful.',
    tools: [],
    ...overrides,
  };
}

function imageMessage(opts: { data?: string; url?: string }): Message {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'look at this' },
      {
        type: 'image',
        ...(opts.data !== undefined ? { data: opts.data } : {}),
        ...(opts.url !== undefined ? { url: opts.url } : {}),
        mimeType: 'image/png',
        alt: 'photo.png',
      },
    ],
    timestamp: Date.now(),
  };
}

/** 装配一次并序列化请求视图（转换后的 LLM 消息） */
async function assembleView(overrides: Partial<AssembleParams> & { messages: Message[] }): Promise<string> {
  const engine = new DefaultContextEngine();
  const result = await engine.assemble(makeParams(overrides));
  return JSON.stringify(result.messages);
}

describe('modelAcceptsInput（唯一判据出口）', () => {
  it('未声明 = 纯文本：text 收、其余拒', () => {
    expect(modelAcceptsInput(undefined, 'text')).toBe(true);
    expect(modelAcceptsInput(null, 'image')).toBe(false);
    expect(modelAcceptsInput(undefined, 'image')).toBe(false);
    expect(modelAcceptsInput(undefined, 'audio')).toBe(false);
  });

  it('显式声明按声明执行', () => {
    expect(modelAcceptsInput(['text', 'image'], 'image')).toBe(true);
    expect(modelAcceptsInput(['text'], 'image')).toBe(false);
    expect(modelAcceptsInput(['text', 'image'], 'audio')).toBe(false);
    expect(modelAcceptsInput(['text', 'image', 'audio', 'video'], 'video')).toBe(true);
  });
});

describe('convertMessage 图像降级判据 = 数据形态 ∧ 模型能力', () => {
  it('有 image 能力 + base64 数据 → 发 image_url 块', async () => {
    const view = await assembleView({
      messages: [imageMessage({ data: 'aGVsbG8=' })],
      modelInput: ['text', 'image'],
    });
    expect(view).toContain('image_url');
    expect(view).toContain('data:image/png;base64,aGVsbG8=');
    expect(view).not.toContain('model has no image input');
  });

  it('有 image 能力 + http(s) URL → 发 image_url 块', async () => {
    const view = await assembleView({
      messages: [imageMessage({ url: 'https://example.com/a.png' })],
      modelInput: ['text', 'image'],
    });
    expect(view).toContain('image_url');
    expect(view).toContain('https://example.com/a.png');
  });

  it('无 image 能力（声明纯文本）→ 降为文字指针并显式标注原因', async () => {
    const view = await assembleView({
      messages: [imageMessage({ data: 'aGVsbG8=' })],
      modelInput: ['text'],
    });
    expect(view).not.toContain('image_url');
    expect(view).toContain('[image: photo.png');
    expect(view).toContain('model has no image input');
  });

  it('modelInput 缺省 = 纯文本 → 同样降级（不白烧图像 token）', async () => {
    const view = await assembleView({
      messages: [imageMessage({ data: 'aGVsbG8=' })],
    });
    expect(view).not.toContain('image_url');
    expect(view).toContain('model has no image input');
  });

  it('本地路径 + 有 image 能力 → 仍降文字指针（数据形态半区生效），不带能力标注', async () => {
    const view = await assembleView({
      messages: [imageMessage({ url: '/tmp/a.png' })],
      modelInput: ['text', 'image'],
    });
    expect(view).not.toContain('image_url');
    expect(view).toContain('path: /tmp/a.png');
    expect(view).not.toContain('model has no image input');
  });

  it('纯文本消息不受判据影响', async () => {
    const view = await assembleView({
      messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      modelInput: ['text'],
    });
    expect(view).toContain('hello');
  });
});
