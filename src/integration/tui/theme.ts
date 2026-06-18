/**
 * Octopi TUI Theme
 *
 * 配色方案：深色终端友好，语义化颜色。
 */

import chalk from 'chalk';

// ── 基础色板 ──

const palette = {
  bg: '#1e1e2e',        // catppuccin mocha base
  surface: '#313244',   // surface0
  overlay: '#45475a',   // surface1
  text: '#cdd6f4',      // text
  subtext: '#a6adc8',   // subtext0
  blue: '#89b4fa',
  green: '#a6e3a1',
  red: '#f38ba8',
  yellow: '#f9e2af',
  mauve: '#cba6f7',
  peach: '#fab387',
  teal: '#94e2d5',
  sky: '#89dceb',
  lavender: '#b4befe',
};

// ── Markdown Theme ──

export const markdownTheme = {
  heading: (t: string) => chalk.hex(palette.lavender).bold(t),
  link: (t: string) => chalk.hex(palette.blue).underline(t),
  linkUrl: (t: string) => chalk.hex(palette.subtext)(t),
  code: (t: string) => chalk.hex(palette.peach)(t),
  codeBlock: (t: string) => chalk.hex(palette.text)(t),
  codeBlockBorder: (t: string) => chalk.hex(palette.surface)(t),
  quote: (t: string) => chalk.hex(palette.subtext).italic(t),
  quoteBorder: (t: string) => chalk.hex(palette.mauve)(t),
  hr: (t: string) => chalk.hex(palette.surface)(t),
  listBullet: (t: string) => chalk.hex(palette.blue)(t),
  bold: (t: string) => chalk.bold(t),
  italic: (t: string) => chalk.italic(t),
  strikethrough: (t: string) => chalk.strikethrough(t),
  underline: (t: string) => chalk.underline(t),
};

// ── Editor Theme ──

export const editorTheme = {
  borderColor: (t: string) => chalk.hex(palette.surface)(t),
  selectList: {
    selectedPrefix: (t: string) => chalk.hex(palette.blue)('> '),
    selectedText: (t: string) => chalk.hex(palette.blue)(t),
    description: (t: string) => chalk.hex(palette.subtext)(t),
    scrollInfo: (t: string) => chalk.hex(palette.subtext)(t),
    noMatch: (t: string) => chalk.hex(palette.subtext).italic(t),
  },
};

// ── 语义化样式 ──

export const theme = {
  // Header / Footer
  header: (t: string) => chalk.hex(palette.blue).bold(t),
  footer: (t: string) => chalk.hex(palette.subtext)(t),
  dim: (t: string) => chalk.hex(palette.subtext)(t),
  bold: (t: string) => chalk.bold(t),
  accent: (t: string) => chalk.hex(palette.mauve)(t),
  accentSoft: (t: string) => chalk.hex(palette.lavender)(t),

  // User message
  userBg: (t: string) => chalk.bgHex(palette.surface)(t),
  userText: (t: string) => chalk.hex(palette.text)(t),
  userPrefix: () => chalk.hex(palette.green).bold('  You'),

  // Assistant message
  assistantText: (t: string) => chalk.hex(palette.text)(t),
  assistantPrefix: () => chalk.hex(palette.mauve).bold('  🐙 Octopi'),

  // System message
  system: (t: string) => chalk.hex(palette.subtext).italic(t),

  // Tool execution
  toolPendingBg: (t: string) => chalk.bgHex('#2a2a3e')(t),
  toolSuccessBg: (t: string) => chalk.bgHex('#1a2e1a')(t),
  toolErrorBg: (t: string) => chalk.bgHex('#2e1a1a')(t),
  toolTitle: (t: string) => chalk.hex(palette.teal)(t),
  toolOutput: (t: string) => chalk.hex(palette.subtext)(t),
  toolDim: (t: string) => chalk.hex(palette.subtext)(t),

  // Status
  statusConnected: (t: string) => chalk.hex(palette.green)(t),
  statusDisconnected: (t: string) => chalk.hex(palette.red)(t),
  statusBusy: (t: string) => chalk.hex(palette.yellow)(t),
  statusIdle: (t: string) => chalk.hex(palette.subtext)(t),

  // Streaming indicator
  thinking: () => chalk.hex(palette.subtext).italic('  🤔 Thinking...'),
  streaming: () => chalk.hex(palette.mauve)(''),

  // Errors
  error: (t: string) => chalk.hex(palette.red)(t),
  warning: (t: string) => chalk.hex(palette.yellow)(t),
  success: (t: string) => chalk.hex(palette.green)(t),
};

export { palette };
