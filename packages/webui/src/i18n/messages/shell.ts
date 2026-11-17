/**
 * i18n 分片：shell — App 顶栏 / ThemeToggle / LanguageToggle（内核自带）。
 * 契约见 arch/i18n-extraction-spec.md。
 *
 * @module
 */

export const zh = {
  'app.panelToggle': '面板',
  'app.panelToggleTitle': '显示/隐藏右侧面板（会话物料 · 工作进度 · 环境；专家模式含运行时透明）',
  'theme.followSystem': '跟随系统',
  'theme.light': '浅色',
  'theme.dark': '深色',
  'theme.toggleTitle': '主题：{mode}（点击切换）',
  'theme.ariaLabel': '主题：{mode}',
  'langToggle.title': '语言：{current}（点击切换到 {next}）',
  'langToggle.ariaLabel': '语言：{current}（点击切换到 {next}）',
} as const;

export const en: Record<keyof typeof zh, string> = {
  'app.panelToggle': 'Panel',
  'app.panelToggleTitle':
    'Show/hide the right panel (session materials · work progress · environment; expert mode adds runtime transparency)',
  'theme.followSystem': 'Follow system',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.toggleTitle': 'Theme: {mode} (click to switch)',
  'theme.ariaLabel': 'Theme: {mode}',
  'langToggle.title': 'Language: {current} (click to switch to {next})',
  'langToggle.ariaLabel': 'Language: {current} (click to switch to {next})',
};
