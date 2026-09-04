import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SubsystemLoader } from '../../src/harness/autonomous-subsystem/loader.js';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const VALID_CONFIG = [
  'id: test-sub', 'name: Test Subsystem', 'description: A test',
  'sense:', '  source: eventBus', '  isolation: structured',
  'think:', '  implementation: code', '  strategy: deterministic',
  'act:', '  mode: none',
  'signal:', '  severity: info', '  channel: [event]',
  'boundary:', '  visibility: structured', '  authority: observe', '  security: sandboxed',
  'tools:', '  mode: none',
  'session:', '  mode: ephemeral', '  scope: session',
].join('\n');

const LLM_CONFIG = [
  'id: llm-sub',
  'sense:', '  source: eventBus', '  isolation: structured',
  'think:', '  implementation: llm', '  strategy: heuristic',
  'act:', '  mode: none',
  'signal:', '  severity: info', '  channel: [event]',
  'boundary:', '  visibility: structured', '  authority: suggest', '  security: sandboxed',
  'tools:', '  mode: none',
  'session:', '  mode: ephemeral', '  scope: session',
].join('\n');

describe('SubsystemLoader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'octopi-loader-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSub(dirName: string, files: Record<string, string>) {
    const dir = join(tmpDir, dirName);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, 'utf-8');
    }
  }

  describe('loadAll', () => {
    it('loads a code subsystem with handler.ts', async () => {
      writeSub('test-sub', {
        'config.yaml': VALID_CONFIG,
        'handler.ts': 'export async function handler() { return { signals: [] }; }',
      });
      const result = await new SubsystemLoader({ projectDir: tmpDir }).loadAll();
      expect(result.specs).toHaveLength(1);
      expect(result.specs[0].id).toBe('test-sub');
      expect(result.specs[0].think.handler).toBeDefined();
      expect(result.specs[0].source).toBe('project');
      expect(result.errors).toHaveLength(0);
    });

    it('loads a subsystem with SUBSYSTEM.md', async () => {
      writeSub('llm-sub', {
        'SUBSYSTEM.md': '---\nname: llm-sub\nversion: 1.0.0\nmodel: mini\n---\n\n# Title\n\nYou are a test.',
        'config.yaml': LLM_CONFIG,
      });
      const result = await new SubsystemLoader({ projectDir: tmpDir }).loadAll();
      expect(result.specs).toHaveLength(1);
      expect(result.specs[0].think.systemPrompt).toContain('You are a test.');
      expect(result.specs[0].think.model).toBe('mini');
    });

    it('reports validation errors for code without handler', async () => {
      writeSub('bad-sub', { 'config.yaml': VALID_CONFIG });
      const result = await new SubsystemLoader({ projectDir: tmpDir }).loadAll();
      expect(result.specs).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('think.handler');
    });

    it('reports validation errors for llm without systemPrompt', async () => {
      writeSub('bad-llm', { 'config.yaml': LLM_CONFIG });
      const result = await new SubsystemLoader({ projectDir: tmpDir }).loadAll();
      expect(result.specs).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('think.systemPrompt');
    });

    it('project overrides builtin for same id', async () => {
      const handler = 'export async function handler() { return { signals: [] }; }';
      writeSub('builtin/sub-a', {
        'config.yaml': VALID_CONFIG.replace('test-sub', 'sub-a').replace('Test Subsystem', 'Builtin Version'),
        'handler.ts': handler,
      });
      writeSub('project/sub-a', {
        'config.yaml': VALID_CONFIG.replace('test-sub', 'sub-a').replace('Test Subsystem', 'Project Version'),
        'handler.ts': handler,
      });
      const result = await new SubsystemLoader({
        builtinDir: join(tmpDir, 'builtin'),
        projectDir: join(tmpDir, 'project'),
      }).loadAll();
      expect(result.specs).toHaveLength(1);
      expect(result.specs[0].name).toBe('Project Version');
    });

    it('skips non-subsystem directories', async () => {
      writeSub('valid-sub', {
        'config.yaml': VALID_CONFIG,
        'handler.ts': 'export async function handler() { return { signals: [] }; }',
      });
      mkdirSync(join(tmpDir, 'not-a-sub'), { recursive: true });
      const result = await new SubsystemLoader({ projectDir: tmpDir }).loadAll();
      expect(result.specs).toHaveLength(1);
    });

    it('returns empty when directories do not exist', async () => {
      const result = await new SubsystemLoader({
        builtinDir: join(tmpDir, 'nonexistent'),
      }).loadAll();
      expect(result.specs).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });
  });
});
