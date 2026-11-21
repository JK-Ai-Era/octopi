# QA Protocol — Render, Inspect, Fix, Re-verify

**Assume there are problems. Your job is to find them.** The first render is almost never correct. Approach QA as a bug hunt, not a confirmation step. If you found zero issues on first inspection, you weren't looking hard enough.

## The loop (non-negotiable)

1. Generate the output.
2. **Render** to images (pipeline below).
3. **Fresh-eyes review** of the rendered images with the checklist.
4. **List the issues found** — including minor ones. (If empty, look again more critically.)
5. Fix the issues.
6. **Re-render and re-check the affected pages** — one fix often creates another problem.
7. Repeat until a full pass reveals no new issues.

**Do not declare success until you've completed at least one fix-and-verify cycle.** A "done" report without QA is a claim, not an effect.

## Fresh-eyes review

You've been staring at the code and will see what you expect, not what's there.

- If delegation is available (e.g. `delegate_dispatch`), send the rendered images to a subagent for visual inspection — even for 2–3 pages. Include expected content per image and the checklist below; ask for ALL issues, including minor ones.
- If no delegation is available, review yourself with the checklist after a deliberate reset (re-read expectations first, scan page by page against the checklist, zoom into dense areas).

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
