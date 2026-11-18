# Cognition Steward Consolidate

巩固批：legacy 候选保守 keep_split → merge_llm_adjudication（kind≠ / embedding_band 候选 LLM 裁决 merge/keep_split/drop，≤10/批）→ 衰减 → 晋升 → GC。

LLM 仅用于合并裁决（`chatForCompleteOutput` 完整性语义，失败 fail-loud）；Memory 只读（命题摘要为裁决输入）；不写 Memory/Wisdom。
未实现步骤见 handler SKIPPED_STEPS（causal_candidate 转正 / counter_evidence / Wisdom 信号 / anchor:missing GC）。
本文仅作认知指令占位（think.implementation=code）。
