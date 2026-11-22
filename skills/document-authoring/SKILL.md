---
name: "document-authoring"
description: "Shared base for designing and authoring professional documents (Word/Excel/PowerPoint/PDF) — design language, QA protocol, and the shared OOXML toolkit. Use when the user asks to design, create, or edit documents with professional quality, or when a format skill (docx/pdf/pptx/xlsx) references this base. Do NOT use for reading/extracting document content — that is native (document_read)."
---

# Document Authoring — Shared Base

## Division of labor (read vs author)

- **Reading / extraction is a native tool**: `document_read` (→ Markdown) and `document_probe` (→ format detection). Never rebuild extraction pipelines (pandoc/markitdown/pdfplumber text dumps) just to read a document.
- **This skill family covers authoring**: create, edit, design, fill, recalculate, render-verify. Format skills hold format-specific workflows and pitfall tables; this base holds what they share.

## Skill family map

| Skill | Owns |
|-------|------|
| `document-authoring` (this) | design doctrine ([design.md](design.md)), QA protocol ([qa.md](qa.md)), shared OOXML toolkit (`scripts/office/`), PDF rendering helper (`scripts/convert_pdf_to_images.py`), preflight & QA checkers (`scripts/`) |
| `docx` | Word creation (docx-js), XML editing, tracked changes, comments |
| `pdf` | PDF creation/manipulation (reportlab/pdf-lib/pypdf/qpdf), form filling |
| `pptx` | Template-based slide editing, from-scratch decks (pptxgenjs) + layout helpers (`scripts/layout-helpers.mjs`) |
| `xlsx` | Spreadsheet creation/editing (openpyxl/pandas), formula recalculation |

**Path convention**: paths in format skills are relative to that skill's directory; the shared toolkit is referenced as `../document-authoring/...`. "Skill root" always means the directory containing the SKILL.md you are reading.

## Source of truth: repo `skills/`, and preflight before you build

- **The repo's `skills/` tree is authoritative.** The deployed copy (`~/.octopi/agents/default/skills/`) is a mirror. If a skill seems missing, thin, or outdated, **go to the repo `skills/` tree first** — never fall back to leftover copies found elsewhere in the workspace (a real incident: obsolete scratch copies of format skills were silently used as authoritative, and the whole job ran on stale guidance).
- **Run preflight before starting a build** (it also proves which QA tier you may claim — see qa.md):

```bash
python3 ../document-authoring/scripts/preflight.py
```

  Preflight fails loudly on **deploy drift** (missing / extra / changed files vs repo `skills/`) and probes dependencies (Python libs, `soffice`, node packages from your workdir, CJK font visibility, vision-capable models in config). Fix drift by re-syncing from repo `skills/` — never edit the deploy copy in place.

## Shared OOXML toolkit (`scripts/office/`)

Office files are ZIP archives of XML. For high-fidelity edits (tracked changes, comments, anything creation libraries can't express), use unpack → edit → pack:

```bash
# from any skill root; substitute the shared path
python ../document-authoring/scripts/office/unpack.py document.docx unpacked/
# edit unpacked/**/*.xml with your file edit tool (never sed, never one-off Python scripts)
python ../document-authoring/scripts/office/pack.py unpacked/ output.docx --original document.docx
python ../document-authoring/scripts/office/validate.py output.docx --original document.docx
```

| Script | Purpose |
|--------|---------|
| `office/unpack.py` | Extract ZIP, pretty-print XML, merge adjacent runs, escape smart quotes as entities |
| `office/pack.py` | Validate with auto-repair, condense XML, repack (`--original` enables redlining checks) |
| `office/validate.py` | XSD schema validation (ISO-IEC 29500) + tracked-changes validation; `--auto-repair` fixes hex IDs and whitespace preservation |
| `office/soffice.py` | LibreOffice wrapper (headless; works in sandboxes where AF_UNIX is blocked) |

- **Auto-repair fixes**: `durableId` overflow, missing `xml:space="preserve"`. It will **not** fix malformed XML, wrong nesting, missing relationships, or schema violations — validate before declaring done.
- **Editing rules**: edit XML with your file edit tool (precise replacement, visible diff). Preserve `<w:rPr>`/`<a:rPr>` formatting when replacing runs. Use XML entities for smart quotes in new text (`&#x2019;` `&#x201C;` `&#x201D;`). Author name for tracked changes and comments is **"Assistant"** unless the user names someone else.

## Design doctrine

Read [design.md](design.md) before creating anything visually judged (slides, reports, posters, dashboards). Summary: topic-informed palette with one dominant color (60–70%), deliberate font pairing with strong size hierarchy, one repeated visual motif, generous spacing, and the "avoid" list (accent lines under titles, text-only slides, generic blue defaults, …).

## QA protocol

Read [qa.md](qa.md) before delivering any visually rendered output. Non-negotiable loop: generate → render → fresh-eyes review → list issues → fix → re-render affected pages → repeat until a full pass finds nothing. **A "done" claim without at least one fix-and-verify cycle is not done.**

## Dependency matrix & degradation

Declare, don't hope. Each capability has hard dependencies — when one is missing, say explicitly "this path is unavailable: <dep> missing" and offer the alternative; never silently degrade to a worse output.

| Capability | Hard deps | Fallback |
|------------|-----------|----------|
| DOCX creation | Node + `npm install docx` | none (report gap) |
| PPTX creation from scratch | Node + `npm install pptxgenjs` | template-based editing via unpack/pack |
| XLSX create/edit | Python + `openpyxl` (or `pandas`) | none |
| PDF create/manipulate | Python + `pypdf` / `reportlab`; `qpdf` optional | pypdf alone covers most |
| Form filling | Python + `pypdf` | annotation overlay (see pdf/forms.md) |
| Formula recalculation | LibreOffice (`soffice`) | none — formulas ship uncomputed without it; say so |
| Visual QA rendering | LibreOffice + Python `pypdfium2` | content QA only (`document_read`), and state that visual QA was skipped |
| OOXML unpack/pack/validate | Python + `defusedxml` (+ `lxml` for XSD) | creation libraries only |

- Python scripts target **Python ≥ 3.9**; required libs per table above (`Pillow` for thumbnails).
- Check availability before starting a long build (e.g. `python3 -c "import pypdf"`); fix the dependency story first when the task justifies it.
