/**
 * Knowledge Tier 0 — Catalog 契约
 *
 * @layer harness/context/knowledge
 *
 * Knowledge = 外生语料（源登记 / 索引 / 检索），不是命题库。
 * System 侧只注入 **catalog**（有哪些源、干什么用）；内容命中走 turn 级 grounding（后续阶段）。
 * 规格：`arch/knowledge-layer.md`。
 */

/** catalog 中的一条知识源摘要 */
export interface KnowledgeCatalogItem {
  id: string;
  displayName: string;
  /** 源形态：directory | file | url | connector | workspace | … */
  kind: string;
  /** 粗状态桶：ready | indexing | error | off */
  status?: string;
  /** 一行用途说明（人工 description 或 generatedDescription） */
  description?: string;
  /** global | project | session */
  scopeLevel?: string;
  /** 规模粗标，如 "~1.2k files" / "small" */
  scaleLabel?: string;
}

/**
 * 提供当前可见 catalog 条目（装配时现取，不持久化 catalog 文本）
 *
 * 可选入参用于 Session 级 ephemeral 源过滤；不传则只含 Global/Project 可见集。
 */
export type KnowledgeCatalogProvider =
  | ((ctx?: {
      agentId?: string;
      sessionId?: string;
    }) => Promise<KnowledgeCatalogItem[]> | KnowledgeCatalogItem[])
  | KnowledgeCatalogItem[];
