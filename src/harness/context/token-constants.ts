/**
 * Token 估算常量
 *
 * 参考 OpenClaw 的分层比率策略，按内容类型使用不同估算比率。
 * 基于 tiktoken cl100k_base 经验值。
 */

// ── 字符/token 比率 ──

/** 通用文本：英文约 4 chars/token，中文约 1 char/token */
export const CHARS_PER_TOKEN = 4;

/** 工具结果：结构化输出更密集，约 2 chars/token */
export const TOOL_RESULT_CHARS_PER_TOKEN = 2;

/** JSON 负载：结构符号多，约 3 chars/token */
export const JSON_CHARS_PER_TOKEN = 3;

/** 消息结构开销（role + 分隔符 + 边界标记） */
export const MESSAGE_OVERHEAD_TOKENS = 12;

/** 安全余量系数：补偿估算不准，参考 OpenClaw 的 SAFETY_MARGIN */
export const SAFETY_MARGIN = 1.2;

// ── 多媒体估算 ──

/** 图片 token 估算（参考 OpenAI vision: 85-170 token/tile，假设 ~1200 token） */
export const IMAGE_TOKEN_ESTIMATE = 1200;

/** 音频 token 估算（~1 token/秒，假设 30 秒） */
export const AUDIO_TOKEN_ESTIMATE = 30;

/** 视频 token 估算（抽帧处理，假设 10 帧 × 85 token） */
export const VIDEO_TOKEN_ESTIMATE = 850;

// ── 采样策略 ──

/** 超长文本采样阈值（字符数） */
export const SAMPLE_THRESHOLD = 2000;
