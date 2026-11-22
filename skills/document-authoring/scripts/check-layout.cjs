#!/usr/bin/env node
/**
 * Layout geometry check for PPTX (or any OOXML slide deck):
 *   - shapes out of slide bounds
 *   - estimated text overflow (CJK-aware width heuristic)
 *   - text frames overlapping each other (containment = parent/child, OK)
 *   - text occluded by later-drawn filled shapes (z-order = document order)
 *
 * Single source of truth: geometry is read from the pptx itself (presentation.xml
 * slide size), never from hand-copied constants.
 *
 * Usage: node check-layout.js file.pptx [more.pptx ...] [--unpack-dir DIR]
 * Exit: 1 if any issue found.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const args = process.argv.slice(2);
const unpackIdx = args.indexOf("--unpack-dir");
const UNPACK_BASE = unpackIdx >= 0 ? args[unpackIdx + 1] : fs.mkdtempSync(path.join(os.tmpdir(), "layoutck-"));
const files = args.filter((a, i) => !a.startsWith("--") && (unpackIdx < 0 || i !== unpackIdx + 1));
if (files.length === 0) {
  console.error("usage: node check-layout.cjs file.pptx [...] [--unpack-dir DIR]");
  process.exit(2);
}

// shared toolkit lives beside this script: scripts/office/unpack.py
const OFFICE = path.join(__dirname, "office");
const EMU_IN = 914400;

function unpack(pptx, dest) {
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
  execSync(`python3 "${path.join(OFFICE, "unpack.py")}" "${pptx}" "${dest}"`, { stdio: "pipe" });
}

function slideSize(unpacked) {
  // presentation.xml: <p:sldSz cx="12192000" cy="6858000"/>
  const xml = fs.readFileSync(path.join(unpacked, "ppt", "presentation.xml"), "utf8");
  const m = xml.match(/<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
  if (!m) throw new Error("sldSz not found in presentation.xml");
  return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
}

function parseSp(xml) {
  const shapes = [];
  // document order = z order (later blocks paint over earlier ones)
  const blocks = xml.match(/<(?:p:sp|p:pic)>[\s\S]*?<\/(?:p:sp|p:pic)>/g) || [];
  for (const b of blocks) {
    const off = b.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/);
    const ext = b.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    if (!off || !ext) continue;
    const isPic = b.startsWith("<p:pic");
    const txBody = b.match(/<p:txBody>([\s\S]*?)<\/p:txBody>/);
    let text = "";
    const runs = [];
    if (txBody) {
      const rs = txBody[1].match(/<a:r>[\s\S]*?<\/a:r>/g) || [];
      for (const r of rs) {
        const t = (r.match(/<a:t>([\s\S]*?)<\/a:t>/) || [])[1] || "";
        const sz = (r.match(/sz="(\d+)"/) || [])[1];
        runs.push({ t, sz: sz ? parseInt(sz, 10) : 1800 });
        text += t;
      }
    }
    const hasFill = /<p:spPr>[\s\S]*?<a:solidFill>/.test(b) || isPic;
    if (!text && !hasFill) continue; // unfilled lines/decor: no occlusion semantics
    shapes.push({
      x: parseInt(off[1], 10), y: parseInt(off[2], 10),
      cx: parseInt(ext[1], 10), cy: parseInt(ext[2], 10),
      text, runs, isPic, hasFill, hasText: text.trim().length > 0,
    });
  }
  return shapes;
}

// Estimated text height (EMU): CJK 1.0em per char, ASCII 0.55em, line 1.25em.
function estTextHeight(shape) {
  const boxWIn = shape.cx / EMU_IN;
  let totalLines = 0;
  let maxSz = 0;
  for (const r of shape.runs) if (r.sz > maxSz) maxSz = r.sz;
  const paras = shape.text.split(/\r?\n/);
  for (const p of paras) {
    if (p.length === 0) { totalLines += 1; continue; }
    const sz = maxSz || 1200;
    const em = sz / 100 / 72; // hundredths of a point -> inch
    let widthIn = 0;
    for (const ch of p) {
      const wide = ch.codePointAt(0) > 0x2000; // CJK / fullwidth punctuation
      widthIn += wide ? em : em * 0.55;
    }
    totalLines += Math.max(1, Math.ceil(widthIn / Math.max(1e-6, boxWIn)));
  }
  const em = (maxSz || 1200) / 100 / 72;
  return totalLines * em * 1.25 * EMU_IN;
}

function overlap(a, b, pad) {
  return a.x < b.x + b.cx - pad && b.x < a.x + a.cx - pad &&
         a.y < b.y + b.cy - pad && b.y < a.y + a.cy - pad;
}

let totalIssues = 0;
for (const file of files) {
  const unpacked = path.join(UNPACK_BASE, path.basename(file).replace(/\.[^.]+$/, "") + "-unpacked");
  unpack(file, unpacked);
  const { w: SLIDE_W, h: SLIDE_H } = slideSize(unpacked);
  const issues = [];
  const slideDir = path.join(unpacked, "ppt", "slides");
  const slideFiles = fs.readdirSync(slideDir).filter((f) => f.endsWith(".xml"))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));

  for (const f of slideFiles) {
    const n = parseInt(f.match(/\d+/)[0], 10);
    const shapes = parseSp(fs.readFileSync(path.join(slideDir, f), "utf8"));

    for (const s of shapes) {
      const tol = 0.02 * EMU_IN;
      if (s.x < -tol || s.y < -tol || s.x + s.cx > SLIDE_W + tol || s.y + s.cy > SLIDE_H + tol) {
        issues.push(`slide ${n}: out of bounds "${s.text.slice(0, 24)}" x=${(s.x / EMU_IN).toFixed(2)} y=${(s.y / EMU_IN).toFixed(2)} w=${(s.cx / EMU_IN).toFixed(2)} h=${(s.cy / EMU_IN).toFixed(2)}`);
      }
      if (!s.isPic && s.text) {
        const need = estTextHeight(s);
        if (need > s.cy * 1.18) {
          issues.push(`slide ${n}: text may overflow (needs ≈${(need / EMU_IN).toFixed(2)}in > box ${(s.cy / EMU_IN).toFixed(2)}in) "${s.text.slice(0, 30)}"`);
        }
      }
    }

    const texts = shapes.filter((s) => !s.isPic && s.text.trim());
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i], b = texts[j];
        if (!overlap(a, b, 0.08 * EMU_IN)) continue;
        const aInB = a.x >= b.x && a.y >= b.y && a.x + a.cx <= b.x + b.cx && a.y + a.cy <= b.y + b.cy;
        const bInA = b.x >= a.x && b.y >= a.y && b.x + b.cx <= a.x + a.cx && b.y + b.cy <= a.y + a.cy;
        if (aInB || bInA) continue; // containment = nested label, fine
        issues.push(`slide ${n}: text frames overlap "${a.text.slice(0, 18)}" ↔ "${b.text.slice(0, 18)}"`);
      }
    }

    for (let i = 0; i < shapes.length; i++) {
      const t = shapes[i];
      if (!t.hasText) continue;
      const cx = t.x + t.cx / 2, cy = t.y + t.cy / 2;
      for (let j = i + 1; j < shapes.length; j++) {
        const o = shapes[j];
        if (o.hasText || o.isPic || !o.hasFill || o.cx <= 0 || o.cy <= 0) continue;
        if (cx > o.x && cx < o.x + o.cx && cy > o.y && cy < o.y + o.cy) {
          issues.push(`slide ${n}: text occluded by later shape "${t.text.slice(0, 24)}" ← shape@(${(o.x / EMU_IN).toFixed(2)},${(o.y / EMU_IN).toFixed(2)})`);
          break;
        }
      }
    }
  }

  if (issues.length === 0) console.log(`LAYOUT OK: ${path.basename(file)}`);
  else {
    console.log(`LAYOUT ${issues.length} issue(s): ${path.basename(file)}`);
    issues.forEach((i) => console.log(" - " + i));
    totalIssues += issues.length;
  }
}
process.exit(totalIssues ? 1 : 0);
