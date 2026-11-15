/**
 * 产品语言本地化原语 — 预设表（provider / agent 角色）展示文案共用。
 *
 * 语义：`LocalizedText` 是可选的双语映射；渲染时按当前语言取值，
 * 缺译回落 `label` / `description` 基准字段（基准字段永在，不拆两套表）。
 *
 * @module
 */

/** 产品语言（顶层 `language` 配置取值域） */
export type ProductLang = 'zh' | 'en';

/** 双语文案映射（缺省语言回落基准字段） */
export type LocalizedText = Partial<Record<ProductLang, string>>;

/**
 * 取本地化文案
 *
 * @param map - 双语映射（可空）
 * @param fallback - 基准字段（label / description 等，永不为空）
 * @param lang - 当前语言
 * @returns 本地化文案；无译文时返回 fallback
 */
export function pickLocalized(map: LocalizedText | undefined, fallback: string, lang: ProductLang): string {
  return map?.[lang]?.trim() || fallback;
}
