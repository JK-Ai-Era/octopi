/**
 * generatedDescription 来源徽标（信任分级 human > llm > heuristic）
 *
 * 数据源：KnowledgeSource.generatedDescriptionSource（v0.98.13 强制归因）。人工
 * description 权威、不带徽标；徽标只标注机器生成的档位，让「这行是模型推断的」
 * 在管理面一眼可辨——LLM 文本读起来像权威，必须与启发式/人工显式区分。
 * 归因缺失（旧库）按启发式显示；blocked_secret 是启发式兜底 + 密钥封锁特例
 * （抽样含密钥形态，素材未外发）。
 */

import type { MessageKey } from '../i18n/core';
import { useT } from '../i18n/react';

const TIERS: Record<
  'heuristic' | 'llm' | 'blocked_secret',
  { labelKey: MessageKey; titleKey: MessageKey; bg: string; color: string }
> = {
  llm: {
    labelKey: 'descriptionSourceBadge.llmLabel',
    titleKey: 'descriptionSourceBadge.llmTitle',
    bg: '#eaf2fb',
    color: '#2c6fbb',
  },
  heuristic: {
    labelKey: 'descriptionSourceBadge.heuristicLabel',
    titleKey: 'descriptionSourceBadge.heuristicTitle',
    bg: '#f0f0f0',
    color: '#666',
  },
  blocked_secret: {
    labelKey: 'descriptionSourceBadge.blockedSecretLabel',
    titleKey: 'descriptionSourceBadge.blockedSecretTitle',
    bg: '#fdf3e7',
    color: '#b9770e',
  },
};

export function DescriptionSourceBadge({
  source,
}: {
  source?: 'heuristic' | 'llm' | 'blocked_secret';
}) {
  const t = useT();
  const tier = TIERS[source ?? 'heuristic'] ?? TIERS.heuristic;
  return (
    <span
      title={t(tier.titleKey)}
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
      {t(tier.labelKey)}
    </span>
  );
}
