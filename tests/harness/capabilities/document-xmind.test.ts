/**
 * XMind T0 后端 — content.json / content.xml → Markdown 大纲
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  createDefaultDocumentPort,
  xmindJsonToMarkdown,
  xmindXmlToMarkdown,
} from '../../../packages/engine/src/harness/capabilities/document/index.js';

describe('xmindJsonToMarkdown', () => {
  it('walks nested attached children as outline', () => {
    const json = JSON.stringify([
      {
        title: 'Sheet A',
        rootTopic: {
          title: 'Root',
          children: {
            attached: [
              {
                title: 'L1',
                children: {
                  attached: [{ title: 'L2', note: { plain: 'hint' }, href: 'https://x' }],
                },
              },
              { title: 'Sibling' },
            ],
          },
        },
      },
    ]);
    const md = xmindJsonToMarkdown(json);
    expect(md).toContain('# Root');
    expect(md).toContain('- L1');
    expect(md).toContain('- L2');
    expect(md).toContain('（hint）');
    expect(md).toContain('<https://x>');
    expect(md).toContain('- Sibling');
    // L2 是 L1 的子节点 → 更深缩进
    expect(md).toMatch(/\n {2}- L2/);
  });
});

describe('xmindXmlToMarkdown', () => {
  it('parses XMind 8 topic nesting', () => {
    const xml = `<?xml version="1.0"?><map><sheet><topic><title>Root</title>
      <children><topics><topic><title>A</title>
        <children><topics><topic><title>A1</title></topic></topics></children>
      </topic><topic><title>B</title></topic></topics></children></topic></sheet></map>`;
    const md = xmindXmlToMarkdown(xml);
    expect(md).toContain('# Root');
    expect(md).toContain('- A');
    expect(md).toContain('- A1');
    expect(md).toContain('- B');
  });
});

describe('DocumentPort xmind (real optional dep)', () => {
  it('marks xmind native when fflate is present', async () => {
    const port = createDefaultDocumentPort();
    const caps = await port.capabilities();
    expect(caps.formats.xmind.level).toBe('native');
  });

  it('extracts sample cloud-tin research map when fixture exists', async () => {
    const sample = String.raw`C:\Users\James\.octopi\workspace\default\documents-test\云锡调研.xmind`;
    let data: Buffer;
    try {
      data = await readFile(sample);
    } catch {
      // 样本不在本机时跳过（CI/其它环境）
      return;
    }
    const port = createDefaultDocumentPort();
    const result = await port.extract({ data: new Uint8Array(data), name: '云锡调研.xmind' });
    expect(result.backend).toBe('xmind');
    expect(result.markdown).toContain('# 云锡');
    expect(result.markdown).toContain('组织架构');
    expect(result.markdown.length).toBeGreaterThan(500);
  });
});
