/**
 * 已声明但尚未接线的配置键检测 — 消除「配了不生效」的静默（docs/KNOWN-ISSUES.md 跟踪面）
 *
 * 与 unknown-keys.ts 的分工：
 * - unknown-keys：schema **不接受**的键（typo）——Zod strip 会静默丢弃，写路径 fail-loud、启动路径告警；
 * - 本模块：schema **接受**但**无消费方**的键——配置合法却毫无效果，是最隐蔽的一类静默，
 *   启动路径必须显式告警（写路径消费方接入后本表同步收窄）。
 *
 * 表的准确性以代码消费面为准（e.g. `knowledge.attachments.inject.fullTextMaxChars/intent*` 已接线，
 * 同段的 `recallTopK/inventory` 未接线）。收窄本表 = 实现消费方；新增未接线键 = 补行 + KNOWN-ISSUES 同步。
 *
 * 覆盖边界：对象路径（含嵌套叶子）；数组段（agents[] / channels[] 等）内部不做下标粒度扫描，
 * 数组段自身的未接线子键需另行跟踪。
 *
 * @module
 */

/** 路径前缀规则：命中该路径本身或其任意子键即报告一次（按规则路径去重） */
const UNWIRED_PREFIXES: readonly string[] = [
  // compact 能力级缺省（会话压缩实际读 contextEngine 键）
  'compact',
  // 逐插件配置：穿过边界但 PluginLoader 不读
  'plugins.configs',
  // 附件注入/工具旋钮：gateway 只转发 fullTextMaxChars/intent/intentTimeoutMs/emptyMessagePrompt，
  // 以下三个无消费方（inventory 是注入产物字段而非配置开关）
  'knowledge.attachments.inject.recallTopK',
  'knowledge.attachments.inject.inventory',
  'knowledge.attachments.tools.attachmentsRootReadOnly',
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
