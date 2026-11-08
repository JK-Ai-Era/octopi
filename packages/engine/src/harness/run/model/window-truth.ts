/**
 * per-model 窗口真值注册表（F 类真值回填，arch/overflow-redesign.md T2②）
 *
 * 「配置窗口是预测、provider 是测量」：长度类 400 的错误文本常带 provider
 * 报告的窗口上限（如 OpenAI "maximum context length is 128000 tokens"）——
 * 这是唯一知道真窗口的机制（守门人反哺调度器）。提取到的真值在此登记，
 * resolver 解析能力时优先于配置声明（`source: 'measured'`）。
 *
 * 只登记 provider 报告的**真值**；T2③ 的收缩上界是保守猜测，只在 run 级
 * 快照生效（见 context-length-feedback.ts），不入本表——猜测持久化会永久削窗。
 *
 * 状态为进程内存；重启后丢失的代价 = 再吃一次 400 重新回填（side effect，
 * 非主路径依赖），可接受。
 *
 * @module harness/run/model/window-truth
 */

/** 真值条目 */
export interface WindowTruthEntry {
  /** provider 报告的窗口上限（tokens） */
  tokens: number;
}

const truthByRef = new Map<string, WindowTruthEntry>();

/**
 * 登记 per-model 窗口真值（覆盖旧值——provider 的最新测量即真值）
 *
 * @param ref - 模型引用（`provider/modelName`，与 ResolvedModel.ref 同构）
 * @param tokens - provider 报告的窗口上限
 */
export function recordWindowTruth(ref: string, tokens: number): void {
  truthByRef.set(ref, { tokens });
}

/**
 * 查询 per-model 窗口真值
 *
 * @param ref - 模型引用
 * @returns 真值条目；未登记时 undefined
 */
export function getWindowTruth(ref: string): WindowTruthEntry | undefined {
  return truthByRef.get(ref);
}

/** 清空注册表（测试用） */
export function resetWindowTruth(): void {
  truthByRef.clear();
}
