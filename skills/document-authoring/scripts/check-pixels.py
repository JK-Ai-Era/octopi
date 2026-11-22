#!/usr/bin/env python3
"""Pixel gap check: verify that declared-empty regions of rendered pages are
actually free of ink (text bleeding into gaps, overflow, stray elements).

Single source of truth: regions come from a build-side manifest (JSON) emitted
by the build helper next to the artifact -- never hand-copy coordinates here.
Manifest schema (all rects in inches, slide coordinate space):

  {
    "artifact": "output.pptx",
    "slide_in": [10.0, 5.625],
    "regions": [
      {"page": 2, "name": "gap between cards and footer",
       "rect": [0.5, 4.94, 9.5, 5.32], "expect": "empty"}
    ]
  }

expect: "empty" (default; zero ink pixels) | "ink" (at least one ink pixel --
use for asserting content IS present in a region).

PPI is derived from the rendered image width vs slide width (no hardcoded
resolution). Ink threshold: max(R,G,B) < 120 by default (paper/shadow sit far
above); override with --threshold.

Usage: python3 check-pixels.py manifest.json shots_dir [--threshold 120]
       shots_dir must contain page_N.png (from convert_pdf_to_images.py).
Exit: 1 if any region fails.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("error: Pillow (PIL) required", file=sys.stderr)
    sys.exit(2)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("manifest", type=Path)
    ap.add_argument("shots_dir", type=Path)
    ap.add_argument("--threshold", type=int, default=120)
    ap.add_argument("--max-samples", type=int, default=3)
    args = ap.parse_args()

    spec = json.loads(args.manifest.read_text(encoding="utf-8"))
    slide_w_in = float(spec["slide_in"][0])
    regions = spec.get("regions", [])
    if not regions:
        print("error: manifest has no regions", file=sys.stderr)
        return 2

    fails = 0
    cache: dict[int, "Image.Image"] = {}
    for reg in regions:
        page = int(reg["page"])
        name = reg.get("name", "")
        x0, y0, x1, y1 = (float(v) for v in reg["rect"])
        expect = reg.get("expect", "empty")

        img_path = args.shots_dir / f"page_{page}.png"
        if page not in cache:
            if not img_path.is_file():
                print(f"page {page:>3} | {name:<28} | FAIL (render missing: {img_path})")
                fails += 1
                continue
            cache[page] = Image.open(img_path).convert("RGB")
        img = cache[page]
        ppi = img.width / slide_w_in  # derived, not assumed

        px0 = max(0, int(x0 * ppi)); py0 = max(0, int(y0 * ppi))
        px1 = min(img.width, int(x1 * ppi)); py1 = min(img.height, int(y1 * ppi))
        if px1 <= px0 or py1 <= py0:
            print(f"page {page:>3} | {name:<28} | FAIL (region outside image)")
            fails += 1
            continue

        crop = img.crop((px0, py0, px1, py1))
        ink = 0
        samples = []
        for yy in range(crop.height):
            for xx in range(crop.width):
                r, g, b = crop.getpixel((xx, yy))[:3]
                if max(r, g, b) < args.threshold:
                    ink += 1
                    if len(samples) < args.max_samples:
                        samples.append((round((px0 + xx) / ppi, 2), round((py0 + yy) / ppi, 2)))

        if expect == "empty":
            ok = ink == 0
            status = "OK" if ok else f"FAIL ({ink} ink px)"
        else:  # "ink"
            ok = ink > 0
            status = "OK" if ok else "FAIL (expected ink, found none)"
        if not ok:
            fails += 1
        print(f"page {page:>3} | {name:<28} | {status}" + (f" @ {samples}" if samples and not ok else ""))

    print(f"\n{len(regions)} regions, {fails} failed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
