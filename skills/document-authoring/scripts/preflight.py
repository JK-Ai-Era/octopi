#!/usr/bin/env python3
"""Preflight for the document-authoring skill family.

Two jobs:

1. Two-layer repo-deploy drift (skill C-architecture): the SHARED layer
   ($OCTOPI_HOME/skills/) must mirror the repo skills/ tree -- missing / extra /
   changed files FAIL LOUDLY. Per-agent layers ($OCTOPI_HOME/agents/<id>/skills/)
   are override layers: same-id skills there intentionally win over the shared
   copy and are REPORTED, not failed. This drift once silently downgraded a live
   build to an obsolete scratch copy of a skill.
2. Capability probes: Python libs, LibreOffice, Node packages, CJK fonts, and
   whether any configured model accepts image input (which QA tier may be
   claimed -- see qa.md "Visual review tiers").

Exit code: 1 on drift (hard failure). Capability gaps are reported loudly but
not fatal -- declare them in the deliverable instead of silently degrading.

Usage:
  python3 preflight.py [--repo-skills DIR] [--deploy-skills DIR]...
                       [--workdir DIR] [--octopi-home DIR]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

IGNORE_NAMES = {"__pycache__", ".DS_Store", ".git", "node_modules"}
IGNORE_SUFFIXES = (".pyc",)

PYTHON_LIBS = [
    ("PIL", "thumbnails / pixel checks"),
    ("pypdfium2", "PDF -> page images (visual QA)"),
    ("defusedxml", "OOXML unpack/pack"),
    ("lxml", "XSD validation"),
    ("openpyxl", "xlsx create/edit"),
    ("pandas", "xlsx data work"),
    ("reportlab", "PDF creation"),
    ("pypdf", "PDF manipulation / form fill"),
    ("pdfminer", "font extraction (optional, check-fonts.py)"),
]

NODE_PACKAGES = ["pptxgenjs", "react-icons", "sharp"]

CJK_FONTS = ["PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC"]


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def tree_snapshot(root: Path) -> dict[str, str]:
    """Map relative posix path -> sha256 for every file under root."""
    out: dict[str, str] = {}
    if not root.is_dir():
        return out
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(root)
        if any(part in IGNORE_NAMES for part in rel.parts):
            continue
        if p.suffix in IGNORE_SUFFIXES:
            continue
        out[rel.as_posix()] = file_sha256(p)
    return out


def diff_trees(repo: Path, deploy: Path) -> tuple[list[str], list[str], list[str]]:
    """Compare two skill trees. Returns (missing_in_deploy, extra_in_deploy, changed)."""
    r = tree_snapshot(repo)
    d = tree_snapshot(deploy)
    missing = sorted(set(r) - set(d))
    extra = sorted(set(d) - set(r))
    changed = sorted(k for k in set(r) & set(d) if r[k] != d[k])
    return missing, extra, changed


def check_drift(repo_skills: Path, shared_root: Path | None, agent_roots: list[Path]) -> bool:
    """Two-layer drift semantics (skill C-architecture, 2026-11-23):

    - shared layer (OCTOPI_HOME/skills) = seeded mirror of repo skills/
      -> strict mirror check, any drift FAILs
    - agent layers (agents/<id>/skills) = override layer
      -> same-id skills here intentionally OVERRIDE the shared copy;
      report only (changed = override, extra = agent-private skill)
    """
    ok = True
    print(f"[drift] repo skills/: {repo_skills}")
    if not repo_skills.is_dir():
        print(f"[drift] FAIL repo skills dir not found: {repo_skills}")
        return False

    # ── shared layer: strict mirror ──
    if shared_root is None or not shared_root.is_dir():
        print(f"[drift] WARN shared layer missing ({shared_root}) -- run `octopi init` "
              "to seed OCTOPI_HOME/skills from the package")
    else:
        print(f"[drift] shared layer: {shared_root}")
        missing, extra, changed = diff_trees(repo_skills, shared_root)
        if not (missing or extra or changed):
            print("[drift] OK shared layer mirrors repo (ignoring __pycache__/*.pyc)")
        else:
            ok = False
            for k in missing:
                print(f"[drift] MISSING in shared: {k}")
            for k in extra:
                print(f"[drift] EXTRA in shared (stale residue?): {k}")
            for k in changed:
                print(f"[drift] CHANGED in shared: {k}")
            print("[drift] FAIL -- restore shared layer from repo skills/ before authoring")

    # ── agent layers: override layer, report only ──
    for dep in agent_roots:
        print(f"[drift] agent override layer: {dep}")
        if not tree_snapshot(dep):
            print("[drift] OK empty (all skills come from the shared layer)")
            continue
        _, extra, changed = diff_trees(repo_skills, dep)
        for k in changed:
            print(f"[drift] OVERRIDE (agent layer wins): {k}")
        for k in extra:
            print(f"[drift] agent-private skill file: {k}")
        if not (extra or changed):
            print("[drift] WARN agent layer is a byte-identical copy of repo -- "
                  "redundant now that the shared layer exists; consider removing")
    return ok


def probe_python() -> bool:
    ok = True
    ver = sys.version_info
    print(f"[deps] python {ver.major}.{ver.minor}.{ver.micro}" + (" (>= 3.9 ok)" if ver >= (3, 9) else " (NEED >= 3.9)"))
    if ver < (3, 9):
        ok = False
    for mod, why in PYTHON_LIBS:
        try:
            __import__(mod)
            print(f"[deps] OK   python:{mod}")
        except ImportError:
            optional = mod == "pdfminer"
            tag = "WARN" if optional else "GAP "
            print(f"[deps] {tag} python:{mod} missing -- {why}")
            if not optional:
                ok = False
    return ok


def probe_binaries() -> bool:
    ok = True
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if soffice:
        print(f"[deps] OK   soffice: {soffice}")
    else:
        for cand in ("/Applications/LibreOffice.app/Contents/MacOS/soffice",
                     "/usr/bin/soffice", "/usr/local/bin/soffice"):
            if Path(cand).exists():
                soffice = cand
                break
        if soffice:
            print(f"[deps] OK   soffice: {soffice} (not on PATH)")
        else:
            print("[deps] GAP  soffice missing -- Office->PDF rendering unavailable; visual QA downgrades to content QA")
            ok = False
    if shutil.which("node"):
        try:
            v = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=10)
            print(f"[deps] OK   node: {v.stdout.strip()}")
        except Exception:
            print("[deps] OK   node: present")
    else:
        print("[deps] GAP  node missing -- pptx/docx creation unavailable")
        ok = False
    return ok


def probe_node_packages(workdir: Path) -> bool:
    ok = True
    if not shutil.which("node"):
        return True  # already reported
    for pkg in NODE_PACKAGES:
        code = f"try {{ require.resolve({pkg!r}); process.exit(0) }} catch {{ process.exit(1) }}"
        try:
            r = subprocess.run(["node", "-e", code], cwd=str(workdir), capture_output=True, timeout=20)
            found = r.returncode == 0
        except Exception:
            found = False
        if found:
            print(f"[deps] OK   node:{pkg} (resolvable from {workdir})")
        else:
            print(f"[deps] GAP  node:{pkg} not resolvable from {workdir} -- npm install there before authoring")
            ok = False
    return ok


def probe_fonts() -> None:
    fc = shutil.which("fc-match")
    if not fc:
        print("[fonts] WARN fc-match unavailable -- CJK font visibility unverified")
        return
    for font in CJK_FONTS:
        try:
            r = subprocess.run([fc, "-f", "%{family}", font], capture_output=True, text=True, timeout=10)
            got = r.stdout.strip()
            hit = font.lower().split()[0] in got.lower()
            print(f"[fonts] {'OK  ' if hit else 'WARN'} {font!r} -> {got or '(none)'}")
        except Exception as e:
            print(f"[fonts] WARN fc-match {font!r} failed: {e}")


def probe_vision(octopi_home: Path) -> None:
    """Report whether any configured model accepts image input (QA tier claim)."""
    cfg = octopi_home / "octopi.json"
    if not cfg.is_file():
        print(f"[vision] WARN config not found: {cfg} -- image capability unknown; declare QA tier manually")
        return
    try:
        data = json.loads(cfg.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[vision] WARN config unreadable: {e}")
        return

    image_models: list[str] = []

    def walk(node, path):
        if isinstance(node, dict):
            inputs = node.get("input")
            label = node.get("id") or node.get("name") or node.get("model") or "?"
            if isinstance(inputs, list) and any(str(x).lower() == "image" for x in inputs):
                image_models.append(f"{path}{label}")
            for k, v in node.items():
                walk(v, f"{path}{k}.")
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{path}[{i}].")

    walk(data, "")
    if image_models:
        print(f"[vision] OK models with image input: {', '.join(image_models)} -- real-vision QA tier claimable (see qa.md)")
    else:
        print("[vision] WARN no model with image input found in config -- QA must fall to measured tier and declare 'aesthetic judgment unverified'")


def main() -> int:
    here = Path(__file__).resolve()
    default_repo = here.parent.parent.parent  # scripts/ -> document-authoring/ -> skills/
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo-skills", type=Path, default=default_repo)
    ap.add_argument("--deploy-skills", type=Path, action="append", default=None,
                    help="deployed skills dir (repeatable; default: $OCTOPI_HOME/agents/*/skills)")
    ap.add_argument("--workdir", type=Path, default=Path.cwd(),
                    help="where node packages are resolved (default: cwd)")
    ap.add_argument("--octopi-home", type=Path, default=Path(os.environ.get("OCTOPI_HOME", str(Path.home() / ".octopi"))))
    ap.add_argument("--skip-deps", action="store_true")
    args = ap.parse_args()

    deploy_roots = args.deploy_skills
    if deploy_roots is None:
        # two-layer layout: shared mirror + per-agent override layers
        shared_root = args.octopi_home / "skills"
        agents = args.octopi_home / "agents"
        agent_roots = sorted(p for p in agents.glob("*/skills") if p.is_dir()) if agents.is_dir() else []
    else:
        # explicit --deploy-skills: treat first as shared mirror, rest as override layers
        shared_root = deploy_roots[0] if deploy_roots else None
        agent_roots = deploy_roots[1:]

    print("=== document-authoring preflight ===")
    drift_ok = check_drift(args.repo_skills.resolve(), shared_root.resolve() if shared_root else None,
                           [p.resolve() for p in agent_roots])

    deps_ok = True
    if not args.skip_deps:
        print("--- capability probes ---")
        deps_ok = probe_python() and probe_binaries()
        probe_node_packages(args.workdir.resolve())
        probe_fonts()
        probe_vision(args.octopi_home)

    if drift_ok:
        print("=== preflight: DRIFT OK ===")
        return 0
    print("=== preflight: DRIFT FAIL (fix before authoring) ===")
    return 1


if __name__ == "__main__":
    sys.exit(main())
