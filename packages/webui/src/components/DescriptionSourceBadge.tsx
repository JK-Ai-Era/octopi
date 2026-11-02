/**
 * generatedDescription 来源徽标（信任分级 human > llm > heuristic）
 *
 * 数据源：KnowledgeSource.generatedDescriptionSource（v0.98.13 强制归因）。人工
 * description 权威、不带徽标；徽标只标注机器生成的档位，让「这行是模型推断的」
 * 在管理面一眼可辨——LLM 文本读起来像权威，必须与启发式/人工显式区分。
 * 归因缺失（旧库）按启发式显示；blocked_secret 是启发式兜底 + 密钥封锁特例
 * （抽样含密钥形态，素材未外发）。
 */
const TIERS: Record<
  'heuristic' | 'llm' | 'blocked_secret',
  { label: string; title: string; bg: string; color: string }
> = {
  llm: {
    label: 'LLM 生成',
    title: '此描述由 LLM 生成（gateway 代生成，素材经密钥扫描）；人工描述优先于它',
    bg: '#eaf2fb',
    color: '#2c6fbb',
  },
  heuristic: {
    label: '启发式',
    title: '此描述由启发式规则（名称/路径推断）生成；人工描述优先于它',
    bg: '#f0f0f0',
    color: '#666',
  },
  blocked_secret: {
    label: '启发式 · 密钥封锁',
    title: '抽样含密钥形态，素材未外发（fail-safe）；描述为启发式兜底',
    bg: '#fdf3e7',
    color: '#b9770e',
  },
};

export function DescriptionSourceBadge({
  source,
}: {
  source?: 'heuristic' | 'llm' | 'blocked_secret';
}) {
  const tier = TIERS[source ?? 'heuristic'] ?? TIERS.heuristic;
  return (
    <span
      title={tier.title}
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: 3,
        background: tier.bg,
        color: tier.color,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.5,
        marginRight: 6,
        verticalAlign: '1px',
      }}
    >
      {tier.label}
    </span>
  );
}
