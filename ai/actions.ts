import { useDoc } from "../store/doc";
import { uid, sanitizeCreation, isClosedPath } from "../canvas/types";
import { layoutText, measureTextBlock, nearestWeight, FONTS } from "../canvas/text";
import { presetById } from "../canvas/templates";
import type { CanvasAction } from "./client";
import type { VecObject } from "../canvas/types";

const HEX = /^#[0-9a-f]{6}$/;

function flash(m: string) {
  useDoc.setState({ jimooError: m });
  setTimeout(() => useDoc.setState({ jimooError: "" }), 3000);
}

export interface AgentCtx {
  /** ids created by this project loop — only these are deletable in strict mode */
  projectIds: Set<string>;
  /** true inside a project loop (strict guards), false for single-turn edits */
  strict: boolean;
}

/** Map summary refs (stable ids preferred, live indexes fallback) to live ids. Stale drop. */
export function resolveRefs(refs: (number | string)[] | undefined): string[] {
  const st = useDoc.getState();
  if (!refs || refs.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string | number>();
  const byId = new Map(st.objects.map((o) => [o.id, o]));
  for (const r of refs) {
    if (typeof r === "string") {
      if (seen.has(r)) continue;
      seen.add(r);
      const o = byId.get(r);
      if (o && !o.locked && !o.hidden) out.push(o.id);
      continue;
    }
    if (!Number.isInteger(r) || r < 0 || seen.has(r)) continue;
    seen.add(r);
    const o = st.objects[r];
    if (o && !o.locked && !o.hidden) out.push(o.id);
  }
  return out;
}

const num = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

function buildObject(
  a: Extract<CanvasAction, { op: "add" }>,
  st: ReturnType<typeof useDoc.getState>
): VecObject | null {
  if (st.objects.length >= 2000) {
    flash("canvas is full (2000 objects max)");
    return null;
  }
  const n = st.objects.length + 1;
  const paint = sanitizeCreation(
    typeof a.fill === "string" && HEX.test(a.fill) ? a.fill : st.fill,
    a.stroke === "none" ? "none" : typeof a.stroke === "string" && HEX.test(a.stroke) ? a.stroke : st.stroke,
    num(a.strokeWidth, 0, 64) ? a.strokeWidth : st.strokeWidth,
    a.kind === "text" ? "text" : "shape"
  );
  const base = {
    id: uid(),
    x: Number.isFinite(a.x) ? Math.round(a.x) : 0,
    y: Number.isFinite(a.y) ? Math.round(a.y) : 0,
    w: Number.isFinite(a.w) ? Math.max(2, Math.round(a.w)) : 80,
    h: Number.isFinite(a.h) ? Math.max(2, Math.round(a.h)) : 40,
    rotation: num(a.rotation, -360, 360) ? Math.round(a.rotation * 10) / 10 : 0,
    fill: paint.fill,
    stroke: paint.stroke,
    strokeWidth: paint.strokeWidth,
    opacity: num(a.opacity, 0, 100) ? Math.round(a.opacity) : st.opacity,
  };
  let obj: VecObject;
  if (a.kind === "text") {
    const text = (a.text ?? "Hello").slice(0, 120);
    const fontFamily =
      typeof a.fontFamily === "string" && FONTS.some((f) => f.key === a.fontFamily)
        ? a.fontFamily
        : st.textFont;
    const fontSize = num(a.fontSize, 8, 400) ? Math.round(a.fontSize) : st.toolOpts.textSize;
    const fontWeight = num(a.fontWeight, 100, 900)
      ? nearestWeight(fontFamily, a.fontWeight)
      : nearestWeight(fontFamily, 500);
    const wrapW = a.wrapW == null ? null : Math.max(40, Math.round(a.wrapW));
    const lines = layoutText(text, fontSize, fontWeight, fontFamily, wrapW);
    const m = measureTextBlock({ lines, fontSize, fontWeight, fontFamily });
    obj = {
      ...base, name: `text ${n}`, kind: "text", text, lines,
      wrapW, fontSize, fontWeight, fontFamily,
    };
    obj.w = Math.max(20, Math.round(m.w));
    obj.h = Math.max(10, Math.round(m.h));
  } else if (a.kind === "ellipse") {
    obj = { ...base, name: `ellipse ${n}`, kind: "ellipse" };
  } else if (a.kind === "line") {
    obj = { ...base, name: `line ${n}`, kind: "line" };
  } else if (a.kind === "polygon") {
    const sides = num(a.sides, 3, 24) ? Math.round(a.sides) : st.toolOpts.polySides;
    obj = { ...base, name: `polygon ${n}`, kind: "polygon", sides };
  } else if (a.kind === "star") {
    const points = num(a.points, 3, 24) ? Math.round(a.points) : st.toolOpts.starPoints;
    obj = { ...base, name: `star ${n}`, kind: "star", points, innerRatio: 0.45 };
  } else {
    const rx = num(a.rx, 0, 500) ? Math.round(a.rx) : 0;
    obj = { ...base, name: `rect ${n}`, kind: "rect", rx };
  }
  return obj;
}

/** Temporarily select ids, run a selection-based store op, restore selection. */
function withSelection<T>(ids: string[], fn: () => T): T {
  const st = useDoc.getState();
  const prev = st.selection;
  st.setSelection(ids);
  try {
    return fn();
  } finally {
    useDoc.getState().setSelection(prev);
  }
}

/** Apply one validated agent batch. Returns applied count.
 *  Project loops squash history at done (see loop driver); single-turn
 *  batches keep today's per-op history semantics. */
export function applyAgentActions(
  actions: CanvasAction[] | undefined,
  ctx?: Partial<AgentCtx>
): number {
  if (!actions || actions.length === 0) return 0;
  const st = useDoc.getState();
  const strict = ctx?.strict ?? false;
  const projectIds = ctx?.projectIds;
  const liveOps = actions.filter(
    (a) => a.op === "move" || a.op === "style" || a.op === "transform"
  );
  if (liveOps.length > 0) {
    const hasRefOps = liveOps.some(
      (a) => (a.op === "move" || a.op === "style" || a.op === "transform") && (a.refs?.length ?? 0) > 0
    );
    const needsSelection = liveOps.some(
      (a) => a.op === "move" && !(a.refs?.length)
    );
    if (needsSelection && st.selection.length === 0 && !hasRefOps) {
      flash("nothing selected — select objects first");
      return 0;
    }
    st.checkpoint();
  }
  let applied = 0;
  for (const a of actions) {
    switch (a.op) {
      case "suggestPalette": {
        const colors = a.colors.filter((c) => HEX.test(c)).slice(0, 6);
        if (colors.length >= 3) {
          st.setJimooPalette(colors);
          applied++;
        }
        break;
      }
      case "newProject":
        // intercepted by the loop driver (fresh-canvas gate); never applied here
        break;
      case "setPage": {
        const p = presetById(a.presetId);
        if (!p) break;
        if (!st.gestureActive) st.checkpoint();
        st.setPage({ w: p.w, h: p.h, name: p.name, presetId: p.id });
        applied++;
        break;
      }
      case "add": {
        const obj = buildObject(a, useDoc.getState());
        if (!obj) break;
        useDoc.getState().addObject(obj);
        projectIds?.add(obj.id);
        applied++;
        break;
      }
      case "move": {
        const ids = a.refs?.length ? resolveRefs(a.refs) : [];
        if (a.refs?.length && ids.length === 0) break;
        if (!num(a.dx, -2000, 2000) || !num(a.dy, -2000, 2000)) break;
        if (ids.length > 0) {
          withSelection(ids, () =>
            useDoc.getState().moveSelection(Math.round(a.dx), Math.round(a.dy))
          );
        } else {
          st.moveSelection(Math.round(a.dx), Math.round(a.dy));
        }
        applied++;
        break;
      }
      case "style": {
        const ids = resolveRefs(a.refs);
        if (ids.length === 0) break;
        const patch: Record<string, unknown> = {};
        if (typeof a.fill === "string" && (HEX.test(a.fill) || a.fill === "transparent")) patch.fill = a.fill;
        if (typeof a.stroke === "string" && (HEX.test(a.stroke) || a.stroke === "none" || a.stroke === "transparent")) {
          patch.stroke = a.stroke;
          if (a.stroke !== "none" && num(a.strokeWidth, 0, 64)) patch.strokeWidth = a.strokeWidth;
        } else if (num(a.strokeWidth, 0, 64)) {
          patch.strokeWidth = a.strokeWidth;
        }
        if (num(a.opacity, 0, 100)) patch.opacity = Math.round(a.opacity);
        if (num(a.fontSize, 8, 400)) patch.fontSize = Math.round(a.fontSize);
        if (typeof a.fontFamily === "string" && FONTS.some((f) => f.key === a.fontFamily)) {
          patch.fontFamily = a.fontFamily;
          if (num(a.fontWeight, 100, 900)) patch.fontWeight = nearestWeight(a.fontFamily, a.fontWeight);
        }
        if (Object.keys(patch).length === 0) break;
        const cur = useDoc.getState();
        for (const id of ids) {
          const o = cur.objects.find((x) => x.id === id);
          if (!o || o.kind === "image") continue;
          if (o.kind === "line" && patch.fill) continue; // lines have no fill
          if ((o.kind === "path" && !isClosedPath(o.d ?? "")) && patch.fill && !patch.stroke) continue;
          cur.updateObject(id, patch as Partial<VecObject>);
        }
        applied++;
        break;
      }
      case "transform": {
        const ids = resolveRefs(a.refs);
        if (ids.length === 0) break;
        const cur = useDoc.getState();
        let touched = false;
        for (const id of ids) {
          const o = cur.objects.find((x) => x.id === id);
          if (!o) continue;
          const p: Partial<VecObject> = {};
          if (num(a.dx, -100000, 100000) || num(a.dy, -100000, 100000)) {
            if (num(a.dx, -100000, 100000)) p.x = Math.round(o.x + (a.dx ?? 0));
            if (num(a.dy, -100000, 100000)) p.y = Math.round(o.y + (a.dy ?? 0));
          }
          if (num(a.w, 1, 10000)) p.w = Math.round(a.w);
          if (num(a.h, 1, 10000)) p.h = Math.round(a.h);
          if (num(a.rotation, -3600, 3600)) p.rotation = Math.round(a.rotation * 10) / 10;
          if (Object.keys(p).length > 0) {
            cur.updateObject(id, p);
            touched = true;
          }
        }
        if (touched) applied++;
        break;
      }
      case "arrange": {
        const ids = a.refs?.length ? resolveRefs(a.refs) : [];
        if (a.refs?.length && ids.length === 0) break;
        const run = () => {
          const s = useDoc.getState();
          if (a.to === "front") s.bringToFront();
          else if (a.to === "back") s.sendToBack();
          if (a.align) s.alignSelection(a.align);
          if (a.distribute) s.distributeSelection(a.distribute);
        };
        if (ids.length > 0) withSelection(ids, run);
        else run();
        applied++;
        break;
      }
      case "align":
        st.alignSelection(a.mode);
        applied++;
        break;
      case "distribute":
        st.distributeSelection(a.axis);
        applied++;
        break;
      case "select": {
        const ids = resolveRefs(a.refs);
        st.setSelection(ids);
        applied++;
        break;
      }
      case "duplicate":
      case "duplicateSelection": {
        if (a.op === "duplicate") {
          const ids = resolveRefs(a.refs);
          if (ids.length === 0) break;
          const duped = withSelection(ids, () => {
            useDoc.getState().duplicateSelection();
            return useDoc.getState().selection;
          });
          duped.forEach((id) => projectIds?.add(id));
        } else {
          const before = new Set(useDoc.getState().objects.map((o) => o.id));
          st.duplicateSelection();
          useDoc.getState().objects.forEach((o) => {
            if (!before.has(o.id)) projectIds?.add(o.id);
          });
        }
        applied++;
        break;
      }
      case "delete":
      case "deleteSelection": {
        if (strict && projectIds) {
          const ids =
            a.op === "delete" ? resolveRefs(a.refs) : [...useDoc.getState().selection];
          const foreign = ids.filter((id) => !projectIds.has(id));
          if (foreign.length > 0) {
            flash("Jimoo only deletes its own objects — delete the rest yourself");
            break;
          }
          if (ids.length === 0) break;
          withSelection(ids, () => useDoc.getState().deleteSelection());
        } else if (a.op === "delete") {
          const ids = resolveRefs(a.refs);
          if (ids.length === 0) break;
          withSelection(ids, () => useDoc.getState().deleteSelection());
        } else {
          st.deleteSelection();
        }
        applied++;
        break;
      }
    }
  }
  return applied;
}
