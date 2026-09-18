import { useDoc } from "../store/doc";

export interface CanvasObjectView {
  i: number;
  id: string;
  kind: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  locked: boolean;
  hidden: boolean;
  // text-only extras
  text?: string;
  fontFamily?: string;
  fontSize?: number;
}

export interface CanvasIssue {
  type: "off-page" | "overlap" | "contrast";
  /** summary indexes (objects[].i) of the involved objects */
  refs: number[];
  note: string;
}

export interface CanvasSummary {
  page: { w: number; h: number; name: string; presetId: string };
  count: number;
  kinds: Record<string, number>;
  selection: { kind: string; x: number; y: number; w: number; h: number; rotation: number }[];
  selCount: number;
  selIdx: number[];
  recents: string[];
  /** Layer order = array order. Capped at 60 (project objects prioritized,
   *  then newest; whole objects only). */
  objects: CanvasObjectView[];
  truncated: boolean;
  droppedCount?: number;
  /** self-audit: layout problems the brain should fix in its next round */
  issues?: CanvasIssue[];
}

const MAX_OBJECTS = 60;

const lum = (hex: string): number | null => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};

/** Self-audit for the brain: off-page text, text-on-text overlap, low-contrast
 *  text. Deliberately conservative (only clear mistakes), capped at 8. */
function auditIssues(objs: CanvasObjectView[], pageW: number, pageH: number): CanvasIssue[] {
  const issues: CanvasIssue[] = [];
  const halfW = pageW / 2;
  const halfH = pageH / 2;
  const visible = objs.filter((o) => !o.hidden && !o.locked);
  for (const o of visible) {
    if (o.kind !== "text") continue;
    const outside =
      o.x < -halfW - 2 || o.y < -halfH - 2 || o.x + o.w > halfW + 2 || o.y + o.h > halfH + 2;
    if (outside) {
      issues.push({ type: "off-page", refs: [o.i], note: `text "${(o.text ?? "").slice(0, 24)}" extends past the page edges` });
    }
  }
  const texts = visible.filter((o) => o.kind === "text");
  for (let a = 0; a < texts.length; a++) {
    for (let b = a + 1; b < texts.length; b++) {
      const A = texts[a];
      const B = texts[b];
      const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
      const oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
      if (ox <= 0 || oy <= 0) continue;
      const inter = ox * oy;
      const smaller = Math.min(A.w * A.h, B.w * B.h);
      if (smaller > 0 && inter / smaller > 0.35) {
        issues.push({ type: "overlap", refs: [A.i, B.i], note: `texts "${A.text?.slice(0, 16)}" and "${B.text?.slice(0, 16)}" overlap` });
      }
    }
  }
  const shapes = visible.filter((o) => o.kind !== "text" && o.fill !== "transparent" && o.opacity >= 80);
  for (const t of texts) {
    const tLum = lum(t.fill);
    if (tLum == null) continue;
    const cx = t.x + t.w / 2;
    const cy = t.y + t.h / 2;
    let bgLum: number | null = null;
    let bgRef = -1;
    for (let k = objs.length - 1; k >= 0; k--) {
      const s = objs[k];
      if (s.i >= t.i || s.hidden || s.locked) continue;
      if (s.kind === "text" || s.fill === "transparent" || s.opacity < 80) continue;
      if (cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h) {
        const l = lum(s.fill);
        if (l != null) {
          bgLum = l;
          bgRef = s.i;
        }
        break;
      }
    }
    const eff = bgLum ?? 1; // nothing under = white paper
    if (bgLum == null && t.i > 0) continue; // only flag page-bg cases when nothing found at all
    if (Math.abs(tLum - eff) < 0.14) {
      issues.push({
        type: "contrast",
        refs: bgRef >= 0 ? [t.i, bgRef] : [t.i],
        note: `text "${(t.text ?? "").slice(0, 24)}" has low contrast on its background`,
      });
    }
  }
  return issues.slice(0, 8);
}

/** Sighted canvas snapshot for the agent brain. The model addresses
 *  objects by their index `i` (refs); the client maps to live ids fresh
 *  every round. Image bytes never leave: images contribute metadata only. */
export function buildCanvasSummary(): CanvasSummary {
  const st = useDoc.getState();
  const kinds: Record<string, number> = {};
  for (const o of st.objects) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
  const selSet = new Set(st.selection);
  const sel = st.objects
    .filter((o) => selSet.has(o.id))
    .slice(0, 50)
    .map((o) => ({
      kind: o.kind,
      x: Math.round(o.x),
      y: Math.round(o.y),
      w: Math.round(o.w),
      h: Math.round(o.h),
      rotation: o.rotation,
    }));
  const selIdx: number[] = [];
  st.objects.forEach((o, i) => {
    if (selSet.has(o.id)) selIdx.push(i);
  });
  const pool = st.objects.length > MAX_OBJECTS ? st.objects.slice(-MAX_OBJECTS) : st.objects;
  const base = st.objects.length - pool.length; // index offset for refs
  const droppedCount = st.objects.length - pool.length;
  const objects: CanvasObjectView[] = pool.map((o, k) => {
    const v: CanvasObjectView = {
      i: base + k,
      id: o.id,
      kind: o.kind,
      name: o.name.slice(0, 40),
      x: Math.round(o.x),
      y: Math.round(o.y),
      w: Math.round(o.w),
      h: Math.round(o.h),
      rotation: o.rotation,
      fill: String(o.fill).slice(0, 24),
      stroke: String(o.stroke).slice(0, 24),
      strokeWidth: o.strokeWidth,
      opacity: o.opacity,
      locked: !!o.locked,
      hidden: !!o.hidden,
    };
    if (o.kind === "text") {
      v.text = o.text.slice(0, 60);
      v.fontFamily = o.fontFamily;
      v.fontSize = Math.round(o.fontSize);
    }
    return v;
  });
  const isHex = (v: string) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
  return {
    page: { w: st.page.w, h: st.page.h, name: st.page.name, presetId: st.page.presetId },
    count: st.objects.length,
    kinds,
    selection: sel,
    selCount: st.selection.length,
    selIdx: selIdx.slice(0, 50),
    recents: st.recents.filter(isHex).slice(0, 6),
    objects,
    truncated: droppedCount > 0,
    droppedCount,
  };
}
