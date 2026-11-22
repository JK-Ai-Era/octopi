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

### Contrast is measurable — check before committing

"Contrast is accessibility" is not a vibe. Every **foreground × background pair you actually use** must pass WCAG: **≥ 4.5:1 for body text**, **≥ 3:1 for large text (≥24pt) and non-text graphics**, and **≥ 3:1 between adjacent color bands** (two fills that touch must be distinguishable). Measure with `scripts/contrast.py <fg> <bg>` — never eyeball it.

The starter palettes are starting points, **not pre-cleared pairings**. Full measured matrix (OK = ≥4.5 body-safe · LARGE = 3–4.5 large/graphics only · NO = <3, never as a text pair):

| Palette | wht×Pri | wht×Sec | wht×Acc | blk×Pri | blk×Sec | blk×Acc | Pri×Sec | Pri×Acc | Sec×Acc |
|---|---|---|---|---|---|---|---|---|---|
| Midnight Executive | 13.83 OK | 1.39 NO | 1.00 NO | 1.52 NO | 15.15 OK | 21.00 OK | 9.98 OK | 13.83 OK | 1.39 NO |
| Forest & Moss | 7.55 OK | 2.17 NO | 1.09 NO | 2.78 NO | 9.69 OK | 19.26 OK | 3.48 LARGE | 6.92 OK | 1.99 NO |
| Coral Energy | 3.03 LARGE | 1.24 NO | 10.15 OK | 6.93 OK | 16.89 OK | 2.07 NO | 2.44 NO | 3.35 LARGE | 8.17 OK |
| Warm Terracotta | 4.92 OK | 1.25 NO | 1.98 NO | 4.26 LARGE | 16.86 OK | 10.62 OK | 3.95 LARGE | 2.49 NO | 1.59 NO |
| Ocean Gradient | 7.52 OK | 5.42 OK | 13.67 OK | 2.79 NO | 3.88 LARGE | 1.54 NO | 1.39 NO | 1.82 NO | 2.52 NO |
| Charcoal Minimal | 9.90 OK | 1.12 NO | 16.10 OK | 2.12 NO | 18.76 OK | 1.30 NO | 8.84 OK | 1.63 NO | 14.38 OK |
| Teal Trust | 4.67 OK | 2.98 NO | 2.26 NO | 4.49 LARGE | 7.04 OK | 9.28 OK | 1.57 NO | 2.06 NO | 1.32 NO |
| Berry & Cream | 9.86 OK | 4.49 LARGE | 1.28 NO | 2.13 NO | 4.68 OK | 16.36 OK | 2.20 NO | 7.68 OK | 3.49 LARGE |
| Sage Calm | 2.31 NO | 2.91 NO | 4.36 LARGE | 9.09 OK | 7.22 OK | 4.82 OK | 1.26 NO | 1.89 NO | 1.50 NO |
| Cherry Bold | 8.89 OK | 1.07 NO | 10.15 OK | 2.36 NO | 19.64 OK | 2.07 NO | 8.31 OK | 1.14 NO | 9.49 OK |

Traps this table exists to prevent: **Teal Trust** `00A896` on white = 2.98 (fails body text!), `02C39A` on `028090` = 2.06 (fails even as graphics) — its "Secondary/Accent" only work as fills behind **dark** text or as large graphics on the primary. **Sage Calm** and **Coral Energy** primaries fail white body text (2.31 / 3.03). When a pairing lands in NO/LARGE, either darken/lighten one side or change which color carries the text — and re-measure.

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

| Element | Size (slides, pitch) | Size (slides, dense) | Size (documents) |
|---------|----------------------|----------------------|------------------|
| Title | 36–44pt bold | 22–26pt bold | 18–24pt bold |
| Section header | 20–24pt bold | 16–18pt bold | 13–16pt bold |
| Body text | 14–16pt | 11–13pt | 10.5–12pt |
| Captions | 10–12pt muted | 8.5–10pt muted | 8–9pt muted |

- Titles need strong size contrast (36pt+ vs 14–16pt body on slides) or they don't stand out.
- **Two slide profiles** — pick per deck type, not per slide: **pitch** (roadshow/announcement: few words, big type) vs **dense** (technical walkthrough/explainer: real sentences, tables, code — 22–26pt titles are correct here, and forcing 36pt titles into a dense deck is how overflow starts).

### CJK typesetting rules

- **Font choice**: pick fonts that render on the target platform (e.g. 宋体/微软雅黑 on Windows, PingFang SC on macOS) and set a sensible fallback; avoid exotic display fonts for body text. Verify availability (`fc-match "PingFang SC"`) — a missing CJK font silently substitutes and reflows every box.
- **No orphan characters (孤字)**: a wrapped line must not end in a single character, and a single character must not sit alone on the last line. When a paragraph nearly fits, edit the wording — never let the wrap decide. Check every short text box after render.
- **Never break inside tokens**: `${VAR}`, `octopi-agent`, `@octopi-agent/core`, URLs, code identifiers — these must survive line wrapping intact. In PPTX text boxes set the box wide enough (or insert an explicit line break at a sensible point); a `${VAR}` split across two lines reads as two different things.
- **Punctuation discipline**: closing punctuation (，。、；：？！」』）) never starts a line; opening punctuation (「『（) never ends one. In tight boxes, adjust wording or box width rather than accepting a punctuation hang.
- **Columns of fixed-width text** (code, aligned values, ASCII tables): compute width from character counts and font metrics — **never hand-count spaces** to align columns. In OOXML, use tabular layout or separate boxes positioned by computed x-coordinates instead of space padding.
- **Mixed CJK/latin spacing**: keep a consistent rule (e.g. no extra spaces around latin tokens inside CJK, or a fixed thin gap) and apply it everywhere — inconsistent spacing is the most visible "assembled" tell in Chinese decks.

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
