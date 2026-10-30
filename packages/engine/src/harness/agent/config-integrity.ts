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
import { computeConfigHash } from '../../config-admin/patch.js';

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
  // P5 审计外送也是安全面（换收口 = 换见证人）
  'opsAuditExportPath',
  'network',
  'escalation',
  // ops P4：危险命令减速带也是安全闸（改档 = 放松/收紧确认闸，须重启 + 宿主署名）
  'dangerousCommands',
] as const;

const SECURITY_CONFIG_SECURITY_KEYS = ['enforce', 'injectionSensitivity', 'allowedPaths'] as const;

/**
 * effectPolicy 中**不进热应用**的子字段（§4.3.1：需重启 + 宿主确认）。
 *
 * 判据是 §4.3.1 **明列**的安全闸 + 注释明确「须重启 + 宿主署名」的字段，**不是**整个
 * 指纹范围（EFFECT_POLICY_SECURITY_KEYS）——指纹范围只回答「哪些字段变化算漂移」，
 * 热应用禁区回答「哪些字段改了必须重启确认」，两者不可混用（把 shellEscape 等一并
 * 划入禁区会误拒 WebUI 的合法合并编辑）。
 *
 * `mode` 允许热改（WebUI「安全组」四选一）；`shellEscape` / `untrustedAdmission` /
 * `pathContainment` / `toolIsolation` / `network` 是普通配置旋钮，允许热改（仍在指纹内，
 * 改了会重锚）。ApplyEngine 据此拒绝禁区字段（评审 M2 补全此前缺失的拒绝逻辑）。
 */
export const EFFECT_POLICY_HOT_BLOCKED_KEYS: readonly string[] = [
  // §4.3.1 明列
  'jail',
  'onJailUnavailable',
  'privilegedAck',
  'effects',
  'escalation',
  // §4.3.1「审计开关」；P5 审计外送 = 换见证人
  'opsAudit',
  'opsAuditPath',
  'opsAuditExportPath',
  // ops P4 注释明说「危险命令减速带…须重启 + 宿主署名」
  'dangerousCommands',
];

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

/**
 * 可重锚定守卫（ops P2 §8.4「WebUI 署名通道」落地）：启动锚定 → 每 run 复核 →
 * 受控写通道写盘成功后 {@link SecurityIntegrityGuard.reattest} 重新锚定。
 *
 * 威胁模型边界：reattest 的调用方是宿主的受控写通道（console 管理面，带鉴权），
 * 等价于人工重启的署名确认；agent 绕过通道直改文件依然被 recheck 判漂移（拒新 run 不变）。
 */
export interface SecurityIntegrityGuard {
  /** 当前锚定指纹（活视图：reattest 后更新；漂移审计的「旧摘要」读它） */
  readonly fingerprint: string;
  /** 复核当前安全配置（读不到/解析失败按漂移对待，fail-closed） */
  recheck(): SecurityConfigDrift;
  /**
   * 受控写通道写盘成功后重新锚定。
   *
   * 两道校验（缺一不可，评审 M1）：
   * - `expectHash`：写盘方给出的写后原文 hash。rename 与重锚之间若有第三方写入
   *   （TOCTOU），hash 不符 → 拒绝重锚。
   * - `allowedChanged`：允许被本次写改变的顶层安全字段。changed 超出白名单 =
   *   既存篡改或越权写（正是 §8.4 要防的自提权面）→ 拒绝重锚，防止一次无关的
   *   console 写把已存在的漂移「洗白」。
   *
   * 两者任一不符即抛错：调用方降级为 warning，守卫维持漂移态（fail-closed），
   * 直至宿主重启采纳盘上配置。
   *
   * @param options - 校验参数（见上）
   * @returns 旧→新指纹与变化字段
   * @throws 校验不符 / 盘上文件读不到
   */
  reattest(options?: {
    /** 写后原文 hash（`computeConfigHash`）；不符 = TOCTOU，拒绝重锚 */
    expectHash?: string;
    /**
     * 允许变化的顶层安全字段（`'agents'` | `'effectPolicy'` | `'security'` | `'plugins'`）。
     * 省略 = 不限（仅宿主显式全量确认，如重启采纳盘上配置）
     */
    allowedChanged?: string[];
  }): { previousFingerprint: string; fingerprint: string; changed: string[] };
}

/**
 * 基于配置文件的可重锚定守卫。
 *
 * @param options.configPath - 配置文件绝对路径
 * @returns 守卫（锚定与复核同口径：都取 raw 文件安全切面）
 * @throws 启动期文件读不到/解析失败（fail-fast，与锚定即拒绝启动的既有语义一致）
 */
export function createSecurityIntegrityGuard(options: {
  configPath: string;
}): SecurityIntegrityGuard {
  type Slice = ReturnType<typeof extractSecurityConfigSlice>;
  const readSlice = (): { text: string; slice: Slice } => {
    const text = readFileSync(options.configPath, 'utf8');
    return { text, slice: extractSecurityConfigSlice(text) };
  };
  let anchor = computeSecurityConfigFingerprint(readSlice().slice);
  return {
    get fingerprint(): string {
      return anchor.fingerprint;
    },
    recheck(): SecurityConfigDrift {
      let slice: Slice;
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
      return diffSecurityConfigFingerprint(anchor, computeSecurityConfigFingerprint(slice));
    },
    reattest(reattestOptions?: {
      expectHash?: string;
      allowedChanged?: string[];
    }): { previousFingerprint: string; fingerprint: string; changed: string[] } {
      // 刚写盘的文件读不到/解析不了 = 内部异常：抛给调用方降级处理（锚不换，fail-closed 保持）
      const { text, slice } = readSlice();

      // 校验一（TOCTOU）：写后 hash 与盘上现状不符 = 重锚前有第三方写入
      if (reattestOptions?.expectHash !== undefined) {
        const actualHash = computeConfigHash(text);
        if (actualHash !== reattestOptions.expectHash) {
          throw new Error(
            `security re-attest refused: config changed on disk since the console write (expected ${reattestOptions.expectHash.slice(0, 8)}, got ${actualHash.slice(0, 8)}); host restart attests instead`,
          );
        }
      }

      const current = computeSecurityConfigFingerprint(slice);
      const diff = diffSecurityConfigFingerprint(anchor, current);

      // 校验二（防白洗）：本次写只应改变它声明的字段；其余安全字段变化 = 既存篡改/越权
      if (reattestOptions?.allowedChanged) {
        const allowed = new Set(reattestOptions.allowedChanged);
        const unexpected = diff.changed.filter((field) => !allowed.has(field.split('.')[0] ?? ''));
        if (unexpected.length > 0) {
          throw new Error(
            `security re-attest refused: security fields outside this write's scope changed (${unexpected.join(', ')}); refusing to attest them — host restart required`,
          );
        }
      }

      const previous = anchor;
      anchor = current;
      return {
        previousFingerprint: previous.fingerprint,
        fingerprint: current.fingerprint,
        changed: diff.changed,
      };
    },
  };
}
