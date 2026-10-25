/**
 * 安全配置指纹与漂移守卫（ops P2，`arch/ops-privileged-mode.md` §4.3 / §8.4 拍板）
 *
 * 「agent 可写自身配置」是自提权面：host 模式下 agent 改写 `octopi.json` 的安全字段
 * 等于自我升档。边界（§8.4）：安全字段**重启才生效**，运行中检测到漂移 → **拒新 run**
 * + `ops.config.security_changed`，直至宿主（重启 / WebUI 署名通道）确认。
 *
 * 本模块只做「指纹 + 对比」；重读配置文件由宿主注入（引擎不越界做 IO 策略）。
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** 安全字段指纹（锚定值 + 字段摘要） */
export interface SecurityConfigFingerprint {
  /** sha256(canonicalJson(fields)) */
  fingerprint: string;
  /** 扁平字段摘要（`effectPolicy.jail` → 值），审计记录与 diff 用 */
  fields: Record<string, unknown>;
}

/** 指纹对比结果 */
export interface SecurityConfigDrift {
  ok: boolean;
  /** 发生变化的字段名（指纹不同则至少一项） */
  changed: string[];
  /** 当前指纹（审计记录的「新摘要」） */
  currentFingerprint: string;
}

/**
 * 参与指纹的安全字段（§8.4：jail / escalation / effects / 审计开关 + 作用域面）。
 * 键序无关；值走稳定序列化。
 */
const EFFECT_POLICY_SECURITY_KEYS = [
  'mode',
  'untrustedAdmission',
  'pathContainment',
  'shellEscape',
  'jail',
  'onJailUnavailable',
  'privilegedAck',
  'effects',
  'toolIsolation',
  'opsAudit',
  'opsAuditPath',
  'network',
  'escalation',
] as const;

const SECURITY_CONFIG_SECURITY_KEYS = ['enforce', 'injectionSensitivity', 'allowedPaths'] as const;

function pickFields(source: Record<string, unknown>, keys: readonly string[], prefix: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[`${prefix}${key}`] = source[key];
  }
  return out;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * 计算安全配置指纹（启动期锚定）。
 *
 * @param config - 已解析配置的安全相关切面（effectPolicy + security）
 * @returns 指纹 + 字段摘要
 */
export function computeSecurityConfigFingerprint(config: {
  effectPolicy?: Record<string, unknown>;
  security?: Record<string, unknown>;
  agents?: Array<Record<string, unknown>>;
  plugins?: Record<string, unknown>;
}): SecurityConfigFingerprint {
  const fields: Record<string, unknown> = {
    ...pickFields(config.effectPolicy ?? {}, EFFECT_POLICY_SECURITY_KEYS, 'effectPolicy.'),
    ...pickFields(config.security ?? {}, SECURITY_CONFIG_SECURITY_KEYS, 'security.'),
  };
  // per-agent 覆盖与工具面/插件加载路径都是安全面（§8.4 补洞）
  if (config.agents !== undefined) fields['agents'] = config.agents;
  if (config.plugins !== undefined && Object.keys(config.plugins).length > 0) {
    fields['plugins'] = pickFields(config.plugins, ['loadPaths'], 'plugins.');
  }
  return {
    fingerprint: createHash('sha256').update(stableStringify(fields)).digest('hex'),
    fields,
  };
}

/**
 * 从原始 JSON 文本提取安全字段切面（漂移复核用；不走完整 schema 解析——
 * 被篡改的配置可能根本过不了 schema，指纹对比必须先于校验）。
 *
 * 覆盖面（§8.4 + 评审补洞）：顶层 effectPolicy / security、**agents[].effectPolicy**
 * （每 agent 覆盖顶层，改单个 agent 的 jail 也必须算漂移）、**agents[].tools**（工具
 * allow/deny）、**plugins.loadPaths**（插件加载路径）。
 *
 * @param jsonText - 配置文件全文
 * @returns 安全字段切面
 */
export function extractSecurityConfigSlice(jsonText: string): {
  effectPolicy: Record<string, unknown>;
  security: Record<string, unknown>;
  agents: Array<Record<string, unknown>>;
  plugins: Record<string, unknown>;
} {
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  const rawAgents = Array.isArray(parsed.agents) ? (parsed.agents as unknown[]) : [];
  const agents = rawAgents.map((a) => {
    const agent = (a ?? {}) as Record<string, unknown>;
    return {
      id: agent.id,
      tools: agent.tools,
      ...pickFields((agent.effectPolicy ?? {}) as Record<string, unknown>, EFFECT_POLICY_SECURITY_KEYS, 'effectPolicy.'),
    };
  });
  return {
    effectPolicy: (parsed.effectPolicy ?? {}) as Record<string, unknown>,
    security: (parsed.security ?? {}) as Record<string, unknown>,
    agents,
    plugins: (parsed.plugins ?? {}) as Record<string, unknown>,
  };
}

/**
 * 对比锚定指纹与当前指纹。
 *
 * @param anchor - 启动期指纹
 * @param current - 当前指纹
 * @returns 漂移结论（changed 为字段名列表）
 */
export function diffSecurityConfigFingerprint(
  anchor: SecurityConfigFingerprint,
  current: SecurityConfigFingerprint,
): SecurityConfigDrift {
  if (anchor.fingerprint === current.fingerprint) {
    return { ok: true, changed: [], currentFingerprint: current.fingerprint };
  }
  const changed = new Set<string>();
  for (const key of new Set([...Object.keys(anchor.fields), ...Object.keys(current.fields)])) {
    if (stableStringify(anchor.fields[key]) !== stableStringify(current.fields[key])) changed.add(key);
  }
  return { ok: false, changed: [...changed].sort(), currentFingerprint: current.fingerprint };
}

/**
 * 基于配置文件的漂移复核器（宿主注入 Runner 的 `securityIntegrity.recheck`）。
 *
 * @param options.configPath - 配置文件绝对路径
 * @param options.anchor - 启动期锚定指纹
 * @returns 复核函数：ok=false 时 changed 非空
 */
export function createFileSecurityIntegrity(options: {
  configPath: string;
  anchor: SecurityConfigFingerprint;
}): () => SecurityConfigDrift {
  return () => {
    let slice: ReturnType<typeof extractSecurityConfigSlice>;
    try {
      slice = extractSecurityConfigSlice(readFileSync(options.configPath, 'utf8'));
    } catch (err) {
      // 读不到/解析不了 = 无法证明未被篡改，按漂移对待（fail-closed）
      return {
        ok: false,
        changed: [`<config unreadable: ${err instanceof Error ? err.message : String(err)}>`],
        currentFingerprint: '<unreadable>',
      };
    }
    return diffSecurityConfigFingerprint(options.anchor, computeSecurityConfigFingerprint(slice));
  };
}
