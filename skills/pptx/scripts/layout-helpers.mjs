/**
 * pptxgenjs layout helpers — one anchor, derived geometry, manifest output.
 *
 * Solves two failure modes from real builds:
 *  1. dual hand-math: card rect and its text frame were computed on two
 *     separate coordinate hand-calculations and drifted apart — here the
 *     text frame is DERIVED from the card anchor + declared inset, always.
 *  2. hand-copied check regions: QA pixel checks listed gap rectangles that
 *     went stale the moment a layout changed — here the build EMITS a
 *     manifest (`emptyGap` calls) that check-pixels.py consumes.
 *
 * Usage (ESM):
 *   import { Layout, card, chip, codeBlock, emptyGap, writeManifest } from "./layout-helpers.mjs";
 *
 *   const L = new Layout({ slideW: 10, slideH: 5.625 });   // inches
 *   card(slide, { x: 0.5, y: 1.2, w: 9, h: 2.4, title: "…" }, L);
 *   emptyGap(L, 2, "gap between cards and footer", [0.5, 4.94, 9.5, 5.32]);
 *   writeManifest(L, "manifest.json", "output.pptx");
 *
 * All geometry in INCHES (pptxgenjs native). The manifest records the same
 * inch coordinate space consumed by check-pixels.py (`slide_in`).
 */

import fs from "node:fs";

const DEFAULT_INSET = 0.14; // text frame inset from card edge (inches)

/** Layout context: slide size + collected QA regions. */
export class Layout {
  /** @param {{slideW: number, slideH: number, inset?: number}} opts */
  constructor(opts) {
    this.slideW = opts.slideW;
    this.slideH = opts.slideH;
    this.inset = opts.inset ?? DEFAULT_INSET;
    /** @type {Array<{page:number,name:string,rect:number[],expect:string}>} */
    this.regions = [];
  }
}

/**
 * Derive a text frame rect from an anchor + inset.
 * @param {{x:number,y:number,w:number,h:number}} anchor
 * @param {number} [inset]
 * @returns {{x:number,y:number,w:number,h:number,margin:number}}
 */
export function textFrame(anchor, inset = DEFAULT_INSET) {
  return {
    x: anchor.x + inset,
    y: anchor.y + inset,
    w: anchor.w - inset * 2,
    h: anchor.h - inset * 2,
    margin: 0,
  };
}

/**
 * Card: filled rect (+ optional accent bar) and its derived text frame —
 * one anchor, no second coordinate calculation.
 * @param {*} slide pptxgenjs slide
 * @param {{x:number,y:number,w:number,h:number,fill?:string,line?:string,accent?:string,shadow?:object}} anchor
 * @param {Layout} [layout] layout for inset
 * @returns {{frame: {x:number,y:number,w:number,h:number,margin:number}, anchor: object}}
 */
export function card(slide, anchor, layout) {
  const inset = layout?.inset ?? DEFAULT_INSET;
  slide.addShape("rect", {
    x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h,
    fill: { color: anchor.fill ?? "FFFFFF" },
    line: anchor.line ? { color: anchor.line, width: 0.75 } : { type: "none" },
    ...(anchor.shadow ? { shadow: anchor.shadow } : {}),
  });
  if (anchor.accent) {
    slide.addShape("rect", {
      x: anchor.x, y: anchor.y, w: 0.07, h: anchor.h,
      fill: { color: anchor.accent }, line: { type: "none" },
    });
  }
  return { frame: textFrame(anchor, inset), anchor };
}

/**
 * Chip: pill with centered text. Text box = pill rect exactly (margin 0,
 * centered) — no separate text coordinates.
 * @param {*} slide
 * @param {string} text
 * @param {{x:number,y:number,w:number,h:number,fill?:string,color?:string,line?:string,fontSize?:number,bold?:boolean}} anchor
 */
export function chip(slide, text, anchor) {
  const radius = anchor.h / 2 > 0.2 ? 0.12 : anchor.h / 3;
  slide.addShape("roundRect", {
    x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h, rectRadius: radius,
    fill: { color: anchor.fill ?? "F2F2F2" },
    line: anchor.line ? { color: anchor.line, width: 0.75 } : { type: "none" },
  });
  slide.addText(text, {
    x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h,
    align: "center", valign: "middle", margin: 0,
    fontSize: anchor.fontSize ?? 10.5, bold: !!anchor.bold,
    color: anchor.color ?? "333333",
  });
}

/**
 * Code block: dark panel + mono text frame derived from the same anchor.
 * @param {*} slide
 * @param {{x:number,y:number,w:number,h:number,fill?:string,color?:string,fontFace?:string,fontSize?:number}} anchor
 * @param {Layout} [layout]
 * @returns {{frame: {x:number,y:number,w:number,h:number,margin:number}}}
 */
export function codeBlock(slide, anchor, layout) {
  const inset = layout?.inset ?? DEFAULT_INSET;
  slide.addShape("rect", {
    x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h,
    fill: { color: anchor.fill ?? "1E2736" }, line: { type: "none" },
  });
  return {
    frame: {
      ...textFrame(anchor, inset),
      fontFace: anchor.fontFace ?? "Menlo",
      fontSize: anchor.fontSize ?? 10,
      color: anchor.color ?? "D8E2EA",
    },
  };
}

/**
 * Declare a region that must render EMPTY (zero ink) in QA.
 * Collects into the layout manifest — the single source of truth consumed by
 * check-pixels.py. Call at build time next to the layout code so regions
 * cannot drift from the layout.
 * @param {Layout} layout
 * @param {number} page 1-based page number
 * @param {string} name human-readable region name (shows in QA output)
 * @param {number[]} rect [x0, y0, x1, y1] inches, slide space
 */
export function emptyGap(layout, page, name, rect) {
  layout.regions.push({ page, name, rect, expect: "empty" });
}

/**
 * Declare a region that must contain ink (content presence assertion).
 * @param {Layout} layout
 * @param {number} page
 * @param {string} name
 * @param {number[]} rect [x0, y0, x1, y1] inches
 */
export function expectInk(layout, page, name, rect) {
  layout.regions.push({ page, name, rect, expect: "ink" });
}

/**
 * Write the QA manifest JSON consumed by check-pixels.py.
 * @param {Layout} layout
 * @param {string} path output path
 * @param {string} [artifact] artifact filename recorded in the manifest
 */
export function writeManifest(layout, path, artifact) {
  const manifest = {
    artifact: artifact ?? null,
    slide_in: [layout.slideW, layout.slideH],
    regions: layout.regions,
  };
  fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}
