import { memo, useEffect, useRef, useState } from "react";
import type { PathObj, BezNode } from "./types";
import { editablePathNodes, nodeTypeOf, type NodeType } from "./types";

interface Props {
  o: PathObj;
  zoom: number;
  sel: number[];
  showAll: boolean; // show handles for every node, not just selected/hovered
  onNodeDown: (e: React.MouseEvent, index: number) => void;
  onNodeDouble: (e: React.MouseEvent, index: number) => void;
  onHandleDown: (e: React.MouseEvent, index: number, which: "h1" | "h2") => void;
  onSegDown: (e: React.MouseEvent, si: number) => void;
}

function NodeOverlayInner({ o, zoom, sel, showAll, onNodeDown, onNodeDouble, onHandleDown, onSegDown }: Props) {
  const nodes = editablePathNodes(o);
  const [hoverNode, setHoverNode] = useState<number | null>(null);
  const [hoverSeg, setHoverSeg] = useState<number | null>(null);
  // Hover grace: reaching from a node to its handle crosses a gap, so the
  // hover state (and with it the handles) must only clear after a beat —
  // otherwise the handles flicker away mid-reach.
  const hoverTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
  }, []);
  const enterNode = (i: number) => {
    if (hoverTimer.current) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = undefined;
    }
    setHoverNode(i);
  };
  const leaveNode = (i: number) => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = undefined;
      setHoverNode((v) => (v === i ? null : v));
    }, 220);
  };
  const closed = (o.d ?? "").trimEnd().endsWith("Z");
  // segments: node index pairs (closed paths add the wrap segment)
  const segs: [number, number][] = [];
  for (let i = 0; i < nodes.length - 1; i++) segs.push([i, i + 1]);
  if (closed && nodes.length >= 3) segs.push([nodes.length - 1, 0]);
  const s = 7 / zoom;
  const hr = 3.5 / zoom;
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const W = (n: BezNode) => o.x + n.x;
  const H = (n: BezNode) => o.y + n.y;
  const segPath = (a: BezNode, b: BezNode) =>
    a.h2 && b.h1
      ? `M ${W(a)} ${H(a)} C ${W(a) + a.h2.x} ${H(a) + a.h2.y}, ${W(b) + b.h1.x} ${H(b) + b.h1.y}, ${W(b)} ${H(b)}`
      : `M ${W(a)} ${H(a)} L ${W(b)} ${H(b)}`;
  const nodeShape = (n: BezNode, i: number) => {
    const t: NodeType = nodeTypeOf(n);
    const k = hoverNode === i ? 1.4 : 1; // hover pops the node
    const size = s * k;
    const x = W(n), y = H(n);
    const fill = sel.includes(i) ? "#00f0ff" : "#0a0a0a";
    if (t === "sym") {
      return <circle cx={x} cy={y} r={size / 2} fill={fill} stroke="#00f0ff" strokeWidth={1 / zoom} />;
    }
    if (t === "cusp") {
      return (
        <rect
          x={x - size / 2} y={y - size / 2} width={size} height={size}
          fill={fill} stroke="#00f0ff" strokeWidth={1 / zoom}
          transform={`rotate(45 ${x} ${y})`}
        />
      );
    }
    return (
      <rect x={x - size / 2} y={y - size / 2} width={size} height={size} fill={fill} stroke="#00f0ff" strokeWidth={1 / zoom} />
    );
  };
  return (
    <g
      transform={o.rotation ? `rotate(${o.rotation} ${cx} ${cy})` : undefined}
      pointerEvents="none"
    >
      {/* segments: fat invisible hit targets + hover/selection highlights */}
      {segs.map(([ai, bi], si) => {
        const segSelected = sel.includes(ai) && sel.includes(bi);
        const hot = hoverSeg === si || segSelected;
        return (
          <g key={`s${si}`}>
            <path
              d={segPath(nodes[ai], nodes[bi])}
              stroke="transparent" strokeWidth={10 / zoom} fill="none"
              style={{ pointerEvents: "stroke", cursor: "grab" }}
              onMouseDown={(e) => onSegDown(e, si)}
              onMouseEnter={() => setHoverSeg(si)}
              onMouseLeave={() => setHoverSeg((v) => (v === si ? null : v))}
            />
            {hot && (
              <path
                d={segPath(nodes[ai], nodes[bi])}
                stroke="#00f0ff" fill="none" pointerEvents="none"
                strokeWidth={(segSelected ? 2.5 : 1.8) / zoom}
                opacity={segSelected ? 0.9 : 0.55}
              />
            )}
          </g>
        );
      })}
      {/* handles: only for selected / hovered nodes (or all via the toggle) */}
      {nodes.map((n, i) => {
        if (!(showAll || sel.includes(i) || hoverNode === i)) return null;
        return (
          <g key={`h${i}`}>
            {n.h1 && (
              <line
                x1={W(n)} y1={H(n)}
                x2={W(n) + n.h1.x} y2={H(n) + n.h1.y}
                stroke="#7c3aed" strokeWidth={1 / zoom}
              />
            )}
            {n.h2 && (
              <line
                x1={W(n)} y1={H(n)}
                x2={W(n) + n.h2.x} y2={H(n) + n.h2.y}
                stroke="#7c3aed" strokeWidth={1 / zoom}
              />
            )}
            {n.h1 && (
              <circle
                cx={W(n) + n.h1.x} cy={H(n) + n.h1.y} r={hr}
                fill="#7c3aed" pointerEvents="all" style={{ cursor: "grab" }}
                onMouseDown={(e) => onHandleDown(e, i, "h1")}
                onMouseEnter={() => enterNode(i)}
                onMouseLeave={() => leaveNode(i)}
              />
            )}
            {n.h2 && (
              <circle
                cx={W(n) + n.h2.x} cy={H(n) + n.h2.y} r={hr}
                fill="#7c3aed" pointerEvents="all" style={{ cursor: "grab" }}
                onMouseDown={(e) => onHandleDown(e, i, "h2")}
                onMouseEnter={() => enterNode(i)}
                onMouseLeave={() => leaveNode(i)}
              />
            )}
          </g>
        );
      })}
      {/* nodes: glyph shape encodes the type (◇ cusp □ smooth ● sym) */}
      {nodes.map((n, i) => (
        <g
          key={`n${i}`}
          pointerEvents="all"
          style={{ cursor: "grab" }}
          onMouseDown={(e) => onNodeDown(e, i)}
          onDoubleClick={(e) => onNodeDouble(e, i)}
          onMouseEnter={() => enterNode(i)}
          onMouseLeave={() => leaveNode(i)}
        >
          {nodeShape(n, i)}
        </g>
      ))}
    </g>
  );
}

// o identity changes only when the path mutates; sel compared by join
export default memo(
  NodeOverlayInner,
  (a, b) =>
    a.o === b.o &&
    a.zoom === b.zoom &&
    a.showAll === b.showAll &&
    a.sel.join(",") === b.sel.join(",")
);
