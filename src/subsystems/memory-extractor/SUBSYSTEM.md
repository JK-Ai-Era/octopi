---
name: memory.extractor
version: 2.0.0
---

# Memory Extractor

从主会话的结构化事件中提取记忆候选，支持 code（纯规则）和 hybrid（规则+LLM）两种模式。

## 工作流程

### Code 模式（默认，无 modelProvider）
1. **采集** — `SessionExtractCollector`（harness 层）监听 EventBus 事件，聚合为 `SessionExtractBundle`
2. **触发** — session 进入 `recent` 状态且 `extractionStatus=pending`
3. **规则提取** — 按事件类型模式匹配（preference/decision/lesson/discovery）
4. **去重** — 同源去重 + 类型标签容量控制 + 证据升级
5. **阈值过滤** — 动态阈值（含修复奖励机制）
6. **入库** — MemoryStore

### Hybrid 模式（配置 modelProvider + llmEnrichment）
1-3. 同 code 模式（规则粗筛）
4. **LLM 语义增强** — 将 bundle 事件压缩为文本，LLM 提取隐式偏好/决策/经验
5. **合并** — rule candidates + LLM candidates
6-8. 去重 → 阈值 → 入库

LLM 增强的价值：
- 理解自然语言中的隐式偏好（"我觉得这样更好"）
- 跨语言提取（中英混合场景）
- 识别隐式决策（讨论后达成共识但无明确事件）
- 提取更丰富、具体的记忆内容

## 注入依赖

| 名称 | 类型 | 必选 | 说明 |
|------|------|------|------|
| `memoryStore` | `MemoryStore` | 是 | 记忆存储实现 |
| `modelProvider` | `ModelProvider` | 否 | LLM 调用接口（hybrid 模式） |

## 契约

- **输入**: `SessionExtractBundle`（定义于 `contracts/bundle.ts`）
- **输出**: `ExtractionResult`（accepted candidates + 统计）

## 观测性

事件前缀：`memory.extractor.*`

信号数据包含 `mode` 字段（`code` 或 `hybrid`），区分提取模式。

## 恢复策略

`PendingExtractor`（harness 层）定时扫描 pending session，指数退避重试。
