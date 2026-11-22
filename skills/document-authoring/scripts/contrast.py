#!/usr/bin/env python3
"""WCAG contrast ratio for color pairs -- measure before committing a palette.

Usage:
  python3 contrast.py 028090 FFFFFF [MORE_PAIRS...]   # hex triplets, pairs of fg bg
  python3 contrast.py --matrix                          # built-in starter palettes

Legend (WCAG 2.x): text pairs need >= 4.5 (body) or >= 3.0 (display >= 24pt);
decorative adjacency needs >= 3.0 to read as structure. This tool only prints
the numbers and verdicts -- the design doctrine owns the rules (design.md).
"""
from __future__ import annotations

import sys


def lum(hexs: str) -> float:
    hexs = hexs.lstrip("#")
    if len(hexs) == 3:
        hexs = "".join(c * 2 for c in hexs)
    if len(hexs) != 6:
        raise ValueError(f"not a hex color: {hexs!r}")
    r, g, b = (int(hexs[i:i + 2], 16) / 255 for i in (0, 2, 4))

    def f(c: float) -> float:
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = f(r), f(g), f(b)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a: str, b: str) -> float:
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def verdict(r: float) -> str:
    if r >= 4.5:
        return "OK body text"
    if r >= 3.0:
        return "LARGE-ONLY (>=24pt text or graphics)"
    return "FAIL (never as text pair)"


PAIRS = [
    ("Midnight Executive", "1E2761", "CADCFC", "FFFFFF"),
    ("Forest & Moss", "2C5F2D", "97BC62", "F5F5F5"),
    ("Coral Energy", "F96167", "F9E795", "2F3C7E"),
    ("Warm Terracotta", "B85042", "E7E8D1", "A7BEAE"),
    ("Ocean Gradient", "065A82", "1C7293", "21295C"),
    ("Charcoal Minimal", "36454F", "F2F2F2", "212121"),
    ("Teal Trust", "028090", "00A896", "02C39A"),
    ("Berry & Cream", "6D2E46", "A26769", "ECE2D0"),
    ("Sage Calm", "84B59F", "69A297", "50808E"),
    ("Cherry Bold", "990011", "FCF6F5", "2F3C7E"),
]


def matrix() -> None:
    cols = ["wht×Pri", "wht×Sec", "wht×Acc", "blk×Pri", "blk×Sec", "blk×Acc", "Pri×Sec", "Pri×Acc", "Sec×Acc"]
    print("| Palette | " + " | ".join(cols) + " |")
    print("|---" * (len(cols) + 1) + "|")
    for name, p, s, a in PAIRS:
        combos = [("FFFFFF", p), ("FFFFFF", s), ("FFFFFF", a), ("000000", p),
                  ("000000", s), ("000000", a), (p, s), (p, a), (s, a)]
        cells = []
        for fg, bg in combos:
            r = ratio(fg, bg)
            mark = "OK" if r >= 4.5 else ("LARGE" if r >= 3.0 else "NO")
            cells.append(f"{r:.2f} {mark}")
        print(f"| {name} | " + " | ".join(cells) + " |")


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    if args == ["--matrix"]:
        matrix()
        return 0
    if len(args) % 2 != 0:
        print("error: arguments must be fg/bg hex pairs", file=sys.stderr)
        return 2
    for i in range(0, len(args), 2):
        fg, bg = args[i], args[i + 1]
        try:
            r = ratio(fg, bg)
        except ValueError as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
        print(f"{fg} on {bg}: {r:.2f}:1  {verdict(r)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
