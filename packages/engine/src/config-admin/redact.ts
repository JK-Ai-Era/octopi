/**
 * 配置脱敏 — WebUI 回显形态（arch/config-hot-reload.md §0）
 *
 * apiKey 只回显「是否已配置 + 引用形态」，绝不回显明文值。
 * `${VAR}` 形态给变量名；明文形态只标记 `literal`。
 *
 * options 键级脱敏（P6-4/M4）：manifest `secretOptions` 声明的键按同一
 * `RedactedSecret` 视图打码；插件贡献不在有效注册表时 fail-closed 全量打码。
 *
 * @module
 */

/** 脱敏后的 Secret 视图 */
export interface RedactedSecret {
  configured: boolean;
  ref: 'literal' | string | null;
}

/** 脱敏后的 provider 视图（WebUI 表单回显） */
export interface RedactedProvider {
  name: string;
  baseUrl: string;
  api: string;
  models: Array<Record<string, unknown>>;
  timeoutSeconds?: number;
  apiKey: RedactedSecret;
  /** 插件 Provider 贡献 id（与 api 二选一） */
  plugin?: string;
  /** 插件自定义旋钮：manifest `secretOptions` 声明的键以 RedactedSecret 打码，其余原样透传。 */
  options?: Record<string, unknown>;
}

const ENV_REF_PATTERN = /^\$\{(\w+)(?::-.*?)?\}$/;

/**
 * 脱敏一个 secret 值（唯一实现点：apiKey 与 options 键共用）
 *
 * @param value - 原始值（可能为 `${VAR}` 形态、明文、空或非字符串对象）
 * @returns 脱敏视图（不含明文）
 */
export function redactSecret(value: unknown): RedactedSecret {
  if (value === undefined || value === null || value === '') return { configured: false, ref: null };
  if (typeof value !== 'string') return { configured: true, ref: 'literal' };
  const m = ENV_REF_PATTERN.exec(value);
  if (m) return { configured: true, ref: m[1] };
  return { configured: true, ref: 'literal' };
}

/**
 * Whether an option value is one of OUR echo placeholders (a `RedactedSecret`
 * view round-tripped by a config client). A placeholder means "the client did
 * not change this value" — upsert must restore the stored value instead of
 * writing the placeholder to disk (see resolveEchoPlaceholders).
 *
 * @param value - Candidate option value
 * @returns Whether the value is a RedactedSecret-shaped placeholder
 */
export function isRedactedSecret(value: unknown): value is RedactedSecret {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { configured?: unknown }).configured === 'boolean' &&
    Object.keys(value).every((key) => key === 'configured' || key === 'ref')
  );
}

/**
 * Resolve echo placeholders in an upserted provider config: for every
 * manifest-declared secret option key holding a `RedactedSecret` placeholder,
 * restore the previous stored value; without a stored value the key is
 * dropped (a placeholder has no meaning on disk).
 *
 * @param config - The upserted provider config fragment
 * @param previous - The stored config fragment it replaces (if any)
 * @param secretOptionKeys - manifest `secretOptions` for this provider
 * @returns The config with placeholders resolved
 */
export function resolveEchoPlaceholders<T extends { options?: Record<string, unknown> }>(
  config: T,
  previous: { options?: Record<string, unknown> } | undefined,
  secretOptionKeys: readonly string[],
): T {
  if (!config.options || secretOptionKeys.length === 0) return config;
  const options: Record<string, unknown> = { ...config.options };
  for (const key of secretOptionKeys) {
    if (!isRedactedSecret(options[key])) continue;
    const stored = previous?.options?.[key];
    if (stored !== undefined && !isRedactedSecret(stored)) options[key] = stored;
    else delete options[key];
  }
  return { ...config, options };
}

/**
 * 脱敏单个 provider 配置
 *
 * @param name - provider 名
 * @param pc - provider 配置
 * @param secretOptionKeys - manifest `secretOptions`（undefined=内置 provider
 *   原样透传；null=插件贡献未知，fail-closed 全量打码；数组=声明键打码）
 * @returns 脱敏视图
 */
export function redactProvider(name: string, pc: Record<string, unknown>, secretOptionKeys?: readonly string[] | null): RedactedProvider {
  const out: RedactedProvider = {
    name,
    baseUrl: typeof pc.baseUrl === 'string' ? pc.baseUrl : '',
    api: typeof pc.api === 'string' ? pc.api : '',
    models: Array.isArray(pc.models) ? (pc.models as Array<Record<string, unknown>>) : [],
    apiKey: redactSecret(typeof pc.apiKey === 'string' ? pc.apiKey : undefined),
  };
  if (typeof pc.timeoutSeconds === 'number') out.timeoutSeconds = pc.timeoutSeconds;
  if (typeof pc.plugin === 'string') out.plugin = pc.plugin;
  if (pc.options !== undefined && pc.options !== null && typeof pc.options === 'object' && !Array.isArray(pc.options)) {
    // Three states: undefined = built-in provider (verbatim echo, no manifest
    // exists); null = plugin contribution unknown to the live registry (fail
    // closed — mask everything rather than echo a possibly-secret value);
    // string[] = manifest-declared secret keys (mask those, pass others).
    out.options =
      secretOptionKeys === undefined
        ? { ...(pc.options as Record<string, unknown>) }
        : Object.fromEntries(
            Object.entries(pc.options as Record<string, unknown>).map(([key, value]) => [
              key,
              secretOptionKeys === null || secretOptionKeys.includes(key) ? redactSecret(value) : value,
            ]),
          );
  }
  return out;
}
