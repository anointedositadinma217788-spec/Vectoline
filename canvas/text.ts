import type { TextObj, TextSpan } from "./types";

export const LINE_H = 1.2;

export interface FontDef {
  key: string; // stored on TextObj.fontFamily
  label: string; // picker label
  css: string; // CSS font-family stack
  weights: number[]; // imported @fontsource weights (ascending)
}

/** Fonts bundled via @fontsource (imports in index.css). Registry weights
 *  must exactly match the imported weight files. */
export const FONTS: FontDef[] = [
  { key: "Space Grotesk", label: "Space Grotesk", css: "'Space Grotesk', sans-serif", weights: [300, 400, 500, 600, 700] },
  { key: "Inter", label: "Inter", css: "'Inter', sans-serif", weights: [400, 500, 600, 700, 800, 900] },
  { key: "Playfair Display", label: "Playfair Display", css: "'Playfair Display', serif", weights: [400, 500, 600, 700, 800, 900] },
  { key: "Bebas Neue", label: "Bebas Neue", css: "'Bebas Neue', sans-serif", weights: [400] },
  { key: "Oswald", label: "Oswald", css: "'Oswald', sans-serif", weights: [200, 300, 400, 500, 600, 700] },
  { key: "Merriweather", label: "Merriweather", css: "'Merriweather', serif", weights: [300, 400, 700, 900] },
  { key: "Lobster", label: "Lobster", css: "'Lobster', cursive", weights: [400] },
  { key: "JetBrains Mono", label: "JetBrains Mono", css: "'JetBrains Mono', monospace", weights: [400, 500, 700] },
];

export const DEFAULT_FONT = "Space Grotesk";

export function fontCss(family: string): string {
  return FONTS.find((f) => f.key === family)?.css ?? FONTS[0].css;
}

export function fontWeights(family: string): number[] {
  return FONTS.find((f) => f.key === family)?.weights ?? FONTS[0].weights;
}

/** Snap to the closest weight a family actually ships (used when switching fonts). */
export function nearestWeight(family: string, want: number): number {
  const ws = fontWeights(family);
  let best = ws[0];
  for (const w of ws) {
    if (Math.abs(w - want) < Math.abs(best - want)) best = w;
  }
  return best;
}

export function textFont(
  o: Pick<TextObj, "fontSize" | "fontWeight" | "fontFamily">
): string {
  return `${o.fontWeight} ${o.fontSize}px ${fontCss(o.fontFamily)}`;
}

let measureCtx: CanvasRenderingContext2D | null = null;

export function measureLineWidth(
  line: string, fontSize: number, fontWeight: number, fontFamily: string
): number {
  if (!line) return 0;
  try {
    if (!measureCtx) {
      const c = document.createElement("canvas");
      measureCtx = c.getContext("2d");
    }
    if (measureCtx) {
      measureCtx.font = `${fontWeight} ${fontSize}px ${fontCss(fontFamily)}`;
      return measureCtx.measureText(line).width;
    }
  } catch {
    // non-DOM environment: fall through to estimate
  }
  return line.length * fontSize * 0.55;
}

/** Split raw text into laid-out lines, word-wrapping at wrapW when set. */
export function layoutText(
  raw: string, fontSize: number, fontWeight: number, fontFamily: string, wrapW: number | null
): string[] {
  const paras = raw.split("\n");
  if (wrapW == null) return paras.length ? paras : [""];
  const out: string[] = [];
  for (const p of paras) {
    if (!p) {
      out.push("");
      continue;
    }
    const words = p.split(/\s+/);
    let line = "";
    for (const w of words) {
      const trial = line ? `${line} ${w}` : w;
      if (!line || measureLineWidth(trial, fontSize, fontWeight, fontFamily) <= wrapW) {
        line = trial;
      } else {
        out.push(line);
        line = w;
      }
    }
    out.push(line);
  }
  return out.length ? out : [""];
}

/** Raw-text index where each laid-out line begins. Lets character spans
 *  (TextObj.spans, indexed over the raw text) map onto rendered lines.
 *  Walks the characters each line consumed: newline after paragraph
 *  splits, collapsed whitespace runs after wraps. */
export function lineStarts(raw: string, lines: string[]): number[] {
  const starts: number[] = [];
  let pos = 0;
  for (const l of lines) {
    starts.push(pos);
    pos += l.length;
    if (pos < raw.length) {
      if (raw[pos] === "\n") pos += 1;
      else while (pos < raw.length && /\s/.test(raw[pos])) pos += 1;
    }
  }
  return starts;
}

export function measureTextBlock(
  o: Pick<TextObj, "lines" | "fontSize" | "fontWeight" | "fontFamily">
): { w: number; h: number } {
  const lines = o.lines.length ? o.lines : [""];
  const w = Math.max(1, ...lines.map((l) => measureLineWidth(l, o.fontSize, o.fontWeight, o.fontFamily)));
  return { w: Math.ceil(w), h: Math.ceil(lines.length * o.fontSize * LINE_H) };
}

/** Recompute lines + w/h after a text/size/weight/font/wrap edit. Returns a patch. */
export function syncTextBox(
  o: Pick<TextObj, "text" | "lines" | "wrapW" | "fontSize" | "fontWeight" | "fontFamily">
): { lines: string[]; w: number; h: number } {
  const lines = layoutText(o.text, o.fontSize, o.fontWeight, o.fontFamily, o.wrapW);
  const { w, h } = measureTextBlock({
    lines, fontSize: o.fontSize, fontWeight: o.fontWeight, fontFamily: o.fontFamily,
  });
  return { lines, w, h };
}

// ---------- per-letter style spans (TextObj.spans) ----------

export type SpanPatch = Partial<Pick<TextSpan, "fill" | "fontWeight" | "fontSize" | "fontFamily">>;

/** Clamp spans to the text length and drop degenerate ranges. */
export function normalizeSpans(
  spans: TextSpan[] | undefined, len: number
): TextSpan[] | undefined {
  if (!spans || spans.length === 0) return undefined;
  const out = spans
    .map((sp) => ({
      ...sp,
      start: Math.max(0, Math.min(sp.start, len)),
      end: Math.max(0, Math.min(sp.end, len)),
    }))
    .filter((sp) => sp.end > sp.start)
    .sort((a, b) => a.start - b.start);
  return out.length > 0 ? out : undefined;
}

/** Style the character range [start, end): overlapping spans are split,
 *  the range gets `patch`, untouched fragments keep their overrides.
 *  Props left undefined in the patch inherit the text object's values. */
export function applySpanStyle(
  spans: TextSpan[] | undefined, start: number, end: number, patch: SpanPatch
): TextSpan[] {
  const s0 = Math.max(0, Math.min(start, end));
  const e0 = Math.max(s0, end);
  if (e0 <= s0) return spans ?? [];
  const out: TextSpan[] = [];
  const sorted = [...(spans ?? [])].sort((a, b) => a.start - b.start);
  for (const sp of sorted) {
    const s = Math.max(0, sp.start), e = Math.max(s, sp.end);
    if (e <= s0 || s >= e0) {
      out.push({ ...sp, start: s, end: e }); // outside the styled range
      continue;
    }
    if (s < s0) out.push({ ...sp, start: s, end: s0 }); // untouched head
    if (e > e0) out.push({ ...sp, start: e0, end: e }); // untouched tail
    // fragments inside [s0, e0) are replaced by the styled span below
  }
  out.push({ ...patch, start: s0, end: e0 } as TextSpan);
  return out.sort((a, b) => a.start - b.start);
}

/** Shift span boundaries after an inline text edit: spans keep styling the
 *  same characters across insertions/deletions at the caret. */
export function remapSpansAfterEdit(
  spans: TextSpan[] | undefined, oldText: string, newText: string
): TextSpan[] | undefined {
  if (!spans || spans.length === 0) return undefined;
  const minLen = Math.min(oldText.length, newText.length);
  let p = 0;
  while (p < minLen && oldText[p] === newText[p]) p++;
  let s = 0;
  while (
    s < minLen - p &&
    oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]
  ) {
    s++;
  }
  const delta = newText.length - oldText.length;
  const editStart = p, editEndOld = oldText.length - s, editEndNew = newText.length - s;
  const mapPt = (b: number, isEnd: boolean) =>
    b <= editStart ? b : b >= editEndOld ? b + delta : isEnd ? editEndNew : editStart;
  const out = spans
    .map((sp) => ({ ...sp, start: mapPt(sp.start, false), end: mapPt(sp.end, true) }))
    .filter((sp) => sp.end > sp.start)
    .sort((a, b) => a.start - b.start);
  return out.length > 0 ? out : undefined;
}

/** One rendered run inside a laid-out line: the text slice plus whichever
 *  span overrides apply (null = inherit the text object's values). */
export interface SpanRun {
  text: string;
  style: SpanPatch | null;
}

/** Split a laid-out line into styled runs. `lineStart` is the raw-text index
 *  where the line begins (see lineStarts). */
export function styledRuns(line: string, lineStart: number, spans: TextSpan[]): SpanRun[] {
  if (!spans || spans.length === 0 || !line) return [{ text: line, style: null }];
  const relevant = spans
    .filter((sp) => sp.end > lineStart && sp.start < lineStart + line.length)
    .sort((a, b) => a.start - b.start);
  if (relevant.length === 0) return [{ text: line, style: null }];
  const runs: SpanRun[] = [];
  let pos = 0; // index within the line
  for (const sp of relevant) {
    const s = Math.max(0, sp.start - lineStart);
    const e = Math.min(line.length, sp.end - lineStart);
    if (e <= s) continue;
    if (s > pos) runs.push({ text: line.slice(pos, s), style: null });
    const style: SpanPatch = {};
    if (sp.fill !== undefined) style.fill = sp.fill;
    if (sp.fontWeight !== undefined) style.fontWeight = sp.fontWeight;
    if (sp.fontSize !== undefined) style.fontSize = sp.fontSize;
    if (sp.fontFamily !== undefined) style.fontFamily = fontCss(sp.fontFamily);
    runs.push({
      text: line.slice(s, e),
      style: Object.keys(style).length > 0 ? style : null,
    });
    pos = e;
  }
  if (pos < line.length) runs.push({ text: line.slice(pos), style: null });
  return runs;
}
