import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SubsystemSpec, ThinkConfig, ThinkImplementation, SenseSource, ActMode,
  IsolationLevel, ContextField,
  SignalSeverity, SignalChannel, VisibilityLevel, AuthorityLevel,
  SecurityLevel, ToolMode, SessionMode, SessionScope,
  SubsystemHandler, RuntimeInjectConfig, LifecycleResumeConfig, ObservabilityConfig,
} from './types.js';
import { validateSubsystemSpec } from './boundary/validator.js';

export interface SubsystemLoaderConfig {
  builtinDir?: string;
  userDir?: string;
  projectDir?: string;
}

interface Frontmatter { [key: string]: unknown; }
interface ParsedMarkdown { frontmatter: Frontmatter; body: string; }

export interface LoadResult {
  specs: SubsystemSpec[];
  errors: Array<{ path: string; error: string }>;
}

export class SubsystemLoader {
  private builtinDir?: string;
  private userDir?: string;
  private projectDir?: string;

  constructor(config: SubsystemLoaderConfig) {
    this.builtinDir = config.builtinDir;
    this.userDir = config.userDir;
    this.projectDir = config.projectDir;
  }

  async loadAll(): Promise<LoadResult> {
    const specs = new Map<string, SubsystemSpec>();
    const errors: Array<{ path: string; error: string }> = [];

    const dirs: Array<{ dir: string | undefined; source: SubsystemSpec['source'] }> = [
      { dir: this.builtinDir, source: 'builtin' },
      { dir: this.userDir, source: 'user' },
      { dir: this.projectDir, source: 'project' },
    ];

    for (const { dir, source } of dirs) {
      if (!dir || !existsSync(dir)) continue;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const subsystemDir = join(dir, entry.name);
        const result = await this.loadOne(subsystemDir, source);
        if (result.spec) specs.set(result.spec.id, result.spec);
        if (result.error) errors.push({ path: subsystemDir, error: result.error });
      }
    }

    return { specs: Array.from(specs.values()), errors };
  }

  async loadOne(dirPath: string, source: SubsystemSpec['source'] = 'project'): Promise<{ spec?: SubsystemSpec; error?: string }> {
    const configPath = join(dirPath, 'config.yaml');
    const subsystemMdPath = join(dirPath, 'SUBSYSTEM.md');

    if (!existsSync(configPath) && !existsSync(subsystemMdPath)) {
      return { error: `No config.yaml or SUBSYSTEM.md found in ${dirPath}` };
    }

    try {
      let config: Record<string, unknown> = {};
      if (existsSync(configPath)) {
        config = parseYaml(readFileSync(configPath, 'utf-8'));
      }

      let frontmatter: Frontmatter = {};
      let systemPrompt: string | undefined;
      if (existsSync(subsystemMdPath)) {
        const parsed = parseMarkdown(readFileSync(subsystemMdPath, 'utf-8'));
        frontmatter = parsed.frontmatter;
        systemPrompt = parsed.body || undefined;
      }

      const merged = { ...frontmatter, ...config };
      const spec = await buildSpec(merged, systemPrompt, source, dirPath);
      if (!spec) return { error: `Failed to build spec from ${dirPath}` };

      const errors = validateSubsystemSpec(spec);
      if (errors.length > 0) {
        return { error: `Validation failed: ${errors.map((e) => `${e.field}: ${e.message}`).join('; ')}` };
      }

      return { spec };
    } catch (err) {
      return { error: `Failed to load ${dirPath}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}

// ── buildSpec ──

async function buildSpec(
  config: Record<string, unknown>,
  systemPrompt: string | undefined,
  source: SubsystemSpec['source'],
  dirPath: string,
): Promise<SubsystemSpec | null> {
  const id = (config.id ?? config.name) as string;
  const name = (config.name ?? id) as string;
  const description = (config.description ?? '') as string;
  if (!id) return null;

  const thinkRaw = (config.think ?? {}) as Record<string, unknown>;
  const impl = (thinkRaw.implementation ?? (systemPrompt ? 'llm' : 'code')) as ThinkImplementation;
  const strategy = (thinkRaw.strategy ?? (impl === 'code' ? 'deterministic' : 'heuristic')) as ThinkConfig['strategy'];

  const senseRaw = (config.sense ?? {}) as Record<string, unknown>;
  const filterRaw = senseRaw.filter as Record<string, unknown> | undefined;

  const actRaw = (config.act ?? {}) as Record<string, unknown>;
  const signalRaw = (config.signal ?? {}) as Record<string, unknown>;
  const boundaryRaw = (config.boundary ?? {}) as Record<string, unknown>;
  const toolsRaw = (config.tools ?? {}) as Record<string, unknown>;
  const sessionRaw = (config.session ?? {}) as Record<string, unknown>;
  const lifecycleRaw = config.lifecycle as Record<string, unknown> | undefined;

  // 尝试加载 handler.ts（code/hybrid 模式）
  // 支持两种导出模式：
  //   1. 传统模式：export handler / preProcess / postProcess（函数直接导出）
  //   2. 标准契约模式：export default SubsystemHandler（对象包含 handler + contract + dependencies）
  let handler: ((input: any, deps?: any) => Promise<any>) | undefined;
  let preProcess: ((input: any) => Promise<any>) | undefined;
  let postProcess: ((output: any) => Promise<any>) | undefined;
  let handlerDependencies: string[] | undefined;

  const handlerPath = join(dirPath, 'handler.ts');
  const handlerJsPath = join(dirPath, 'handler.js');
  const handlerFile = existsSync(handlerPath) ? handlerPath : existsSync(handlerJsPath) ? handlerJsPath : undefined;

  if (handlerFile) {
    try {
      const mod = await import(handlerFile);
      // 优先检查标准契约模式（export default 具有 handler 属性的对象）
      const exported = mod.default ?? mod;
      if (exported && typeof exported === 'object' && typeof exported.handler === 'function' && ('contract' in exported || 'dependencies' in exported)) {
        // 标准契约模式
        handler = exported.handler;
        handlerDependencies = exported.dependencies as string[] | undefined;
      } else {
        // 传统模式
        handler = mod.handler ?? (typeof mod.default === 'function' ? mod.default : undefined);
        preProcess = mod.preProcess;
        postProcess = mod.postProcess;
      }
    } catch {
      // handler 加载失败，不影响 spec 构建
    }
  }

  // 解析运行时扩展字段
  const runtimeInjectRaw = config.runtimeInject as Record<string, unknown> | undefined;
  const resumeRaw = config.resume as Record<string, unknown> | undefined;
  const observabilityRaw = config.observability as Record<string, unknown> | undefined;

  return {
    id, name, description,
    sense: {
      source: (senseRaw.source ?? 'eventBus') as SenseSource,
      filter: filterRaw ? {
        events: filterRaw.events as string[] | undefined,
        condition: filterRaw.condition as string | undefined,
        conditionRef: filterRaw.conditionRef as string | undefined,
      } : undefined,
      interval: senseRaw.interval as number | undefined,
      isolation: (senseRaw.isolation ?? 'structured') as IsolationLevel,
      fields: senseRaw.fields as ContextField[] | undefined,
    },
    think: {
      strategy,
      implementation: impl,
      systemPrompt: (thinkRaw.systemPrompt as string) ?? systemPrompt,
      model: (thinkRaw.model as string) ?? (config.model as string),
      maxIterations: (thinkRaw.maxIterations as number) ?? (config.maxIterations as number),
      handler,
      preProcess,
      postProcess,
    },
    act: { mode: (actRaw.mode ?? 'none') as ActMode },
    signal: {
      severity: (signalRaw.severity ?? 'info') as SignalSeverity,
      channel: (signalRaw.channel ?? ['event']) as SignalChannel[],
    },
    boundary: {
      visibility: (boundaryRaw.visibility ?? 'structured') as VisibilityLevel,
      authority: (boundaryRaw.authority ?? (actRaw.mode === 'none' ? 'suggest' : 'act')) as AuthorityLevel,
      security: (boundaryRaw.security ?? 'sandboxed') as SecurityLevel,
    },
    tools: {
      mode: (toolsRaw.mode ?? 'none') as ToolMode,
      names: toolsRaw.names as string[] | undefined,
    },
    session: {
      mode: ((sessionRaw.mode as string) === 'persistent' ? 'persistent' : 'ephemeral') as SessionMode,
      scope: (sessionRaw.scope ?? 'session') as SessionScope,
      ttl: sessionRaw.ttl as string | undefined,
    },
    lifecycle: lifecycleRaw ? {
      maxDurationMs: lifecycleRaw.maxDurationMs as number | undefined,
      maxConcurrent: lifecycleRaw.maxConcurrent as number | undefined,
      maxTokens: lifecycleRaw.maxTokens as number | undefined,
      degradeOn: lifecycleRaw.degradeOn as 'timeout' | 'error' | 'both' | undefined,
    } : undefined,
    runtimeInject: runtimeInjectRaw ? {
      requires: (runtimeInjectRaw.requires as string[]) ?? [],
    } as RuntimeInjectConfig : undefined,
    resume: resumeRaw ? {
      enabled: (resumeRaw.enabled as boolean) ?? false,
      scanIntervalMs: resumeRaw.scanIntervalMs as number | undefined,
      maxRetries: resumeRaw.maxRetries as number | undefined,
      baseRetryMs: resumeRaw.baseRetryMs as number | undefined,
      maxRetryMs: resumeRaw.maxRetryMs as number | undefined,
    } as LifecycleResumeConfig : undefined,
    observability: observabilityRaw ? {
      eventPrefix: (observabilityRaw.eventPrefix as string) ?? '',
    } as ObservabilityConfig : undefined,
    metadata: config.metadata as Record<string, unknown> | undefined,
    version: config.version as string | undefined,
    source,
    sourcePath: dirPath,
  };
}

// ── parseMarkdown ──

function parseMarkdown(content: string): ParsedMarkdown {
  const frontmatter: Frontmatter = {};
  let body = content;
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (fmMatch) {
    body = fmMatch[2].trim();
    for (const line of fmMatch[1].split('\n')) {
      const match = line.match(/^(\w+)\s*:\s*(.+)$/);
      if (match) {
        const key = match[1].trim();
        let value: unknown = match[2].trim();
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (/^\d+$/.test(value as string)) value = parseInt(value as string, 10);
        frontmatter[key] = value;
      }
    }
  }
  return { frontmatter, body };
}

// ── parseYaml ──

function parseYaml(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<[number, Record<string, unknown>]> = [[-1, root]];

  for (const rawLine of content.split('\n')) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.search(/\S/);
    const line = rawLine.trim();
    const match = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();

    while (stack.length > 1 && stack[stack.length - 1][0] >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1][1];

    if (value) {
      parent[key] = parseYamlValue(value);
    } else {
      const obj: Record<string, unknown> = {};
      parent[key] = obj;
      stack.push([indent, obj]);
    }
  }
  return root;
}

function parseYamlValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map((v) => parseYamlValue(v.trim()));
  }
  return value;
}
