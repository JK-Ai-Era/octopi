/**
 * Token 估算常量
 *
 * 分层比率策略，按内容类型使用不同估算比率。
 * 基于 tiktoken cl100k_base 经验值。
 */

// ── 字符/token 比率 ──

/** 通用文本：英文约 4 chars/token，中文约 1 char/token */
export const CHARS_PER_TOKEN = 4;

/** 工具结果：结构化输出更密集，约 1.7 chars/token（2026-11-08 生产样本拟合：原 2 系统低估 ~40%） */
export const TOOL_RESULT_CHARS_PER_TOKEN = 1.7;

/** JSON 负载（schema / arguments）：结构符号多，约 2 chars/token（2026-11-08 样本拟合调低；与 tr 档共线，取业界密度区间居中，勿硬拟合） */
export const JSON_CHARS_PER_TOKEN = 2;

/** 中文等 CJK：1 token/字 */
export const TEXT_CJK_CHARS_PER_TOKEN = 1;

/** 代码 / 标识符：约 3 chars/token */
export const CODE_CHARS_PER_TOKEN = 3;

/** 消息结构开销（role + 分隔符 + 边界标记） */
export const MESSAGE_OVERHEAD_TOKENS = 12;

/** 安全余量系数：补偿估算不准 */
export const SAFETY_MARGIN = 1.2;

// ── 多媒体估算 ──

/** 图片 token 估算（参考 OpenAI vision: 85-170 token/tile，假设 ~1200 token） */
export const IMAGE_TOKEN_ESTIMATE = 1200;

/** 音频 token 估算（~1 token/秒，假设 30 秒） */
export const AUDIO_TOKEN_ESTIMATE = 30;

/** 视频 token 估算（抽帧处理，假设 10 帧 × 85 token） */
export const VIDEO_TOKEN_ESTIMATE = 850;
