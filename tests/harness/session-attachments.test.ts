/**
 * SessionAttachmentService 基础行为（OP-15）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionAttachmentService } from '@octopi-agent/engine/harness/session/attachments/service.js';
import { sanitizeAttachmentName, isPathInside } from '@octopi-agent/engine/harness/session/attachments/sanitize.js';
import {
  buildAttachmentMessageContent,
  buildAttachmentGroundingText,
  DEFAULT_EMPTY_ATTACHMENT_PROMPT,
} from '@octopi-agent/engine/harness/session/attachments/inject.js';
import { fallbackInjectPlan, resolveInjectPlan } from '@octopi-agent/engine/harness/session/attachments/intent.js';

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

    const g = await buildAttachmentGroundingText(
      [a],
      {
        fullTextMaxChars: 1000,
        readText: (id, max) => svc.readExtractedText('s', id, max),
        absolutePath: (id) => svc.resolveAbsolutePath('s', id),
      },
      { mode: 'full', reason: 'small' },
    );
    expect(g.text).toContain('body text here');
    expect(g.text).toContain('trust="untrusted"');
    await rm(sessionsDir, { recursive: true, force: true });
  });

  it('large extract uses structure head when planMode=structure_tools (not truncated full)', async () => {
    const big = 'L'.repeat(5000);
    const item = {
      id: 'att1',
      name: 'big.md',
      kind: 'text',
      status: 'parsed',
      parse: { ok: true, chars: 5000 },
      sizeBytes: 5000,
    } as never;
    const g = await buildAttachmentGroundingText(
      [item],
      {
        fullTextMaxChars: 100,
        // 模拟 readText 截断
        readText: () => big.slice(0, 100),
        absolutePath: () => '/tmp/big.md',
      },
      { mode: 'structure_tools', reason: 'whole document' },
    );
    expect(g.text).toContain('结构/开头摘要');
    expect(g.text).not.toContain('已达注入上限');
    // 不应注入完整 5k 正文（只给开头）
    expect(g.text!.length).toBeLessThan(1200);
  });
});

describe('attachment local recall', () => {
  it('defaults to a session-local index without creating a Knowledge source', async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), 'octopi-att-recall-'));
    try {
      const svc = new SessionAttachmentService({ sessionsDir });
      const item = await svc.save('s', {
        name: 'guide.md',
        data: `${'opening\n'.repeat(20)}# Retention\nAttachments expire with this session.`,
      });
      expect(item.searchableSourceId).toBeUndefined();
      const hits = await svc.recall('s', 'retention', [item.id], 6);
      expect(hits).toHaveLength(1);
      expect(hits?.[0]?.text).toContain('expire with this session');
      expect(hits?.[0]?.startLine).toBeGreaterThan(20);
      expect(await svc.recall('other-session', 'retention', [item.id], 6)).toEqual([]);
    } finally {
      await rm(sessionsDir, { recursive: true, force: true });
    }
  });

  it('injects actual top-k passages and keeps small attachments in full', async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), 'octopi-att-recall-'));
    try {
      const svc = new SessionAttachmentService({ sessionsDir });
      const big = await svc.save('s', {
        name: 'large.md',
        data: `${'intro\n'.repeat(30)}# Isolation\nThe session attachment recall index is private.`,
      });
      const small = await svc.save('s', { name: 'small.md', data: 'small attachment must stay complete' });
      const result = await buildAttachmentGroundingText(
        [big, small],
        {
          fullTextMaxChars: 20,
          recallTopK: 1,
          readText: (id, max) => svc.readExtractedText('s', id, max),
          absolutePath: (id) => svc.resolveAbsolutePath('s', id),
          recall: (query, ids, limit) => svc.recall('s', query, ids, limit),
        },
        { mode: 'recall_tools', focus: 'recall index', targets: ['large.md'], reason: 'local' },
      );
      expect(result.recallHits).toBe(1);
      expect(result.text).toContain('The session attachment recall index is private');
      expect(result.text).toContain('small attachment must stay complete');
      expect(result.text).not.toContain('intro\nintro');
      expect(result.text).toContain('trust="untrusted"');
    } finally {
      await rm(sessionsDir, { recursive: true, force: true });
    }
  });

  it('ranks globally across targets and never lets targets expand the selected attachments', async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), 'octopi-att-recall-'));
    try {
      const svc = new SessionAttachmentService({ sessionsDir });
      const a = await svc.save('s', { name: 'a.md', data: 'alpha beta gamma\nunique alpha topic' });
      const b = await svc.save('s', { name: 'b.md', data: 'alpha beta gamma\nother alpha topic' });
      const seenIds: string[][] = [];
      const result = await buildAttachmentGroundingText(
        [a],
        {
          fullTextMaxChars: 1,
          recallTopK: 1,
          readText: (id, max) => svc.readExtractedText('s', id, max),
          absolutePath: (id) => svc.resolveAbsolutePath('s', id),
          recall: (query, ids, limit) => {
            seenIds.push(ids);
            return svc.recall('s', query, ids, limit);
          },
        },
        { mode: 'recall_tools', focus: 'alpha', targets: ['b.md'], reason: 'local' },
      );
      expect(seenIds).toEqual([]);
      expect(result.recallHits).toBe(0);
      expect(result.fallbackAttachmentIds).toEqual([a.id]);
      expect(result.text).toContain('结构/开头摘要');
      expect(result.text).not.toContain('other alpha topic');
      expect(b.searchableSourceId).toBeUndefined();
    } finally {
      await rm(sessionsDir, { recursive: true, force: true });
    }
  });

  it('falls back to structure for missing/corrupt/stale indexes and removes deleted projections', async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), 'octopi-att-recall-'));
    try {
      const svc = new SessionAttachmentService({ sessionsDir });
      const item = await svc.save('s', {
        name: 'large.md',
        data: `${'intro\n'.repeat(30)}target passage after the opening`,
      });
      const indexPath = join(svc.attachmentRoot('s'), '.recall-index.json');
      await writeFile(indexPath, '{broken', 'utf8');
      const fallback = await buildAttachmentGroundingText(
        [item],
        {
          fullTextMaxChars: 20,
          readText: (id, max) => svc.readExtractedText('s', id, max),
          absolutePath: (id) => svc.resolveAbsolutePath('s', id),
          recall: (query, ids, limit) => svc.recall('s', query, ids, limit),
        },
        { mode: 'recall_tools', focus: 'target passage', reason: 'local' },
      );
      expect(fallback.fallbackAttachmentIds).toEqual([item.id]);
      expect(fallback.text).toContain('结构/开头摘要');

      await svc.save('s', { name: 'other.md', data: 'other' });
      expect(await readFile(indexPath, 'utf8')).toBe('{broken');

      await svc.rebuildRecall('s');
      await writeFile(svc.resolveAbsolutePath('s', item.id), 'changed extract', 'utf8');
      expect(await svc.recall('s', 'target', [item.id], 6)).toBeNull();
      await svc.delete('s', item.id);
      const index = JSON.parse(await readFile(indexPath, 'utf8')) as { attachments: Record<string, unknown> };
      expect(index.attachments[item.id]).toBeUndefined();
    } finally {
      await rm(sessionsDir, { recursive: true, force: true });
    }
  });
  it('serializes concurrent saves across service instances and refuses corrupt manifests', async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), 'octopi-attach-writes-'));
    try {
      const first = new SessionAttachmentService({ sessionsDir });
      const second = new SessionAttachmentService({ sessionsDir });
      const [a, b] = await Promise.all([
        first.save('s', { name: 'a.md', data: 'alpha attachment' }),
        second.save('s', { name: 'b.md', data: 'beta attachment' }),
      ]);
      expect(first.list('s').map((item) => item.name).sort()).toEqual(['a.md', 'b.md']);
      expect(await first.recall('s', 'alpha', [a.id], 6)).toHaveLength(1);
      expect(await second.recall('s', 'beta', [b.id], 6)).toHaveLength(1);

      const manifestPath = join(first.attachmentRoot('s'), '.manifest.json');
      const before = await readFile(manifestPath, 'utf8');
      await writeFile(manifestPath, '{broken', 'utf8');
      await expect(first.save('s', { name: 'c.md', data: 'must not overwrite' })).rejects.toThrow();
      expect(await readFile(manifestPath, 'utf8')).toBe('{broken');
      expect(before).toContain('a.md');
    } finally {
      await rm(sessionsDir, { recursive: true, force: true });
    }
  });

  it('indexes long minified code tails without dropping content', async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), 'octopi-attach-long-line-'));
    const svc = new SessionAttachmentService({ sessionsDir });
    try {
      const code = `const prefix = '${'x'.repeat(17_000)}'; const targetTail = 'local-needle';`;
      const item = await svc.save('s', { name: 'minified.js', data: code });
      const hits = await svc.recall('s', 'local-needle', [item.id], 6);
      expect(hits?.[0]?.text).toContain('local-needle');
      expect(hits?.[0]?.text).toContain('targetTail');
    } finally {
      await rm(sessionsDir, { recursive: true, force: true });
    }
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
      '@octopi-agent/engine/harness/session/attachments/llm-intent.js'
    );
    const provider = {
      name: 'test',
      chat: async () => ({
        content: '{"mode":"recall_tools","focus":"对 XX 的看法","reason":"local"}',
        model: 'test',
        finishReason: 'stop' as const,
      }),
      stream: async function* () {},
      isAvailable: async () => true,
      getModelInfo: () => null,
      getModelInfos: () => [],
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
