import { useCallback, useEffect, useRef, useState } from "react";
import { useDoc, type ToolId } from "../store/doc";
import { uid, freehandToPath, spiralPoints, bezierToPath, parsePathPoints, transformObject, editablePathNodes, renormPath, shapeToPath, isClosedPath, sanitizeCreation, polygonPoints, starPoints, insertNodeMidpoint, insertNodeAtT, setNodesType, deleteNodesKeepShape, duplicateNodes, joinNodes, alignNodes, reversePathNodes, dragSegment, pathNodeWorld, worldToPathLocal, snapWorldPoint, nodeTypeOf, type BezNode, type Box, type PathObj, type VecObject } from "../canvas/types";
import { syncTextBox, layoutText, measureTextBlock, LINE_H, fontCss, nearestWeight, FONTS, fontWeights, applySpanStyle, remapSpansAfterEdit, type SpanPatch } from "../canvas/text";
import ObjectNode from "../canvas/ObjectNode";
import SelectionBox, { type ScaleHandle, SCALE_CURSORS } from "../canvas/SelectionBox";
import NodeOverlay from "../canvas/NodeOverlay";
import ContextMenu, { type CtxItem } from "./ContextMenu";

const GRID = 24;

// visible world rect (with margin) for the grid: constant raster cost at any zoom
function visibleWorld(camera: { x: number; y: number; zoom: number }, vw: number, vh: number) {
  const m = 48;
  return {
    x: (0 - camera.x) / camera.zoom - m,
    y: (0 - camera.y) / camera.zoom - m,
    w: vw / camera.zoom + m * 2,
    h: vh / camera.zoom + m * 2,
  };
}
const DRAW_TOOLS: ToolId[] = ["rect", "ellipse", "line", "polygon", "star", "spiral", "text", "pen"];

interface Preview { x0: number; y0: number; x1: number; y1: number; shift: boolean }

// eraser helpers (module scope: pure geometry)
function sampleNodes(nodes: BezNode[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (i === 0) {
      out.push({ x: nodes[0].x, y: nodes[0].y });
      continue;
    }
    const p = nodes[i - 1], c = nodes[i];
    if (p.h2 && c.h1) {
      for (let k = 1; k <= 12; k++) {
        const t = k / 12, u = 1 - t;
        out.push({
          x: u * u * u * p.x + 3 * u * u * t * (p.x + p.h2.x) + 3 * u * t * t * (c.x + c.h1.x) + t * t * t * c.x,
          y: u * u * u * p.y + 3 * u * u * t * (p.y + p.h2.y) + 3 * u * t * t * (c.y + c.h1.y) + t * t * t * c.y,
        });
      }
    } else {
      out.push({ x: c.x, y: c.y });
    }
  }
  return out;
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Resize a shared box from a handle drag. uniform = Shift, symmetric = Alt.
 *  Crossing the anchor mirrors through it (signed edges); the returned box
 *  is always positive with mx/my flags carrying the flips. */
function resizeBox(
  box: Box, handle: ScaleHandle, dx: number, dy: number, uniform: boolean, symmetric: boolean
): { box: Box; mx: boolean; my: boolean } {
  let L = box.x, R = box.x + box.w, T = box.y, B = box.y + box.h;
  if (handle.includes("w")) L += dx;
  if (handle.includes("e")) R += dx;
  if (handle.includes("n")) T += dy;
  if (handle.includes("s")) B += dy;
  let nw = R - L, nh = B - T;
  if (uniform && handle.length === 2 && box.w > 0 && box.h > 0) {
    const kx = nw / box.w, ky = nh / box.h;
    const k = Math.abs(kx - 1) > Math.abs(ky - 1) ? kx : ky;
    const kk = k === 0 ? 0.02 : k; // never fully collapse
    nw = box.w * kk;
    nh = box.h * kk;
    const fx = handle.includes("w") ? box.x + box.w : box.x;
    const fy = handle.includes("n") ? box.y + box.h : box.y;
    L = handle.includes("w") ? fx - nw : fx;
    T = handle.includes("n") ? fy - nh : fy;
    R = L + nw;
    B = T + nh;
  }
  if (symmetric) {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    L = cx - nw / 2; R = cx + nw / 2;
    T = cy - nh / 2; B = cy + nh / 2;
  }
  if (Math.abs(nw) < 1) {
    nw = (nw < 0 ? -1 : 1);
    R = L + nw;
  }
  if (Math.abs(nh) < 1) {
    nh = (nh < 0 ? -1 : 1);
    B = T + nh;
  }
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    box: { x: r1(Math.min(L, R)), y: r1(Math.min(T, B)), w: Math.abs(nw), h: Math.abs(nh) },
    mx: nw < 0,
    my: nh < 0,
  };
}

export default function CanvasViewport() {
  const camera = useDoc((s) => s.camera);
  const tool = useDoc((s) => s.tool);
  const objects = useDoc((s) => s.objects);
  const selection = useDoc((s) => s.selection);
  const page = useDoc((s) => s.page);
  const setCursor = useDoc((s) => s.setCursor);
  const zoomAt = useDoc((s) => s.zoomAt);

  const boxRef = useRef<HTMLElement>(null);
  const panRef = useRef<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  const createRef = useRef<{ sx: number; sy: number; wx: number; wy: number } | null>(null);
  const dragRef = useRef<{
    sx: number; sy: number;
    orig: Map<string, { x: number; y: number }>;
    wasSelected: boolean; moved: boolean;
    snapshot: VecObject[];
  } | null>(null);
  const resizeRef = useRef<{
    handle: ScaleHandle; sx: number; sy: number;
    box: Box; objs: VecObject[]; snapshot: VecObject[]; moved: boolean;
  } | null>(null);
  const rotateRef = useRef<{
    px: number; py: number; startAngle: number;
    startRot: Map<string, number>;
    origPos: Map<string, { x: number; y: number }>;
    snapshot: VecObject[]; moved: boolean;
  } | null>(null);
  const pivotDragRef = useRef(false);
  const rotateModeRef = useRef(false);
  const penRef = useRef<{ x: number; y: number }[]>([]);
  const zoomRef = useRef<{ sx: number; sy: number } | null>(null);
  const bezHoldRef = useRef<{ index: number } | null>(null);
  const bezLiveRef = useRef<BezNode[]>([]);
  const eraserRef = useRef<{
    pts: { x: number; y: number }[];
    radius: number;
    snapshot: VecObject[];
  } | null>(null);
  const imageFileRef = useRef<HTMLInputElement>(null);
  const imageAtRef = useRef<{ x: number; y: number } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [penLive, setPenLive] = useState<{ x: number; y: number }[]>([]);
  const [zoomBox, setZoomBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [bezLive, setBezLive] = useState<BezNode[]>([]);
  const [bezRubber, setBezRubber] = useState<{ x: number; y: number } | null>(null);
  const [eraserLive, setEraserLive] = useState<{ x: number; y: number }[]>([]);
  const [editing, setEditing] = useState<{
    id: string; draft: string; fresh: boolean; checkpointed: boolean;
  } | null>(null);
  const editingRef = useRef<typeof editing>(null);
  const [nodeSel, setNodeSel] = useState<{ objId: string; idx: number[] } | null>(null);
  const nodeSelRef = useRef<typeof nodeSel>(null);
  const deleteNodesRef = useRef<(keepShape: boolean) => boolean>(() => false);
  // node-op dispatcher for the options bar (options bar → canvas event bridge)
  const nodeOpRef = useRef<(op: string | { op: string; x?: number | null; y?: number | null }) => void>(() => {});
  // rubber-band selection of nodes (node tool)
  const [nodeMarquee, setNodeMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const nodeMarqueeRef = useRef<{ sx: number; sy: number; add: boolean; base: number[] } | null>(null);
  // segment dragging: the segment follows the cursor (Phase 4)
  const segDragRef = useRef<{
    objId: string; si: number; orig: BezNode[]; snapshot: VecObject[];
    moved: boolean; sx: number; sy: number;
  } | null>(null);
  // snapping indicator: world point where a node just snapped (Phase 5)
  const [snapHint, setSnapHint] = useState<{ x: number; y: number } | null>(null);
  const nodeDragRef = useRef<{
    objId: string; idx: number[]; orig: BezNode[]; snapshot: VecObject[]; moved: boolean;
    sx: number; sy: number;
  } | null>(null);
  const handleDragRef = useRef<{
    objId: string; index: number; which: "h1" | "h2";
    orig: BezNode[]; snapshot: VecObject[]; moved: boolean;
    sx: number; sy: number;
  } | null>(null);
  // rotate-handle mode lives in the store so the options bar can drive it too
  const rotateMode = useDoc((s) => s.rotateMode);
  const nodeHandlesAll = useDoc((s) => s.nodeHandlesAll);
  const [pivot, setPivot] = useState<{ x: number; y: number } | null>(null);
  const [dragCursor, setDragCursor] = useState<string | null>(null);
  // right-click context menu (tool- and target-aware, see openContextMenu)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  // per-letter styling: the textarea's selected character range while editing
  const [editSel, setEditSel] = useState<{ start: number; end: number } | null>(null);
  const editSelRef = useRef<typeof editSel>(null);
  // coalesces a styling burst on one selection into a single undo step
  const spanSnapRef = useRef<{ key: string; snapshot: VecObject[] } | null>(null);
  const finishRef = useRef<(x: number, y: number, altKey?: boolean, shiftKey?: boolean) => void>(() => {});
  const spaceHeldRef = useRef(false);
  const arrowBurstRef = useRef<{ timer: number | undefined }>({ timer: undefined });
  // frame pipeline: coalesce native pointer rate to one flush per frame
  const rafRef = useRef(0);
  interface StashedMove { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean }
  const pendingMoveRef = useRef<StashedMove | null>(null);
  const queueMoveRef = useRef<(x: number, y: number, shift: boolean, alt: boolean, ctrl: boolean) => void>(() => {});
  // cached canvas rect: getBoundingClientRect once per layout, not per pixel
  const rectCache = useRef<DOMRect | null>(null);
  const lastCursorRef = useRef({ x: 0, y: 0, t: 0 });

  const setMode = (v: boolean) => {
    rotateModeRef.current = v;
    useDoc.getState().setRotateMode(v);
  };
  // mirror store-driven changes (options bar buttons) into the gesture ref
  useEffect(() => {
    rotateModeRef.current = rotateMode;
  }, [rotateMode]);

  // reset transform mode when the selection membership or tool changes
  const selKey = selection.join(",");
  useEffect(() => {
    setMode(false);
    setPivot(null);
    setNodeSel((cur) => {
      const keep = cur && selKey.split(",").includes(cur.objId) ? cur : null;
      nodeSelRef.current = keep;
      return keep;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, tool]);

  useEffect(() => {
    nodeSelRef.current = nodeSel;
    // publish for the options bar (readout + X/Y editors)
    useDoc.getState().setNodeSelInfo(
      nodeSel && nodeSel.idx.length > 0 ? { objId: nodeSel.objId, idx: [...nodeSel.idx] } : null
    );
  }, [nodeSel]);

  // ---------- bezier commit (stable: refs + store only) ----------
  const commitBezier = useCallback((closed: boolean, dropLast = false) => {
    let nodes = [...bezLiveRef.current];
    if (dropLast && nodes.length >= 2) {
      // only drop when the double-click really duplicated the last node
      const a = nodes[nodes.length - 1], b = nodes[nodes.length - 2];
      if (Math.hypot(a.x - b.x, a.y - b.y) < 3) nodes.pop();
    }
    bezLiveRef.current = [];
    setBezLive([]);
    setBezRubber(null);
    bezHoldRef.current = null;
    if (nodes.length < 2) return;
    const st = useDoc.getState();
    // bbox unions node centers AND handle overhang
    const xs = nodes.flatMap((n) => [
      n.x,
      n.h1 ? n.x + n.h1.x : n.x,
      n.h2 ? n.x + n.h2.x : n.x,
    ]);
    const ys = nodes.flatMap((n) => [
      n.y,
      n.h1 ? n.y + n.h1.y : n.y,
      n.h2 ? n.y + n.h2.y : n.y,
    ]);
    const bx = Math.min(...xs), by = Math.min(...ys);
    const rel: BezNode[] = nodes.map((n) => ({
      ...n,
      x: Math.round((n.x - bx) * 10) / 10,
      y: Math.round((n.y - by) * 10) / 10,
    }));
    const n = st.objects.length + 1;
    const paint = sanitizeCreation(st.fill, st.stroke, st.strokeWidth, "stroke");
    st.addObject({
      id: uid(), name: `curve ${n}`, kind: "path",
      x: Math.round(bx), y: Math.round(by),
      w: Math.max(1, Math.round((Math.max(...xs) - bx) * 10) / 10),
      h: Math.max(1, Math.round((Math.max(...ys) - by) * 10) / 10),
      rotation: 0, fill: paint.fill, stroke: paint.stroke,
      strokeWidth: paint.strokeWidth, opacity: st.opacity,
      d: bezierToPath(rel, closed), nodes: rel,
    });
  }, []);

  useEffect(() => {
    bezLiveRef.current = bezLive;
  }, [bezLive]);

  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);

  // ---------- inline text editing ----------
  const commitEdit = useCallback(() => {
    const ed = editingRef.current;
    if (!ed) return;
    setEditing(null);
    // close the per-letter style bar and its undo coalescing session
    editSelRef.current = null;
    setEditSel(null);
    spanSnapRef.current = null;
    const st = useDoc.getState();
    const o = st.objects.find((x) => x.id === ed.id);
    if (!o || o.kind !== "text") return;
    if (!ed.draft && ed.fresh) {
      // typed nothing into a fresh box: remove without adding history.
      // Never pop past blindly — an interleaved history push (AI, autosave
      // consumers) would corrupt the stack. Leaving the creation step is
      // a harmless no-op undo.
      useDoc.setState((s) => ({
        objects: s.objects.filter((x) => x.id !== o.id),
        selection: s.selection.filter((id) => id !== o.id),
      }));
    }
  }, []);

  // changing tools commits any open edit
  useEffect(() => {
    commitEdit();
  }, [tool, commitEdit]);

  const onEditChange = (draft: string) => {
    const ed = editingRef.current;
    if (!ed) return;
    const st = useDoc.getState();
    const o = st.objects.find((x) => x.id === ed.id);
    if (!o || o.kind !== "text") return;
    let cpd = ed.checkpointed;
    if (!cpd && !ed.fresh) {
      // selection gestures snapshot without pushing, so the first keystroke
      // always owns exactly one undo step — no stringify comparison needed
      st.checkpoint();
      cpd = true;
    }
    const lines = layoutText(draft, o.fontSize, o.fontWeight, o.fontFamily, o.wrapW);
    const m = measureTextBlock({ lines, fontSize: o.fontSize, fontWeight: o.fontWeight, fontFamily: o.fontFamily });
    // shift letter spans so they keep styling the same characters
    const spans = remapSpansAfterEdit(o.spans, o.text, draft);
    st.updateObject(o.id, {
      text: draft, lines, w: m.w, h: m.h,
      ...(spans ? { spans } : { spans: undefined }),
    });
    setEditing({ ...ed, draft, checkpointed: cpd });
  };

  const openEditor = (id: string, draft: string, fresh: boolean) => {
    commitEdit();
    setEditing({ id, draft, fresh, checkpointed: false });
    useDoc.getState().setSelection([id]);
  };

  /** Apply a style override to the selected character range. The first apply
   *  per selection pushes one undo snapshot; a burst of tweaks (color-drag,
   *  size nudges) then collapses into that single step. */
  const applyStyleToSel = (patch: SpanPatch) => {
    const ed = editingRef.current;
    const sel = editSelRef.current;
    if (!ed || !sel || sel.end <= sel.start) return;
    const st = useDoc.getState();
    const o = st.objects.find((x) => x.id === ed.id);
    if (!o || o.kind !== "text") return;
    const key = `${ed.id}:${sel.start}:${sel.end}`;
    if (!spanSnapRef.current || spanSnapRef.current.key !== key) {
      spanSnapRef.current = { key, snapshot: snapshotObjects() };
      st.pushHistory(spanSnapRef.current.snapshot);
    }
    st.updateObject(o.id, { spans: applySpanStyle(o.spans, sel.start, sel.end, patch) });
  };

  const onEditSelect = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget;
    const s = { start: t.selectionStart ?? 0, end: t.selectionEnd ?? 0 };
    editSelRef.current = s;
    setEditSel(s);
  };

  /** Blur-commit only when focus truly leaves the editor: clicking the
   *  span-style bar's controls keeps the edit session open. */
  const onEditBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => {
    const rt = e.relatedTarget;
    if (rt instanceof Element && rt.closest(".vl-span-bar")) return;
    commitEdit();
  };

  // ---------- fit page (stable) ----------
  const getRect = (): DOMRect =>
    rectCache.current ?? boxRef.current?.getBoundingClientRect() ?? new DOMRect();

  const fitPage = useCallback(() => {
    const r = getRect();
    if (r.width === 0) return;
    const st = useDoc.getState();
    const next = Math.min(
      8,
      Math.max(0.1, Math.min((r.width - 96) / st.page.w, (r.height - 96) / st.page.h))
    );
    st.setCamera({ zoom: next, x: r.width / 2, y: r.height / 2 });
  }, []);

  // center on the page at startup
  useEffect(() => {
    fitPage();
  }, [fitPage]);

  useEffect(() => {
    spaceHeldRef.current = spaceHeld;
  }, [spaceHeld]);

  // bezier live state: ref is truth, state mirrors for render
  const setBez = (nodes: BezNode[]) => {
    bezLiveRef.current = nodes;
    setBezLive(nodes);
  };

  // switching tools commits doc gestures and drops previews (never orphans).
  // placed after setBez so every callee is defined above this effect.
  useEffect(() => {
    commitDocGestures();
    setBez([]);
    setBezRubber(null);
    bezHoldRef.current = null;
    penRef.current = [];
    setPenLive([]);
    createRef.current = null;
    setPreview(null);
    zoomRef.current = null;
    setZoomBox(null);
    eraserRef.current = null;
    setEraserLive([]);
    imageAtRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  // ---------- keyboard ----------
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      // a focused button keeps its own keys (no stolen Delete/Space/Enter)
      if (
        t &&
        t.tagName === "BUTTON" &&
        (e.key === "Delete" ||
          e.key === "Backspace" ||
          e.key === "Escape" ||
          e.key === "Enter" ||
          e.code === "Space")
      )
        return;
      const st = useDoc.getState();
      if (e.code === "Space") { e.preventDefault(); spaceHeldRef.current = true; setSpaceHeld(true); return; }
      if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey) { fitPage(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "0") { e.preventDefault(); fitPage(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); st.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); st.redo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") { e.preventDefault(); st.duplicateSelection(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        // node tool: Ctrl+A selects all nodes of the active path
        if (st.tool === "node") {
          const o = activeNodePath();
          if (o && o.kind === "path") {
            setNodeSel({ objId: o.id, idx: editablePathNodes(o).map((_, i) => i) });
            return;
          }
        }
        st.selectAll();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (st.tool === "node" && deleteNodesRef.current(!e.ctrlKey)) return;
        st.deleteSelection();
        return;
      }
      if (st.tool === "node" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // node ops off the keyboard (Inkscape/Corel conventions)
        if (e.key === "Insert") { e.preventDefault(); nodeOpRef.current("insert"); return; }
        if (e.key === "D" && e.shiftKey) { nodeOpRef.current("dup"); return; }
        if (e.key === "J" && e.shiftKey) { nodeOpRef.current("join"); return; }
        if (e.key === "!") { nodeOpRef.current("toggleType"); return; }
        if (e.key === "Tab") {
          e.preventDefault();
          const cur = nodeSelRef.current;
          const o = cur ? getPath(cur.objId) : activeNodePath();
          if (!o || o.kind !== "path") return;
          const n = editablePathNodes(o).length;
          if (n === 0) return;
          if (!cur || cur.objId !== o.id || cur.idx.length === 0) {
            setNodeSel({ objId: o.id, idx: [0] });
            return;
          }
          const sorted = [...cur.idx].sort((a, b) => a - b);
          const next = e.shiftKey ? sorted[0] - 1 : sorted[sorted.length - 1] + 1;
          setNodeSel({ objId: o.id, idx: [(next + n) % n] });
          return;
        }
      }
      if (e.key === "Escape") {
        // node tool: first Esc clears the node selection, then cancels gestures
        if (
          st.tool === "node" &&
          nodeSelRef.current && nodeSelRef.current.idx.length > 0 &&
          !nodeDragRef.current && !handleDragRef.current
        ) {
          setNodeSel({ objId: nodeSelRef.current.objId, idx: [] });
          return;
        }
        // Cancel any in-flight gesture: roll back live mutations to their
        // snapshot (no history push), drop every ref, reset mode/cursor.
        const hadBez = bezLiveRef.current.length > 0;
        const hadZoom = !!zoomRef.current;
        const hadEraser = !!eraserRef.current;
        const hadCreate = !!createRef.current;
        const hadRotateMode = rotateModeRef.current;
        const rollbacks: VecObject[][] = [];
        if (dragRef.current?.snapshot) rollbacks.push(dragRef.current.snapshot);
        if (resizeRef.current?.snapshot) rollbacks.push(resizeRef.current.snapshot);
        if (rotateRef.current?.snapshot) rollbacks.push(rotateRef.current.snapshot);
        if (nodeDragRef.current?.snapshot) rollbacks.push(nodeDragRef.current.snapshot);
        if (handleDragRef.current?.snapshot) rollbacks.push(handleDragRef.current.snapshot);
        // eraser/bezier/creation snapshots are discarded, not committed
        const restore = rollbacks[rollbacks.length - 1] ?? eraserRef.current?.snapshot;
        if (restore) {
          const snap = restore;
          useDoc.setState({ objects: snap });
        }
        dragRef.current = null;
        resizeRef.current = null;
        rotateRef.current = null;
        nodeDragRef.current = null;
        handleDragRef.current = null;
        panRef.current = null;
        setPanning(false);
        pivotDragRef.current = false;
        createRef.current = null;
        setPreview(null);
        penRef.current = [];
        setPenLive([]);
        zoomRef.current = null;
        setZoomBox(null);
        eraserRef.current = null;
        setEraserLive([]);
        bezLiveRef.current = [];
        setBezLive([]);
        setBezRubber(null);
        bezHoldRef.current = null;
        imageAtRef.current = null;
        useDoc.getState().setGestureActive(false);
        setDragCursor(null);
        if (hadRotateMode) {
          setMode(false);
          return;
        }
        if (restore || hadBez || hadZoom || hadEraser || hadCreate) return;
        st.clearSelection(); st.setTool("move"); return;
      }
      if (e.key === "Enter" && st.tool === "bezier" && bezLiveRef.current.length >= 2) {
        commitBezier(false);
        return;
      }
      // node tool: arrows nudge the selected nodes, not the whole objects
      if (e.key.startsWith("Arrow") && st.tool === "node" && (nodeSelRef.current?.idx.length ?? 0) > 0) {
        e.preventDefault();
        const cur = nodeSelRef.current!;
        const o = getPath(cur.objId);
        if (o) {
          const step = e.shiftKey ? 8 : 1;
          let dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
          let dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
          // rotation-aware: screen steps are rotated into the object's frame
          if (o.rotation) {
            const a = (-o.rotation * Math.PI) / 180;
            const rx = dx * Math.cos(a) - dy * Math.sin(a);
            const ry = dx * Math.sin(a) + dy * Math.cos(a);
            dx = rx; dy = ry;
          }
          // same burst coalescing as the object nudge: one undo step per burst
          if (!arrowBurstRef.current.timer) {
            if (!st.gestureActive) st.checkpoint();
            st.setGestureActive(true);
          } else {
            window.clearTimeout(arrowBurstRef.current.timer);
          }
          arrowBurstRef.current.timer = window.setTimeout(() => {
            arrowBurstRef.current.timer = undefined;
            useDoc.getState().setGestureActive(false);
          }, 800);
          const nodes = editablePathNodes(o).map((n, i) =>
            cur.idx.includes(i) ? { ...n, x: n.x + dx, y: n.y + dy } : n
          );
          st.updateObject(o.id, renormPath(o, nodes));
        }
        return;
      }
      if (e.key.startsWith("Arrow") && st.selection.length > 0) {
        e.preventDefault();
        const step = e.shiftKey ? 8 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        if (dx !== 0 || dy !== 0) {
          // coalesce a key burst into one undo step: checkpoint once, hold
          // gestureActive until 800ms of quiet, then release for the next burst
          if (!arrowBurstRef.current.timer) {
            if (!st.gestureActive) st.checkpoint();
            st.setGestureActive(true);
          } else {
            window.clearTimeout(arrowBurstRef.current.timer);
          }
          arrowBurstRef.current.timer = window.setTimeout(() => {
            arrowBurstRef.current.timer = undefined;
            useDoc.getState().setGestureActive(false);
          }, 800);
          st.moveSelection(dx, dy);
        }
        return;
      }
      const map: Record<string, ToolId> = {
        v: "move", z: "zoom", r: "rect", o: "ellipse", l: "line", t: "text",
        p: "pen", b: "bezier", n: "node", i: "eye", u: "polygon", e: "eraser",
      };
      const hit = map[e.key.toLowerCase()];
      if (hit && !e.ctrlKey && !e.metaKey && !e.altKey) st.setTool(hit);
      if (e.key.toLowerCase() === "x" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        useDoc.setState((s) => ({ colorTarget: s.colorTarget === "fill" ? "stroke" : "fill" }));
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") { spaceHeldRef.current = false; setSpaceHeld(false); }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [commitBezier, fitPage]);

  // window release always lands: leaving the canvas can never orphan a gesture
  useEffect(() => {
    const up = (e: PointerEvent) => {
      finishRef.current(e.clientX, e.clientY, e.altKey, e.shiftKey);
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  // while any gesture is in flight, feed moves from the window as well: the
  // canvas handler alone misses fast cursors crossing the rails/docks or
  // leaving the window, which used to freeze drags mid-gesture
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const g =
        dragRef.current || resizeRef.current || rotateRef.current ||
        panRef.current || nodeDragRef.current || handleDragRef.current ||
        segDragRef.current ||
        eraserRef.current || createRef.current || zoomRef.current;
      if (!g) return;
      queueMoveRef.current(e.clientX, e.clientY, e.shiftKey, e.altKey, e.ctrlKey);
    };
    window.addEventListener("mousemove", move);
    return () => window.removeEventListener("mousemove", move);
  }, []);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => {
      rectCache.current = el.getBoundingClientRect();
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // wheel zoom-to-cursor (native, non-passive so we can preventDefault)
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = getRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const toWorld = (clientX: number, clientY: number) => {
    const r = getRect();
    const sx = clientX - r.left;
    const sy = clientY - r.top;
    const cam = useDoc.getState().camera;
    return { sx, sy, wx: (sx - cam.x) / cam.zoom, wy: (sy - cam.y) / cam.zoom };
  };

  const beginZoom = (clientX: number, clientY: number) => {
    zoomRef.current = { sx: clientX, sy: clientY };
    setZoomBox({ x0: clientX, y0: clientY, x1: clientX, y1: clientY });
  };

  const commitZoom = (clientX: number, clientY: number, alt: boolean) => {
    const z = zoomRef.current;
    zoomRef.current = null;
    setZoomBox(null);
    if (!z) return;
    const r = getRect();
    if (r.width === 0) return;
    const dx = clientX - z.sx, dy = clientY - z.sy;
    const st = useDoc.getState();
    if (Math.hypot(dx, dy) < 6) {
      // click: zoom in (alt = out) centered on cursor
      st.zoomAt(z.sx - r.left, z.sy - r.top, alt ? 1 / 1.5 : 1.5);
      return;
    }
    // marquee: fit world rect to viewport
    const w0 = (Math.min(z.sx, clientX) - r.left - st.camera.x) / st.camera.zoom;
    const w1 = (Math.max(z.sx, clientX) - r.left - st.camera.x) / st.camera.zoom;
    const h0 = (Math.min(z.sy, clientY) - r.top - st.camera.y) / st.camera.zoom;
    const h1 = (Math.max(z.sy, clientY) - r.top - st.camera.y) / st.camera.zoom;
    const next = Math.min(8, Math.max(0.1, Math.min(r.width / (w1 - w0), r.height / (h1 - h0))));
    st.setCamera({
      zoom: next,
      x: r.width / 2 - ((w0 + w1) / 2) * next,
      y: r.height / 2 - ((h0 + h1) / 2) * next,
    });
  };

  // ---------- node tool ----------
  const flashErr = (m: string) => {
    useDoc.setState({ jimooError: m });
    setTimeout(() => useDoc.setState({ jimooError: "" }), 3000);
  };

  const getPath = (id: string): PathObj | undefined => {
    const o = useDoc.getState().objects.find((x) => x.id === id);
    return o && o.kind === "path" ? o : undefined;
  };

  // ---------- break tool: shape -> editable path (one undo step) ----------
  const breakObject = (id: string) => {
    const st = useDoc.getState();
    const o = st.objects.find((x) => x.id === id);
    if (!o || o.locked || o.hidden) return;
    if (o.kind === "path") {
      flashErr("already an editable path — use the node tool");
      return;
    }
    if (o.kind === "text" || o.kind === "image") {
      // glyph-outline conversion needs font path data (opentype) — roadmap,
      // not silent lossy bbox tracing. Keep the selection so the click feels
      // owned, then tell the exact next step.
      st.setSelection([id]);
      flashErr(
        o.kind === "text"
          ? "text → path needs glyph outlines — roadmap; use BREAK on shapes for now"
          : "images can't be node-edited"
      );
      return;
    }
    const p = shapeToPath(o);
    if (!p) return;
    st.checkpoint();
    useDoc.setState((s) => ({
      objects: s.objects.map((x) => (x.id === id ? p : x)),
      selection: [id],
    }));
    setNodeSel({ objId: id, idx: [] });
    st.setTool("node");
  };

  // ---------- image tool ----------
  const openImagePicker = (wx: number, wy: number) => {
    imageAtRef.current = { x: Math.round(wx), y: Math.round(wy) };
    imageFileRef.current?.click();
  };

  const onImageFile = async (f: File | undefined) => {
    const at = imageAtRef.current;
    imageAtRef.current = null;
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      flashErr("that file is not an image");
      return;
    }
    if (f.size > 12_000_000) {
      flashErr("image too large (12 MB max)");
      return;
    }
    try {
      const url = URL.createObjectURL(f);
      try {
        const bmp = await createImageBitmap(f);
        const iw = bmp.width, ih = bmp.height;
        bmp.close();
        const MAX = 1600;
        const k = Math.min(1, MAX / Math.max(iw, ih));
        const dw = Math.max(1, Math.round(iw * k));
        const dh = Math.max(1, Math.round(ih * k));
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("decode"));
          img.src = url;
        });
        const canvas = document.createElement("canvas");
        canvas.width = dw;
        canvas.height = dh;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas");
        ctx.drawImage(img, 0, 0, dw, dh);
        const src = canvas.toDataURL("image/png");
        if (src.length > 8_000_000) {
          flashErr("image too large after decode — try a smaller file");
          return;
        }
        const st = useDoc.getState();
        const n = st.objects.length + 1;
        const cx = at ? at.x : 0;
        const cy = at ? at.y : 0;
        st.addObject({
          id: uid(),
          name: f.name.replace(/\.[^.]+$/, "").slice(0, 32) || `image ${n}`,
          kind: "image",
          x: Math.round(cx - dw / 2),
          y: Math.round(cy - dh / 2),
          w: dw,
          h: dh,
          rotation: 0,
          fill: "transparent",
          stroke: "none",
          strokeWidth: 0,
          opacity: st.opacity,
          src,
          naturalW: iw,
          naturalH: ih,
        });
        st.setTool("move");
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      flashErr("could not read that image");
    }
  };

  // OptionsBar "IMPORT" button reuses the canvas picker (page center)
  useEffect(() => {
    const onImport = () => {
      if (useDoc.getState().tool !== "image") return;
      openImagePicker(0, 0);
    };
    window.addEventListener("vl:import-image", onImport);
    return () => window.removeEventListener("vl:import-image", onImport);
  }, []);

  // options-bar node controls → node operations (same bridge as image import)
  useEffect(() => {
    const onNodeOp = (e: Event) => {
      const detail = (e as CustomEvent<string | { op: string; x?: number; y?: number }>).detail;
      if (useDoc.getState().tool !== "node") return;
      nodeOpRef.current(detail);
    };
    window.addEventListener("vl:node-op", onNodeOp);
    return () => window.removeEventListener("vl:node-op", onNodeOp);
  }, []);

  const writeNodesLive = (id: string, nodes: BezNode[]) => {
    const o = getPath(id);
    if (!o) return;
    useDoc.getState().updateObject(id, {
      nodes,
      d: nodes.length >= 2 ? bezierToPath(nodes, isClosedPath(o.d)) : "",
    });
  };

  const onNodeDown = (e: React.MouseEvent, objId: string, index: number) => {
    e.stopPropagation();
    e.preventDefault(); // gesture starts must never start a text selection
    const o = getPath(objId);
    if (!o) return;
    if (e.altKey) {
      // Alt-click deletes the node (closed needs 3+, open 2+)
      const nodes = editablePathNodes(o);
      const min = isClosedPath(o.d) ? 3 : 2;
      if (nodes.length <= min) {
        flashErr(`a path needs at least ${min} nodes`);
        return;
      }
      const st = useDoc.getState();
      const snapshot = snapshotObjects();
      st.updateObject(objId, renormPath(o, nodes.filter((_, i) => i !== index)));
      st.pushHistory(snapshot);
      setNodeSel({ objId, idx: [] });
      return;
    }
    const cur = nodeSelRef.current;
    const idx =
      e.shiftKey && cur?.objId === objId
        ? cur.idx.includes(index)
          ? cur.idx.filter((i) => i !== index)
          : [...cur.idx, index]
        : [index];
    setNodeSel({ objId, idx });
    nodeDragRef.current = {
      objId, idx, orig: editablePathNodes(o), snapshot: snapshotObjects(),
      moved: false, sx: e.clientX, sy: e.clientY,
    };
    setDragCursor("grabbing");
    useDoc.getState().setGestureActive(true);
  };

  const onHandleDown = (
    e: React.MouseEvent, objId: string, index: number, which: "h1" | "h2"
  ) => {
    e.stopPropagation();
    e.preventDefault(); // gesture starts must never start a text selection
    const o = getPath(objId);
    if (!o) return;
    handleDragRef.current = {
      objId, index, which, orig: editablePathNodes(o),
      snapshot: snapshotObjects(), moved: false, sx: e.clientX, sy: e.clientY,
    };
    setDragCursor("grabbing");
    useDoc.getState().setGestureActive(true);
  };

  const onNodeDouble = (e: React.MouseEvent, objId: string, index: number) => {
    e.stopPropagation();
    const o = getPath(objId);
    if (!o) return;
    const nodes = editablePathNodes(o);
    const n = nodes[index];
    if (!n) return;
    const st = useDoc.getState();
    const snapshot = snapshotObjects();
    const closed = isClosedPath(o.d);
    // single source of truth for cusp<->smooth so dbl-click matches the
    // options-bar buttons and always stamps t correctly
    const target = nodeTypeOf(n) === "cusp" ? "smooth" : "cusp";
    st.updateObject(objId, renormPath(o, setNodesType(nodes, [index], target, closed)));
    st.pushHistory(snapshot);
  };

  useEffect(() => {
    deleteNodesRef.current = deleteSelectedNodes;
    nodeOpRef.current = runNodeOp;
  });

  /** Double-click on a path body inserts a corner node at the nearest point. */
  const insertNodeAt = (objId: string, clientX: number, clientY: number): boolean => {
    const o = getPath(objId);
    if (!o) return false;
    const r = getRect();
    const cam = useDoc.getState().camera;
    const wx = (clientX - r.left - cam.x) / cam.zoom;
    const wy = (clientY - r.top - cam.y) / cam.zoom;
    // into object-local frame (unrotate about bbox center)
    let lx = wx - o.x, ly = wy - o.y;
    if (o.rotation) {
      const a = (-o.rotation * Math.PI) / 180;
      const cx = o.w / 2, cy = o.h / 2;
      const dx = lx - cx, dy = ly - cy;
      lx = cx + dx * Math.cos(a) - dy * Math.sin(a);
      ly = cy + dx * Math.sin(a) + dy * Math.cos(a);
    }
    const nodes = editablePathNodes(o);
    if (nodes.length < 1) return false;
    const closed = isClosedPath(o.d);
    const segs: [number, number][] = [];
    for (let i = 0; i < nodes.length - 1; i++) segs.push([i, i + 1]);
    if (closed && nodes.length >= 3) segs.push([nodes.length - 1, 0]);
    const tol = 12 / cam.zoom;
    // best point on the path under the cursor, plus the segment parameter t
    // so the split can rebuild the curve without changing its shape
    const nearest = (): { si: number; dist: number; px: number; py: number; t: number } | null => {
      let best: { si: number; dist: number; px: number; py: number; t: number } | null = null;
      const consider = (
        si: number, ax: number, ay: number, bx: number, by: number, t0: number, t1: number
      ) => {
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        // project the click onto the piece: the node lands where clicked,
        // not at the segment midpoint
        const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((lx - ax) * dx + (ly - ay) * dy) / len2));
        const px = ax + t * dx, py = ay + t * dy;
        const d = Math.hypot(lx - px, ly - py);
        if (!best || d < best.dist) {
          best = { si, dist: d, px, py, t: t0 + t * (t1 - t0) };
        }
      };
      segs.forEach(([a, b], si) => {
        const p = nodes[a], c = nodes[b];
        if (p.h2 && c.h1) {
          let px = p.x, py = p.y;
          for (let k = 1; k <= 16; k++) {
            const t = k / 16, u = 1 - t;
            const qx = u * u * u * p.x + 3 * u * u * t * (p.x + p.h2!.x) + 3 * u * t * t * (c.x + c.h1!.x) + t * t * t * c.x;
            const qy = u * u * u * p.y + 3 * u * u * t * (p.y + p.h2!.y) + 3 * u * t * t * (c.y + c.h1!.y) + t * t * t * c.y;
            consider(si, px, py, qx, qy, (k - 1) / 16, k / 16);
            px = qx; py = qy;
          }
        } else {
          consider(si, p.x, p.y, c.x, c.y, 0, 1);
        }
      });
      return best;
    };
    const found = nearest();
    if (!found || found.dist > tol) return false;
    const st = useDoc.getState();
    const snapshot = snapshotObjects();
    // exact de Casteljau split at the clicked parameter: a curved segment
    // keeps its shape instead of collapsing to straight lines
    const split = insertNodeAtT(nodes, segs[found.si][0], found.t, closed);
    if (split.index < 0) return false;
    st.updateObject(objId, renormPath(o, split.nodes));
    st.pushHistory(snapshot);
    // select the path so the node overlay (and the new node) is visible
    st.setSelection([objId]);
    setNodeSel({ objId, idx: [split.index] });
    return true;
  };

  const deleteSelectedNodes = (keepShape = true): boolean => {
    const cur = nodeSelRef.current;
    if (!cur || cur.idx.length === 0) return false;
    const o = getPath(cur.objId);
    if (!o) return false;
    const nodes = editablePathNodes(o);
    const closed = isClosedPath(o.d);
    const min = closed ? 3 : 2;
    // keep-shape (Del) re-aims the neighbors over the hole; Ctrl+Del is plain
    const keep = keepShape
      ? deleteNodesKeepShape(nodes, cur.idx, closed)
      : nodes.filter((_, i) => !cur.idx.includes(i));
    if (keep.length < min) {
      flashErr(`a path needs at least ${min} nodes`);
      return true;
    }
    const st = useDoc.getState();
    const snapshot = snapshotObjects();
    st.updateObject(cur.objId, renormPath(o, keep));
    st.pushHistory(snapshot);
    setNodeSel({ objId: cur.objId, idx: [] });
    return true;
  };

  /** The path the node tool is editing: the node selection's owner, else the
   *  single selected path (multi-select falls back to the first path so the
   *  marquee / Ctrl+A / Tab keep working instead of silently doing nothing). */
  const activeNodePath = (): PathObj | undefined => {
    const st = useDoc.getState();
    const cur = nodeSelRef.current;
    const owned = cur ? getPath(cur.objId) : undefined;
    if (owned) return owned;
    const paths = st.objects.filter(
      (o): o is PathObj =>
        st.selection.includes(o.id) && o.kind === "path" && !o.locked && !o.hidden
    );
    return paths.length >= 1 ? paths[0] : undefined;
  };

  /** Node operations shared by the options bar, right-click menu and keys.
   *  Payload ops carry coordinates (e.g. the X/Y fields in the options bar);
   *  every op writes one undo step and keeps the selection meaningful. */
  interface NodeOpPayload { op: string; x?: number | null; y?: number | null }
  const runNodeOp = (opOr: string | NodeOpPayload) => {
    const op = typeof opOr === "string" ? opOr : opOr.op;
    const cur = nodeSelRef.current;
    if (!cur || cur.idx.length === 0) { flashErr("select nodes first"); return; }
    const o = getPath(cur.objId);
    if (!o) return;
    const nodes = editablePathNodes(o);
    const closed = isClosedPath(o.d);
    const st = useDoc.getState();
    const snapshot = snapshotObjects();
    const idxs = [...cur.idx].sort((a, b) => a - b);
    switch (op) {
      case "cusp":
      case "smooth":
      case "sym":
        st.updateObject(o.id, renormPath(o, setNodesType(nodes, idxs, op, closed)));
        break;
      case "toggleType": {
        const allSmooth = idxs.every((i) => nodes[i] && nodeTypeOf(nodes[i]) !== "cusp");
        st.updateObject(
          o.id,
          renormPath(o, setNodesType(nodes, idxs, allSmooth ? "cusp" : "smooth", closed))
        );
        break;
      }
      case "insert": {
        let next = nodes;
        const born: number[] = [];
        let shift = 0;
        for (let k = 0; k < idxs.length - 1; k++) {
          if (idxs[k + 1] - idxs[k] !== 1) continue; // adjacent pairs only
          const r = insertNodeMidpoint(next, idxs[k] + shift, closed);
          if (r.index < 0) continue;
          next = r.nodes;
          born.push(r.index);
          shift++;
        }
        if (born.length === 0) {
          flashErr("select two adjacent nodes to insert between them");
          return;
        }
        st.updateObject(o.id, renormPath(o, next));
        setNodeSel({ objId: o.id, idx: born });
        break;
      }
      case "dup": {
        const next = duplicateNodes(nodes, idxs);
        const born = idxs.map((i, k) => i + 1 + k); // copies follow originals
        st.updateObject(o.id, renormPath(o, next));
        setNodeSel({ objId: o.id, idx: born });
        break;
      }
      case "join": {
        const r = joinNodes(nodes, idxs);
        if (!r) { flashErr("select exactly two nodes to join"); return; }
        st.updateObject(o.id, renormPath(o, r.nodes));
        setNodeSel({ objId: o.id, idx: [r.index] });
        break;
      }
      case "alignH":
        st.updateObject(o.id, renormPath(o, alignNodes(nodes, idxs, "h")));
        break;
      case "alignV":
        st.updateObject(o.id, renormPath(o, alignNodes(nodes, idxs, "v")));
        break;
      case "reverse":
        st.updateObject(o.id, renormPath(o, reversePathNodes(nodes)));
        setNodeSel({ objId: o.id, idx: [] });
        break;
      case "closePath": {
        if (closed) return; // idempotent: no history when already closed
        st.updateObject(o.id, renormPath({ ...o, d: `${o.d ?? ""} Z` }, nodes));
        break;
      }
      case "openPath": {
        if (!closed) return; // idempotent: no history when already open
        st.updateObject(o.id, renormPath({ ...o, d: (o.d ?? "").replace(/\s*Z\s*$/i, "") }, nodes));
        break;
      }
      case "moveNodeTo": {
        // options-bar X/Y: world-space target for the first selected node;
        // unedited axes arrive as null and keep their live value. Typed
        // entries are exact (no magnetic snap); rotation is honored by
        // routing through world<->local so rotated paths move correctly.
        const target: { x?: number | null; y?: number | null } =
          typeof opOr === "object" ? opOr : {};
        const head = nodes[idxs[0]];
        if (!head) return;
        const hw = pathNodeWorld(o, head);
        const tx = typeof target.x === "number" ? target.x : hw.x;
        const ty = typeof target.y === "number" ? target.y : hw.y;
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
        const local = worldToPathLocal(o, tx, ty);
        const dx = Math.round((local.x - head.x) * 10) / 10;
        const dy = Math.round((local.y - head.y) * 10) / 10;
        if (dx === 0 && dy === 0) return;
        const idxSet = new Set(idxs);
        const moved = nodes.map((n, i) =>
          idxSet.has(i) ? { ...n, x: n.x + dx, y: n.y + dy } : n
        );
        st.updateObject(o.id, renormPath(o, moved));
        break;
      }
      default:
        return;
    }
    st.pushHistory(snapshot);
  };

  /** Rubber-band node selection: every node of the active path inside the
   *  dragged rectangle is selected (Shift adds to the current set). */
  const finishNodeMarquee = (clientX: number, clientY: number) => {
    const g = nodeMarqueeRef.current;
    nodeMarqueeRef.current = null;
    setNodeMarquee(null);
    if (!g) return;
    const o = activeNodePath();
    if (!o || o.kind !== "path") return;
    const r = getRect();
    const cam = useDoc.getState().camera;
    const wx0 = (Math.min(g.sx, clientX) - r.left - cam.x) / cam.zoom;
    const wy0 = (Math.min(g.sy, clientY) - r.top - cam.y) / cam.zoom;
    const wx1 = (Math.max(g.sx, clientX) - r.left - cam.x) / cam.zoom;
    const wy1 = (Math.max(g.sy, clientY) - r.top - cam.y) / cam.zoom;
    // into the object's local frame (axis-aligned bounds of the rotated box)
    let lx0 = wx0 - o.x, ly0 = wy0 - o.y, lx1 = wx1 - o.x, ly1 = wy1 - o.y;
    if (o.rotation) {
      const a = (-o.rotation * Math.PI) / 180;
      const cx = o.w / 2, cy = o.h / 2;
      const rot = (px: number, py: number) => {
        const dx = px - cx, dy = py - cy;
        return {
          x: cx + dx * Math.cos(a) - dy * Math.sin(a),
          y: cy + dx * Math.sin(a) + dy * Math.cos(a),
        };
      };
      const corners = [rot(lx0, ly0), rot(lx1, ly0), rot(lx1, ly1), rot(lx0, ly1)];
      lx0 = Math.min(...corners.map((p) => p.x));
      lx1 = Math.max(...corners.map((p) => p.x));
      ly0 = Math.min(...corners.map((p) => p.y));
      ly1 = Math.max(...corners.map((p) => p.y));
    }
    const hit = editablePathNodes(o)
      .map((n, i) => (n.x >= lx0 && n.x <= lx1 && n.y >= ly0 && n.y <= ly1 ? i : -1))
      .filter((i) => i >= 0);
    const idx = g.add ? Array.from(new Set([...g.base, ...hit])) : hit;
    setNodeSel({ objId: o.id, idx });
  };

  /** Press on a segment: select its two endpoint nodes, then (if the pointer
   *  moves) drag the segment itself — a straight one bows into a curve, a
   *  curved one bulges, with the segment's midpoint tracking the cursor. */
  const onSegDown = (e: React.MouseEvent, objId: string, si: number) => {
    e.stopPropagation();
    e.preventDefault();
    const o = getPath(objId);
    if (!o) return;
    const nodes = editablePathNodes(o);
    if (nodes.length < 2) return;
    const segs: [number, number][] = [];
    for (let i = 0; i < nodes.length - 1; i++) segs.push([i, i + 1]);
    if (isClosedPath(o.d) && nodes.length >= 3) segs.push([nodes.length - 1, 0]);
    const seg = segs[si];
    if (!seg) return;
    const cur = nodeSelRef.current;
    const idx =
      e.shiftKey && cur?.objId === objId
        ? Array.from(new Set([...cur.idx, seg[0], seg[1]]))
        : [seg[0], seg[1]];
    setNodeSel({ objId, idx });
    segDragRef.current = {
      objId, si, orig: nodes, snapshot: snapshotObjects(),
      moved: false, sx: e.clientX, sy: e.clientY,
    };
    setDragCursor("grabbing");
    useDoc.getState().setGestureActive(true);
  };

  // ---------- right-click context menu (tool- and target-aware) ----------
  const openContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const st = useDoc.getState();
    const oidEl = (e.target as SVGElement).closest?.("[data-oid]");
    const oid = oidEl?.getAttribute("data-oid") ?? null;
    const o = oid ? st.objects.find((x) => x.id === oid) : undefined;
    // right-press selects what's under the cursor, like a first left click
    if (o && !o.locked && !o.hidden && !st.selection.includes(o.id)) {
      st.setSelection([o.id]);
    }
    const items: CtxItem[] = [];

    // shared background entries: selection, zoom, page fit
    const bgItems = (): CtxItem[] => {
      const out: CtxItem[] = [];
      if (st.objects.length > 0) {
        out.push({ label: "Select All", hint: "Ctrl+A", run: () => useDoc.getState().selectAll() });
      }
      if (st.selection.length > 0) {
        out.push({ label: "Deselect", run: () => useDoc.getState().clearSelection() });
      }
      out.push(
        { sep: true, label: "" },
        {
          label: "Zoom In",
          run: () => { const r = getRect(); useDoc.getState().zoomAt(r.width / 2, r.height / 2, 1.5); },
        },
        {
          label: "Zoom Out",
          run: () => { const r = getRect(); useDoc.getState().zoomAt(r.width / 2, r.height / 2, 1 / 1.5); },
        },
        { label: "Fit Page", run: () => fitPage() },
      );
      return out;
    };

    // node tool: node-level operations on paths, conversion for shapes
    if (st.tool === "node") {
      if (o) {
        if (o.kind === "path") {
          items.push({
            label: "Insert Node Here",
            run: () => { insertNodeAt(o.id, e.clientX, e.clientY); },
          });
          const ns = nodeSelRef.current;
          if (ns && ns.objId === o.id && ns.idx.length > 0) {
            items.push(
              {
                label: ns.idx.length === 1 ? "Delete Node" : `Delete ${ns.idx.length} Nodes`,
                hint: "Del",
                danger: true,
                run: () => { deleteSelectedNodes(true); },
              },
              {
                label: "Insert at Midpoints",
                hint: "Ins",
                run: () => { runNodeOp("insert"); },
              },
              {
                label: "Duplicate Nodes",
                hint: "Shift+D",
                run: () => { runNodeOp("dup"); },
              },
              { sep: true, label: "" },
              {
                label: "Make Cusp (corner)",
                run: () => { runNodeOp("cusp"); },
              },
              {
                label: "Make Smooth",
                run: () => { runNodeOp("smooth"); },
              },
              {
                label: "Make Symmetrical",
                run: () => { runNodeOp("sym"); },
              },
              { sep: true, label: "" },
              {
                label: ns.idx.length === 2 ? "Join Nodes" : "Join Nodes (2)",
                hint: "Shift+J",
                disabled: ns.idx.length !== 2,
                run: () => { runNodeOp("join"); },
              },
              { sep: true, label: "" },
              {
                label: "Align Nodes Horizontally",
                disabled: ns.idx.length < 2,
                run: () => { runNodeOp("alignH"); },
              },
              {
                label: "Align Nodes Vertically",
                disabled: ns.idx.length < 2,
                run: () => { runNodeOp("alignV"); },
              },
              {
                label: "Reverse Path Direction",
                run: () => { runNodeOp("reverse"); },
              },
              isClosedPath(o.d)
                ? { label: "Open Path", run: () => { runNodeOp("openPath"); } }
                : { label: "Close Path", run: () => { runNodeOp("closePath"); } },
            );
          }
        } else if (o.kind !== "text" && o.kind !== "image") {
          items.push({
            label: "Convert to Path",
            run: () => {
              const s = useDoc.getState();
              const cur = s.objects.find((x) => x.id === o.id);
              if (!cur || cur.kind === "path" || cur.kind === "text" || cur.kind === "image") return;
              const p = shapeToPath(cur);
              if (!p) return;
              s.checkpoint();
              useDoc.setState((u) => ({
                objects: u.objects.map((x) => (x.id === o.id ? p : x)),
              }));
            },
          });
        }
      }
      items.push(...bgItems());
      setCtxMenu({ x: e.clientX, y: e.clientY, items });
      return;
    }

    // bezier in progress: finish or close the live path
    if (st.tool === "bezier" && bezLiveRef.current.length >= 2) {
      items.push(
        { label: "Finish Path", hint: "Enter", run: () => commitBezier(false) },
        { label: "Close Path", run: () => commitBezier(true) },
      );
      setCtxMenu({ x: e.clientX, y: e.clientY, items });
      return;
    }

    // object under the cursor: the standard object menu
    if (o) {
      const editable = !o.locked && !o.hidden;
      if (o.kind === "text" && (st.tool === "move" || st.tool === "text")) {
        items.push({ label: "Edit Text", run: () => openEditor(o.id, o.text, false) });
      }
      items.push(
        {
          label: "Duplicate", hint: "Ctrl+D", disabled: !editable,
          run: () => useDoc.getState().duplicateSelection(),
        },
        {
          label: "Bring to Front", disabled: !editable,
          run: () => useDoc.getState().bringToFront(),
        },
        {
          label: "Send to Back", disabled: !editable,
          run: () => useDoc.getState().sendToBack(),
        },
        {
          label: o.hidden ? "Show" : "Hide",
          run: () => {
            const s = useDoc.getState();
            s.checkpoint();
            s.updateObject(o.id, { hidden: !o.hidden });
            if (!o.hidden) s.setSelection(s.selection.filter((x) => x !== o.id));
          },
        },
        { sep: true, label: "" },
        {
          label: "Delete", hint: "Del", danger: true, disabled: !editable,
          run: () => useDoc.getState().deleteSelection(),
        },
      );
      setCtxMenu({ x: e.clientX, y: e.clientY, items });
      return;
    }

    setCtxMenu({ x: e.clientX, y: e.clientY, items: bgItems() });
  };

  // changing tools closes any open context menu
  useEffect(() => {
    setCtxMenu(null);
  }, [tool]);

  const placeBezierNode = (wx: number, wy: number) => {
    const st = useDoc.getState();
    const live = bezLiveRef.current;
    const rwx = Math.round(wx * 10) / 10, rwy = Math.round(wy * 10) / 10;
    if (live.length >= 3) {
      const f = live[0];
      if (Math.hypot(rwx - f.x, rwy - f.y) < 10 / st.camera.zoom) {
        commitBezier(true);
        return;
      }
    }
    const next = [...live, { x: rwx, y: rwy, h1: null, h2: null }];
    setBez(next);
    setBezRubber(null);
    bezHoldRef.current = { index: next.length - 1 };
  };

  // ---------- eraser: splits line/path strokes along the gesture ----------
  const beginErase = (wx: number, wy: number) => {
    const st = useDoc.getState();
    eraserRef.current = {
      pts: [{ x: Math.round(wx), y: Math.round(wy) }],
      // screen-constant radius from the eraser's own SIZE, not outline WIDTH
      radius: st.toolOpts.eraserSize / st.camera.zoom,
      snapshot: structuredClone(st.objects),
    };
    setEraserLive([...eraserRef.current.pts]);
  };

  const applyErase = () => {
    const g = eraserRef.current;
    eraserRef.current = null;
    setEraserLive([]);
    if (!g || g.pts.length === 0) return;
    const st = useDoc.getState();
    const es = g.pts;
    // rotation-aware: unrotate eraser stroke + test point into the object's
    // local frame (bbox origin, unrotated about bbox center)
    const toLocalPts = (o: VecObject): { x: number; y: number }[] => {
      if (!o.rotation) return es.map((p) => ({ x: p.x - o.x, y: p.y - o.y }));
      const a = (-o.rotation * Math.PI) / 180;
      const cos = Math.cos(a), sin = Math.sin(a);
      const cx = o.w / 2, cy = o.h / 2;
      return es.map((p) => {
        const lx = p.x - o.x, ly = p.y - o.y;
        const dx = lx - cx, dy = ly - cy;
        return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
      });
    };
    const hitLocal = (o: VecObject, les: { x: number; y: number }[], x: number, y: number) => {
      void o;
      for (let i = 0; i < les.length; i++) {
        const a = les[Math.max(0, i - 1)], b = les[i];
        if (distToSeg(x, y, a.x, a.y, b.x, b.y) < g.radius) return true;
      }
      return false;
    };
    const removeIds = new Set<string>();
    const add: VecObject[] = [];
    // perimeter sampler for closed shapes: any touch deletes the whole
    // shape (splitting fills is out of scope); open strokes split below.
    const samplePerimeter = (o: VecObject): { x: number; y: number }[] | null => {
      const PER = 10;
      const edge = (ax: number, ay: number, bx: number, by: number): { x: number; y: number }[] => {
        const out: { x: number; y: number }[] = [];
        for (let k = 0; k <= PER; k++) {
          out.push({ x: ax + ((bx - ax) * k) / PER, y: ay + ((by - ay) * k) / PER });
        }
        return out;
      };
      switch (o.kind) {
        case "rect":
          return [
            ...edge(0, 0, o.w, 0),
            ...edge(o.w, 0, o.w, o.h),
            ...edge(o.w, o.h, 0, o.h),
            ...edge(0, o.h, 0, 0),
            { x: o.w / 2, y: o.h / 2 },
          ];
        case "ellipse": {
          const out: { x: number; y: number }[] = [];
          for (let k = 0; k < 40; k++) {
            const a = (k / 40) * Math.PI * 2;
            out.push({
              x: o.w / 2 + (o.w / 2) * Math.cos(a),
              y: o.h / 2 + (o.h / 2) * Math.sin(a),
            });
          }
          out.push({ x: o.w / 2, y: o.h / 2 });
          return out;
        }
        case "polygon":
        case "star": {
          const raw =
            o.kind === "polygon"
              ? polygonPoints(o.w / 2, o.h / 2, o.w / 2, o.h / 2, o.sides)
              : starPoints(o.w / 2, o.h / 2, o.w / 2, o.h / 2, o.points, o.innerRatio);
          const verts = raw.split(" ").map((s) => {
            const [vx, vy] = s.split(",").map(Number);
            return { x: vx, y: vy };
          });
          const out: { x: number; y: number }[] = [];
          for (let i = 0; i < verts.length; i++) {
            out.push(...edge(verts[i].x, verts[i].y, verts[(i + 1) % verts.length].x, verts[(i + 1) % verts.length].y));
          }
          out.push({ x: o.w / 2, y: o.h / 2 });
          return out;
        }
        default:
          return null;
      }
    };
    for (const o of st.objects) {
      if (o.locked || o.hidden) continue;
      // closed shapes + text + images: whole-object delete on any touch.
      // text/images erase by body hit; geometric shapes by perimeter or fill.
      // all tests run in the object's local (unrotated) frame.
      const les = toLocalPts(o);
      if (o.kind === "rect" || o.kind === "ellipse" || o.kind === "polygon" || o.kind === "star") {
        const samples = samplePerimeter(o);
        if (samples && samples.some((p) => hitLocal(o, les, p.x, p.y))) removeIds.add(o.id);
        continue;
      }
      if (o.kind === "text" || o.kind === "image") {
        const inside =
          les.some((p) => p.x >= -g.radius && p.x <= o.w + g.radius && p.y >= -g.radius && p.y <= o.h + g.radius) ||
          hitLocal(o, les, o.w / 2, o.h / 2);
        if (inside) removeIds.add(o.id);
        continue;
      }
      let local: { x: number; y: number }[] | null = null;
      if (o.kind === "line") {
        local = [{ x: 0, y: 0 }, { x: o.w, y: o.h }];
      } else if (o.kind === "path") {
        const pts = o.nodes ? sampleNodes(o.nodes) : parsePathPoints(o.d ?? "");
        if (pts.length >= 2) local = pts;
      }
      if (!local) continue;
      const erased = local.map((p) => hitLocal(o, les, p.x, p.y));
      if (!erased.some(Boolean)) continue;
      // split in local frame, then lift runs back to world for new objects
      const toWorldPt = (p: { x: number; y: number }) => {
        if (!o.rotation) return { x: p.x + o.x, y: p.y + o.y };
        const a = (o.rotation * Math.PI) / 180;
        const cos = Math.cos(a), sin = Math.sin(a);
        const cx = o.w / 2, cy = o.h / 2;
        const dx = p.x - cx, dy = p.y - cy;
        return { x: o.x + cx + dx * cos - dy * sin, y: o.y + cy + dx * sin + dy * cos };
      };
      const worldLocal = local.map(toWorldPt);
      const runs: { x: number; y: number }[][] = [];
      let cur: { x: number; y: number }[] = [];
      for (let i = 0; i < worldLocal.length; i++) {
        if (!erased[i]) cur.push(worldLocal[i]);
        else {
          if (cur.length >= 2) runs.push(cur);
          cur = [];
        }
      }
      if (cur.length >= 2) runs.push(cur);
      if (runs.length === 0) {
        // fully erased -> object goes; a surviving fragment too small
        // to split keeps the original (no silent data loss)
        if (erased.every(Boolean)) removeIds.add(o.id);
        continue;
      }
      removeIds.add(o.id);
      for (const run of runs) {
        const xs = run.map((p) => p.x), ys = run.map((p) => p.y);
        const bx = Math.min(...xs), by = Math.min(...ys);
        const rel = run.map((p) => ({
          x: Math.round((p.x - bx) * 10) / 10,
          y: Math.round((p.y - by) * 10) / 10,
        }));
        add.push({
          id: uid(), name: `${o.name}+`, kind: "path",
          x: Math.round(bx), y: Math.round(by),
          w: Math.max(1, Math.round((Math.max(...xs) - bx) * 10) / 10),
          h: Math.max(1, Math.round((Math.max(...ys) - by) * 10) / 10),
          rotation: 0, fill: "transparent",
          stroke: o.stroke, strokeWidth: o.strokeWidth, opacity: o.opacity,
          d: freehandToPath(rel),
        } as VecObject);
      }
    }
    if (removeIds.size === 0) return; // untouched: no history written
    const snapshot = g.snapshot;
    useDoc.setState((s) => ({
      objects: [...s.objects.filter((o) => !removeIds.has(o.id)), ...add],
      selection: add.map((a) => a.id),
      past: [...s.past, snapshot].slice(-50),
      future: [],
    }));
  };

  // ---------- selection box (transformable objects only) ----------
  const editableSel = objects.filter(
    (o) => selection.includes(o.id) && !o.locked && !o.hidden
  );
  const selBox: Box | null = (() => {
    if (tool !== "move" || editableSel.length === 0) return null;
    const xs = editableSel.flatMap((o) => [o.x, o.x + o.w]);
    const ys = editableSel.flatMap((o) => [o.y, o.y + o.h]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  })();
  const pivotPt =
    pivot ?? (selBox ? { x: selBox.x + selBox.w / 2, y: selBox.y + selBox.h / 2 } : { x: 0, y: 0 });

  const snapshotObjects = (): VecObject[] =>
    structuredClone(useDoc.getState().objects);

  const onScaleDown = (e: React.MouseEvent, handle: ScaleHandle) => {
    e.stopPropagation();
    e.preventDefault(); // gesture starts must never start a text selection
    if (!selBox || editableSel.length === 0) return;
    resizeRef.current = {
      handle,
      sx: e.clientX, sy: e.clientY,
      box: { ...selBox },
      objs: structuredClone(editableSel),
      snapshot: snapshotObjects(),
      moved: false,
    };
    setDragCursor(SCALE_CURSORS[handle]);
    useDoc.getState().setGestureActive(true);
  };

  const onRotateDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault(); // gesture starts must never start a text selection
    if (editableSel.length === 0) return;
    const { wx, wy } = toWorld(e.clientX, e.clientY);
    const startRot = new Map<string, number>();
    const origPos = new Map<string, { x: number; y: number }>();
    for (const o of editableSel) {
      startRot.set(o.id, o.rotation);
      origPos.set(o.id, { x: o.x + o.w / 2, y: o.y + o.h / 2 });
    }
    rotateRef.current = {
      px: pivotPt.x, py: pivotPt.y,
      startAngle: (Math.atan2(wy - pivotPt.y, wx - pivotPt.x) * 180) / Math.PI,
      startRot,
      origPos,
      snapshot: snapshotObjects(),
      moved: false,
    };
    setDragCursor("grabbing");
    useDoc.getState().setGestureActive(true);
  };

  const onPivotDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault(); // gesture starts must never start a text selection
    pivotDragRef.current = true;
    setDragCursor("move");
  };

  // ---------- shared pan starter (background AND objects) ----------
  const beginPan = (clientX: number, clientY: number) => {
    const cam = useDoc.getState().camera;
    panRef.current = { sx: clientX, sy: clientY, cx: cam.x, cy: cam.y };
    setPanning(true);
    setDragCursor("grabbing");
  };

  // ---------- object press (select / drag / pick) ----------
  const onObjectDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault(); // gesture starts must never start a text selection
    if (e.button === 2) return; // right press: the context menu owns it
    if (editingRef.current) commitEdit();
    const st = useDoc.getState();
    if (spaceHeldRef.current || e.button === 1) {
      beginPan(e.clientX, e.clientY);
      return;
    }
    if (st.tool === "zoom") { beginZoom(e.clientX, e.clientY); return; }
    if (st.tool === "eraser") {
      const { wx, wy } = toWorld(e.clientX, e.clientY);
      beginErase(wx, wy);
      return;
    }
    if (st.tool === "node") {
      const o = st.objects.find((x) => x.id === id);
      if (!o || o.locked || o.hidden) return;
      if (o.kind === "text" || o.kind === "image") {
        if (e.shiftKey) st.toggleSelect(id);
        else st.setSelection([id]);
        flashErr(
          o.kind === "text"
            ? "text → path needs glyph outlines — roadmap; use BREAK on shapes for now"
            : "images can't be node-edited"
        );
        return;
      }
      if (o.kind !== "path") {
        // geometric shapes auto-convert (one undo step), like Inkscape
        const p = shapeToPath(o);
        if (!p) return;
        st.checkpoint();
        useDoc.setState((s) => ({
          objects: s.objects.map((x) => (x.id === id ? p : x)),
        }));
      }
      if (e.shiftKey) st.toggleSelect(id);
      else st.setSelection([id]);
      setNodeSel({ objId: id, idx: [] });
      return;
    }
    if (st.tool === "bezier") {
      const { wx, wy } = toWorld(e.clientX, e.clientY);
      placeBezierNode(wx, wy);
      return;
    }
    if (st.tool === "break") {
      breakObject(id);
      return;
    }
    if (st.tool === "image") {
      const { wx, wy } = toWorld(e.clientX, e.clientY);
      openImagePicker(wx, wy);
      return;
    }
    if (st.tool === "eye") {
      const o = st.objects.find((x) => x.id === id);
      if (o && o.kind === "image") {
        st.setTool("move");
        return;
      }
      if (o && o.kind !== "line") useDoc.setState({ fill: o.fill });
      if (o) {
        useDoc.setState({
          stroke: o.stroke === "transparent" ? "none" : o.stroke,
          strokeWidth: o.strokeWidth,
          opacity: o.opacity,
        });
      }
      if (o) {
        // renderable colors only: never evict recents with invisible slots
        const isHex = (v: string) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
        const picked = [o.fill, o.stroke].filter(isHex);
        if (picked.length > 0) {
          useDoc.setState((s) => ({
            recents: [...picked.filter((c) => !s.recents.includes(c)), ...s.recents].slice(0, 6),
          }));
        }
      }
      st.setTool("move");
      return;
    }
    if (st.tool !== "move") return;
    const o = st.objects.find((x) => x.id === id);
    if (!o || o.hidden) return;
    // locked objects are not selectable on canvas (use Layers to unlock)
    if (o.locked) return;
    const wasSelected = st.selection.includes(id);
    if (e.shiftKey) st.toggleSelect(id);
    else if (!wasSelected) st.setSelection([id]);
    // origins cover editable objects only: locked/hidden never ride along
    const fresh = useDoc.getState();
    const orig = new Map<string, { x: number; y: number }>();
    for (const obj of fresh.objects) {
      if (fresh.selection.includes(obj.id) && !obj.locked && !obj.hidden) {
        orig.set(obj.id, { x: obj.x, y: obj.y });
      }
    }
    dragRef.current = {
      sx: e.clientX, sy: e.clientY, orig,
      wasSelected: wasSelected && !e.shiftKey,
      moved: false,
      snapshot: snapshotObjects(),
    };
    setDragCursor("grabbing");
    st.setGestureActive(true);
  };

  // ---------- background press ----------
  const onBackgroundDown = (e: React.MouseEvent) => {
    e.preventDefault(); // never let background drags select the empty-state text
    if (e.button === 2) return; // right press: the context menu owns it
    if (editingRef.current) commitEdit();
    if (spaceHeldRef.current || e.button === 1) {
      beginPan(e.clientX, e.clientY);
      return;
    }
    const st = useDoc.getState();
    if (st.tool === "zoom") { beginZoom(e.clientX, e.clientY); return; }
    if (st.tool === "eraser") {
      const { wx, wy } = toWorld(e.clientX, e.clientY);
      beginErase(wx, wy);
      return;
    }
    if (st.tool === "bezier") {
      const { wx, wy } = toWorld(e.clientX, e.clientY);
      placeBezierNode(wx, wy);
      return;
    }
    if (st.tool === "node") {
      // rubber-band node selection over the active path (Inkscape-style)
      nodeMarqueeRef.current = {
        sx: e.clientX, sy: e.clientY,
        add: e.shiftKey,
        base: nodeSelRef.current?.idx ?? [],
      };
      setNodeMarquee({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
      return;
    }
    if (st.tool === "break" || st.tool === "eye") {
      // these tools act on objects only: background clicks do nothing
      return;
    }
    if (st.tool === "image") {
      const { wx, wy } = toWorld(e.clientX, e.clientY);
      openImagePicker(wx, wy);
      return;
    }
    if (DRAW_TOOLS.includes(st.tool)) {
      const { wx, wy } = toWorld(e.clientX, e.clientY);
      createRef.current = { sx: e.clientX, sy: e.clientY, wx, wy };
      if (st.tool === "pen") {
        penRef.current = [{ x: Math.round(wx), y: Math.round(wy) }];
        setPenLive([...penRef.current]);
      } else {
        setPreview({ x0: wx, y0: wy, x1: wx, y1: wy, shift: e.shiftKey });
      }
      return;
    }
    if (st.tool === "move" && !e.shiftKey) st.clearSelection();
  };

  // pointer rate (120Hz+) coalesced to one store flush per frame
  const queueMove = (clientX: number, clientY: number, shiftKey: boolean, altKey: boolean, ctrlKey = false) => {
    pendingMoveRef.current = { clientX, clientY, shiftKey, altKey, ctrlKey };
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const ev = pendingMoveRef.current;
        pendingMoveRef.current = null;
        if (ev) handleMove(ev);
      });
    }
  };
  const onMove = (e: React.MouseEvent) => queueMove(e.clientX, e.clientY, e.shiftKey, e.altKey, e.ctrlKey);
  // window-level indirection: the always-on listener below must reach the
  // latest closure, not the one captured at mount (same pattern as finishRef)
  queueMoveRef.current = queueMove;

  const handleMove = (e: StashedMove) => {
    const { wx, wy } = toWorld(e.clientX, e.clientY);
    // status cursor: rounded, change-checked, ~12Hz max — never a render storm
    const cxr = Math.round(wx), cyr = Math.round(wy);
    const now = performance.now();
    const lc = lastCursorRef.current;
    if ((cxr !== lc.x || cyr !== lc.y) && now - lc.t > 80) {
      lastCursorRef.current = { x: cxr, y: cyr, t: now };
      setCursor(cxr, cyr);
    }
    const p = panRef.current;
    if (p) {
      useDoc.setState((s) => ({
        camera: { ...s.camera, x: p.cx + (e.clientX - p.sx), y: p.cy + (e.clientY - p.sy) },
      }));
      return;
    }
    const st = useDoc.getState();
    // zoom marquee
    if (zoomRef.current) {
      const z = zoomRef.current;
      setZoomBox({ x0: z.sx, y0: z.sy, x1: e.clientX, y1: e.clientY });
      return;
    }
    // node marquee (rubber-band node selection)
    if (nodeMarqueeRef.current) {
      setNodeMarquee((m) => (m ? { ...m, x1: e.clientX, y1: e.clientY } : m));
      return;
    }
    // creation preview
    if (createRef.current && st.tool !== "pen" && st.tool !== "text") {
      const c = createRef.current;
      setPreview({ x0: c.wx, y0: c.wy, x1: wx, y1: wy, shift: e.shiftKey });
      return;
    }
    // pen tracing
    if (createRef.current && st.tool === "pen") {
      const last = penRef.current[penRef.current.length - 1];
      if (!last || Math.hypot(wx - last.x, wy - last.y) > 3 / st.camera.zoom) {
        penRef.current.push({ x: Math.round(wx), y: Math.round(wy) });
        setPenLive([...penRef.current]);
      }
      return;
    }
    // bezier: pull handles while held, rubber-band when free
    // Alt-drag = cusp (independent outgoing handle), plain drag = smooth mirror
    if (st.tool === "bezier" && bezLiveRef.current.length > 0) {
      const live = bezLiveRef.current;
      const hold = bezHoldRef.current;
      const hn = hold ? live[hold.index] : undefined;
      if (hn) {
        const dx = Math.round((wx - hn.x) * 10) / 10;
        const dy = Math.round((wy - hn.y) * 10) / 10;
        if (Math.hypot(dx, dy) > 2 / st.camera.zoom) {
          const upd = [...live];
          upd[hold!.index] = e.altKey
            ? { ...hn, h2: { x: dx, y: dy }, t: "cusp" }
            : { ...hn, h2: { x: dx, y: dy }, h1: { x: -dx, y: -dy }, t: "smooth" };
          setBez(upd);
        }
      } else {
        setBezRubber({ x: Math.round(wx * 10) / 10, y: Math.round(wy * 10) / 10 });
      }
      return;
    }
    // eraser tracing
    if (st.tool === "eraser" && eraserRef.current) {
      const pts = eraserRef.current.pts;
      const last = pts[pts.length - 1];
      if (Math.hypot(wx - last.x, wy - last.y) > 2) {
        pts.push({ x: Math.round(wx), y: Math.round(wy) });
        setEraserLive([...pts]);
      }
      return;
    }
    // pivot drag
    if (pivotDragRef.current) {
      setPivot({ x: Math.round(wx), y: Math.round(wy) });
      return;
    }
    // resize drag
    const rs = resizeRef.current;
    if (rs) {
      const dx = (e.clientX - rs.sx) / st.camera.zoom;
      const dy = (e.clientY - rs.sy) / st.camera.zoom;
      const { box: nb, mx, my } = resizeBox(rs.box, rs.handle, dx, dy, e.shiftKey, e.altKey);
      // note: text wrap/measure deferred to gesture end (cheap fontSize scale live)
      // geometry comes from the frozen snapshot, but paint is re-sourced live
      // every frame so a color edit mid-drag survives the next flush
      const liveColors = new Map(st.objects.map((o) => [o.id, o] as const));
      const byId = new Map(
        rs.objs.map((o) => {
          const t = transformObject(o, rs.box, nb, { mx, my });
          const lv = liveColors.get(o.id);
          if (lv) {
            t.fill = lv.fill;
            t.stroke = lv.stroke;
            t.strokeWidth = lv.strokeWidth;
            t.opacity = lv.opacity;
          }
          return [o.id, t] as const;
        })
      );
      if (
        nb.x !== rs.box.x || nb.y !== rs.box.y || nb.w !== rs.box.w || nb.h !== rs.box.h ||
        mx || my
      ) {
        rs.moved = true;
      }
      useDoc.setState((s) => ({
        objects: s.objects.map((o) => byId.get(o.id) ?? o),
      }));
      return;
    }
    // rotate drag: each center orbits the pivot, angles follow
    const rt = rotateRef.current;
    if (rt) {
      // dead zone at the pivot: angle undefined there, hold last pose
      if (Math.hypot(wx - rt.px, wy - rt.py) < 8 / st.camera.zoom) return;
      const ang = (Math.atan2(wy - rt.py, wx - rt.px) * 180) / Math.PI;
      let d = ang - rt.startAngle;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      if (Math.abs(d) > 0.5) rt.moved = true;
      if (e.shiftKey) {
        // magnetic 15° on the delta: sticks near steps, never jumps
        const snapped = Math.round(d / 15) * 15;
        if (Math.abs(d - snapped) <= 4) d = snapped;
      }
      const rad = (d * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const updates = new Map<string, { x: number; y: number; rotation: number }>();
      for (const [id, r0] of rt.startRot) {
        const p0 = rt.origPos.get(id);
        if (!p0) continue;
        updates.set(id, {
          x: rt.px + (p0.x - rt.px) * cos - (p0.y - rt.py) * sin,
          y: rt.py + (p0.x - rt.px) * sin + (p0.y - rt.py) * cos,
          rotation: Math.round((r0 + d) * 10) / 10,
        });
      }
      useDoc.setState((s) => ({
        objects: s.objects.map((o) => {
          const u = updates.get(o.id);
          if (!u) return o;
          // updates store centers: convert back to top-left
          return {
            ...o,
            x: Math.round((u.x - o.w / 2) * 10) / 10,
            y: Math.round((u.y - o.h / 2) * 10) / 10,
            rotation: u.rotation,
          };
        }),
      }));
      return;
    }
    // segment drag: the segment's midpoint follows the cursor exactly
    const sd = segDragRef.current;
    if (sd) {
      const o0 = getPath(sd.objId);
      if (!o0) return;
      const z = st.camera.zoom;
      let dx = (e.clientX - sd.sx) / z, dy = (e.clientY - sd.sy) / z;
      if (o0.rotation) {
        const a = (-o0.rotation * Math.PI) / 180;
        const rx = dx * Math.cos(a) - dy * Math.sin(a);
        const ry = dx * Math.sin(a) + dy * Math.cos(a);
        dx = rx; dy = ry;
      }
      if (Math.hypot(e.clientX - sd.sx, e.clientY - sd.sy) > 2) sd.moved = true;
      if (sd.moved) {
        writeNodesLive(sd.objId, dragSegment(sd.orig, sd.si, isClosedPath(o0.d), dx, dy));
      }
      return;
    }
    // node drag (screen delta rotated into the object's local frame)
    const nd = nodeDragRef.current;
    if (nd) {
      const z = st.camera.zoom;
      let dx = (e.clientX - nd.sx) / z, dy = (e.clientY - nd.sy) / z;
      const o0 = useDoc.getState().objects.find((x) => x.id === nd.objId);
      const rot = o0?.rotation ?? 0;
      if (rot) {
        const a = (-rot * Math.PI) / 180;
        const rx = dx * Math.cos(a) - dy * Math.sin(a);
        const ry = dx * Math.sin(a) + dy * Math.cos(a);
        dx = rx; dy = ry;
      }
      if (e.ctrlKey) {
        // Ctrl constrains the node to one axis (dominant direction wins)
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      if (Math.hypot(e.clientX - nd.sx, e.clientY - nd.sy) > 2) nd.moved = true;
      if (nd.moved) {
        let upd = nd.orig.map((n, i) =>
          nd.idx.includes(i) ? { ...n, x: n.x + dx, y: n.y + dy } : n
        );
        // magnetic snapping: measured on the first selected node, applied to
        // the whole selection so multi-node drags stay rigid
        let hint: { x: number; y: number } | null = null;
        if (o0 && o0.kind === "path" && useDoc.getState().nodeSnap) {
          const first = upd[nd.idx[0]];
          if (first) {
            const w = pathNodeWorld(o0, first);
            const targets: { x: number; y: number }[] = [];
            for (const oo of st.objects) {
              if (oo.hidden || oo.kind !== "path") continue;
              const ns = editablePathNodes(oo);
              for (let i = 0; i < ns.length; i++) {
                if (oo.id === o0.id && nd.idx.includes(i)) continue; // moving
                targets.push(pathNodeWorld(oo, ns[i]));
              }
            }
            const s = snapWorldPoint(w.x, w.y, 6 / z, targets);
            if (s.snapped) {
              const back = worldToPathLocal(o0, s.x, s.y);
              const adx = back.x - first.x, ady = back.y - first.y;
              upd = upd.map((n, i) =>
                nd.idx.includes(i) ? { ...n, x: n.x + adx, y: n.y + ady } : n
              );
              hint = { x: s.x, y: s.y };
            }
          }
        }
        setSnapHint(hint);
        writeNodesLive(nd.objId, upd);
      }
      return;
    }
    // bezier-handle drag (Alt = independent, plain = mirrored)
    const hd = handleDragRef.current;
    if (hd) {
      const o = getPath(hd.objId);
      if (o) {
        const z = st.camera.zoom;
        let dx = (e.clientX - hd.sx) / z, dy = (e.clientY - hd.sy) / z;
        if (o.rotation) {
          const a = (-o.rotation * Math.PI) / 180;
          const rx = dx * Math.cos(a) - dy * Math.sin(a);
          const ry = dx * Math.sin(a) + dy * Math.cos(a);
          dx = rx; dy = ry;
        }
        if (Math.hypot(e.clientX - hd.sx, e.clientY - hd.sy) > 2) hd.moved = true;
        if (hd.moved) {
          const base = hd.orig[hd.index];
          const start = base[hd.which] ?? { x: 0, y: 0 };
          let nh = { x: start.x + dx, y: start.y + dy };
          if (e.ctrlKey) {
            // Ctrl: 15° angle steps around the node, length preserved
            const len = Math.hypot(nh.x, nh.y);
            const step = Math.PI / 12;
            const ang = Math.round(Math.atan2(nh.y, nh.x) / step) * step;
            nh = { x: Math.cos(ang) * len, y: Math.sin(ang) * len };
          }
          const upd = [...hd.orig];
          upd[hd.index] = e.altKey
            ? { ...base, [hd.which]: nh, t: "cusp" }
            : { ...base, h1: hd.which === "h1" ? nh : { x: -nh.x, y: -nh.y }, h2: hd.which === "h2" ? nh : { x: -nh.x, y: -nh.y }, t: "smooth" };
          writeNodesLive(hd.objId, upd);
        }
      }
      return;
    }
    // dragging selection
    const d = dragRef.current;
    if (d) {
      let dx = (e.clientX - d.sx) / st.camera.zoom;
      let dy = (e.clientY - d.sy) / st.camera.zoom;
      if (e.shiftKey) {
        // magnetic grid: sticks only near a line, never teleports
        const t = 6 / st.camera.zoom;
        const mag = (v: number) => {
          const r = Math.round(v / 8) * 8;
          return Math.abs(v - r) <= t ? r : Math.round(v * 10) / 10;
        };
        dx = mag(dx);
        dy = mag(dy);
      }
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 3) d.moved = true;
      const orig = d.orig;
      useDoc.setState((s) => ({
        objects: s.objects.map((o) => {
          const o0 = orig.get(o.id);
          return o0
            ? { ...o, x: Math.round((o0.x + dx) * 10) / 10, y: Math.round((o0.y + dy) * 10) / 10 }
            : o;
        }),
      }));
    }
  };

  // shared: normalize absolute points into a bbox-relative path object
  const commitPointsAsPath = (
    st: ReturnType<typeof useDoc.getState>,
    pts: { x: number; y: number }[],
    name: string,
    d?: string
  ) => {
    if (pts.length < 2) return;
    const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
    const bx = Math.min(...xs), by = Math.min(...ys);
    const rel = pts.map((q) => ({ x: Math.round((q.x - bx) * 10) / 10, y: Math.round((q.y - by) * 10) / 10 }));
    const n = st.objects.length + 1;
    const paint = sanitizeCreation(st.fill, st.stroke, st.strokeWidth, "stroke");
    st.addObject({
      id: uid(), name: `${name} ${n}`, kind: "path",
      x: Math.round(bx), y: Math.round(by),
      w: Math.max(1, Math.round((Math.max(...xs) - bx) * 10) / 10),
      h: Math.max(1, Math.round((Math.max(...ys) - by) * 10) / 10),
      rotation: 0, fill: paint.fill, stroke: paint.stroke,
      strokeWidth: paint.strokeWidth, opacity: st.opacity,
      d: d ?? freehandToPath(rel),
    });
  };

  const commitCreation = (e: React.MouseEvent) => {
    const st = useDoc.getState();
    const c = createRef.current;
    createRef.current = null;
    if (!c) return;
    const distPx = Math.hypot(e.clientX - c.sx, e.clientY - c.sy);

    if (st.tool === "text") {
      const n = st.objects.length + 1;
      const fs = st.toolOpts.textSize;
      // drag = fixed-width wrapped box, click = growing point text
      const wrapW = distPx > 6
        ? Math.max(40, Math.round(Math.abs(e.clientX - c.sx) / st.camera.zoom))
        : null;
      const id = uid();
      const paint = sanitizeCreation(st.fill, st.stroke, st.strokeWidth, "text");
      st.addObject({
        id, name: `text ${n}`, kind: "text",
        x: Math.round(c.wx), y: Math.round(c.wy),
        w: wrapW ?? 60, h: Math.round(fs * LINE_H),
        rotation: 0, fill: paint.fill,
        stroke: paint.stroke, strokeWidth: paint.strokeWidth, opacity: st.opacity,
        text: "", lines: [""], wrapW, fontSize: fs,
        fontWeight: nearestWeight(st.textFont, 500),
        fontFamily: st.textFont,
      });
      setPreview(null);
      openEditor(id, "", true);
      return;
    }

    if (st.tool === "pen") {
      const pts = penRef.current;
      penRef.current = [];
      setPenLive([]);
      commitPointsAsPath(st, pts, "path");
      return;
    }

    if (st.tool === "spiral") {
      const pv = preview;
      setPreview(null);
      if (!pv) return;
      const cx = (pv.x0 + pv.x1) / 2, cy = (pv.y0 + pv.y1) / 2;
      const maxR = Math.min(Math.abs(pv.x1 - pv.x0), Math.abs(pv.y1 - pv.y0)) / 2;
      if (maxR < 4) return;
      const pts = spiralPoints(Math.round(cx), Math.round(cy), Math.round(maxR), st.toolOpts.spiralTurns);
      commitPointsAsPath(st, pts, "spiral");
      return;
    }

    const pv = preview;
    setPreview(null);
    if (!pv) return;
    // Shift may have been released between the last mousemove and mouseup:
    // the drag preview remembers it, so squares / 45° lines survive release.
    const shift = e.shiftKey || pv.shift;
    let { x0, y0, x1, y1 } = pv;
    if (shift && st.tool !== "line") {
      const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      x1 = x0 + Math.sign(x1 - x0 || 1) * s;
      y1 = y0 + Math.sign(y1 - y0 || 1) * s;
    }
    if (st.tool === "line" && shift) {
      const dx = x1 - x0, dy = y1 - y0;
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      x1 = x0 + Math.cos(ang) * len;
      y1 = y0 + Math.sin(ang) * len;
    }
    const x = Math.round(Math.min(x0, x1)), y = Math.round(Math.min(y0, y1));
    const w = Math.round(Math.abs(x1 - x0)), h = Math.round(Math.abs(y1 - y0));
    if (w < 3 && h < 3) return;
    const n = st.objects.length + 1;
    const shapePaint = sanitizeCreation(st.fill, st.stroke, st.strokeWidth, "shape");
    const strokePaint = sanitizeCreation(st.fill, st.stroke, st.strokeWidth, "stroke");
    const base = {
      id: uid(), x, y, w: Math.max(w, 2), h: Math.max(h, 2),
      rotation: 0, fill: shapePaint.fill, stroke: shapePaint.stroke,
      strokeWidth: shapePaint.strokeWidth, opacity: st.opacity,
    };
    let obj: VecObject;
    if (st.tool === "rect") obj = { ...base, name: `rect ${n}`, kind: "rect", rx: st.toolOpts.rectRx };
    else if (st.tool === "ellipse") obj = { ...base, name: `ellipse ${n}`, kind: "ellipse" };
    else if (st.tool === "line") obj = { ...base, name: `line ${n}`, kind: "line", fill: strokePaint.fill, stroke: strokePaint.stroke, strokeWidth: strokePaint.strokeWidth };
    else if (st.tool === "polygon") obj = { ...base, name: `polygon ${n}`, kind: "polygon", sides: st.toolOpts.polySides };
    else obj = { ...base, name: `star ${n}`, kind: "star", points: st.toolOpts.starPoints, innerRatio: 0.45 };
    st.addObject(obj);
  };

  const onUp = (e: React.MouseEvent) => {
    finishGesture(e.clientX, e.clientY, e.altKey, e.shiftKey);
  };

  /** Push history for doc-mutating gestures and drop all gesture refs. */
  const commitDocGestures = () => {
    const st = useDoc.getState();
    st.setGestureActive(false);
    panRef.current = null;
    setPanning(false);
    pivotDragRef.current = false;
    setDragCursor(null);
    const rs = resizeRef.current;
    resizeRef.current = null;
    if (rs && rs.moved) {
      // finalize text wrap/measure once per gesture (not per pixel)
      const textIds = new Set(
        rs.objs.filter((o) => o.kind === "text").map((o) => o.id)
      );
      if (textIds.size > 0) {
        useDoc.setState((s) => ({
          objects: s.objects.map((o) => {
            if (!textIds.has(o.id) || o.kind !== "text") return o;
            return { ...o, ...syncTextBox(o) };
          }),
        }));
      }
      st.pushHistory(rs.snapshot);
    }
    const rt = rotateRef.current;
    rotateRef.current = null;
    if (rt && rt.moved) st.pushHistory(rt.snapshot);
    const dg = dragRef.current;
    dragRef.current = null;
    if (dg && dg.moved) st.pushHistory(dg.snapshot);
    const ndr = nodeDragRef.current;
    nodeDragRef.current = null;
    if (ndr && ndr.moved) {
      const o = getPath(ndr.objId);
      if (o) {
        st.updateObject(ndr.objId, renormPath(o, editablePathNodes(o)));
        st.pushHistory(ndr.snapshot);
      }
    }
    const hdr = handleDragRef.current;
    handleDragRef.current = null;
    if (hdr && hdr.moved) {
      const o = getPath(hdr.objId);
      if (o) {
        st.updateObject(hdr.objId, renormPath(o, editablePathNodes(o)));
        st.pushHistory(hdr.snapshot);
      }
    }
    const sdg = segDragRef.current;
    segDragRef.current = null;
    if (sdg && sdg.moved) {
      const o = getPath(sdg.objId);
      if (o) {
        st.updateObject(sdg.objId, renormPath(o, editablePathNodes(o)));
        st.pushHistory(sdg.snapshot);
      }
    }
    setSnapHint(null);
  };

  /** Commit every in-flight gesture. Idempotent: refs null after first run. */
  const finishGesture = (clientX: number, clientY: number, altKey: boolean, shiftKey = false) => {
    if (nodeMarqueeRef.current) finishNodeMarquee(clientX, clientY);
    commitDocGestures();
    bezHoldRef.current = null;
    if (eraserRef.current) applyErase();
    if (zoomRef.current) commitZoom(clientX, clientY, altKey);
    if (createRef.current) commitCreation({ clientX, clientY, shiftKey } as React.MouseEvent);
    // NOTE: a plain click must never flip scale/rotate mode — that made the
    // next drag suddenly rotate. Rotate is entered by double-click on a
    // selected object (see onDoubleClick) or the options-bar mode buttons.
  };

  finishRef.current = (x, y, altKey = false, shiftKey = false) =>
    finishGesture(x, y, altKey, shiftKey);

  const gridOpacity = camera.zoom < 0.35 ? 0.18 : camera.zoom < 0.7 ? 0.45 : 0.9;

  const editingObj = editing
    ? objects.find((o) => o.id === editing.id)
    : undefined;
  const editingText =
    editingObj && editingObj.kind === "text" ? editingObj : undefined;

  const normPreview = () => {
    if (!preview) return null;
    const x = Math.min(preview.x0, preview.x1), y = Math.min(preview.y0, preview.y1);
    return { x, y, w: Math.abs(preview.x1 - preview.x0), h: Math.abs(preview.y1 - preview.y0) };
  };
  const np = normPreview();

  const rectNow = rectCache.current;
  const gridBox = visibleWorld(
    camera,
    rectNow ? rectNow.width : 1200,
    rectNow ? rectNow.height : 800
  );

  return (
    <main
      ref={boxRef}
      className="vl-canvas"
      style={{ cursor: dragCursor ?? (panning ? "grabbing" : spaceHeld ? "grab" : tool === "move" ? "default" : "crosshair") }}
      onMouseDown={onBackgroundDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onContextMenu={openContextMenu}
      onDoubleClick={(e) => {
        if (useDoc.getState().tool === "bezier" && bezLiveRef.current.length >= 2) {
          commitBezier(false, true); // drop the doubled click node, finish open
          return;
        }
        const oidEl = (e.target as SVGElement).closest?.("[data-oid]");
        if (oidEl) {
          const oid = oidEl.getAttribute("data-oid")!;
          const t = useDoc.getState().tool;
          if (t === "node") {
            if (insertNodeAt(oid, e.clientX, e.clientY)) return;
          }
          const o = useDoc.getState().objects.find((x) => x.id === oid);
          if (o && o.kind === "text" && (t === "move" || t === "text")) {
            openEditor(oid, o.text, false);
            return;
          }
          // double-click on a selected object toggles the rotate handles
          // (text objects double-click into the editor above instead)
          if (o && t === "move" && o.kind !== "text" && !o.locked && !o.hidden) {
            if (useDoc.getState().selection.includes(oid)) setMode(!rotateModeRef.current);
            return;
          }
        }
        const t = e.target as SVGElement;
        if (t.dataset.bg || t.dataset.page) fitPage();
      }}
    >
      <svg width="100%" height="100%" display="block">
        <defs>
          <pattern id="vl-dots" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
            <circle cx={1} cy={1} r={1} fill="#26282e" />
          </pattern>
        </defs>
        <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.zoom})`}>
          <rect
            data-bg="1"
            x={gridBox.x} y={gridBox.y} width={gridBox.w} height={gridBox.h}
            fill="url(#vl-dots)" opacity={gridOpacity}
          />
          <g opacity={0.8}>
            <line x1={-14} y1={0} x2={14} y2={0} stroke="#00f0ff" strokeWidth={1 / camera.zoom} opacity={0.6} />
            <line x1={0} y1={-14} x2={0} y2={14} stroke="#00f0ff" strokeWidth={1 / camera.zoom} opacity={0.6} />
          </g>
          {/* white design page (exports map to these bounds) */}
          <rect
            data-page="1"
            x={-page.w / 2 + 7} y={-page.h / 2 + 9}
            width={page.w} height={page.h}
            fill="#000000" opacity={0.55}
          />
          <rect
            data-page="1"
            x={-page.w / 2} y={-page.h / 2}
            width={page.w} height={page.h}
            fill="#ffffff" stroke="#000000" strokeWidth={1 / camera.zoom}
          />
          <text
            x={-page.w / 2} y={page.h / 2 + 22 / camera.zoom}
            fontFamily="'JetBrains Mono', monospace"
            fontSize={12 / camera.zoom}
            fill="#5c5f66"
            pointerEvents="none"
          >
            {page.name} · {page.w}×{page.h}
          </text>
          {objects
            .filter((o) => o.id !== editing?.id)
            .map((o) => (
              <ObjectNode
                key={o.id}
                o={o}
                selected={selection.includes(o.id)}
                zoom={camera.zoom}
                dimmed={
                  o.x + o.w < -page.w / 2 || o.x > page.w / 2 ||
                  o.y + o.h < -page.h / 2 || o.y > page.h / 2
                }
                onDown={onObjectDown}
              />
            ))}
          {editingText && editing && (
            <foreignObject
              x={editingText.x - 6}
              y={editingText.y - 6}
              width={Math.max(editingText.w + 140, 220)}
              height={editingText.h + editingText.fontSize * LINE_H + 32}
            >
              <textarea
                className="vl-text-edit"
                value={editing.draft}
                autoFocus
                placeholder="type…"
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onChange={(e) => onEditChange(e.target.value)}
                onSelect={onEditSelect}
                onBlur={onEditBlur}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") commitEdit();
                }}
                style={{
                  fontSize: editingText.fontSize,
                  fontWeight: editingText.fontWeight,
                  fontFamily: fontCss(editingText.fontFamily),
                  color: editingText.fill,
                  lineHeight: LINE_H,
                }}
              />
            </foreignObject>
          )}
          {bezLive.length > 0 && (
            <g pointerEvents="none">
              <path
                d={bezierToPath(bezLive, false)}
                fill="none" stroke="#00f0ff" strokeWidth={2 / camera.zoom}
              />
              {bezRubber && bezLive.length > 0 && (
                <line
                  x1={bezLive[bezLive.length - 1].x} y1={bezLive[bezLive.length - 1].y}
                  x2={bezRubber.x} y2={bezRubber.y}
                  stroke="#00f0ff" strokeWidth={1 / camera.zoom}
                  strokeDasharray={`${4 / camera.zoom} ${3 / camera.zoom}`} opacity={0.7}
                />
              )}
              {bezLive.map((n, i) => (
                <g key={i}>
                  {n.h1 && (
                    <line x1={n.x} y1={n.y} x2={n.x + n.h1.x} y2={n.y + n.h1.y}
                      stroke="#7c3aed" strokeWidth={1 / camera.zoom} />
                  )}
                  {n.h2 && (
                    <line x1={n.x} y1={n.y} x2={n.x + n.h2.x} y2={n.y + n.h2.y}
                      stroke="#7c3aed" strokeWidth={1 / camera.zoom} />
                  )}
                  {n.h1 && <circle cx={n.x + n.h1.x} cy={n.y + n.h1.y} r={2.5 / camera.zoom} fill="#7c3aed" />}
                  {n.h2 && <circle cx={n.x + n.h2.x} cy={n.y + n.h2.y} r={2.5 / camera.zoom} fill="#7c3aed" />}
                  <rect
                    x={n.x - 3 / camera.zoom} y={n.y - 3 / camera.zoom}
                    width={6 / camera.zoom} height={6 / camera.zoom}
                    fill={i === 0 ? "#00f0ff" : "#0a0a0a"}
                    stroke="#00f0ff" strokeWidth={1 / camera.zoom}
                  />
                </g>
              ))}
            </g>
          )}
          {eraserLive.length > 0 && (() => {
            const last = eraserLive[eraserLive.length - 1];
            const r = eraserRef.current?.radius ?? 10;
            return (
              <g pointerEvents="none">
                <polyline
                  points={eraserLive.map((q) => `${q.x},${q.y}`).join(" ")}
                  fill="none" stroke="#ff4d4d" strokeWidth={1.5 / camera.zoom}
                  strokeLinecap="round" opacity={0.8}
                />
                <circle
                  cx={last.x} cy={last.y} r={r}
                  fill="rgba(255,77,77,0.08)" stroke="#ff4d4d" strokeWidth={1 / camera.zoom}
                />
              </g>
            );
          })()}
          {tool === "move" && selBox && (
            <SelectionBox
              box={selBox}
              zoom={camera.zoom}
              rotateMode={rotateMode}
              pivot={pivotPt}
              onScaleDown={onScaleDown}
              onRotateDown={onRotateDown}
              onPivotDown={onPivotDown}
            />
          )}
          {tool === "node" &&
            editableSel
              .filter((o): o is PathObj => o.kind === "path")
              .map((o) => (
                <NodeOverlay
                  key={o.id}
                  o={o}
                  zoom={camera.zoom}
                  sel={nodeSel?.objId === o.id ? nodeSel.idx : []}
                  showAll={nodeHandlesAll}
                  onNodeDown={(e, i) => onNodeDown(e, o.id, i)}
                  onNodeDouble={(e, i) => onNodeDouble(e, o.id, i)}
                  onHandleDown={(e, i, w) => onHandleDown(e, o.id, i, w)}
                  onSegDown={(e, si) => onSegDown(e, o.id, si)}
                />
              ))}
          {snapHint && (
            <g pointerEvents="none">
              <circle
                cx={snapHint.x} cy={snapHint.y} r={7 / camera.zoom}
                fill="none" stroke="#00f0ff" strokeWidth={1.5 / camera.zoom}
              />
              <line
                x1={snapHint.x - 3 / camera.zoom} y1={snapHint.y}
                x2={snapHint.x + 3 / camera.zoom} y2={snapHint.y}
                stroke="#00f0ff" strokeWidth={1.5 / camera.zoom}
              />
              <line
                x1={snapHint.x} y1={snapHint.y - 3 / camera.zoom}
                x2={snapHint.x} y2={snapHint.y + 3 / camera.zoom}
                stroke="#00f0ff" strokeWidth={1.5 / camera.zoom}
              />
            </g>
          )}
          {np && preview && tool !== "pen" && tool !== "text" && tool !== "spiral" && (
            <rect
              x={np.x} y={np.y} width={Math.max(np.w, 1)} height={Math.max(np.h, 1)}
              fill="rgba(0,240,255,0.08)" stroke="#00f0ff" strokeWidth={1 / camera.zoom}
              strokeDasharray={`${5 / camera.zoom} ${4 / camera.zoom}`}
              pointerEvents="none"
            />
          )}
          {np && preview && tool === "spiral" && (() => {
            const cx = (preview.x0 + preview.x1) / 2;
            const cy = (preview.y0 + preview.y1) / 2;
            const maxR = Math.min(Math.abs(preview.x1 - preview.x0), Math.abs(preview.y1 - preview.y0)) / 2;
            if (maxR < 4) return null;
            const turns = useDoc.getState().toolOpts.spiralTurns;
            return (
              <polyline
                points={spiralPoints(cx, cy, maxR, turns).map((q) => `${q.x},${q.y}`).join(" ")}
                fill="none" stroke="#00f0ff" strokeWidth={2}
                strokeLinecap="round" pointerEvents="none"
              />
            );
          })()}
          {penLive.length > 1 && (
            <polyline
              points={penLive.map((q) => `${q.x},${q.y}`).join(" ")}
              fill="none" stroke="#00f0ff" strokeWidth={2}
              strokeLinecap="round" pointerEvents="none"
            />
          )}
        </g>
        {zoomBox && (() => {
          const r = rectCache.current;
          if (!r) return null;
          const ox = r.left, oy = r.top;
          const x = Math.min(zoomBox.x0, zoomBox.x1) - ox;
          const y = Math.min(zoomBox.y0, zoomBox.y1) - oy;
          return (
            <rect
              x={x} y={y}
              width={Math.max(1, Math.abs(zoomBox.x1 - zoomBox.x0))}
              height={Math.max(1, Math.abs(zoomBox.y1 - zoomBox.y0))}
              fill="rgba(0,240,255,0.08)" stroke="#00f0ff" strokeWidth={1}
              strokeDasharray="5 4" pointerEvents="none"
            />
          );
        })()}
        {nodeMarquee && (() => {
          const r = rectCache.current;
          if (!r) return null;
          const x = Math.min(nodeMarquee.x0, nodeMarquee.x1) - r.left;
          const y = Math.min(nodeMarquee.y0, nodeMarquee.y1) - r.top;
          return (
            <rect
              x={x} y={y}
              width={Math.max(1, Math.abs(nodeMarquee.x1 - nodeMarquee.x0))}
              height={Math.max(1, Math.abs(nodeMarquee.y1 - nodeMarquee.y0))}
              fill="rgba(0,240,255,0.06)" stroke="#00f0ff" strokeWidth={1}
              strokeDasharray="4 3" pointerEvents="none"
            />
          );
        })()}
      </svg>
      <input
        ref={imageFileRef}
        type="file"
        accept="image/*"
        hidden
        aria-label="Import image"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          void onImageFile(f);
        }}
      />
      <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />
      {editingText && editing && editSel && editSel.end > editSel.start && (
        <div
          className="vl-span-bar"
          style={{
            left: Math.max(4, camera.x + editingText.x * camera.zoom),
            top: Math.max(4, camera.y + (editingText.y - editingText.fontSize * 1.6) * camera.zoom),
          }}
          onMouseDown={(e) => {
            // never reach the canvas, but let the inputs take focus
            e.stopPropagation();
            const t = e.target instanceof Element ? e.target.tagName : "";
            if (t !== "INPUT" && t !== "SELECT") e.preventDefault();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <span className="vl-span-tag">SELECTION</span>
          <input
            type="color"
            aria-label="Letter color"
            title="Letter color"
            value={/^#[0-9a-fA-F]{6}$/.test(editingText.fill) ? editingText.fill : "#000000"}
            onChange={(e) => applyStyleToSel({ fill: e.target.value })}
          />
          <select
            aria-label="Letter font"
            title="Letter font"
            value={editingText.fontFamily}
            onChange={(e) => applyStyleToSel({ fontFamily: e.target.value })}
          >
            {FONTS.map((f) => (
              <option key={f.key} value={f.key} style={{ fontFamily: f.css }}>
                {f.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Letter weight"
            title="Letter weight"
            value={editingText.fontWeight}
            onChange={(e) => applyStyleToSel({ fontWeight: Number(e.target.value) })}
          >
            {fontWeights(editingText.fontFamily).map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
          <input
            type="number"
            aria-label="Letter size"
            title="Letter size"
            min={4}
            max={400}
            defaultValue={editingText.fontSize}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 4 && v <= 400 && v !== editingText.fontSize) {
                applyStyleToSel({ fontSize: v });
              }
            }}
          />
        </div>
      )}
      {objects.length === 0 && !preview && penLive.length === 0 && (
        <div className="vl-canvas-empty">
          {spaceHeld || panning
            ? "PANNING — DRAG TO MOVE · SCROLL TO ZOOM"
            : "PICK A TOOL AND DRAG — R RECT · O ELLIPSE · L LINE · T TEXT · P PEN · B BEZIER · F FIT PAGE"}
        </div>
      )}
    </main>
  );
}
