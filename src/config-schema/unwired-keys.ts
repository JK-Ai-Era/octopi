/**
 * 已声明但尚未接线的配置键检测 — 消除「配了不生效」的静默（docs/KNOWN-ISSUES.md 跟踪面）
 *
 * 与 unknown-keys.ts 的分工：
 * - unknown-keys：schema **不接受**的键（typo）——Zod strip 会静默丢弃，写路径 fail-loud、启动路径告警；
 * - 本模块：schema **接受**但**无消费方**的键——配置合法却毫无效果，是最隐蔽的一类静默，
 *   启动路径必须显式告警（写路径消费方接入后本表同步收窄）。
 *
 * 表的准确性以代码消费面为准（例如附件注入的 `fullTextMaxChars` / `intent` / `recallTopK` 均有生产消费方）。
 * 收窄本表 = 实现消费方；新增未接线键 = 补行 + KNOWN-ISSUES 同步。
 *
 * 覆盖边界：对象路径（含嵌套叶子）；数组段（agents[] / channels[] 等）内部不做下标粒度扫描，
 * 数组段自身的未接线子键需另行跟踪。
 *
 * @module
 */

/** 路径前缀规则：命中该路径本身或其任意子键即报告一次（按规则路径去重） */
const UNWIRED_PREFIXES: readonly string[] = [

];

/**
 * 收集 raw 对象树上的全部点路径（对象中间节点与叶子都收集）
 *
 * @param val - 当前值
 * @param path - 当前路径前缀（根为 ''）
 * @param out - 收集器（有序、去重）
 */
function collectPaths(val: unknown, path: string, out: Set<string>): void {
  if (val === null || typeof val !== 'object') return;
  if (Array.isArray(val)) {
    // 数组元素不做下标粒度：数组段本身视为叶子（未接线规则均非数组段）
    return;
  }
  for (const [key, value] of Object.entries(val as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    out.add(childPath);
    collectPaths(value, childPath, out);
  }
}

/**
 * 检测配置中「已声明但尚未接线」（配置了不生效）的键
 *
 * `session` 已收紧为显式 schema（v0.98.16）：其未知子键由 `detectUnknownConfigKeys`
 * 按 typo 处理，本模块不再单列 `session.*`（否则同一问题会在启动时报两次）。
 *
 * @param raw - raw 配置对象（未过 Zod；形状与 octopi.json 一致）
 * @returns 命中的规则路径数组（每条规则至多报告一次）
 */
export function detectUnwiredConfigKeys(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object') return [];
  const paths = new Set<string>();
  collectPaths(raw, '', paths);

  const out: string[] = [];
  for (const prefix of UNWIRED_PREFIXES) {
    if (paths.has(prefix) || [...paths].some((p) => p.startsWith(`${prefix}.`))) {
      out.push(prefix);
    }
  }
  return out;
}

/**
 * 仅本地托管 Knowledge Service（manageLocal）消费的调参路径——经
 * `knowledgeTuningFromConfig` 进本地 Service boot；`manageLocal=false` 时无消费方，
 * 远程 Service 由其自身部署配置。注意：`promotion.*`、`query.*`、`autoInject` 的
 * 预算/条数键、`catalog` 展示键均为网关侧消费，不在此列。
 */
const MANAGED_SERVICE_ONLY_KNOWLEDGE_PREFIXES: readonly string[] = [
  'knowledge.embed',
  'knowledge.load',
  'knowledge.index',
  'knowledge.keywordWeight',
  'knowledge.autoInject.minScore',
  'knowledge.autoInject.minCoverage',
  'knowledge.hint.minScore',
  'knowledge.catalog.autoDescribe',
  'knowledge.service.connectTimeoutMs',
];

/**
 * 条件性未接线检测：`knowledge.service.manageLocal === false` 时无消费方的调参键（配了不生效；
 * 与 unwired 键一样经 loadConfig 启动告警，不再静默）。
 * 与 `detectUnwiredConfigKeys` 同机制（路径前缀规则、每条至多报告一次）。
 *
 * @param raw - raw 配置对象（未过 Zod；形状与 octopi.json 一致）
 * @returns 命中的调参路径数组；非「非本地托管」形态返回 []
 */
export function detectRemoteIgnoredKnowledgeKeys(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object') return [];
  const kn = (raw as Record<string, unknown>).knowledge;
  if (kn === null || typeof kn !== 'object') return [];
  const service = (kn as Record<string, unknown>).service;
  const manageLocal =
    service !== null && typeof service === 'object'
      ? (service as Record<string, unknown>).manageLocal
      : undefined;
  if (manageLocal !== false) return [];
  const paths = new Set<string>();
  collectPaths(kn, 'knowledge', paths);
  const out: string[] = [];
  for (const prefix of MANAGED_SERVICE_ONLY_KNOWLEDGE_PREFIXES) {
    if (paths.has(prefix) || [...paths].some((p) => p.startsWith(`${prefix}.`))) {
      out.push(prefix);
    }
  }
  return out;
}
