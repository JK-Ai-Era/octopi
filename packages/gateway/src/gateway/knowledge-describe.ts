/**
 * Knowledge describe（B 方案，2026-11-02 拍板）— gateway 代生成 LLM 描述
 *
 * LLM 调用面收敛在 gateway（凭证不扩散进 Knowledge Service）；Service 只提供
 * 抽样（经密钥扫描）与写入口。素材组合与封锁口径见 describe-sample.ts。
 */

import type { ModelProvider } from '@octopi-agent/core/interfaces/model-provider.js';
import type { KnowledgeDescribePort } from '@octopi-agent/engine/harness/knowledge/describe.js';

/** LLM describe 调用超时（毫秒）：超时即弃，启发式保底 */
const DESCRIBE_LLM_TIMEOUT_MS = 30_000;

/**
 * 构造 LLM describe 端口（KnowledgeDescribePort 形状）。
 *
 * @param provider - models.level 解析出的模型提供者
 * @param model - 显式模型名（缺省用 provider 默认模型）
 * @returns describe 端口；失败向上抛出，由 generateKnowledgeDescription 回退启发式
 */
export function buildKnowledgeDescribePort(
  provider: ModelProvider,
  model?: string,
): KnowledgeDescribePort {
  return async (input) => {
    const prompt = [
      'Write ONE line describing what this knowledge corpus documents and when to search it.',
      'Output only the line — no label, no quotes, no trailing period. Max 160 characters.',
      `name: ${input.displayName}`,
      `kind: ${input.kind}`,
      `location: ${input.location}`,
      'sample:',
      input.sample,
    ].join('\n');
    const chat = provider.chat({
      messages: [{ role: 'user', content: prompt }],
      model,
      // 描述是短任务：输出硬顶 200（端口消费侧另有 300 字符钳制）
      maxTokens: 200,
    });
    // 超时即弃（启发式保底）：单飞 worker 不能挂死在一条无响应请求上
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`llm describe timeout (${DESCRIBE_LLM_TIMEOUT_MS}ms)`)),
        DESCRIBE_LLM_TIMEOUT_MS,
      );
      t.unref?.();
    });
    const res = await Promise.race([chat, timeout]);
    return res.content;
  };
}
