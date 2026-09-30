/**
 * 模型能力相关的共享常量
 *
 * @module core/types/model-info
 */

/**
 * 产品配置层默认上下文窗口（历史常量）
 *
 * **不再**作为引擎运行时预算回退。contextWindow 未在配置中声明时：
 * 引擎按「未知」处理（跳过基于窗口的自动压缩），不猜测。
 * 仅当用户显式配置 `defaults.contextWindow` 时才会进入 resolveModelConfig。
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
