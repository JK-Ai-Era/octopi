# Memory

> 八层上下文中的第 6 层。在对话窗口（Information）消失之后，仍能改善未来决策与行为。  
> 面向集成方与产品读者；实现细节见源码与内部规格。

---

## 1. 核心理念

| 公理 | 含义 |
|------|------|
| **单位是命题** | 记的是可检验、可行动的命题，不是摘要、计数、活动日志 |
| **宁缺毋滥** | 0 条合法。无证据、无锚点、不改变未来行为的内容不得入库 |
| **写者多样，准入同一** | Agent 自写 / 子系统补录 / 管理 API 走同一门控与置信度 |
| **意图归 LLM，执法归代码** | 「是否值得记住」「属于哪类」由模型判断；形态、溯源、安全由代码强制 |
| **置信度是挣得的** | 写入时暂定，经检索与时间强化；不依赖人工「确认」UI |

Memory **不是**对话备份、不是任务列表、不是外部文档库。这些各有归属（Session / Tasks / Knowledge）。

---

## 2. 价值模型：三类命题

| type | 回答 | 例子 |
|------|------|------|
| **fact** | 现在什么是真的 | 环境事实、已定技术选型、会话确认的项目约定 |
| **method** | 同类问题怎么做更有效 | 情境 → 动作 → 原因（可复用做法） |
| **norm** | 以后应 / 不应如何行动 | 行为开关（「禁止提交 octopi.json」） |

不入库：开放回路（进行中任务）、外部静态资料、人格/平台规则、密钥、统计句（「有 3 条约束」）。

---

## 3. 写入

```text
                    ┌─ Agent 显著时 memory_store（主通道）
用户 / 会话 ────────┼─ Steward.backfill（收敛后补录，可关）
                    └─ 管理 API / 集成方
                              │
                              ▼
              槽位：type / proposition / evidence
                    / future_use / anchors / channel
                              │
                    confidence 暂定 + 结构门控
                              │
                              ▼
                      MemoryStore（agent.db）
```

**主通道**由产品宪法（system preamble）引导：只有显著性命中才写（偏好/约束/决策/fail→fix/稳定事实/用户明确要求）。0 条是常态。

**补录（Steward.backfill）**在会话收敛后（硬收敛 / 空闲漂移）从 Session 原文提取遗漏命题；可用 `memory.backfill.enabled: false` 关闭以省 LLM 成本。

**门控（结构）**拒绝：空命题、过短/过长、无证据、伪证据、统计句、活动日志、无检索锚点、注入形态、密钥等。拒绝带 reason code，可观测。

**置信度（channel 暂定）**写入时定 `status`：

| status | 含义 |
|--------|------|
| `shadow` | 可搜索、**默认不注入** system（假设级） |
| `active` | 可召回注入 |
| `strengthened` | 经时间/使用强化，注入更宽松 |

---

## 4. 读取

| 路径 | 行为 |
|------|------|
| **MemoryLayer** | 按当前任务召回 active/strengthened，拼进 system prompt；不含 shadow / 已删 |
| **`memory_search`** | LLM 主动检索；含 shadow（弱线索）；排除已删 |
| **`memory_store`** | 写入；可选 `supersedes_id` 替换过时结论（软删旧条） |

与 **`session_search`** 分工：Memory = 蒸馏命题；Session = 原文与过程。

---

## 5. 治理（Steward.govern）

定时（默认 1h）对记忆库「理架」，**不产生新命题**：

1. **连续衰减** — 按类型 idle 曲线降低 `decayFactor`（method 更易过时，norm 更稳）
2. **软删除** — 垃圾复检、shadow 过期、长期未用、容量溢出、近重复合并（`winnerId` 可审计）
3. **保护名单** — 高置信用户指令、近期强化、高分 norm、安全/环境 tag 不被误删
4. **挣得** — 仍被检索的条目弱强化；shadow 被多次检索可晋升 active

只软删、可恢复、可 dryRun。治理信号不污染主会话。

**触发时机（补录）**：会话硬收敛（结束 / `/new`）立即；空闲漂移（默认 20min）；覆盖差扫描兜底。带覆盖表去重，避免重复烧钱。

---

## 6. 配置

```json
{
  "memory": {
    "profile": "embedded_interactive",
    "backfill": {
      "enabled": true,
      "idleDelayMs": 1200000,
      "gapScanMs": 21600000,
      "minUserTurns": 2
    },
    "decay": {
      "typeParams": {
        "method": { "idleDays": 21, "factor": 0.93, "min": 0.1 }
      }
    },
    "health": {
      "intervalMs": 3600000,
      "shadowBacklogLimit": 50,
      "limits": { "fact": 200, "method": 100, "norm": 150 }
    },
    "confidence": { "injectMinScore": 0.55 },
    "gates": { "maxLength": { "fact": 400, "method": 500, "norm": 300 } }
  }
}
```

| 键 | 作用 |
|----|------|
| `profile` | 通道先验（`personal_assistant` / `embedded_interactive` / `embedded_headless`） |
| `backfill.enabled` | 自动补录开关（默认开）；不影响 govern |
| `decay.typeParams` | 按 fact/method/norm 的衰减 idle / 步进 / 下限 |
| `health.*` | 库存水位 / shadow 积压探测阈值（触发治理双脉搏） |
| `confidence` / `gates` | 注入分数地板、结构长度 |

---

## 7. 边界

| 不是 Memory | 归属 |
|-------------|------|
| 对话原文 / 过程 | Session（`session_search`） |
| 进行中任务 / 开放回路 | Session Tasks |
| API 文档、静态资料 | Knowledge |
| 人格、语气、平台规则 | Persona / Constitution |
| 思维范式二次提炼 | Wisdom / Cognition（下游） |

持久化为 **per-agent** `agent.db`（内置 `node:sqlite`，Node ≥ 24）。Memory 与 Cognition/Wisdom 同库不同表；Steward 只写 Memory。

---

## 8. 质量口径

1. 宁可 0 条记忆，不可 1 条无证据、无锚点、不改变未来行为的条目。  
2. 单位是命题，不是摘要。  
3. 意图理解不进正则；结构执法不猜语义。  
4. 所有写者同一门控；治理可审计、可软删、可恢复。

---

## 相关

- Knowledge（外生语料）：[docs/knowledge.md](./knowledge.md)
- 层契约与 system 装配：`docs/context-layer-contracts.md`
- 架构总览：`docs/architecture.md`
- 实现入口：`src/harness/memory/`
