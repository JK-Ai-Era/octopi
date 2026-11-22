# QA Protocol — Render, Inspect, Fix, Re-verify

**Assume there are problems. Your job is to find them.** The first render is almost never correct. Approach QA as a bug hunt, not a confirmation step. If you found zero issues on first inspection, you weren't looking hard enough.

## The loop (non-negotiable)

1. Generate the output.
2. **Render** to images (pipeline below).
3. **Machine checks first** (measured QA below) — geometry, overflow, pixels, content. These are cheap and deterministic; run them before spending review attention.
4. **Visual review at the highest tier available** (tiers below) with the checklist.
5. **List the issues found** — including minor ones. (If empty, look again more critically.)
6. Fix the issues.
7. **Re-render and re-check the affected pages** — one fix often creates another problem.
8. Repeat until a full pass reveals no new issues.

**Do not declare success until you've completed at least one fix-and-verify cycle.** A "done" report without QA is a claim, not an effect.

## Visual review tiers (declare which tier ran)

Visual QA has three tiers. **Whatever tier you reach, state it explicitly in the delivery note** — including "aesthetic judgment unverified" when below tier 1. A geometry-clean deck can still be ugly; only say what was actually checked.

| Tier | What ran | What it proves |
|------|----------|----------------|
| **1 — Real vision** | A human or an image-capable reviewer actually looked at rendered pages | aesthetics + layout |
| **2 — Measured only** | Machine checks (below) passed, no one saw the images | layout/geometry/content only — **declare: "aesthetic judgment unverified"** |
| **3 — Content only** | Render pipeline unavailable; extraction-level checks only | content only — declare visual QA skipped entirely |

- Probe your vision capability honestly (e.g. `file_read` a rendered PNG — if you receive an image you can see it; if you receive bytes/metadata you cannot). An agent without an image channel cannot do tier 1 by looking — do not pretend a pixel report is "review".
- Tier 1 review can be **your own eyes or a subagent's** — but only a reviewer that genuinely receives images counts.

## Fresh-eyes review (tier 1)

You've been staring at the code and will see what you expect, not what's there.

- If delegation is available (e.g. `delegate_dispatch`) and the subagent has an image channel, send the rendered images for visual inspection — even for 2–3 pages. Include expected content per image and the checklist below; ask for ALL issues, including minor ones.
- **Subagent dispatch protocol** (learned from a real QA failure where the reviewer mixed old and new renders):
  - **Render-set hygiene**: every image batch carries its render timestamp; delete or clearly supersede old renders before dispatching. Tell the reviewer: "report only against images with timestamp ≥ <T>; if you see an older render, say so instead of reporting it."
  - **Ask for measurements, not impressions**: findings must cite page + coordinates/box + measured value (e.g. "p7, gap between card bottom (y≈4.92) and footer (y≈5.34) is 0.42in but the two rows differ by 0.1in").
  - **Image/source distinction**: the reviewer must label each finding as "seen in the rendered image" vs "read from source/layout data" — mixed reports caused double-fixes and false alarms.
- If no reviewer with vision exists, you are at tier 2: run measured QA and declare it.

## Measured QA (tier 2 — always run, even under tier 1)

Machine checks catch what eyes miss (a 0.05in drift, a 1-in-255 contrast failure) and give tier-1 reviewers clean images to judge. Scripts live in `scripts/` of this skill:

```bash
# layout geometry: out-of-bounds, text overflow estimate, text overlaps, z-order occlusion
node scripts/check-layout.cjs output.pptx

# pixel gaps: declared-empty regions must render with zero ink
#   manifest.json is EMITTED BY YOUR BUILD (see pptx skill layout-helpers.mjs
#   emptyGap/expectInk/writeManifest) — never hand-copy coordinates
python3 scripts/check-pixels.py manifest.json shots/

# content placeholders at word boundaries (no "NaN" ⊂ "governance" false hits)
python3 scripts/check-content.py output.pptx [--allow '{VAR}']

# palette contrast before you commit colors (prints WCAG ratios)
python3 scripts/contrast.py 028090 FFFFFF
```

- **Manifest is the single source of truth** for pixel checks: regions come from the build code (`emptyGap` calls beside the layout), so they cannot drift from the layout. A hand-copied region list is how checks go stale and misfire.
- The layout script is `.cjs` on purpose — a `.js` script flips CJS/ESM with the ambient `package.json`; extension-agnostic tools must pin their module system.
- Found-zero-on-first-pass rule applies here too: if a machine check reports clean but you never fed it real regions, it proved nothing.

## Human spot-check (aesthetic backstop)

When the deliverable is visually judged and tier 1 was not reached by the requester's own eyes, offer the cheap backstop: **send 3–5 key pages (cover, densest content page, conclusion) to the user for a glance before final delivery**. Human eyes are the only visual channel that is always available — use them for the aesthetic verdict instead of guessing.

## Render pipeline (all formats)

Rendered QA needs: LibreOffice (`soffice`) + Python `pypdfium2` (via `../document-authoring/scripts/convert_pdf_to_images.py`). If unavailable, run content QA only and **state explicitly that visual QA was skipped**.

```bash
# 1) to PDF (skip for PDF input)
python ../document-authoring/scripts/office/soffice.py --headless --convert-to pdf output.docx   # .pptx/.xlsx/.docx

# 2) PDF → page images
python ../document-authoring/scripts/convert_pdf_to_images.py output.pdf shots/ [max_dim]
```

Re-render specific pages after fixes instead of the whole document when possible.

## Content QA (always, before or alongside visual QA)

- Extract the output with `document_read` and check: missing content, wrong order, typos, truncation.
- Grep for leftover placeholders: `xxxx|lorem|ipsum|TODO|placeholder` — fix any hit before declaring success.
- For template-based work, also grep for template slot labels that should have been replaced.

## Visual checklist

- Overlapping elements (text through shapes, lines through words, stacked elements)
- Text overflow or cut off at edges/box boundaries
- Decorative elements positioned for one line but text wrapped to two
- Footers/citations colliding with content above
- Elements too close (< 0.3" gaps) or blocks nearly touching
- Uneven gaps (empty area here, cramped there)
- Insufficient margin from page edges (< 0.5")
- Columns/blocks not aligned consistently
- Low-contrast text or icons
- Text boxes too narrow causing excessive wrapping
- Leftover placeholder content
- (Spreadsheets) formula errors (`#REF!`, `#DIV/0!`, …), wrong number formats, cut-off columns
- (Forms) text mispositioned inside fields — zoom into each filled region

## Format-specific verification

| Format | Extra gate |
|--------|-----------|
| docx | `validate.py` XSD + redlining pass; tracked changes accepted/rejected intentionally |
| pptx | content grep for placeholder text; layout variety across slides |
| xlsx | `recalc.py` reports zero formula errors (mandatory when formulas exist) |
| pdf forms | `check_bounding_boxes.py` before fill; post-fill render zoom per field |
