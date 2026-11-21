# PDF Processing Advanced Reference

Advanced authoring/manipulation features, JavaScript libraries, and troubleshooting. Reading/extraction is native (`document_read`) and out of scope here.

## Rendering (also used by the QA protocol)

### pypdfium2 (Apache/BSD License) — render pages to images

```python
import pypdfium2 as pdfium

pdf = pdfium.PdfDocument("document.pdf")
for i, page in enumerate(pdf):
    bitmap = page.render(scale=2.0)   # ~144 DPI at default page size
    img = bitmap.to_pil()
    img.save(f"page_{i+1}.png", "PNG")
```

The shared helper wraps this: `../document-authoring/scripts/convert_pdf_to_images.py <input.pdf> <output_dir> [max_dim]`.

## JavaScript Libraries

### pdf-lib (MIT License) — create and modify PDFs in JS

```javascript
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fs from 'fs';

// Create from scratch
const pdfDoc = await PDFDocument.create();
const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
const page = pdfDoc.addPage([595, 842]); // A4
const { width, height } = page.getSize();
page.drawText('Invoice #12345', { x: 50, y: height - 50, size: 18, font: helveticaBold, color: rgb(0.2, 0.2, 0.8) });
page.drawRectangle({ x: 40, y: height - 100, width: width - 80, height: 30, color: rgb(0.9, 0.9, 0.9) });
fs.writeFileSync('created.pdf', await pdfDoc.save());

// Merge (load existing, copy pages)
const merged = await PDFDocument.create();
const src = await PDFDocument.load(fs.readFileSync('input.pdf'));
(await merged.copyPages(src, src.getPageIndices())).forEach(p => merged.addPage(p));
fs.writeFileSync('merged.pdf', await merged.save());
```

pdf-lib maintains AcroForm structure better than most alternatives when filling forms.

## Advanced Command-Line Operations (qpdf)

```bash
# Complex page extraction / merging
qpdf input.pdf --pages input.pdf 1,3-5,8,10-end -- extracted.pdf
qpdf --empty --pages doc1.pdf 1-3 doc2.pdf 5-7 doc3.pdf 2,4 -- combined.pdf

# Optimization / repair
qpdf --linearize input.pdf optimized.pdf
qpdf --optimize-level=all input.pdf compressed.pdf
qpdf --check corrupted.pdf
qpdf --fix-qdf damaged.pdf repaired.pdf
qpdf --show-all-pages input.pdf > structure.txt   # structure debug

# Encryption with permissions
qpdf --encrypt user_pass owner_pass 256 --print=none --modify=none -- input.pdf encrypted.pdf
qpdf --show-encryption input.pdf
```

## Advanced Python Techniques

### reportlab — professional tables

```python
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib import colors

data = [['Product', 'Q1', 'Q2', 'Q3', 'Q4'], ['Widgets', '120', '135', '142', '158']]
table = Table(data)
table.setStyle(TableStyle([
    ('BACKGROUND', (0, 0), (-1, 0), colors.grey),
    ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
    ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
    ('GRID', (0, 0), (-1, -1), 1, colors.black),
]))
doc = SimpleDocTemplate("report.pdf"); doc.build([table])
```

### Cropping pages

```python
from pypdf import PdfWriter, PdfReader

reader = PdfReader("input.pdf")
writer = PdfWriter()
page = reader.pages[0]
page.mediabox.left, page.mediabox.bottom = 50, 50     # points: left, bottom
page.mediabox.right, page.mediabox.top = 550, 750     # right, top
writer.add_page(page)
with open("cropped.pdf", "wb") as output:
    writer.write(output)
```

### Batch processing with error handling

```python
import glob, logging
from pypdf import PdfReader, PdfWriter

for pdf_file in glob.glob("input_dir/*.pdf"):
    try:
        reader = PdfReader(pdf_file)
        writer = PdfWriter()
        for page in reader.pages:
            writer.add_page(page)
        with open(pdf_file.replace(".pdf", "_merged.pdf"), "wb") as f:
            writer.write(f)
    except Exception as e:  # per-file skip must stay visible in logs
        logging.error("Failed to process %s: %s", pdf_file, e)
```

## Performance Tips

- **Large PDFs**: process page-by-page or in chunks (`qpdf --split-pages` to pre-split); don't hold the whole file in memory.
- **Image extraction**: `pdfimages` is much faster than rendering pages.
- **Form filling**: pre-validate fields (see forms.md) before processing.

## Troubleshooting

### Encrypted PDFs
```python
reader = PdfReader("encrypted.pdf")
if reader.is_encrypted:
    reader.decrypt("password")
```

### Corrupted PDFs
```bash
qpdf --check corrupted.pdf && qpdf --replace-input corrupted.pdf   # or --fix-qdf
```

### Rendering fallbacks
If `pdf2image`/poppler is unavailable, use pypdfium2 (above) — never make poppler a hard dependency.

## License Information

- **pypdf**: BSD · **reportlab**: BSD · **pypdfium2**: Apache/BSD · **qpdf**: Apache · **pdf-lib**: MIT
