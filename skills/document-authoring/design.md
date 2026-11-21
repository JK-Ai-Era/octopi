# Design Doctrine — Documents, Slides, Spreadsheets, PDF Artifacts

Apply this whenever output is visually judged. The goal is work that looks **designed for this specific topic**, not assembled from defaults.

## Core principles

- **Pick a bold, content-informed palette.** The palette should feel designed for THIS topic. If swapping your colors into a completely different document would still "work," you haven't made specific enough choices.
- **Dominance over equality.** One color dominates (60–70% visual weight), 1–2 supporting tones, one sharp accent. Never give all colors equal weight.
- **Dark/light contrast.** Dark backgrounds for title + conclusion slides, light for content ("sandwich" structure). Or commit to dark throughout for a premium feel.
- **Commit to a visual motif.** Pick ONE distinctive element and repeat it — rounded image frames, icons in colored circles, thick single-side borders. Carry it through the whole document/deck.
- **Contrast is accessibility.** Light text on light backgrounds and dark icons on dark backgrounds are defects, not style.

## Color palettes (starting points, not defaults)

| Theme | Primary | Secondary | Accent |
|-------|---------|-----------|--------|
| **Midnight Executive** | `1E2761` (navy) | `CADCFC` (ice blue) | `FFFFFF` (white) |
| **Forest & Moss** | `2C5F2D` (forest) | `97BC62` (moss) | `F5F5F5` (cream) |
| **Coral Energy** | `F96167` (coral) | `F9E795` (gold) | `2F3C7E` (navy) |
| **Warm Terracotta** | `B85042` (terracotta) | `E7E8D1` (sand) | `A7BEAE` (sage) |
| **Ocean Gradient** | `065A82` (deep blue) | `1C7293` (teal) | `21295C` (midnight) |
| **Charcoal Minimal** | `36454F` (charcoal) | `F2F2F2` (off-white) | `212121` (black) |
| **Teal Trust** | `028090` (teal) | `00A896` (seafoam) | `02C39A` (mint) |
| **Berry & Cream** | `6D2E46` (berry) | `A26769` (dusty rose) | `ECE2D0` (cream) |
| **Sage Calm** | `84B59F` (sage) | `69A297` (eucalyptus) | `50808E` (slate) |
| **Cherry Bold** | `990011` (cherry) | `FCF6F5` (off-white) | `2F3C7E` (navy) |

Don't default to generic blue. Choose colors that reflect the specific topic.

## Typography

**Choose an interesting font pairing** — a header font with personality plus a clean body font.

| Header Font | Body Font |
|-------------|-----------|
| Georgia | Calibri |
| Arial Black | Arial |
| Calibri | Calibri Light |
| Cambria | Calibri |
| Trebuchet MS | Calibri |
| Impact | Arial |
| Palatino | Garamond |
| Consolas | Calibri |

| Element | Size (slides) | Size (documents) |
|---------|---------------|------------------|
| Title | 36–44pt bold | 18–24pt bold |
| Section header | 20–24pt bold | 13–16pt bold |
| Body text | 14–16pt | 10.5–12pt |
| Captions | 10–12pt muted | 8–9pt muted |

- Titles need strong size contrast (36pt+ vs 14–16pt body on slides) or they don't stand out.
- **CJK text**: pick fonts that render on the target platform (e.g. 宋体/微软雅黑 on Windows, PingFang SC on macOS) and set a sensible fallback; avoid exotic display fonts for body text.

## Layout & spacing

- **Slides**: every slide needs a visual element — image, chart, icon, or shape. Text-only slides are forgettable. Layout options: two-column (text + illustration), icon + text rows (icon in colored circle), 2×2/2×3 grids, half-bleed image with overlay, large stat callouts (big numbers 60–72pt with small labels), comparison columns, timeline/process flow.
- **Documents**: hierarchy does the work — clear heading styles, consistent spacing before/after, real lists and tables (not tab-aligned text), headers/footers with page numbers, TOC for anything over ~5 pages.
- **Spreadsheets**: one header row with strong fill + white bold text; freeze header; sensible column widths; group related columns; number formats do the talking (see xlsx skill for financial conventions).
- **PDF artifacts** (reports, certificates, posters): one dominant element per page, generous margins, explicit alignment grid; draw backgrounds before text; verify by rendering (vector text may reflow when rasterized).
- **Spacing**: 0.5" minimum margins; 0.3–0.5" between content blocks; choose one gap size and use it consistently. Leave breathing room — don't fill every inch.

## Avoid (common mistakes + AI tells)

- **NEVER accent lines under titles** — a hallmark of AI-generated slides; use whitespace or background color instead.
- **Don't repeat the same layout** across pages — vary columns, cards, and callouts.
- **Don't center body text** — left-align paragraphs and lists; center only titles.
- **Don't default to blue** or drop-shadowed WordArt-style headings.
- **Don't mix spacing randomly** — pick 0.3" or 0.5" and stick to it.
- **Don't style one page and leave the rest plain** — commit fully or keep it simple throughout.
- **Don't create text-only slides** — add images, icons, charts, or shape-based structure.
- **Don't forget text box padding** — when aligning text with shapes/lines, set margin 0 on the text box or offset for padding.
- **Don't use low-contrast elements** — icons AND text both need strong contrast against their background.
- **Don't leave placeholder text** (`xxxx`, `lorem ipsum`, template slots) — QA must catch these.
