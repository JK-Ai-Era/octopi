#!/usr/bin/env python3
"""Content placeholder scan with word boundaries (a naive substring grep for
"NaN" matches "gover-nan-ce" -- this tool does not).

Checks, on any OOXML (docx/pptx/xlsx) or plain text file:
  1. placeholder tokens at word boundaries (case-insensitive)
  2. template slots left unreplaced ({...}, {{...}}, <FILL...>, [...]-style
     slot labels) -- list expected slots via --slots to assert they are GONE
  3. optional exact-string leftovers via --banish STRING (repeatable)

Usage:
  python3 check-content.py file.docx [more files...]
  python3 check-content.py file.pptx --slots "NAME" "DATE" --banish "TODO v2"
  python3 check-content.py file.pptx --allow "{VAR}" "{serverId}"
    (--allow: slot-shaped strings that are INTENTIONAL content, e.g. code
     examples documenting ${VAR} placeholders -- exact-string whitelist)
Exit: 1 on any hit.
"""
from __future__ import annotations

import argparse
import html
import re
import sys
import zipfile
from pathlib import Path

PLACEHOLDER_WORDS = ["xxxx", "lorem", "ipsum", "todo", "placeholder", "tbd", "fixme", "nan", "undefined"]

# word-boundary regex; \b works for ASCII tokens, which is what placeholders are
WORD_RE = re.compile(r"\b(?:" + "|".join(PLACEHOLDER_WORDS) + r")\b", re.IGNORECASE)

# template slots that survived editing: {X}, {{X}}, <FILL-X>, [SLOT]
SLOT_RES = [
    re.compile(r"\{\{[^}]{1,40}\}\}"),
    re.compile(r"(?<!\{)\{[A-Za-z_][A-Za-z0-9_ .-]{0,38}\}(?!\})"),
    re.compile(r"<FILL[-_ ][^>]{1,40}>", re.IGNORECASE),
    re.compile(r"\[(?:SLOT|FILL|TODO|NAME|DATE)[^\]]{0,38}\]", re.IGNORECASE),
]


def extract_text(path: Path) -> str:
    """Extract author-visible text only.

    For OOXML that means text nodes (content between tags) -- attribute
    values (shape names like 'Notes Placeholder 2', relationship targets,
    GUIDs) are structural metadata and must not enter the scan surface.
    """
    if zipfile.is_zipfile(path):
        parts = []
        with zipfile.ZipFile(path) as z:
            for n in z.namelist():
                # .rels / docProps carry GUIDs and generator strings, never
                # authored content -- scanning them raises false slots
                if n.endswith(".rels") or n.startswith("docProps/"):
                    continue
                if n.endswith(".xml"):
                    try:
                        xml = z.read(n).decode("utf-8", "replace")
                    except Exception:
                        continue
                    nodes = re.findall(r">([^<>]+)<", xml)
                    parts.append("\n".join(html.unescape(t) for t in nodes))
        return "\n".join(parts)
    return path.read_text(encoding="utf-8", errors="replace")


GUID_RE = re.compile(r"^\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?$")


def scan(path: Path, extra_slots: list[str], banish: list[str], allow: list[str]) -> list[str]:
    text = extract_text(path)
    findings = []
    for m in WORD_RE.finditer(text):
        ctx = text[max(0, m.start() - 40):m.end() + 40].replace("\n", " ")
        findings.append(f"{path.name}: placeholder word {m.group(0)!r} … {ctx!r}")
    for rx in SLOT_RES:
        for m in rx.finditer(text):
            inner = m.group(0).strip("{}<>[]")
            if GUID_RE.match(inner):
                continue  # relationship / durable IDs are not template slots
            if m.group(0) in allow or inner in allow:
                continue  # intentional slot-shaped content (e.g. code examples)
            findings.append(f"{path.name}: unreplaced slot {m.group(0)!r}")
    for slot in extra_slots:
        # slots given on CLI must be GONE from the output
        if slot in text:
            findings.append(f"{path.name}: expected slot {slot!r} still present")
    for b in banish:
        if b in text:
            findings.append(f"{path.name}: banished string {b!r} still present")
    return findings


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--slots", nargs="*", default=[], help="slot labels that must have been replaced (any presence = fail)")
    ap.add_argument("--banish", nargs="*", default=[], help="exact strings that must not appear")
    ap.add_argument("--allow", nargs="*", default=[], help="slot-shaped strings that are intentional content")
    args = ap.parse_args()

    all_findings: list[str] = []
    for f in args.files:
        if not f.is_file():
            print(f"error: not a file: {f}", file=sys.stderr)
            return 2
        all_findings.extend(scan(f, args.slots, args.banish, args.allow))

    if not all_findings:
        print(f"CONTENT OK: {len(args.files)} file(s) scanned, no placeholders")
        return 0
    print(f"CONTENT {len(all_findings)} finding(s):")
    for line in all_findings:
        print(" - " + line)
    return 1


if __name__ == "__main__":
    sys.exit(main())
