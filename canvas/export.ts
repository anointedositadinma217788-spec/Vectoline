import type { VecObject } from "./types";
import { polygonPoints, starPoints, isClosedPath } from "./types";
import { fontCss, LINE_H, lineStarts, styledRuns } from "./text";

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** ZS-safe element id: unique per export, never the display name. */
export const safeId = (id: string, i: number) =>
  `vl-${i}-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/** Shared geometry clamp: canvas and export agree on degenerate sizes. */
export const clampW = (w: number) => Math.max(0, w);
export const clampR = (r: number, w: number, h: number) =>
  Math.min(Math.max(0, r), Math.min(w, h) / 2);

function node(o: VecObject, i: number): string {
  const id = safeId(o.id, i);
  const op = (o.opacity / 100).toString();
  const tr = o.rotation ? ` transform="rotate(${o.rotation} ${o.x + o.w / 2} ${o.y + o.h / 2})"` : "";
  switch (o.kind) {
    case "rect": {
      const w = clampW(o.w), h = clampW(o.h);
      const sw = o.stroke === "none" ? 0 : o.strokeWidth;
      return `<g id="${id}"${tr} opacity="${op}"><rect x="${o.x}" y="${o.y}" width="${w}" height="${h}" rx="${clampR(o.rx, w, h)}" fill="${esc(o.fill)}" stroke="${esc(o.stroke)}" stroke-width="${sw}"/></g>`;
    }
    case "ellipse": {
      const rx = Math.max(0, o.w / 2), ry = Math.max(0, o.h / 2);
      const sw = o.stroke === "none" ? 0 : o.strokeWidth;
      return `<g id="${id}"${tr} opacity="${op}"><ellipse cx="${o.x + o.w / 2}" cy="${o.y + o.h / 2}" rx="${rx}" ry="${ry}" fill="${esc(o.fill)}" stroke="${esc(o.stroke)}" stroke-width="${sw}"/></g>`;
    }
    case "line": {
      const sw = o.stroke === "none" ? 0 : Math.max(0, o.strokeWidth);
      return `<g id="${id}"${tr} opacity="${op}"><line x1="${o.x}" y1="${o.y}" x2="${o.x + o.w}" y2="${o.y + o.h}" stroke="${esc(o.stroke)}" stroke-width="${sw}" stroke-linecap="round"/></g>`;
    }
    case "text": {
      const lines = (o.lines && o.lines.length ? o.lines : [o.text ?? ""]) as string[];
      const baseY = o.y + o.fontSize * 0.85;
      // outline: stroke painted under the fill, identical to the canvas render
      const outlineOn =
        o.outlineOn === true && o.stroke !== "none" && o.stroke !== "transparent" && o.strokeWidth > 0;
      const outlineAttrs = outlineOn
        ? ` stroke="${esc(o.stroke)}" stroke-width="${o.strokeWidth}" stroke-linejoin="round" paint-order="stroke"`
        : "";
      // per-letter spans: identical run-splitting to the canvas renderer
      const starts = lineStarts(o.text ?? "", lines);
      const spans = o.spans ?? [];
      const spanAttr = (k: string, v: unknown) =>
        v === undefined || v === null ? "" : ` ${k}="${esc(String(v))}"`;
      const spanXml = lines
        .map((l, li) => {
          const runs = styledRuns(l, starts[li] ?? 0, spans);
          const attrs = li === 0 ? `x="${o.x}" dy="0"` : `x="${o.x}" dy="${o.fontSize * LINE_H}"`;
          const inner = runs
            .map((r) =>
              r.style
                ? `<tspan${spanAttr("fill", r.style.fill)}${spanAttr("font-weight", r.style.fontWeight)}${spanAttr("font-size", r.style.fontSize)}${spanAttr("font-family", r.style.fontFamily)}>${esc(r.text) || " "}</tspan>`
                : esc(r.text) || " "
            )
            .join("");
          return `<tspan ${attrs}>${inner}</tspan>`;
        })
        .join("");
      return `<g id="${id}"${tr} opacity="${op}"><text x="${o.x}" y="${baseY}" font-family="${esc(fontCss(o.fontFamily))}" font-size="${o.fontSize}" font-weight="${o.fontWeight}" fill="${esc(o.fill)}"${outlineAttrs}>${spanXml}</text></g>`;
    }
    case "path": {
      const sw = o.stroke === "none" ? 0 : Math.max(0, o.strokeWidth);
      const d = o.d ?? "";
      const showFill = isClosedPath(d) && o.fill !== "transparent" ? esc(o.fill) : "none";
      return `<g id="${id}" transform="translate(${o.x} ${o.y})${o.rotation ? ` rotate(${o.rotation} ${o.w / 2} ${o.h / 2})` : ""}" opacity="${op}"><path d="${esc(d)}" fill="${showFill}" stroke="${esc(o.stroke)}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/></g>`;
    }
    case "polygon": {
      const w = clampW(o.w), h = clampW(o.h);
      const sw = o.stroke === "none" ? 0 : o.strokeWidth;
      const pts = polygonPoints(o.x + o.w / 2, o.y + o.h / 2, Math.max(0, w / 2), Math.max(0, h / 2), o.sides);
      return `<g id="${id}"${tr} opacity="${op}"><polygon points="${pts}" fill="${esc(o.fill)}" stroke="${esc(o.stroke)}" stroke-width="${sw}" stroke-linejoin="round"/></g>`;
    }
    case "star": {
      const w = clampW(o.w), h = clampW(o.h);
      const sw = o.stroke === "none" ? 0 : o.strokeWidth;
      const pts = starPoints(o.x + o.w / 2, o.y + o.h / 2, Math.max(0, w / 2), Math.max(0, h / 2), o.points, o.innerRatio);
      return `<g id="${id}"${tr} opacity="${op}"><polygon points="${pts}" fill="${esc(o.fill)}" stroke="${esc(o.stroke)}" stroke-width="${sw}" stroke-linejoin="round"/></g>`;
    }
    case "image": {
      const w = Math.max(1, o.w), h = Math.max(1, o.h);
      return `<g id="${id}"${tr} opacity="${op}"><image href="${esc(o.src)}" xlink:href="${esc(o.src)}" x="${o.x}" y="${o.y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/></g>`;
    }
  }
}

export interface PageBounds { w: number; h: number }

function boundsOf(objects: VecObject[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const corners = (o: VecObject): { x: number; y: number }[] => {
    const pts = [
      { x: o.x, y: o.y },
      { x: o.x + o.w, y: o.y },
      { x: o.x + o.w, y: o.y + o.h },
      { x: o.x, y: o.y + o.h },
    ];
    if (!o.rotation) return pts;
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    const a = (o.rotation * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    return pts.map((p) => ({
      x: cx + (p.x - cx) * cos - (p.y - cy) * sin,
      y: cy + (p.x - cx) * sin + (p.y - cy) * cos,
    }));
  };
  for (const o of objects) {
    for (const p of corners(o)) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
  }
  if (!isFinite(x0)) return { x: -500, y: -500, w: 1000, h: 1000 };
  const pad = 40;
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}

export function objectsToSVG(objects: VecObject[], page?: PageBounds): string {
  const live = objects.filter((o) => !o.hidden && !o.guide);
  const body = live.map(node).join("\n");
  if (!page) {
    const b = boundsOf(live);
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${b.x} ${b.y} ${b.w} ${b.h}" width="${Math.max(1, Math.round(b.w))}" height="${Math.max(1, Math.round(b.h))}">\n${body}\n</svg>`;
  }
  // page is centered at world origin: shift so page top-left lands on (0,0).
  // bleed outside the page is clipped out of the file (canvas still shows it).
  const clipId = `vl-page-${Math.random().toString(36).slice(2, 8)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${page.w} ${page.h}" width="${page.w}" height="${page.h}">\n<defs><clipPath id="${clipId}"><rect x="0" y="0" width="${page.w}" height="${page.h}"/></clipPath></defs>\n<g clip-path="url(#${clipId})"><rect x="0" y="0" width="${page.w}" height="${page.h}" fill="#ffffff"/><g transform="translate(${page.w / 2} ${page.h / 2})">\n${body}\n</g></g>\n</svg>`;
}

export function downloadSVG(objects: VecObject[], page?: PageBounds) {
  const blob = new Blob([objectsToSVG(objects, page)], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "vectoline.svg";
  // Firefox/Safari require the anchor in the DOM for the click to land
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
