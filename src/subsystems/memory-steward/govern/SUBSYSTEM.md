# Memory Steward Govern

本子系统**不提取内容**。对 MemoryStore 执行治理：

1. **连续衰减**：`memoryStore.decay()`（idle 未访问 → `decay_factor *= 0.95`，下限 0.1）；须在 softDelete 规划前执行
2. 保护名单
3. 重复合并（软删败者）
4. shadow 过期 / 低价值衰减 / 容量溢出 → 软删除
5. **挣得 boost**：幸存且近 30d 仍被检索的条目弱 boost；shadow 检索≥2 次晋升 active
6. **晋升候选**：method/norm 高分且被检索 → 仅 signal（`promotionCandidates`），**不写 Wisdom**

`dryRun` 时 decay / softDelete / boost 均不落库。soft_delete 与 boost 写入审计 ops；signal.channel 仅 event，不注入主会话。
