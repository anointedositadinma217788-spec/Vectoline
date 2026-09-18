import { memo } from "react";
import type { Box } from "../canvas/types";

export type ScaleHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type RotateHandle = "r-nw" | "r-ne" | "r-se" | "r-sw";

interface Props {
  box: Box;
  zoom: number;
  rotateMode: boolean;
  pivot: { x: number; y: number };
  onScaleDown: (e: React.MouseEvent, h: ScaleHandle) => void;
  onRotateDown: (e: React.MouseEvent) => void;
  onPivotDown: (e: React.MouseEvent) => void;
}

export const SCALE_CURSORS: Record<ScaleHandle, string> = {
  nw: "nwse-resize", se: "nwse-resize",
  ne: "nesw-resize", sw: "nesw-resize",
  n: "ns-resize", s: "ns-resize",
  e: "ew-resize", w: "ew-resize",
};

function scaleXY(box: Box, h: ScaleHandle): { x: number; y: number } {
  const cx = box.x + box.w / 2;
  switch (h) {
    case "nw": return { x: box.x, y: box.y };
    case "n": return { x: cx, y: box.y };
    case "ne": return { x: box.x + box.w, y: box.y };
    case "e": return { x: box.x + box.w, y: box.y + box.h / 2 };
    case "se": return { x: box.x + box.w, y: box.y + box.h };
    case "s": return { x: cx, y: box.y + box.h };
    case "sw": return { x: box.x, y: box.y + box.h };
    case "w": return { x: box.x, y: box.y + box.h / 2 };
  }
}

function rotateXY(box: Box, h: RotateHandle, off: number): { x: number; y: number } {
  switch (h) {
    case "r-nw": return { x: box.x - off, y: box.y - off };
    case "r-ne": return { x: box.x + box.w + off, y: box.y - off };
    case "r-se": return { x: box.x + box.w + off, y: box.y + box.h + off };
    case "r-sw": return { x: box.x - off, y: box.y + box.h + off };
  }
}

const SCALE_HANDLES: ScaleHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const ROTATE_HANDLES: RotateHandle[] = ["r-nw", "r-ne", "r-se", "r-sw"];

function SelectionBoxInner({ box, zoom, rotateMode, pivot, onScaleDown, onRotateDown, onPivotDown }: Props) {
  const s = 8 / zoom; // screen-constant handle size
  const off = 22 / zoom; // rotate handles sit clear of the corner scale handles
  return (
    <g pointerEvents="none">
      <rect
        x={box.x} y={box.y} width={Math.max(0.5, box.w)} height={Math.max(0.5, box.h)}
        fill="none" stroke="#00f0ff" strokeWidth={1 / zoom}
      />
      {!rotateMode &&
        SCALE_HANDLES.map((h) => {
          const p = scaleXY(box, h);
          return (
            <rect
              key={h}
              x={p.x - s / 2} y={p.y - s / 2} width={s} height={s}
              fill="#0a0a0a" stroke="#00f0ff" strokeWidth={1 / zoom}
              style={{ cursor: SCALE_CURSORS[h] }}
              pointerEvents="all"
              onMouseDown={(e) => onScaleDown(e, h)}
            />
          );
        })}
      {rotateMode && (
        <>
          <line x1={pivot.x - 7 / zoom} y1={pivot.y} x2={pivot.x + 7 / zoom} y2={pivot.y} stroke="#00f0ff" strokeWidth={1 / zoom} />
          <line x1={pivot.x} y1={pivot.y - 7 / zoom} x2={pivot.x} y2={pivot.y + 7 / zoom} stroke="#00f0ff" strokeWidth={1 / zoom} />
          <circle
            cx={pivot.x} cy={pivot.y} r={5 / zoom}
            fill="none" stroke="#00f0ff" strokeWidth={1 / zoom}
            style={{ cursor: "move" }}
            pointerEvents="all"
            onMouseDown={onPivotDown}
          />
          {ROTATE_HANDLES.map((h) => {
            const p = rotateXY(box, h, off);
            return (
              <circle
                key={h}
                cx={p.x} cy={p.y} r={s / 2}
                fill="#0a0a0a" stroke="#00f0ff" strokeWidth={1 / zoom}
                style={{ cursor: "grab" }}
                pointerEvents="all"
                onMouseDown={(e) => onRotateDown(e)}
              />
            );
          })}
        </>
      )}
    </g>
  );
}

// no custom comparator: onScaleDown/onRotateDown close over live selection,
// so same-bbox/different-membership selections must never reuse a stale render
export default memo(SelectionBoxInner);
