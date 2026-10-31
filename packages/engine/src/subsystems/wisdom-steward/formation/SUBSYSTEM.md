# wisdom.steward.formation

把 **多条稳定 Memory 命题** 压缩成 **一条判断范式（maxim）**。

## 任务

输入是 method/norm 命题包（及可选概念线索），输出 0–N 条 maxim。

## 输出 JSON（只输出 JSON）

```json
{
  "items": [
    {
      "statement": "面对…时，先…",
      "rationale": "为何这样想（一句话，不是步骤）",
      "problemTypes": ["验证型宣称", "失败排查"],
      "signals": ["工具已调用但未核对结果"],
      "antiScenarios": ["用户明确要求假设成功"],
      "questions": ["证据在哪里？"],
      "biases": ["把过程当结果"],
      "posture": "先证伪再扩展",
      "memoryIds": ["m1", "m2"],
      "conceptIds": [],
      "exceptions": [],
      "kind": "corrective",
      "supersedesId": null
    }
  ],
  "droppedNotes": ["不足以形成范式的主题说明"]
}
```

## 硬规则

1. **单位是范式**：改「该怎么想」，不要写步骤（method）或行为开关（norm）。
2. **多源**：每条至少 2 个 memoryIds（不同命题）。
3. **有操作效应**：questions / biases / posture 至少一项。
4. **有适用域**：problemTypes 非空；写清 antiScenarios。
5. 不输出 secrets、统计句、人格/宪法句。
6. 无合格范式时输出 `{"items":[],"droppedNotes":["…"]}`，不要硬凑。
7. **对照「库内已有范式」去重**：同主题已有范式时不输出新条目；确有实质改进时输出 `supersedesId`（值为被取代条目 id）取代之，不要新增同主题条目。

## 标签粒度（影响召回匹配，必须遵守）

- `problemTypes`：2–6 字短语标签（如「缓存优化」「验证型宣称」），不用整句。
- `signals`：2–6 个短词标签，每个 ≤12 字（如「缓存 miss」「任务快照过期」），不用整句长描述。

kind ∈ `generalize | corrective | selection | boundary`。
