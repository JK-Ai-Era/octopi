# Memory Steward Govern

本子系统**不提取内容**。对 MemoryStore 执行治理：

1. 保护名单
2. 重复合并（软删败者）
3. shadow 过期 / 低价值衰减 / 容量溢出 → 软删除

全部动作写入审计 ops；signal.channel 仅 event，不注入主会话。
