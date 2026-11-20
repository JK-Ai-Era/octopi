/**
 * admin 密码策略 — 单源常量与判定。
 *
 * 独立成文件（零依赖）的原因：这个值同时被三处消费——
 * ① 状态机校验（`onboarding.ts` validateStep）
 * ② 落盘前终检（`onboarding-apply.ts`）
 * ③ 渲染层文案（webui i18n）
 * 若把常量留在 `onboarding.ts` 里，webui 的 tsconfig `paths` 会把整棵 engine 源码树
 * 拉进前端类型检查（`@octopi-agent/engine/*` → `packages/engine/src/*`），
 * 触发引擎里既有的未使用变量报错。零依赖模块让三方都能只拿到这一个值。
 *
 * 下限 8 是安全底线而非目标：组织模式常暴露在局域网，弱密码是实际风险。
 *
 * @module
 */

/** admin 密码最短长度（组织/多组织模式必填项的下限） */
export const MIN_ADMIN_PASSWORD_LENGTH = 8;

/**
 * 校验 admin 密码是否满足最低要求。
 *
 * @param password - 明文密码（可能为空/未填）
 * @returns 不合格原因；合格返回空串
 */
export function checkAdminPassword(password: string | undefined): string {
  const pw = (password ?? '').trim();
  if (!pw) return 'required';
  if (pw.length < MIN_ADMIN_PASSWORD_LENGTH) return 'too_short';
  return '';
}
