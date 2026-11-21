"""Render PDF pages to PNG images using pypdfium2 (no poppler/pdf2image needed).

Usage:
    python convert_pdf_to_images.py <input.pdf> <output_dir> [max_dim]

Output: <output_dir>/page_1.png, page_2.png, ... (longest edge capped at max_dim, default 1000)
"""
import os
import sys

import pypdfium2 as pdfium


def convert(pdf_path, output_dir, max_dim=1000):
    os.makedirs(output_dir, exist_ok=True)
    pdf = pdfium.PdfDocument(pdf_path)

    for i, page in enumerate(pdf):
        bitmap = page.render(scale=2.0)  # ~144 DPI at default page size
        image = bitmap.to_pil()
        width, height = image.size
        if width > max_dim or height > max_dim:
            scale_factor = min(max_dim / width, max_dim / height)
            image = image.resize((int(width * scale_factor), int(height * scale_factor)))

        image_path = os.path.join(output_dir, f"page_{i + 1}.png")
        image.save(image_path)
        print(f"Saved page {i + 1} as {image_path} (size: {image.size})")

    print(f"Converted {len(pdf)} pages to PNG images")


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        print("Usage: convert_pdf_to_images.py <input.pdf> <output_dir> [max_dim]")
        sys.exit(1)
    max_dim = int(sys.argv[3]) if len(sys.argv) == 4 else 1000
    convert(sys.argv[1], sys.argv[2], max_dim)
