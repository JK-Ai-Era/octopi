---
name: "pdf"
description: "Use this skill for PDF authoring and manipulation: creating new PDFs, merging/splitting/rotating pages, adding watermarks, encrypting/decrypting, filling PDF forms (fillable fields or annotation overlay), extracting embedded images, and cropping/optimizing. If the user mentions a .pdf file that must be produced, filled, or modified, use this skill. Do NOT use for reading/extracting text or tables from PDFs — that is native (document_read)."
---

# PDF Processing Guide

Shared design doctrine and QA protocol: `../document-authoring/design.md`, `../document-authoring/qa.md` — read before creating or delivering PDFs. Advanced examples: [reference.md](reference.md). Form filling: [forms.md](forms.md) — follow its instructions exactly. **All relative script paths in this skill resolve from this skill's directory** (the one containing this SKILL.md).

## Overview

PDF work splits into **creation** (reportlab / pdf-lib) and **page manipulation** (pypdf / qpdf). For advanced features and JavaScript libraries, see [reference.md](reference.md). Reading/extraction (text, tables, OCR) is native — `document_read`.

## Quick Start

```python
from pypdf import PdfReader, PdfWriter

# Page count / structure
reader = PdfReader("document.pdf")
print(f"Pages: {len(reader.pages)}")
```

## Python Libraries

### pypdf - Page Operations

#### Merge PDFs
```python
from pypdf import PdfWriter, PdfReader

writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf", "doc3.pdf"]:
    reader = PdfReader(pdf_file)
    for page in reader.pages:
        writer.add_page(page)

with open("merged.pdf", "wb") as output:
    writer.write(output)
```

#### Split PDF
```python
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as output:
        writer.write(output)
```

#### Extract / Set Metadata
```python
reader = PdfReader("document.pdf")
meta = reader.metadata
print(f"Title: {meta.title}, Author: {meta.author}")

writer = PdfWriter()
writer.add_metadata({"/Title": "New Title", "/Author": "Assistant"})
```

#### Rotate Pages
```python
reader = PdfReader("input.pdf")
writer = PdfWriter()
page = reader.pages[0]
page.rotate(90)  # 90 degrees clockwise
writer.add_page(page)
with open("rotated.pdf", "wb") as output:
    writer.write(output)
```

### reportlab - Create PDFs

#### Basic PDF Creation
```python
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

c = canvas.Canvas("hello.pdf", pagesize=letter)
width, height = letter
c.drawString(100, height - 100, "Hello World!")
c.line(100, height - 140, 400, height - 140)
c.save()
```

#### Create PDF with Multiple Pages
```python
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet

doc = SimpleDocTemplate("report.pdf", pagesize=letter)
styles = getSampleStyleSheet()
story = []
story.append(Paragraph("Report Title", styles['Title']))
story.append(Spacer(1, 12))
story.append(Paragraph("This is the body of the report. " * 20, styles['Normal']))
story.append(PageBreak())
story.append(Paragraph("Page 2", styles['Heading1']))
doc.build(story)
```

#### Subscripts and Superscripts

**IMPORTANT**: Never use Unicode subscript/superscript characters (₀₁₂₃₄₅₆₇₈₉, ⁰¹²³⁴⁵⁶⁷⁸⁹) in ReportLab PDFs. The built-in fonts do not include these glyphs, causing them to render as solid black boxes.

Instead, use ReportLab's XML markup tags in Paragraph objects:
```python
chemical = Paragraph("H<sub>2</sub>O", styles['Normal'])
squared = Paragraph("x<super>2</super> + y<super>2</super>", styles['Normal'])
```
For canvas-drawn text (not Paragraph objects), manually adjust font size and position.

## Command-Line Tools

### qpdf (Apache License)
```bash
# Merge / split
qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf
qpdf input.pdf --pages . 1-5 -- pages1-5.pdf

# Rotate
qpdf input.pdf output.pdf --rotate=+90:1

# Decrypt with password
qpdf --password=mypassword --decrypt encrypted.pdf decrypted.pdf

# Repair / optimize / inspect
qpdf --check damaged.pdf
qpdf --fix-qdf damaged.pdf repaired.pdf
qpdf --linearize input.pdf optimized.pdf
```

## Common Tasks

### Add Watermark
```python
from pypdf import PdfReader, PdfWriter

watermark = PdfReader("watermark.pdf").pages[0]
reader = PdfReader("document.pdf")
writer = PdfWriter()
for page in reader.pages:
    page.merge_page(watermark)
    writer.add_page(page)
with open("watermarked.pdf", "wb") as output:
    writer.write(output)
```

### Extract Embedded Images
```bash
pdfimages -j input.pdf output_prefix      # OPTIONAL, requires poppler — if unavailable, state this path is unavailable; see reference.md for pypdfium2 fallbacks
```

### Password Protection
```python
reader = PdfReader("input.pdf")
writer = PdfWriter()
for page in reader.pages:
    writer.add_page(page)
writer.encrypt("userpassword", "ownerpassword")
with open("encrypted.pdf", "wb") as output:
    writer.write(output)
```

## Quick Reference

| Task | Best Tool |
|------|-----------|
| Read text/tables | native `document_read` |
| Create PDFs | reportlab (Python) or pdf-lib (JS) |
| Merge/split/rotate | pypdf (Python) or qpdf |
| Fill PDF forms | see [forms.md](forms.md) |
| Watermark / encrypt | pypdf |
| Visual verification | render via `../document-authoring/scripts/convert_pdf_to_images.py` (see qa.md) |

## Dependencies

Per the shared dependency matrix (`../document-authoring/SKILL.md`): Python ≥ 3.9 + `pypdf` (core), `reportlab` (creation), `qpdf` (CLI optional), `pdfplumber` only for structure extraction in form workflows. Check before starting; missing dependency = state the gap explicitly.
