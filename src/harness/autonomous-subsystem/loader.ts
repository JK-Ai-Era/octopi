import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type {
  SubsystemSpec, ThinkConfig, ThinkImplementation, SenseSource, ActMode,
  IsolationLevel, ContextField,
  SignalSeverity, SignalChannel, VisibilityLevel, AuthorityLevel,
  SecurityLevel, ToolMode, SessionMode, SessionScope,
  SubsystemHandler, RuntimeInjectConfig, LifecycleResumeConfig, ObservabilityConfig,
} from './types.js';
import { validateSubsystemSpec } from './boundary/validator.js';

// js-yaml 自身未附带 d.ts；仅使用 load，避免为类型强装 @types（与当前 TS 版本 peer 冲突）
// 惰性 require：包缺失时只在真正解析 YAML 时失败，不阻断模块 import
let loadYamlFn: ((text: string) => unknown) | undefined;

function loadYaml(text: string): unknown {
  if (!loadYamlFn) {
    const require = createRequire(import.meta.url);
    loadYamlFn = (require('js-yaml') as { load: (t: string) => unknown }).load;
  }
  return loadYamlFn(text);
}

export interface SubsystemLoaderConfig {
  builtinDir?: string;
  userDir?: string;
  projectDir?: string;
  /** node_modules 目录（用于 npm 子系统发现） */
  npmDir?: string;
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
  private npmDir?: string;

  constructor(config: SubsystemLoaderConfig) {
    this.builtinDir = config.builtinDir;
    this.userDir = config.userDir;
    this.projectDir = config.projectDir;
    this.npmDir = config.npmDir;
  }

  async loadAll(): Promise<LoadResult> {
    const specs = new Map<string, SubsystemSpec>();
    const errors: Array<{ path: string; error: string }> = [];

    const dirs: Array<{ dir: string | undefined; source: SubsystemSpec['source'] }> = [
      { dir: this.builtinDir, source: 'builtin' },
      { dir: this.userDir, source: 'user' },
      { dir: this.projectDir, source: 'project' },
      { dir: this.npmDir, source: 'npm' },
    ];

    for (const { dir, source } of dirs) {
      if (!dir || !existsSync(dir)) continue;
      const entries = readdirSync(dir, { withFileTypes: true });

      const packageDirs = source === 'npm'
        ? this.collectNpmPackageDirs(dir, entries)
        : entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => join(dir, e.name));

      for (const subsystemDir of packageDirs) {
        const result = await this.loadOne(subsystemDir, source);
        if (result.spec) specs.set(result.spec.id, result.spec);
        if (result.error) errors.push({ path: subsystemDir, error: result.error });
      }
    }

    return { specs: Array.from(specs.values()), errors };
  }

  private collectNpmPackageDirs(nodeModulesDir: string, entries: import('node:fs').Dirent[]): string[] {
    const dirs: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

      if (entry.name.startsWith('@')) {
        const scopeDir = join(nodeModulesDir, entry.name);
        try {
          const scopedEntries = readdirSync(scopeDir, { withFileTypes: true });
          for (const scopedEntry of scopedEntries) {
            if (!scopedEntry.isDirectory()) continue;
            const packageDir = join(scopeDir, scopedEntry.name);
            if (this.isSubsystemPackageDir(packageDir)) {
              dirs.push(packageDir);
            }
          }
        } catch {
          // ignore unreadable scope
        }
        continue;
      }

      const packageDir = join(nodeModulesDir, entry.name);
      if (this.isSubsystemPackageDir(packageDir)) {
        dirs.push(packageDir);
      }
    }

    return dirs;
  }

  private isSubsystemPackageDir(packageDir: string): boolean {
    try {
      const manifestPath = join(packageDir, 'package.json');
      if (!existsSync(manifestPath)) {
        return false;
      }

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
      const name = String(manifest.name ?? '');
      return this.isSubsystemPackage(name);
    } catch {
      return false;
    }
  }

  private isSubsystemPackage(name: string): boolean {
    if (name.startsWith('@octopi/subsystem-')) {
      return true;
    }

    const plain = name.startsWith('@') ? name.split('/').pop() ?? name : name;
    return plain.startsWith('octopi-subsystem-');
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

      const missingExplicitFields = [] as string[];
      if (!config.boundary) missingExplicitFields.push('boundary');
      if (!config.signal) missingExplicitFields.push('signal');
      if (!config.act) missingExplicitFields.push('act');
      if (missingExplicitFields.length > 0) {
        return { error: `Missing required explicit fields: ${missingExplicitFields.join(', ')}` };
      }

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
      const { pathToFileURL } = await import('node:url');
      const mod = await import(pathToFileURL(handlerFile).href);
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
        emits: filterRaw.emits as string[] | undefined,
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
      definitions: Array.isArray(toolsRaw.definitions)
        ? (toolsRaw.definitions as Array<Record<string, unknown>>).map((d) => {
            const rawDef = (d.definition ?? d) as Record<string, unknown>;
            const name = String(rawDef.name ?? '');
            const description = String(rawDef.description ?? '');
            const parameters = (rawDef.parameters ?? {}) as Record<string, import('../../core/types.js').ToolParameter>;

            return {
              definition: { name, description, parameters },
              handler: async () => {
                throw new Error(`Tool ${name} does not have a runtime handler`);
              },
            } satisfies import('../../core/types.js').RegisteredTool;
          })
        : undefined,
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
    emits: (config.emits as string[] | undefined) ?? (filterRaw?.emits as string[] | undefined),
  };
}

// ── parseMarkdown ──

function parseMarkdown(content: string): ParsedMarkdown {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fmMatch) {
    return { frontmatter: {}, body: content.trim() };
  }

  let frontmatter: Frontmatter = {};
  try {
    const parsed = loadYaml(fmMatch[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Frontmatter;
    }
  } catch {
    // frontmatter 非法时按无 frontmatter 处理，正文仍可用
  }

  return { frontmatter, body: fmMatch[2].trim() };
}

// ── parseYaml ──

function parseYaml(content: string): Record<string, unknown> {
  const parsed = loadYaml(content);
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config.yaml root must be a mapping');
  }
  return parsed as Record<string, unknown>;
}
