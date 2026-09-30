# DESIGN.md — Octopi Web Runtime

## 1. Objective

任何合格的 Octopi Web 产物，都应让开发者在 **10 秒内看懂「本轮 agent 为什么这样答」**：System 契约层是否参与、占了多少预算、为何被丢弃；以及 Information（session 消息窗口）的压缩状态。质量底线是运行时可解释，而不是仪表盘好看。

**命名纪律：** UI 不得把产品八层模型写成「全是 system prompt」。产品第 7 层是 **Runtime**（system 侧，Run 活态）；第 8 层是 **Information**（消息窗口）。恒等式：产品八层 = system ContextLayer（1–7）+ Information（8）。

## 2. Product Context

- **What the product does:** 把 Agent 运行时（会话、工具、八层上下文装配）变成浏览器里可观察、可调试的交互系统。
- **Who it's for:** 正在打磨八层模型的 Octopi 开发者；以及需要理解「agent 核心价值」的技术受众（demo）。
- **Adjacent brands (feel like these):** Linear 的检查器密度、Figma 右侧属性面板的层级感、科学仪器/质谱软件的数据读数感。
- **Distant brand (do not feel like this):** 通用 SaaS 后台模板（KPI 卡片墙 + 渐变 hero）——它假装产品是指标，而 Octopi 的产品是 **信息如何被分馏进上下文**。
- **Cultural register:** technical / instrument-grade。冷静、精确、可验证；不营销。

## 3. Visual Foundations

### 3a. Color

- **Neutral scale (workbench, chat-first):**
  - `--n-50: #f6f7f9`
  - `--n-100: #eef0f3`
  - `--n-200: #e5e7eb`
  - `--n-400: #9ca3af`
  - `--n-600: #4b5563`
  - `--n-800: #1f2937`
  - `--n-900: #111827`
  - `--n-950: #0b1220`（Runtime 仪器底）
- **Accent primary:** `#0f766e`（teal — 正常参与 / included）
- **Semantic:**
  - `--ok: #0f766e` included
  - `--warn: #b45309` truncated / over-budget-kept
  - `--error: #b91c1c` assemble failed
  - `--muted: #6b7280` empty / unregistered / idle
- **Layer hues (fixed, used only for that layer):**
  - wisdom `#c9a227`
  - persona `#4f46e5`
  - skill `#0d9488`
  - knowledge `#2563eb`
  - cognition `#7c3aed`
  - memory `#059669`
  - runtime `#64748b`
  - information `#0891b2`（消息窗口，非 ContextLayer）
- **Usage rules:** 层色只用于该层的色条、token 填充与选中描边；**禁止**用层色铺整卡背景。全页强调色 teal 仍用于主操作与 included 状态。

### 3b. Typography

- **Display / UI:** `-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif`
- **Mono (tokens, ids, reasons):** `'SF Mono', 'Fira Code', Menlo, Consolas, monospace`
- **Type scale:** `11 / 12 / 13 / 14 / 18 / 24`
- **Weight discipline:** 层名 600；数值 mono 500；说明 400；禁止 700+ 大标题堆叠在检查器里。

### 3c. Spacing & rhythm

- **Base unit:** 4px
- **Spacing scale:** `4, 8, 12, 16, 24, 32`
- **「密集但不挤」的数字定义：** 层条目高 ≥ 44px，条目内 padding 8–10px，面板间距 12px；检查器列宽 320–380px（focus 模式可到全宽）。

### 3d. Component seeds

- **Button:** 一屏最多一个 filled primary；其余 ghost / secondary。
- **Layer band (核心组件):** 全宽横条 = 左侧层色 3px 竖条 + 层名 + 状态徽章 + token 读数 + 进度条；点击展开详情。**不是**圆角阴影卡片网格。
- **Budget bar:** 单条 stacked horizontal，段 = 层 token；未用预算留空槽。
- **Iconography:** 无装饰 emoji。状态用文字徽章（纳入/空/丢弃/失败/未注册）+ 微型色点。

## 4. Accessibility

- **Text contrast:** body ≥ 4.5:1，状态徽章与大号 token 读数 ≥ 3:1。
- **Motion:** 默认短时（≤200ms）状态过渡；装配进行中用低调扫描/脉冲，`prefers-reduced-motion` 时改为静态描边。
- **Focus indicators:** `box-shadow: 0 0 0 2px #93c5fd`，层条目键盘可聚焦、Enter 展开。
- **Alt / a11y text:** 装饰色条 `aria-hidden`；层状态用可读文本，不单靠颜色。

## 5. Voice & Tone

- **Register:** technical，短句，可验证。
- **Sentence rhythm:** 短句为主；原因字段直译 manifest（如 `empty` / `system budget exhausted`），不粉饰。
- **Words this brand uses:** 装配、层、预算、纳入、丢弃、指纹、溯源、消息窗口。
- **Words this brand refuses:** seamless, elevate, unlock, 全方位赋能, 一站式, 智能大脑可视化（空话）。
- **Address:** 「你」对开发者说话；demo 文案也可用「当前会话」这种第三人称运行时口吻。

## 6. Implementation Practices

- **Token format:** CSS variables（现有 `web/src/styles.css` 扩展 `--layer-*`）。
- **Component library convention:** bespoke（现有 React + class，不引入重型 UI 库）。
- **Image treatment rules:** 无摄影/插画；可视化全部由数据编码（色条、进度、栈）。
- **Grid system:** Playground 三栏（left / chat / inspector）；顶栏统一 Focus 开关：chat 弱化 + inspector 扩展（各页签共用，不 per-tab）。
- **Motion rules:** ease-out 120–200ms；token 条宽度变化用 transition；不做装饰性 parallax。
- **数据源约定:** UI **只渲染** `AssembleManifest` / `ContextLayersSnapshot`，禁止前端臆造层状态。

## 7. Anti-Patterns

- **No KPI card wall.** 八层不是八张同等仪表卡；那是把结构信息压成噪声。
- **No pie chart of budget shares.** 七段角度编码差；用单条 stacked bar + 直接标注。
- **No emoji layer icons.** 八层模型是契约不是表情符号系统。
- **No “agent 变聪明了” 式空洞文案.** 只展示 reason / tokens / sources 等可验证字段。
- **No silent missing layers.** 未注册、空内容、被丢弃必须是三种不同状态，不得都显示成灰掉。
- **No full systemPrompt 默认展开.** 预览截断 + 溯源；全文属于显式 debug 动作。

## 8. Decision-Making

1. **Truth over polish.** manifest 说什么 UI 就显示什么；冲突时改后端事件而不是改 UI 装饰。
2. **Chat remains the product center.** 八层是检查器/演示层，不得把 playground 改成纯 dashboard。
3. **Distinguish states before adding charts.** 状态可读优先于任何统计图。
4. **One primary interaction per surface.** 右栏主交互 = 选层看详情；不是七个等权 CTA。
5. **Demo mode must be the same data path.** 禁止 demo 专用假后端逻辑与生产 UI 分叉。

## 9. Workflow

1. 读取最新 `ContextLayersSnapshot`（WS 优先，REST 兜底）。
2. 渲染顶栏预算摘要（systemBudget / used / reserve）。
3. 按 `order` 渲染 System 七层 band（产品 L1-L7）；Information（L8）单独 strip。
4. 用 status → 徽章/色语义映射，禁止颜色-only。
5. 选中层 → 详情：budget vs tokens、reason、dropped、sources、preview。
6. 事件 `context.layers.*` 到达时局部刷新，避免整页重置滚动。
7. Focus/demo 模式只改变布局密度与是否展开 preview，不改变数据字段。
