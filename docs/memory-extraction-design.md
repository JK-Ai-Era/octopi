# Session → Memory 提取设计（历史文档 · Tombstone）

> **SUPERSEDED — DO NOT IMPLEMENT FROM THIS DOC**  
> 现行真相源：[docs/memory-system-redesign.md](./memory-system-redesign.md)  
> 本文正文已删除；完整历史见 `git log -- docs/memory-extraction-design.md`。

## 新旧概念对照

| 本文件历史概念 | 现行对应 |
|----------------|----------|
| `memory.extractor` 子系统 | **已删除** → `memory.steward.backfill` + `memory.steward.govern` |
| `MemoryExtractorBridge` / `PendingExtractor` | **已删除** → Steward 子系统（schedule / event 触发） |
| `MemoryExtractionWiring` / `build().memoryExtraction` | **已删除** → 无 build 句柄 |
| `JsonlExtractorStore` / `agentHome/extract/` | **已删除** → 补录读 SessionStore |
| `extractCandidates` 统计句规则 | **已删除** → 宪法 + LLM 命题 + `gates.ts` |
| `MemoryType = preference/decision/lesson/discovery/context/relationship` | → **`fact \| method \| norm`** |
| session lifecycle ETL 主路径 | → agent 自写 `memory_store` + Steward 补录/治理 |

## 还需要记忆系统时读什么

1. 设计与验收：`docs/memory-system-redesign.md`
2. 禁止复活清单：`src/harness/memory/README.md`
3. 项目不变量：仓库根 `AGENTS.md`（Runtime home layout 一节）
4. 产品宪法：`src/harness/context/constitution/default-agents.md`
5. Steward 实现：`src/subsystems/memory-steward/`
