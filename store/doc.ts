import { create } from "zustand";
import type { VecObject, TextObj } from "../canvas/types";
import { uid, isClosedPath } from "../canvas/types";
import { DEFAULT_FONT, FONTS, nearestWeight } from "../canvas/text";

export type ToolId =
  | "move" | "zoom" | "pen" | "bezier" | "line" | "rect" | "ellipse"
  | "polygon" | "star" | "spiral" | "text" | "image"
  | "break" | "node" | "eraser" | "eye";

export interface Camera { x: number; y: number; zoom: number }

export interface Page { w: number; h: number; name: string; presetId: string }

export interface ToolOpts {
  rectRx: number;
  polySides: number;
  starPoints: number;
  spiralTurns: number;
  textSize: number;
  eraserSize: number;
}

export type AlignMode = "left" | "centerX" | "right" | "top" | "centerY" | "bottom";

const HISTORY_LIMIT = 50;

interface DocState {
  tool: ToolId;
  camera: Camera;
  cursor: { x: number; y: number };
  objects: VecObject[];
  selection: string[];
  past: VecObject[][];
  future: VecObject[][];
  pastPage: Page[];
  futurePage: Page[];
  // color bar state
  colorTarget: "fill" | "stroke";
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  // font used for newly placed text (font key from FONTS registry)
  textFont: string;
  setTextFont: (f: string) => void;
  recents: string[];
  jimooPalette: string[];
  jimooError: string;
  setJimooError: (m: string) => void;
  // page (white design canvas)
  page: Page;
  setPage: (p: Partial<Page>) => void;
  newDoc: () => void;
  applyTemplate: (page: Page, objects: VecObject[]) => void;
  /** Agent project commit: append (or replace-all when fresh) objects plus
   *  an optional page swap in exactly ONE history step. Selection = new ids. */
  commitProject: (page: Page | null, objects: VecObject[], fresh: boolean) => void;
  loadDoc: (page: Page, objects: VecObject[]) => void;
  dirty: boolean;
  setDirty: (v: boolean) => void;
  markClean: () => void;
  // per-tool creation options
  toolOpts: ToolOpts;
  setToolOpt: (k: keyof ToolOpts, v: number) => void;
  // arrange actions push their own history, and only when something changed
  alignSelection: (mode: AlignMode) => void;
  distributeSelection: (axis: "x" | "y") => void;
  // rail flyout memory: group id -> last used tool
  railMemory: Record<string, ToolId>;
  rememberTool: (group: string, t: ToolId) => void;

  setTool: (t: ToolId) => void;
  setCamera: (c: Partial<Camera>) => void;
  panBy: (dx: number, dy: number) => void;
  zoomAt: (sx: number, sy: number, factor: number) => void;
  resetCamera: () => void;
  setCursor: (x: number, y: number) => void;

  addObject: (o: VecObject) => void;
  updateObject: (id: string, patch: Partial<VecObject>) => void;
  deleteSelection: () => void;
  duplicateSelection: () => void;
  // context-menu actions (each owns its own history step)
  bringToFront: () => void;
  sendToBack: () => void;
  selectAll: () => void;
  setSelection: (ids: string[]) => void;
  toggleSelect: (id: string) => void;
  clearSelection: () => void;
  moveSelection: (dx: number, dy: number) => void;
  checkpoint: () => void;
  squashProjectHistory: (keep: number) => void;
  pushHistory: (snapshot: VecObject[]) => void;
  // true while a transform gesture (move/resize/rotate/node/handle) is in
  // flight: color inputs join the gesture's undo step instead of pushing
  gestureActive: boolean;
  setGestureActive: (v: boolean) => void;
  // rotate-handle mode for the move tool (double-click or options bar)
  rotateMode: boolean;
  setRotateMode: (v: boolean) => void;
  // node tool: show bezier handles for every node, not only selected/hovered
  nodeHandlesAll: boolean;
  setNodeHandlesAll: (v: boolean) => void;
  // node tool: selected nodes published for the options bar readout/editors
  nodeSelInfo: { objId: string; idx: number[] } | null;
  setNodeSelInfo: (v: { objId: string; idx: number[] } | null) => void;
  // node tool: magnetic snapping (grid + other nodes' nodes)
  nodeSnap: boolean;
  setNodeSnap: (v: boolean) => void;
  undo: () => void;
  redo: () => void;

  setColorTarget: (t: "fill" | "stroke") => void;
  applyColor: (hex: string) => void;
  clearOutline: () => void;
  setOpacity: (v: number) => void;
  setStrokeWidth: (v: number) => void;
  setJimooPalette: (colors: string[]) => void;
}

const deepClone = <T>(v: T): T => {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v));
  }
};

const clone = (o: VecObject[]): VecObject[] => deepClone(o);

/** Text objects from older saves may predate fontFamily/spans: fill in
 *  defaults, snap weights to what the family actually ships, and clamp
 *  spans to the current text length so rendering can never index out. */
const normalizeText = (o: TextObj): TextObj => {
  const known = typeof o.fontFamily === "string" && FONTS.some((f) => f.key === o.fontFamily);
  const family = known ? (o.fontFamily as string) : DEFAULT_FONT;
  const spans = Array.isArray(o.spans)
    ? o.spans
        .filter(
          (sp) =>
            Number.isFinite(sp.start) &&
            Number.isFinite(sp.end) &&
            sp.end > sp.start &&
            sp.start >= 0
        )
        .map((sp) => ({
          ...sp,
          start: Math.min(Math.floor(sp.start), o.text.length),
          end: Math.min(Math.floor(sp.end), o.text.length),
        }))
        .filter((sp) => sp.end > sp.start)
    : undefined;
  return {
    ...o,
    fontFamily: family,
    fontWeight: nearestWeight(family, typeof o.fontWeight === "number" ? o.fontWeight : 400),
    ...(spans && spans.length > 0 ? { spans } : { spans: undefined }),
  };
};

const normalizeObjects = (objects: VecObject[]): VecObject[] =>
  objects.map((o) => {
    const base = {
      rotation: typeof o.rotation === "number" && Number.isFinite(o.rotation) ? o.rotation : 0,
      opacity: typeof o.opacity === "number" && Number.isFinite(o.opacity) ? o.opacity : 100,
      strokeWidth:
        typeof o.strokeWidth === "number" && Number.isFinite(o.strokeWidth) ? o.strokeWidth : 2,
      locked: !!o.locked,
      hidden: !!o.hidden,
    };
    if (o.kind === "text") return { ...normalizeText(o), ...base, kind: "text" } as VecObject;
    return { ...o, ...base } as VecObject;
  });

export const useDoc = create<DocState>((set) => ({
  tool: "move",
  camera: { x: 0, y: 0, zoom: 1 },
  cursor: { x: 0, y: 0 },
  objects: [],
  selection: [],
  past: [],
  future: [],
  pastPage: [],
  futurePage: [],
  colorTarget: "fill",
  fill: "#111214",
  stroke: "#00f0ff",
  strokeWidth: 2,
  opacity: 100,
  textFont: DEFAULT_FONT,
  setTextFont: (textFont) => set({ textFont }),
  recents: ["#0a0a0a", "#111214", "#f4f4f4", "#00f0ff", "#7c3aed"],
  jimooPalette: [],
  jimooError: "",
  setJimooError: (jimooError) => set({ jimooError }),
  page: { w: 794, h: 1123, name: "A4", presetId: "a4" },
  setPage: (p) =>
    set((s) => {
      const next = { ...s.page, ...p };
      if (next.w === s.page.w && next.h === s.page.h && next.name === s.page.name && next.presetId === s.page.presetId)
        return s;
      return {
        page: next,
        past: [...s.past, clone(s.objects)].slice(-HISTORY_LIMIT),
        pastPage: [...s.pastPage, { ...s.page }].slice(-HISTORY_LIMIT),
        future: [],
        futurePage: [],
        dirty: true,
      };
    }),
  newDoc: () =>
    set((s) => ({
      objects: [],
      selection: [],
      past: [...s.past, clone(s.objects)].slice(-HISTORY_LIMIT),
      pastPage: [...s.pastPage, { ...s.page }].slice(-HISTORY_LIMIT),
      future: [],
      futurePage: [],
      dirty: true,
    })),
  applyTemplate: (page, objects) =>
    set((s) => ({
      page,
      objects,
      selection: objects.map((o) => o.id),
      past: [...s.past, clone(s.objects)].slice(-HISTORY_LIMIT),
      pastPage: [...s.pastPage, { ...s.page }].slice(-HISTORY_LIMIT),
      future: [],
      futurePage: [],
      dirty: true,
    })),
  commitProject: (page, objects, fresh) =>
    set((s) => ({
      page: page ?? s.page,
      objects: fresh ? objects : [...s.objects, ...objects],
      selection: objects.map((o) => o.id),
      past: [...s.past, clone(s.objects)].slice(-HISTORY_LIMIT),
      pastPage: [...s.pastPage, { ...s.page }].slice(-HISTORY_LIMIT),
      future: [],
      futurePage: [],
      dirty: true,
    })),
  loadDoc: (page, objects) =>
    set(() => ({
      page,
      objects: normalizeObjects(objects),
      selection: [],
      past: [],
      future: [],
      pastPage: [],
      futurePage: [],
      dirty: false,
    })),
  dirty: false,
  setDirty: (dirty) => set({ dirty }),
  markClean: () => set({ dirty: false }),
  toolOpts: { rectRx: 0, polySides: 6, starPoints: 5, spiralTurns: 3, textSize: 32, eraserSize: 14 },
  setToolOpt: (k, v) => set((s) => ({ toolOpts: { ...s.toolOpts, [k]: v } })),
  alignSelection: (mode) =>
    set((s) => {
      const sel = s.objects.filter(
        (o) => s.selection.includes(o.id) && !o.locked && !o.hidden
      );
      if (sel.length < 2) return s;
      const xs = sel.flatMap((o) => [o.x, o.x + o.w]);
      const ys = sel.flatMap((o) => [o.y, o.y + o.h]);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const ids = new Set(sel.map((o) => o.id));
      let changed = false;
      const objects = s.objects.map((o) => {
        if (!ids.has(o.id)) return o;
        let nx = o.x, ny = o.y;
        switch (mode) {
          case "left": nx = minX; break;
          case "centerX": nx = Math.round(minX + (maxX - minX) / 2 - o.w / 2); break;
          case "right": nx = maxX - o.w; break;
          case "top": ny = minY; break;
          case "centerY": ny = Math.round(minY + (maxY - minY) / 2 - o.h / 2); break;
          case "bottom": ny = maxY - o.h; break;
        }
        if (nx !== o.x || ny !== o.y) {
          changed = true;
          return { ...o, x: nx, y: ny };
        }
        return o;
      });
      if (!changed) return s;
      return {
        objects,
        past: [...s.past, clone(s.objects)].slice(-HISTORY_LIMIT),
        pastPage: [...s.pastPage, { ...s.page }].slice(-HISTORY_LIMIT),
        future: [],
        futurePage: [],
      };
    }),
  distributeSelection: (axis) =>
    set((s) => {
      const sel = s.objects.filter(
        (o) => s.selection.includes(o.id) && !o.locked && !o.hidden
      );
      if (sel.length < 3) return s;
      const c = (o: VecObject) => (axis === "x" ? o.x + o.w / 2 : o.y + o.h / 2);
      const sorted = [...sel].sort((a, b) => c(a) - c(b));
      const lo = c(sorted[0]), hi = c(sorted[sorted.length - 1]);
      const step = (hi - lo) / (sorted.length - 1);
      if (step === 0) return s;
      const target = new Map(sorted.map((o, i) => [o.id, Math.round(lo + step * i)]));
      let changed = false;
      const objects = s.objects.map((o) => {
        const t = target.get(o.id);
        if (t === undefined) return o;
        const nn = axis === "x" ? { ...o, x: Math.round(t - o.w / 2) } : { ...o, y: Math.round(t - o.h / 2) };
        if (nn.x !== o.x || nn.y !== o.y) {
          changed = true;
          return nn;
        }
        return o;
      });
      if (!changed) return s;
      return {
        objects,
        past: [...s.past, clone(s.objects)].slice(-HISTORY_LIMIT),
        pastPage: [...s.pastPage, { ...s.page }].slice(-HISTORY_LIMIT),
        future: [],
        futurePage: [],
      };
    }),
  railMemory: {},
  rememberTool: (group, t) =>
    set((s) => ({ railMemory: { ...s.railMemory, [group]: t } })),

  setTool: (tool) => set({ tool }),
  setCamera: (c) => set((s) => ({ camera: { ...s.camera, ...c } })),
  panBy: (dx, dy) =>
    set((s) => ({ camera: { ...s.camera, x: s.camera.x + dx, y: s.camera.y + dy } })),
  zoomAt: (sx, sy, factor) =>
    set((s) => {
      const next = Math.min(8, Math.max(0.1, s.camera.zoom * factor));
      const k = next / s.camera.zoom;
      return {
        camera: {
          zoom: next,
          x: sx - (sx - s.camera.x) * k,
          y: sy - (sy - s.camera.y) * k,
        },
      };
    }),
  resetCamera: () => set({ camera: { x: 0, y: 0, zoom: 1 } }),
  setCursor: (x, y) => set({ cursor: { x, y } }),

  addObject: (o) =>
    set((s) => {
      const ids = new Set(s.objects.map((x) => x.id));
      let id = o.id;
      // ~32-bit short ids can collide on large docs / AI batches — regen
      while (ids.has(id)) id = uid();
      const obj = id === o.id ? o : ({ ...o, id } as VecObject);
      return {
        objects: [...s.objects, obj],
        selection: [obj.id],
        past: [...s.past, clone(s.objects)].slice(-HISTORY_LIMIT),
        pastPage: [...s.pastPage, { ...s.page }].slice(-HISTORY_LIMIT),
        future: [],
        futurePage: [],
      };
    }),
  updateObject: (id, patch) =>
    set((s) => ({
      objects: s.objects.map((o) => (o.id === id ? ({ ...o, ...patch } as VecObject) : o)),
    })),
  deleteSelection: () =>
    set((s) => {
      const ids = new Set(
        s.objects.filter((o) => s.selection.includes(o.id) && !o.locked && !o.hidden).map((o) => o.id)
      );
      if (ids.size === 0) return s;
      const objects = s.objects.filter((o) => !ids.has(o.id));
      const alive = new Set(objects.map((o) => o.id));
      return {
        objects,
        selection: s.selection.filter((id) => alive.has(id)),
        past: [...s.past, clone(s.objects)].slice(-HISTORY_LIMIT),
        pastPage: [...s.pastPage, { ...s.page }].slice(-HISTORY_LIMIT),
        future: [],
        futurePage: [],
      };
    }),
  duplicateSelection: () =>
    set((s) => {
      const src = s.objects.filter(
        (o) => s.selection.includes(o.id) && !o.locked && !o.hidden
      );
      if (src.length === 0) return s;
      const dupes = src.map((o) => {
        const copy = deepClone(o);
        return {
          ...copy,
          id: uid(),
          name: `${o.name} copy`,
          x: o.x + 16,
          y: o.y + 16,
        } as VecObject;
      });
      return {
        objects: [...s.objects, ...dupes],
        selection: dupes.map((d) => d.id),
        past: [...s.past, clone(s.objects)].slice(-HISTORY_LIMIT),
        pastPage: [...s.pastPage, { ...s.page }].slice(-HISTORY_LIMIT),
        future: [],
        futurePage: [],
      };
    }),
  // reordering moves the selection as a block, keeping its internal order
  bringToFront: () =>
    set((s) => {
      const sel = s.objects.filter(
        (o) => s.selection.includes(o.id) && !o.locked && !o.hidden
      );
      if (sel.length === 0) return s;
      const moving = new Set(sel.map((o) => o.id));
      return {
        objects: [...s.objects.filter((o) => !moving.has(o.id)), ...sel],
        past: [...s.past, clone(s.objects)].slice(-HISTORY_LIMIT),
        pastPage: [...s.pastPage, { ...s.page }].slice(-HISTORY_LIMIT),
        future: [],
        futurePage: [],
      };
    }),
  sendToBack: () =>
    set((s) => {
      const sel = s.objects.filter(
        (o) => s.selection.includes(o.id) && !o.locked && !o.hidden
      );
      if (sel.length === 0) return s;
      const moving = new Set(sel.map((o) => o.id));
      return {
        objects: [...sel, ...s.objects.filter((o) => !moving.has(o.id))],
        past: [...s.past, clone(s.objects)].slice(-HISTORY_LIMIT),
        pastPage: [...s.pastPage, { ...s.page }].slice(-HISTORY_LIMIT),
        future: [],
        futurePage: [],
      };
    }),
  selectAll: () =>
    set((s) => ({
      selection: s.objects.filter((o) => !o.locked && !o.hidden).map((o) => o.id),
    })),
  setSelection: (selection) =>
    set((s) => {
      const ids = new Set(s.objects.map((o) => o.id));
      return { selection: selection.filter((id) => ids.has(id)) };
    }),
  toggleSelect: (id) =>
    set((s) => {
      if (!s.objects.some((o) => o.id === id)) return s;
      return {
        selection: s.selection.includes(id)
          ? s.selection.filter((x) => x !== id)
          : [...s.selection, id],
      };
    }),
  clearSelection: () => set({ selection: [] }),
  gestureActive: false,
  setGestureActive: (gestureActive) => set({ gestureActive }),
  rotateMode: false,
  setRotateMode: (rotateMode) =>
    set((s) => (s.rotateMode === rotateMode ? s : { rotateMode })),
  nodeHandlesAll: false,
  setNodeHandlesAll: (nodeHandlesAll) => set({ nodeHandlesAll }),
  nodeSelInfo: null,
  setNodeSelInfo: (nodeSelInfo) => set({ nodeSelInfo }),
  nodeSnap: true,
  setNodeSnap: (nodeSnap) => set({ nodeSnap }),
  checkpoint: () =>
    set((s) => ({
      past: [...s.past, clone(s.objects)].slice(-HISTORY_LIMIT),
      pastPage: [...s.pastPage, { ...s.page }].slice(-HISTORY_LIMIT),
      future: [],
      futurePage: [],
    })),
  // agent loop: collapse every history entry pushed since `keep` into the
  // single pre-project snapshot, so one Ctrl+Z removes the whole project.
  // keep = past.length captured before the loop's first mutation.
  squashProjectHistory: (keep: number) =>
    set((s) => ({
      past: s.past.length > keep ? s.past.slice(0, keep + 1) : s.past,
      pastPage: s.pastPage.length > keep ? s.pastPage.slice(0, keep + 1) : s.pastPage,
      future: [],
      futurePage: [],
    })),
  // push a caller-owned snapshot (gestures that manage their own history)
  pushHistory: (snapshot) =>
    set((s) => ({
      past: [...s.past, clone(snapshot)].slice(-HISTORY_LIMIT),
      pastPage: [...s.pastPage, { ...s.page }].slice(-HISTORY_LIMIT),
      future: [],
      futurePage: [],
    })),
  moveSelection: (dx, dy) =>
    set((s) => ({
      objects: s.objects.map((o) =>
        s.selection.includes(o.id) && !o.locked && !o.hidden
          ? { ...o, x: o.x + dx, y: o.y + dy }
          : o
      ),
    })),
  undo: () =>
    set((s) => {
      if (s.past.length === 0) return s;
      const prev = clone(s.past[s.past.length - 1]);
      const prevPage = s.pastPage.length > 0 ? s.pastPage[s.pastPage.length - 1] : s.page;
      const alive = new Set(prev.map((o) => o.id));
      return {
        objects: prev,
        page: { ...prevPage },
        selection: s.selection.filter((id) => alive.has(id)),
        past: s.past.slice(0, -1),
        pastPage: s.pastPage.slice(0, -1),
        future: [clone(s.objects), ...s.future].slice(0, HISTORY_LIMIT),
        futurePage: [{ ...s.page }, ...s.futurePage].slice(0, HISTORY_LIMIT),
      };
    }),
  redo: () =>
    set((s) => {
      if (s.future.length === 0) return s;
      const [nextRaw, ...rest] = s.future;
      const [nextPageRaw, ...restPage] = s.futurePage;
      const next = clone(nextRaw);
      const alive = new Set(next.map((o) => o.id));
      return {
        objects: next,
        page: nextPageRaw ? { ...nextPageRaw } : s.page,
        selection: s.selection.filter((id) => alive.has(id)),
        past: [...s.past, clone(s.objects)].slice(-HISTORY_LIMIT),
        pastPage: [...s.pastPage, { ...s.page }].slice(-HISTORY_LIMIT),
        future: rest,
        futurePage: restPage,
      };
    }),

  setColorTarget: (colorTarget) => set({ colorTarget }),
  // Live apply: no history push. Callers checkpoint() once per gesture.
  // Invisible channels reroute exactly like the ColorBar effTarget:
  // lines/open paths have no fill. Text has no inline stroke: the stroke
  // channel paints its outline instead (and enables outlineOn).
  applyColor: (hex) =>
    set((s) => {
      const norm = (v: string) =>
        v.replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i, "#$1$1$2$2$3$3").toLowerCase();
      const okHex = /^#([0-9a-f]{6})$/i.test(norm(hex));
      const allowed = hex === "none" || hex === "transparent";
      if (!okHex && !allowed) {
        return { jimooError: `invalid color ${hex}` } as Partial<DocState>;
      }
      const paint = okHex ? norm(hex) : hex;
      const selObjs = s.objects.filter((o) => s.selection.includes(o.id));
      const allLines = selObjs.length > 0 && selObjs.every((o) => o.kind === "line");
      const allOpenPath =
        selObjs.length > 0 &&
        selObjs.every((o) => o.kind === "path" && !isClosedPath(o.d ?? ""));
      const key =
        (allOpenPath || allLines) && s.colorTarget === "fill"
          ? "stroke"
            : s.colorTarget === "fill"
              ? "fill"
              : "stroke";
      const isColor = okHex;
      const hollow = (v: string) => v === "none" || v === "transparent";
      let paintsFill = false;
      let paintsStroke = false;
      const objects =
        s.selection.length === 0
          ? s.objects
          : s.objects.map((o) =>
              s.selection.includes(o.id) && !o.locked && !o.hidden && o.kind !== "image"
                ? o.kind === "line"
                  ? (paintsStroke = true, { ...o, stroke: paint })
                  : o.kind === "text"
                    ? key === "fill"
                      ? (paintsFill = true, { ...o, fill: paint } as VecObject)
                      : (
                          paintsStroke = true,
                          // stroke channel on text = its outline; picking a
                          // visible color turns the outline on, none turns it off
                          { ...o, stroke: paint, outlineOn: !hollow(paint) } as VecObject
                        )
                    : o.kind === "path" && !isClosedPath(o.d ?? "") && key === "fill"
                      ? (paintsStroke = true, { ...o, stroke: paint } as VecObject)
                      : (key === "fill" ? (paintsFill = true) : (paintsStroke = true),
                    ({
                      ...o,
                      [key]: paint,
                      // repainting a hollow stroke restores a visible width
                      ...(key === "stroke" && hollow(o.stroke) && o.strokeWidth === 0
                        ? { strokeWidth: s.strokeWidth || 2 }
                        : null),
                    } as VecObject))
                : o
            );
      return {
        ...(paintsFill ? { fill: paint } : null),
        ...(paintsStroke ? { stroke: paint } : null),
        ...(s.selection.length === 0
          ? s.colorTarget === "fill"
            ? { fill: paint }
            : { stroke: paint }
          : null),
        objects,
        recents: isColor
          ? [paint, ...s.recents.filter((c) => c.toLowerCase() !== paint)].slice(0, 6)
          : s.recents,
      };
    }),
  // Canonical "no outline": stroke none + width 0 together. Caller checkpoints.
  // Selection-only: with nothing selected it leaves future objects alone.
  // Text joins in too: outlineOn is dropped along with the stroke.
  clearOutline: () =>
    set((s) => {
      if (s.selection.length === 0) return s;
      const targets = s.objects.filter(
        (o) => s.selection.includes(o.id) && !o.locked && !o.hidden && o.kind !== "image"
      );
      if (targets.length === 0) return s;
      const ids = new Set(targets.map((o) => o.id));
      return {
        stroke: "none",
        strokeWidth: 0,
        objects: s.objects.map((o) =>
          ids.has(o.id)
            ? o.kind === "text"
              ? ({ ...o, stroke: "none", strokeWidth: 0, outlineOn: false } as VecObject)
              : ({ ...o, stroke: "none", strokeWidth: 0 } as VecObject)
            : o
        ),
      };
    }),
  setOpacity: (opacity) =>
    set((s) => {
      if (s.selection.length === 0) return { opacity };
      return {
        opacity,
        objects: s.objects.map((o) =>
          s.selection.includes(o.id) && !o.locked && !o.hidden ? { ...o, opacity } : o
        ),
      };
    }),
  // Live apply: no history push. Callers checkpoint() once per gesture.
  // Images carry no stroke: selection-only width edits skip them.
  setStrokeWidth: (strokeWidth) =>
    set((s) => ({
      strokeWidth,
      objects:
        s.selection.length === 0
          ? s.objects
          : s.objects.map((o) =>
              s.selection.includes(o.id) && !o.locked && !o.hidden && o.kind !== "image"
                ? { ...o, strokeWidth }
                : o
            ),
    })),
  setJimooPalette: (jimooPalette) => set({ jimooPalette }),
}));

export const selectedObjects = (s: DocState): VecObject[] =>
  s.objects.filter((o) => s.selection.includes(o.id));
