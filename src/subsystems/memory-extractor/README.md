# Memory Extractor（作者说明）

> 认知指令见 [SUBSYSTEM.md](./SUBSYSTEM.md)（注入 `llmPort` 作为 system prompt）。
> 本文档面向子系统作者 / 运维，不进入 LLM prompt。

## 模式

`think.implementation: code`。handler 自包含流水线：

| 运行模式 | 条件 | 流程 |
|----------|------|------|
| code | 无 `llmPort` 或未启用 `llmEnrichment` | 规则提取 → 去重 → 阈值 → 入库 |
| hybrid（handler 内） | 有 `llmPort` + `metadata.config.llmEnrichment` | 规则粗筛 → `llmPort.chat` 语义增强 → 合并 → 去重 → 阈值 → 入库 |

> 这里的 hybrid 指 **handler 运行模式**，不是 `think.implementation: hybrid`（那是框架 `pre→LLM→post`）。

## 目录

```
memory-extractor/
├── config.yaml           # 运行时边界 / sense / runtimeInject
├── SUBSYSTEM.md          # LLM 认知指令（唯一 prompt 真相）
├── README.md             # 本文件
├── handler.ts            # 流水线入口
├── llm-enrichment.ts     # 事件压缩 + JSON 解析（不内置 system prompt）
├── contracts/bundle.ts   # 输入契约
├── policies/             # 去重 / 阈值
└── types.ts
```

## 注入依赖

| 名称 | 类型 | 必选 | 说明 |
|------|------|------|------|
| `memoryStore` | `MemoryStore` | 是 | 经 `runtimeInject.requires` 声明 |
| `llmPort` | `SubsystemLLMPort` | 否 | **框架自动注入**；含认知 prompt + fallback |
| `__subsystem_config__` | `MemoryExtractorConfig` | 否 | 来自 `metadata.config` |

无 `llmPort` 时跳过 LLM，仅规则提取（`mode: code`）。

## 契约

- **输入**: `SessionExtractBundle`（`payload.sessionExtractBundle`）
- **输出**: `ExtractionResult`（accepted candidates + 统计；`act.target = memory-store`）

## 观测

事件前缀：`memory.extractor.*`  
信号 `data.mode`：`code` 或 `hybrid`。

## 恢复

`PendingExtractor`（harness）定时扫描 pending session，指数退避重试。
