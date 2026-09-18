# Memory — 记忆系统

> Layer: Layer 2

价值模型 **fact / method / norm**（见 `docs/memory-system-redesign.md`）。

**核心命题**：Memory 在 Information 窗口消失后仍改变未来行为；单位是可行动命题，不是摘要或计数。

## 职责

- 契约与实现：InMemory / Sqlite（`AgentDatabase` → `agent.db`）
- 写入策略：`confidence.ts`（channel 暂定）+ `gates.ts`（结构门控 reason code）
- 治理：软删除 `deleted` + Steward 策略（`subsystems/memory-steward/shared`）
- system prompt 七层组装在 `harness/context/`；全局宪法在 `harness/context/constitution/`

## 不做什么

- 不做上下文压缩（context）
- 不做开放回路/任务状态（session tasks）
- 不做静态外部资料（Knowledge）
- **不做** session ETL 提取（`memory-extractor` / Bridge / Pending / `extract/` 目录均已删除）

## 禁止复活的路径

| 废弃 API / 路径 | 替代 |
|-----------------|------|
| `memory.extractor` 子系统 | `memory.steward.backfill` / `memory.steward.govern` |
| `MemoryExtractionWiring` / `build().memoryExtraction` | 无句柄；治理由 Steward schedule/event 驱动 |
| `JsonlExtractorStore` / `agentHome/extract/` | 补录读 SessionStore |
| `MemoryType: preference/decision/lesson/discovery` | `fact \| method \| norm` |
| 统计句 `extractCandidates` | 宪法 + LLM 命题 + gates |

完整规格：`docs/memory-system-redesign.md`。

## 文件说明

- types.ts — MemoryType/Entry/Query/Store
- store.ts / sqlite/memory-store.ts — 实现（含 softDelete/undelete/listForGovern）
- confidence.ts / gates.ts — 写入暂定与准入
- cognition.ts / sqlite/cognition-store.ts — 概念图谱
- index.ts — 导出
