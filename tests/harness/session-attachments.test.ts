/**
 * SessionAttachmentService 基础行为（OP-15）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionAttachmentService } from '../../src/harness/session/attachments/service.js';
import { sanitizeAttachmentName, isPathInside } from '../../src/harness/session/attachments/sanitize.js';
import {
  buildAttachmentMessageContent,
  buildAttachmentGroundingText,
  DEFAULT_EMPTY_ATTACHMENT_PROMPT,
} from '../../src/harness/session/attachments/inject.js';
import { fallbackInjectPlan, resolveInjectPlan } from '../../src/harness/session/attachments/intent.js';

describe('SessionAttachmentService', () => {
  let sessionsDir: string;
  let svc: SessionAttachmentService;

  beforeEach(async () => {
    sessionsDir = await mkdtemp(join(tmpdir(), 'octopi-att-'));
    svc = new SessionAttachmentService({ sessionsDir });
  });

  afterEach(async () => {
    await rm(sessionsDir, { recursive: true, force: true });
  });

  it('save text attachment → parsed + extractPath', async () => {
    const item = await svc.save('sess-1', {
      name: 'notes.md',
      data: '# hello\n\nworld',
    });
    expect(item.name).toBe('notes.md');
    expect(item.status).toBe('parsed');
    expect(item.extractPath).toBe('notes.md');
    expect(item.kind).toBe('text');
    expect(svc.list('sess-1')).toHaveLength(1);

    const abs = svc.resolveAbsolutePath('sess-1', item.id);
    const raw = await readFile(abs, 'utf8');
    expect(raw).toContain('hello');
  });

  it('rejects disallowed extension and oversize', async () => {
    await expect(svc.save('sess-1', { name: 'evil.exe', data: 'x' })).rejects.toThrow(/not allowed/);
    const small = new SessionAttachmentService({
      sessionsDir,
      limits: { maxFileBytes: 4 },
    });
    await expect(small.save('sess-1', { name: 'a.md', data: '12345' })).rejects.toThrow(/maxFileBytes/);
  });

  it('maxFiles limit', async () => {
    const limited = new SessionAttachmentService({ sessionsDir, limits: { maxFiles: 1 } });
    await limited.save('sess-1', { name: 'a.md', data: 'a' });
    await expect(limited.save('sess-1', { name: 'b.md', data: 'b' })).rejects.toThrow(/too many/);
  });

  it('unique name on collision', async () => {
    await svc.save('sess-1', { name: 'a.md', data: 'one' });
    const b = await svc.save('sess-1', { name: 'a.md', data: 'two' });
    expect(b.name).toBe('a_2.md');
  });

  it('delete removes file and manifest entry', async () => {
    const item = await svc.save('sess-1', { name: 'x.md', data: 'x' });
    expect(await svc.delete('sess-1', item.id)).toBe(true);
    expect(svc.list('sess-1')).toHaveLength(0);
  });

  it('deleteAll wipes attachments dir', async () => {
    await svc.save('sess-1', { name: 'x.md', data: 'x' });
    await svc.deleteAll('sess-1');
    expect(svc.list('sess-1')).toHaveLength(0);
  });

  it('markPromoted excludes from list', async () => {
    const item = await svc.save('sess-1', { name: 'x.md', data: 'x' });
    await svc.markPromoted('sess-1', item.id, { projectKey: 'p1' });
    expect(svc.list('sess-1')).toHaveLength(0);
    expect(svc.listAll('sess-1')).toHaveLength(1);
    expect(svc.listAll('sess-1')[0]?.status).toBe('promoted');
  });

  it('markSearchable stores source id', async () => {
    const item = await svc.save('sess-1', { name: 'x.md', data: 'x' });
    const marked = await svc.markSearchable('sess-1', item.id, 'ks_abc');
    expect(marked.searchableSourceId).toBe('ks_abc');
    expect(svc.get('sess-1', item.id)?.searchableSourceId).toBe('ks_abc');
  });

  it('pdf has no extract but is listed', async () => {
    const item = await svc.save('sess-1', { name: 'doc.pdf', data: Buffer.from('%PDF-1.4') });
    expect(item.kind).toBe('document');
    expect(item.extractPath).toBeUndefined();
    expect(item.parse?.ok).toBe(false);
  });

  it('undefined limits do not wipe defaults (config wiring regression)', async () => {
    const loose = new SessionAttachmentService({
      sessionsDir,
      limits: {
        maxFiles: undefined,
        maxFileBytes: undefined,
        allowedExtensions: undefined,
      } as never,
    });
    const item = await loose.save('sess-1', { name: 'ok.md', data: 'hello' });
    expect(item.name).toBe('ok.md');
    expect(loose.limitsConfig.allowedExtensions.length).toBeGreaterThan(0);
  });
});

describe('sanitizeAttachmentName', () => {
  it('strips path segments and unsafe chars', () => {
    expect(sanitizeAttachmentName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeAttachmentName('a<b>.md')).toBe('a_b_.md');
    expect(sanitizeAttachmentName('')).toBe('attachment');
  });
});

describe('inject builders', () => {
  it('empty user text uses synthetic prompt + FileBlocks', async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), 'octopi-att-inj-'));
    const svc = new SessionAttachmentService({ sessionsDir });
    const a = await svc.save('s', { name: 'n.md', data: 'body text here' });
    const built = buildAttachmentMessageContent([a], '  ', {
      absolutePath: (id) => svc.resolveAbsolutePath('s', id),
    });
    expect(built.syntheticInstruction).toBe(true);
    expect(Array.isArray(built.content)).toBe(true);
    const blocks = built.content as Array<{ type: string; text?: string; name?: string }>;
    expect(blocks[0]?.text).toBe(DEFAULT_EMPTY_ATTACHMENT_PROMPT);
    expect(blocks.some((b) => b.type === 'file' && b.name === 'n.md')).toBe(true);

    const g = buildAttachmentGroundingText(
      [a],
      {
        fullTextMaxChars: 1000,
        readText: (id, max) => svc.readExtractedText('s', id, max),
        absolutePath: (id) => svc.resolveAbsolutePath('s', id),
      },
      'full',
    );
    expect(g).toContain('body text here');
    expect(g).toContain('trust="untrusted"');
    await rm(sessionsDir, { recursive: true, force: true });
  });

  it('large extract uses structure head when planMode=structure_tools (not truncated full)', () => {
    const big = 'L'.repeat(5000);
    const item = {
      id: 'att1',
      name: 'big.md',
      kind: 'text',
      status: 'parsed',
      parse: { ok: true, chars: 5000 },
      sizeBytes: 5000,
    } as never;
    const g = buildAttachmentGroundingText(
      [item],
      {
        fullTextMaxChars: 100,
        headLines: 3,
        // 模拟 readText 截断
        readText: () => big.slice(0, 100),
        absolutePath: () => '/tmp/big.md',
      },
      'structure_tools',
    );
    expect(g).toContain('结构/开头摘要');
    expect(g).not.toContain('已达注入上限');
    // 不应注入完整 5k 正文（只给开头）
    expect(g!.length).toBeLessThan(1200);
  });
});

describe('inject plan', () => {
  it('empty text → overview without LLM', async () => {
    const plan = await resolveInjectPlan(
      { userText: '', attachments: [] },
      { fullTextMaxChars: 100, intent: 'llm' },
    );
    expect(plan.mode).toBe('overview_tools');
  });

  it('small docs → full', async () => {
    const plan = await resolveInjectPlan(
      {
        userText: '总结一下',
        attachments: [{ parse: { ok: true, chars: 10 } } as never],
      },
      { fullTextMaxChars: 100, intent: 'llm' },
    );
    expect(plan.mode).toBe('full');
  });

  it('LLM timeout → fail-open structure', async () => {
    const plan = await resolveInjectPlan(
      {
        userText: '帮我看下 XX',
        attachments: [{ parse: { ok: true, chars: 10_000 }, sizeBytes: 20_000 } as never],
      },
      {
        fullTextMaxChars: 100,
        intent: 'llm',
        timeoutMs: 10,
        resolver: () => new Promise(() => {}),
      },
    );
    expect(plan.mode).toBe('structure_tools');
  });

  it('fallback plan carries focus', () => {
    const p = fallbackInjectPlan({ userText: '关于 foo 的看法', attachments: [] });
    expect(p.mode).toBe('structure_tools');
    expect(p.focus).toContain('foo');
  });
});

describe('isPathInside', () => {
  it('accepts inside and rejects escape', () => {
    expect(isPathInside('/data/att', '/data/att/a.md')).toBe(true);
    expect(isPathInside('/data/att', '/data/att/../x')).toBe(false);
  });
});

describe('createLlmIntentResolver', () => {
  it('parses JSON plan from model output', async () => {
    const { createLlmIntentResolver } = await import(
      '../../src/harness/session/attachments/llm-intent.js'
    );
    const provider = {
      chat: async () => ({
        content: '{"mode":"recall_tools","focus":"对 XX 的看法","reason":"local"}',
        model: 'test',
        finishReason: 'stop' as const,
      }),
    };
    const plan = await createLlmIntentResolver(provider)({
      userText: '帮我看一下这篇翻译稿中对 XX 的看法',
      attachments: [{ name: '翻译稿.md', kind: 'text', sizeBytes: 10, status: 'parsed' } as never],
    });
    expect(plan.mode).toBe('recall_tools');
    expect(plan.focus).toContain('XX');
    // 不因文件名含「翻译」判 structure
    expect(plan.mode).not.toBe('structure_tools');
  });
});
