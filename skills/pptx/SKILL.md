---
name: "pptx"
description: "Use this skill any time a .pptx file must be created, edited, or modified — pitch decks, presentations, templates, layouts, speaker notes. Trigger whenever the user mentions \"deck\", \"slides\", \"presentation\", or a .pptx file that needs producing or changing, regardless of what they plan to do with it afterward. Do NOT use for reading/extracting slide content (native: document_read) or for other formats."
---

# PPTX Skill

Shared design doctrine and QA protocol: `../document-authoring/design.md`, `../document-authoring/qa.md` — **read both before building slides**. Shared OOXML toolkit: `../document-authoring/scripts/office/`. **All relative script paths in this skill resolve from this skill's directory** (the one containing this SKILL.md).

## Quick Reference

| Task | Guide |
|------|-------|
| Read/analyze content | native `document_read` tool |
| Edit or create from template | Read [editing.md](editing.md) |
| Create from scratch | Read [pptxgenjs.md](pptxgenjs.md) |
| Design language | `../document-authoring/design.md` (palette, typography, motifs, avoid list) |
| QA | `../document-authoring/qa.md` (render → fresh-eyes → fix → re-verify) |

## Reading Content

Content extraction is native (`document_read`). For authoring work you additionally need:

```bash
# Visual overview of a template's layouts (authoring aid)
python scripts/thumbnail.py presentation.pptx

# Raw XML
python ../document-authoring/scripts/office/unpack.py presentation.pptx unpacked/
```

## Editing Workflow

**Read [editing.md](editing.md) for full details.**

1. Analyze template with `thumbnail.py`
2. Unpack → manipulate slides → edit content → clean → pack

## Creating from Scratch

**Read [pptxgenjs.md](pptxgenjs.md) for full details.** Use when no template or reference presentation is available.

## Design

Don't create boring slides. Plain bullets on a white background won't impress anyone. The full design doctrine — topic-informed palettes with one dominant color, font pairings, layout options, visual motifs, spacing rules, and the "avoid" list (including **NEVER accent lines under titles**) — lives in `../document-authoring/design.md`. Key slide-specific rules:

- **Every slide needs a visual element** — image, chart, icon, or shape. Text-only slides are forgettable.
- **Vary layouts across slides** — don't repeat the same text-heavy layout; match content type to layout style (key points → bullets, team → multi-column, testimonials → quote, stats → callouts).
- **Bold all headers and inline labels**; left-align body text; strong title/body size contrast.

## QA (Required)

Follow `../document-authoring/qa.md` — the loop is non-negotiable: render to images, fresh-eyes inspection (delegate when available), list issues, fix, re-render affected slides, repeat until a clean pass. For PPTX specifically:

- Render: `python ../document-authoring/scripts/office/soffice.py --headless --convert-to pdf output.pptx` then `python ../document-authoring/scripts/convert_pdf_to_images.py output.pdf shots/`.
- Machine checks (before/alongside visual review — full protocol in `../document-authoring/qa.md`): `node ../document-authoring/scripts/check-layout.cjs output.pptx` for geometry, `python ../document-authoring/scripts/check-content.py output.pptx` for placeholders, `python ../document-authoring/scripts/check-pixels.py manifest.json shots/` for declared gaps (manifest emitted by your build via `scripts/layout-helpers.mjs` `emptyGap`/`writeManifest` — never hand-copy regions).
- Content QA first: extract with `document_read`; grep for leftover placeholder text:
  ```bash
  python ../document-authoring/scripts/office/unpack.py output.pptx unpacked/ && grep -riE "xxxx|lorem|ipsum|this.*(page|slide).*layout" unpacked/ppt/slides/
  ```
  Any hit must be fixed before declaring success.
- **Do not declare success until at least one fix-and-verify cycle is complete.**

## Dependencies

Per the shared dependency matrix (`../document-authoring/SKILL.md`): Node + `pptxgenjs` (from-scratch creation), Python ≥ 3.9 + `defusedxml` + `Pillow` (template tooling), LibreOffice (rendering). If `pptxgenjs` is missing, fall back to template-based editing and say so.
