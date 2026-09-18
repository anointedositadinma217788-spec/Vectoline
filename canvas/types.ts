export interface ObjBase {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number; // 0-100
  locked?: boolean;
  hidden?: boolean;
  guide?: boolean; // construction guide: dashed on canvas, skipped on export
}

export interface RectObj extends ObjBase { kind: "rect"; rx: number }
export interface EllipseObj extends ObjBase { kind: "ellipse" }
export interface LineObj extends ObjBase { kind: "line" }
/** Per-letter style override: character range over the raw text string
 *  (start inclusive, end exclusive). Unset props inherit the text object's. */
export interface TextSpan {
  start: number;
  end: number;
  fill?: string;
  fontWeight?: number;
  fontFamily?: string;
  fontSize?: number;
}

export interface TextObj extends ObjBase {
  kind: "text";
  text: string;
  lines: string[];
  wrapW: number | null; // fixed wrap width (world px) or null = single growing line set
  fontSize: number;
  fontWeight: number;
  fontFamily: string; // key into FONTS registry (src/canvas/text.ts)
  outlineOn?: boolean; // paint the outline stroke behind the glyph fill
  spans?: TextSpan[]; // per-letter style overrides
}
export interface BezNode {
  x: number;
  y: number;
  // handle offsets relative to node; null handle = corner (straight segment)
  h1: { x: number; y: number } | null; // incoming handle
  h2: { x: number; y: number } | null; // outgoing handle
  // explicit node type (Corel/Inkscape model): cusp = sharp corner,
  // smooth = collinear handles, sym = collinear + equal-length handles.
  // Absent = legacy: derived from the handles.
  t?: "cusp" | "smooth" | "sym";
}
export interface PathObj extends ObjBase {
  kind: "path";
  d: string;
  nodes?: BezNode[]; // set when drawn with the bezier tool; freehand leaves undefined
}
export interface PolygonObj extends ObjBase { kind: "polygon"; sides: number }
export interface StarObj extends ObjBase {
  kind: "star";
  points: number;
  innerRatio: number;
}
export interface ImageObj extends ObjBase {
  kind: "image";
  src: string;
  naturalW: number;
  naturalH: number;
}

export type VecObject =
  | RectObj | EllipseObj | LineObj | TextObj | PathObj | PolygonObj | StarObj | ImageObj;

export const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : `o${Math.random().toString(36).slice(2, 9)}`;

export function polygonPoints(
  cx: number, cy: number, rx: number, ry: number, sides: number, rotDeg = -90
): string {
  const n = Math.min(24, Math.max(3, Math.floor(sides) || 3));
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((rotDeg + (360 / n) * i) * Math.PI) / 180;
    pts.push(`${(cx + rx * Math.cos(a)).toFixed(1)},${(cy + ry * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(" ");
}

export function starPoints(
  cx: number, cy: number, rx: number, ry: number, points: number, innerRatio = 0.45, rotDeg = -90
): string {
  const p = Math.min(24, Math.max(3, Math.floor(points) || 5));
  const pts: string[] = [];
  const n = p * 2;
  for (let i = 0; i < n; i++) {
    const a = ((rotDeg + (360 / n) * i) * Math.PI) / 180;
    const k = i % 2 === 0 ? 1 : innerRatio;
    pts.push(`${(cx + rx * k * Math.cos(a)).toFixed(1)},${(cy + ry * k * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(" ");
}

export function freehandToPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y} L ${pts[0].x + 0.1} ${pts[0].y + 0.1}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i].x} ${pts[i].y}`;
  return d;
}

/** Parse M/L point runs out of a path d string (local coords). */
export function parsePathPoints(d: string): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const re = /[ML]\s*(-?\d+\.?\d*)\s+(-?\d+\.?\d*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) pts.push({ x: Number(m[1]), y: Number(m[2]) });
  return pts;
}

export function isClosedPath(d: string): boolean {
  if (!d) return false;
  return /z\s*$/i.test(d.trimEnd());
}

export interface Box { x: number; y: number; w: number; h: number }

export interface Mirror { mx: boolean; my: boolean }
export const NO_MIRROR: Mirror = { mx: false, my: false };

/** Default ink: dark, reads on the white page. */
export const INK = "#111214";

/**
 * Sanitize paint at creation so new objects always land visible.
 * - shape: hollow fills recover to ink; transparent strokes become none.
 * - stroke (line/pen/bezier/spiral): missing strokes recover to ink + usable width.
 * - text: hollow fills recover to ink; text never takes a stroke here.
 */
export function sanitizeCreation(
  fill: string, stroke: string, strokeWidth: number,
  kind: "shape" | "stroke" | "text"
): { fill: string; stroke: string; strokeWidth: number } {
  const hollowFill = fill === "none" || fill === "transparent";
  const hollowStroke = stroke === "none" || stroke === "transparent";
  if (kind === "text") {
    return { fill: hollowFill ? INK : fill, stroke: "none", strokeWidth: 0 };
  }
  if (kind === "stroke") {
    return {
      fill: "transparent",
      stroke: hollowStroke ? INK : stroke,
      strokeWidth: strokeWidth > 0 ? strokeWidth : 2,
    };
  }
  return {
    fill: hollowFill ? INK : fill,
    stroke: hollowStroke ? "none" : stroke,
    strokeWidth: hollowStroke ? 0 : strokeWidth,
  };
}

/** Local-space editable nodes for any path (native or parsed polyline). */
export function editablePathNodes(o: PathObj): BezNode[] {
  if (o.nodes) {
    return o.nodes.map((n) => ({
      ...n,
      h1: n.h1 ? { ...n.h1 } : null,
      h2: n.h2 ? { ...n.h2 } : null,
    }));
  }
  return parsePathPoints(o.d).map((p) => ({ x: p.x, y: p.y, h1: null, h2: null }));
}

/** Rebuild d + renormalize x/y/w/h around nodes (call on gesture end). */
export function renormPath(o: PathObj, nodes: BezNode[]): Pick<PathObj, "x" | "y" | "w" | "h" | "nodes" | "d"> {
  const closed = isClosedPath(o.d);
  if (nodes.length === 0) return { x: o.x, y: o.y, w: o.w, h: o.h, nodes, d: "" };
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
  const rel = nodes.map((n) => ({
    ...n,
    x: Math.round((n.x - bx) * 10) / 10,
    y: Math.round((n.y - by) * 10) / 10,
  }));
  return {
    x: Math.round((o.x + bx) * 10) / 10,
    y: Math.round((o.y + by) * 10) / 10,
    w: Math.max(1, Math.round((Math.max(...xs) - bx) * 10) / 10),
    h: Math.max(1, Math.round((Math.max(...ys) - by) * 10) / 10),
    nodes: rel,
    d: nodes.length >= 2 ? bezierToPath(rel, closed) : "",
  };
}

/** Convert a geometric shape into an editable path. Text/images: null. */
export function shapeToPath(o: VecObject): PathObj | null {
  const base = {
    id: o.id, name: o.name, x: o.x, y: o.y, w: o.w, h: o.h,
    rotation: o.rotation, fill: o.fill, stroke: o.stroke,
    strokeWidth: o.strokeWidth, opacity: o.opacity,
    locked: o.locked, hidden: o.hidden, guide: o.guide,
  };
  const pts = (list: { x: number; y: number }[], closed: boolean): PathObj => ({
    ...base,
    kind: "path",
    d: list.length >= 2 ? freehandToPath(list) + (closed ? " Z" : "") : "",
    nodes: list.map((p) => ({ x: p.x, y: p.y, h1: null, h2: null })),
  });
  switch (o.kind) {
    case "path":
      return o;
    case "rect":
      return pts(
        [{ x: 0, y: 0 }, { x: o.w, y: 0 }, { x: o.w, y: o.h }, { x: 0, y: o.h }],
        true
      );
    case "ellipse": {
      // Bezier ellipse approx (4 cubic spans, kappa) — keeps smooth curve, not faceted polygon
      const rx = o.w / 2, ry = o.h / 2;
      const k = 0.5522847498;
      const kx = rx * k, ky = ry * k;
      const cx = rx, cy = ry;
      const list: BezNode[] = [
        { x: cx + rx, y: cy, h1: { x: 0, y: -ky }, h2: { x: 0, y: ky }, t: "smooth" },
        { x: cx, y: cy + ry, h1: { x: kx, y: 0 }, h2: { x: -kx, y: 0 }, t: "smooth" },
        { x: cx - rx, y: cy, h1: { x: 0, y: ky }, h2: { x: 0, y: -ky }, t: "smooth" },
        { x: cx, y: cy - ry, h1: { x: -kx, y: 0 }, h2: { x: kx, y: 0 }, t: "smooth" },
      ];
      return {
        ...base,
        kind: "path",
        d: bezierToPath(list, true),
        nodes: list,
      };
    }
    case "line":
      return pts([{ x: 0, y: 0 }, { x: o.w, y: o.h }], false);
    case "polygon": {
      const list = polygonPoints(o.w / 2, o.h / 2, o.w / 2, o.h / 2, o.sides)
        .split(" ")
        .map((s) => {
          const [x, y] = s.split(",").map(Number);
          return { x, y };
        });
      return pts(list, true);
    }
    case "star": {
      const list = starPoints(o.w / 2, o.h / 2, o.w / 2, o.h / 2, o.points, o.innerRatio)
        .split(" ")
        .map((s) => {
          const [x, y] = s.split(",").map(Number);
          return { x, y };
        });
      return pts(list, true);
    }
    default:
      return null;
  }
}

/**
 * Map one object from an old shared box to a new one (resize).
 * Text font scaling + path internals included; text re-measure
 * happens in the caller via syncTextBox (avoids an import cycle).
 */
export function transformObject(o: VecObject, a: Box, b: Box, mirror: Mirror = NO_MIRROR): VecObject {
  const kx = a.w === 0 ? 1 : b.w / a.w;
  const ky = a.h === 0 ? 1 : b.h / a.h;
  const nx = b.x + (o.x - a.x) * kx;
  const ny = b.y + (o.y - a.y) * ky;
  const nw = Math.max(1, o.w * kx);
  const nh = Math.max(1, o.h * ky);
  switch (o.kind) {
    case "rect":
      return { ...o, x: nx, y: ny, w: nw, h: nh, rx: o.rx * Math.min(kx, ky) };
    case "ellipse":
    case "image":
      return { ...o, x: nx, y: ny, w: nw, h: nh };
    case "polygon":
    case "star": {
      if (!mirror.mx && !mirror.my) return { ...o, x: nx, y: ny, w: nw, h: nh };
      // vertical flip changes pointing direction: freeze exact vertices
      const pts =
        o.kind === "polygon"
          ? polygonPoints(nw / 2, nh / 2, nw / 2, nh / 2, o.sides)
          : starPoints(nw / 2, nh / 2, nw / 2, nh / 2, o.points, o.innerRatio);
      const verts = pts.split(" ").map((s) => {
        const [x, y] = s.split(",").map(Number);
        return { x: Math.round(x * 10) / 10, y: Math.round((nh - y) * 10) / 10 };
      });
      return {
        id: o.id, name: o.name, kind: "path", x: nx, y: ny, w: nw, h: nh,
        rotation: o.rotation, fill: o.fill, stroke: o.stroke,
        strokeWidth: o.strokeWidth, opacity: o.opacity,
        locked: o.locked, hidden: o.hidden, guide: o.guide,
        d: freehandToPath(verts) + " Z",
        nodes: verts.map((p) => ({ x: p.x, y: p.y, h1: null, h2: null })),
      };
    }
    case "line": {
      if (!mirror.mx && !mirror.my) return { ...o, x: nx, y: ny, w: nw, h: nh };
      // mirrored slope isn't bbox-expressible: freeze to a 2-node path
      const p1 = { x: mirror.mx ? nw : 0, y: mirror.my ? nh : 0 };
      const p2 = { x: mirror.mx ? 0 : nw, y: mirror.my ? 0 : nh };
      return {
        id: o.id, name: o.name, kind: "path", x: nx, y: ny, w: nw, h: nh,
        rotation: o.rotation, fill: "transparent", stroke: o.stroke,
        strokeWidth: o.strokeWidth, opacity: o.opacity,
        locked: o.locked, hidden: o.hidden, guide: o.guide,
        d: freehandToPath([p1, p2]),
        nodes: [
          { x: p1.x, y: p1.y, h1: null, h2: null },
          { x: p2.x, y: p2.y, h1: null, h2: null },
        ],
      };
    }
    case "text": {
      const k = Math.abs(kx - 1) > Math.abs(ky - 1) ? kx : ky;
      return {
        ...o, x: nx, y: ny, w: nw, h: nh, fontSize: Math.max(4, o.fontSize * k),
        wrapW: o.wrapW == null ? null : Math.max(20, o.wrapW * kx),
      };
    }
    case "path": {
      const fx = o.w === 0 ? 1 : nw / o.w;
      const fy = o.h === 0 ? 1 : nh / o.h;
      const closed = isClosedPath(o.d);
      if (o.nodes) {
        const nodes: BezNode[] = o.nodes.map((n) => ({
          ...n,
          x: mirror.mx ? nw - n.x * fx : n.x * fx,
          y: mirror.my ? nh - n.y * fy : n.y * fy,
          h1: n.h1
            ? { x: (mirror.mx ? -n.h1.x : n.h1.x) * fx, y: (mirror.my ? -n.h1.y : n.h1.y) * fy }
            : null,
          h2: n.h2
            ? { x: (mirror.mx ? -n.h2.x : n.h2.x) * fx, y: (mirror.my ? -n.h2.y : n.h2.y) * fy }
            : null,
        }));
        return {
          ...o, x: nx, y: ny, w: nw, h: nh, nodes,
          d: bezierToPath(nodes, closed),
        };
      }
      const pts = parsePathPoints(o.d).map((p) => ({
        x: mirror.mx ? nw - p.x * fx : p.x * fx,
        y: mirror.my ? nh - p.y * fy : p.y * fy,
      }));
      if (pts.length < 2) return { ...o, x: nx, y: ny, w: nw, h: nh };
      return {
        ...o, x: nx, y: ny, w: nw, h: nh,
        d: freehandToPath(pts) + (closed ? " Z" : ""),
      };
    }
  }
}

export function bezierToPath(nodes: BezNode[], closed = false): string {
  if (nodes.length === 0) return "";
  if (nodes.length === 1) return `M ${nodes[0].x} ${nodes[0].y}`;
  const f = (n: number) => (Math.round(n * 10) / 10).toString();
  let d = `M ${f(nodes[0].x)} ${f(nodes[0].y)}`;
  for (let i = 1; i < nodes.length; i++) {
    const p = nodes[i - 1];
    const c = nodes[i];
    if (p.h2 && c.h1) {
      d += ` C ${f(p.x + p.h2.x)} ${f(p.y + p.h2.y)}, ${f(c.x + c.h1.x)} ${f(c.y + c.h1.y)}, ${f(c.x)} ${f(c.y)}`;
    } else {
      d += ` L ${f(c.x)} ${f(c.y)}`;
    }
  }
  if (closed) d += " Z";
  return d;
}

export function spiralPoints(
  cx: number, cy: number, maxR: number, turns: number, divergence = 1
): { x: number; y: number }[] {
  const steps = Math.max(24, Math.floor(turns * 48));
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * turns * Math.PI * 2 - Math.PI / 2;
    const r = maxR * Math.pow(t, divergence);
    pts.push({
      x: Math.round((cx + r * Math.cos(a)) * 10) / 10,
      y: Math.round((cy + r * Math.sin(a)) * 10) / 10,
    });
  }
  return pts;
}

// ---------- node-tool operations (Inkscape/CorelDRAW-style) ----------

export type NodeType = "cusp" | "smooth" | "sym";

/** Effective node type: stored type wins; legacy nodes derive from handles. */
export function nodeTypeOf(n: BezNode): NodeType {
  if (n.t) return n.t;
  return n.h1 || n.h2 ? "smooth" : "cusp";
}

const unit = (x: number, y: number) => {
  const l = Math.hypot(x, y);
  return l < 1e-9 ? null : { x: x / l, y: y / l };
};

/** Tangent direction through node i (neighbor to neighbor). */
function nodeTangent(nodes: BezNode[], i: number, closed: boolean): { x: number; y: number } {
  const n = nodes.length;
  if (n < 2) return { x: 1, y: 0 };
  const prev = nodes[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
  const next = nodes[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
  return { x: next.x - prev.x, y: next.y - prev.y };
}

/** Re-type the selected nodes (Corel's cusp/smooth/symmetrical):
 *  cusp retracts the handles; smooth builds collinear handles from the
 *  longest existing handle or the neighbor tangent; sym equalizes lengths. */
export function setNodesType(
  nodes: BezNode[], idxs: number[], type: NodeType, closed: boolean
): BezNode[] {
  const out = nodes.map((n) => ({ ...n }));
  for (const i of idxs) {
    const n = out[i];
    if (!n) continue;
    if (type === "cusp") {
      out[i] = { x: n.x, y: n.y, h1: null, h2: null, t: "cusp" };
      continue;
    }
    let dir: { x: number; y: number } | null = null;
    let l1 = 0, l2 = 0;
    if (n.h1 && n.h2) {
      const lh = Math.hypot(n.h1.x, n.h1.y), rh = Math.hypot(n.h2.x, n.h2.y);
      const ref = rh >= lh ? n.h2 : { x: -n.h1.x, y: -n.h1.y };
      dir = unit(ref.x, ref.y);
      l1 = lh; l2 = rh;
    } else if (n.h2) {
      dir = unit(n.h2.x, n.h2.y);
      l1 = l2 = Math.hypot(n.h2.x, n.h2.y);
    } else if (n.h1) {
      dir = unit(-n.h1.x, -n.h1.y);
      l1 = l2 = Math.hypot(n.h1.x, n.h1.y);
    }
    if (!dir || l1 < 1e-9 || l2 < 1e-9) {
      const tan = nodeTangent(nodes, i, closed);
      dir = unit(tan.x, tan.y) ?? { x: 1, y: 0 };
      const def = Math.max(12, Math.hypot(tan.x, tan.y) * 0.25);
      l1 = def; l2 = def;
    }
    if (type === "sym") {
      const l = (l1 + l2) / 2;
      l1 = l; l2 = l;
    }
    out[i] = {
      x: n.x, y: n.y, t: type,
      h1: { x: -dir.x * l1, y: -dir.y * l1 },
      h2: { x: dir.x * l2, y: dir.y * l2 },
    };
  }
  return out;
}

/** de Casteljau split of the segment leaving node si at parameter t (0..1).
 *  Handles are rebuilt so the curve keeps its exact shape. Returns the new
 *  node list and the index of the inserted node (-1 on bad input). */
export function insertNodeAtT(
  nodes: BezNode[], si: number, t: number, closed: boolean
): { nodes: BezNode[]; index: number } {
  const n = nodes.length;
  const a = nodes[si];
  const b = nodes[(si + 1) % n];
  if (!a || !b || (!closed && si >= n - 1)) return { nodes, index: -1 };
  const tt = Math.min(0.999, Math.max(0.001, t));
  const next: BezNode[] = nodes.map((x) => ({
    x: x.x, y: x.y,
    h1: x.h1 ? { ...x.h1 } : null,
    h2: x.h2 ? { ...x.h2 } : null,
    t: x.t,
  }));
  const A = next[si], B = next[(si + 1) % n];
  const m = {
    x: (A.x + B.x) / 2, y: (A.y + B.y) / 2,
    h1: null as BezNode["h1"], h2: null as BezNode["h1"],
  };
  if (A.h2 || B.h1) {
    const at = (qx: number, qy: number, rx: number, ry: number) => ({
      x: qx + (rx - qx) * tt,
      y: qy + (ry - qy) * tt,
    });
    const p1x = A.x, p1y = A.y;
    const p2x = A.x + (A.h2?.x ?? 0), p2y = A.y + (A.h2?.y ?? 0);
    const p3x = B.x + (B.h1?.x ?? 0), p3y = B.y + (B.h1?.y ?? 0);
    const p4x = B.x, p4y = B.y;
    const l1 = at(p1x, p1y, p2x, p2y);
    const l2 = at(p2x, p2y, p3x, p3y);
    const l3 = at(p3x, p3y, p4x, p4y);
    const r0 = at(l1.x, l1.y, l2.x, l2.y);
    const r1 = at(l2.x, l2.y, l3.x, l3.y);
    const mp = at(r0.x, r0.y, r1.x, r1.y);
    A.h2 = { x: l1.x - A.x, y: l1.y - A.y };
    m.x = mp.x;
    m.y = mp.y;
    m.h1 = { x: r0.x - mp.x, y: r0.y - mp.y };
    m.h2 = { x: r1.x - mp.x, y: r1.y - mp.y };
    B.h1 = { x: l3.x - B.x, y: l3.y - B.y };
  } else {
    m.x = A.x + (B.x - A.x) * tt;
    m.y = A.y + (B.y - A.y) * tt;
  }
  const index = si + 1;
  // a split node carries collinear handles by construction -> smooth
  next.splice(index, 0, { ...m, t: m.h1 || m.h2 ? "smooth" : "cusp" } as BezNode);
  return { nodes: next, index };
}

/** Split a segment in half (Insert key on a node pair). */
export function insertNodeMidpoint(
  nodes: BezNode[], si: number, closed: boolean
): { nodes: BezNode[]; index: number } {
  return insertNodeAtT(nodes, si, 0.5, closed);
}

/** Delete nodes while keeping the curve's flow (Inkscape default): the
 *  surviving neighbors' gap-side handles are scaled over the hole. */
export function deleteNodesKeepShape(
  nodes: BezNode[], del: number[], closed: boolean
): BezNode[] {
  const n = nodes.length;
  const delSet = new Set(del);
  const survivors = nodes.map((_, i) => i).filter((i) => !delSet.has(i));
  if (survivors.length === n) return nodes.map((x) => ({ ...x }));
  const posOf = new Map<number, number>();
  const out = survivors.map((i, k) => {
    posOf.set(i, k);
    const x = nodes[i];
    return {
      x: x.x, y: x.y,
      h1: x.h1 ? { ...x.h1 } : null,
      h2: x.h2 ? { ...x.h2 } : null,
      t: x.t,
    };
  });
  if (out.length === 0) return out;
  // every run of deleted nodes between two survivors becomes one gap: the
  // surviving handles are re-aimed along the new chord (Inkscape's "delete
  // while preserving shape") and sized proportionally to the removed span
  for (let k = 0; k < survivors.length; k++) {
    if (k === survivors.length - 1 && !closed) break;
    const s = survivors[k];
    const t = survivors[(k + 1) % survivors.length];
    if (!closed && t <= s) continue;
    if ((t - s + n) % n <= 1) continue; // adjacent, nothing deleted between
    const d1 = (s + 1) % n; // first deleted after s
    const d2 = (t - 1 + n) % n; // last deleted before t
    const S = nodes[s], T = nodes[t];
    const dx = T.x - S.x, dy = T.y - S.y;
    const segLen = Math.max(1e-6, Math.hypot(dx, dy));
    const ux = dx / segLen, uy = dy / segLen;
    const ks = posOf.get(s)!;
    const kt = posOf.get(t)!;
    if (out[ks].h2) {
      const oldLen = Math.hypot(S.h2?.x ?? 0, S.h2?.y ?? 0);
      const reach = Math.max(1e-6, Math.hypot(
        S.x + (S.h2?.x ?? 0) - nodes[d1].x,
        S.y + (S.h2?.y ?? 0) - nodes[d1].y
      ));
      const f = Math.min(6, Math.max(0.1, segLen / reach));
      const len = Math.min(oldLen * f, segLen * 0.5);
      out[ks].h2 = { x: ux * len, y: uy * len };
    }
    if (out[kt].h1) {
      const oldLen = Math.hypot(T.h1?.x ?? 0, T.h1?.y ?? 0);
      const reach = Math.max(1e-6, Math.hypot(
        T.x + (T.h1?.x ?? 0) - nodes[d2].x,
        T.y + (T.h1?.y ?? 0) - nodes[d2].y
      ));
      const f = Math.min(6, Math.max(0.1, segLen / reach));
      const len = Math.min(oldLen * f, segLen * 0.5);
      out[kt].h1 = { x: -ux * len, y: -uy * len };
    }
  }
  return out;
}

/** Copy each selected node, offset by a hint amount (Inkscape Shift+D). */
export function duplicateNodes(nodes: BezNode[], idxs: number[]): BezNode[] {
  const out = nodes.map((n) => ({
    x: n.x, y: n.y,
    h1: n.h1 ? { ...n.h1 } : null,
    h2: n.h2 ? { ...n.h2 } : null,
    t: n.t,
  }));
  for (const i of [...idxs].sort((a, b) => b - a)) {
    const n = out[i];
    if (!n) continue;
    out.splice(i + 1, 0, {
      x: n.x + 8, y: n.y + 8,
      h1: n.h1 ? { ...n.h1 } : null,
      h2: n.h2 ? { ...n.h2 } : null,
      t: n.t,
    });
  }
  return out;
}

/** Merge exactly two selected nodes into one at their midpoint (Shift+J). */
export function joinNodes(
  nodes: BezNode[], idxs: number[]
): { nodes: BezNode[]; index: number } | null {
  if (idxs.length !== 2) return null;
  const [i, j] = [...idxs].sort((a, b) => a - b);
  const a = nodes[i], b = nodes[j];
  if (!a || !b) return null;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const merged: BezNode = {
    x: mx, y: my,
    h1: a.h1 ? { x: a.h1.x + (a.x - mx), y: a.h1.y + (a.y - my) } : null,
    h2: b.h2 ? { x: b.h2.x + (b.x - mx), y: b.h2.y + (b.y - my) } : null,
    t: a.t,
  };
  const out: BezNode[] = nodes.filter((_, k) => k !== j).map((x) => ({
    x: x.x, y: x.y,
    h1: x.h1 ? { ...x.h1 } : null,
    h2: x.h2 ? { ...x.h2 } : null,
    t: x.t,
  }));
  out[i] = merged;
  return { nodes: out, index: i };
}

/** Align selected nodes on a shared horizontal (h) or vertical (v) line. */
export function alignNodes(nodes: BezNode[], idxs: number[], axis: "h" | "v"): BezNode[] {
  const sel = idxs.map((i) => nodes[i]).filter(Boolean);
  if (sel.length < 2) return nodes;
  const mean = axis === "h"
    ? sel.reduce((s, n) => s + n.y, 0) / sel.length
    : sel.reduce((s, n) => s + n.x, 0) / sel.length;
  const set = new Set(idxs);
  return nodes.map((n, i) => {
    if (!set.has(i)) return n;
    const moved = axis === "h" ? { y: mean } : { x: mean };
    return {
      ...n,
      h1: n.h1 ? { ...n.h1 } : null,
      h2: n.h2 ? { ...n.h2 } : null,
      ...moved,
    };
  });
}

/** Reverse node order, swapping handle roles (path direction flip). */
export function reversePathNodes(nodes: BezNode[]): BezNode[] {
  return [...nodes].reverse().map((n) => ({
    x: n.x, y: n.y,
    h1: n.h2 ? { ...n.h2 } : null,
    h2: n.h1 ? { ...n.h1 } : null,
    t: n.t,
  }));
}

/** Deep copy of a node list (handles cloned, types kept). */
export function cloneNodes(nodes: BezNode[]): BezNode[] {
  return nodes.map((n) => ({
    x: n.x, y: n.y,
    h1: n.h1 ? { ...n.h1 } : null,
    h2: n.h2 ? { ...n.h2 } : null,
    t: n.t,
  }));
}

/** Drag a segment (CorelDRAW/Inkscape feel). One rule for both cases: the
 *  segment's control points shift by 4/3 of the drag offset, so the curve's
 *  midpoint (t = 0.5) lands exactly under the cursor while the endpoints stay
 *  put. A straight segment gains handles (and its nodes become smooth); a
 *  curved one bulges, keeping its existing handle shape. */
export function dragSegment(
  nodes: BezNode[], si: number, closed: boolean, dx: number, dy: number
): BezNode[] {
  const n = nodes.length;
  const a = nodes[si];
  const b = nodes[(si + 1) % n];
  if (!a || !b || (!closed && si >= n - 1)) return nodes;
  const next = cloneNodes(nodes);
  const A = next[si], B = next[(si + 1) % n];
  const k = 4 / 3;
  const ox = dx * k, oy = dy * k;
  if (A.h2 && B.h1) {
    // curved segment: bulge it, preserving the existing handle shape
    A.h2 = { x: A.h2.x + ox, y: A.h2.y + oy };
    B.h1 = { x: B.h1.x + ox, y: B.h1.y + oy };
    return next;
  }
  // straight segment: give it handles first, then bulge
  const vx = (B.x - A.x) / 3, vy = (B.y - A.y) / 3;
  A.h2 = { x: vx + ox, y: vy + oy };
  B.h1 = { x: -vx + ox, y: -vy + oy };
  if (nodeTypeOf(A) === "cusp") A.t = "smooth";
  if (nodeTypeOf(B) === "cusp") B.t = "smooth";
  return next;
}

/** Magnetic snap for a dragged node: other nodes' positions win over the
 *  8px source grid. Targets are measured from the original point (not the
 *  grid-snapped one) so a nearby node is never hidden by the grid pulling
 *  first. Grid uses a tighter tolerance so free placement stays possible:
 *  with an 8px grid the max distance to a line is 4px, so a 6px tolerance
 *  would stick on every drag. Returns the snapped world point and whether
 *  it engaged (so the caller can flash an indicator). Pure: unit-testable. */
export function snapWorldPoint(
  wx: number, wy: number, tol: number, targets: { x: number; y: number }[]
): { x: number; y: number; snapped: boolean } {
  // node targets first, measured from the raw cursor
  let bestD = Infinity, bx = 0, by = 0;
  for (const t of targets) {
    const dx = Math.abs(t.x - wx), dy = Math.abs(t.y - wy);
    if (dx > tol || dy > tol) continue;
    const d = Math.hypot(dx, dy);
    if (d < bestD) { bestD = d; bx = t.x; by = t.y; }
  }
  if (bestD < Infinity) return { x: bx, y: by, snapped: true };
  // grid fallback: tighter than the node tolerance so it assists without
  // gluing every drag (max grid distance is 4px).
  const gridTol = Math.min(tol, 3.5);
  let x = wx, y = wy, snapped = false;
  const gx = Math.round(wx / 8) * 8, gy = Math.round(wy / 8) * 8;
  if (Math.abs(wx - gx) <= gridTol) { x = gx; snapped = true; }
  if (Math.abs(wy - gy) <= gridTol) { y = gy; snapped = true; }
  return { x, y, snapped };
}

/** World position of a node (accounts for the object's rotation). */
export function pathNodeWorld(o: PathObj, n: BezNode): { x: number; y: number } {
  if (!o.rotation) return { x: o.x + n.x, y: o.y + n.y };
  const a = (o.rotation * Math.PI) / 180;
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  const dx = o.x + n.x - cx, dy = o.y + n.y - cy;
  return {
    x: cx + dx * Math.cos(a) - dy * Math.sin(a),
    y: cy + dx * Math.sin(a) + dy * Math.cos(a),
  };
}

/** Inverse of pathNodeWorld: world point -> coordinates in o's local frame. */
export function worldToPathLocal(o: PathObj, wx: number, wy: number): { x: number; y: number } {
  if (!o.rotation) return { x: wx - o.x, y: wy - o.y };
  const a = (-o.rotation * Math.PI) / 180;
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  const dx = wx - cx, dy = wy - cy;
  return {
    x: cx + dx * Math.cos(a) - dy * Math.sin(a) - o.x,
    y: cy + dx * Math.sin(a) + dy * Math.cos(a) - o.y,
  };
}
