import { memo } from "react";
import type { VecObject } from "./types";
import { polygonPoints, starPoints } from "./types";
import { fontCss, LINE_H, lineStarts, styledRuns } from "./text";

interface Props {
  o: VecObject;
  selected: boolean;
  zoom: number;
  dimmed?: boolean;
  onDown: (e: React.MouseEvent, id: string) => void;
}

function ObjectNodeInner({ o, selected, zoom, dimmed, onDown }: Props) {
  if (o.hidden) return null;
  const selW = 1 / zoom;
  const op = o.opacity / 100;

  // construction guide: dashed violet shell, never filled, skipped on export
  if (o.guide) {
    return (
      <g
        className="vl-obj"
        data-oid={o.id}
        opacity={dimmed ? 0.4 : 0.9}
        onMouseDown={(e: React.MouseEvent) => onDown(e, o.id)}
        style={{ cursor: "move" }}
      >
        <rect
          x={o.x} y={o.y} width={Math.max(0.1, o.w)} height={Math.max(0.1, o.h)}
          fill="none" stroke="#7c3aed" strokeWidth={selW}
          strokeDasharray={`${6 / zoom} ${4 / zoom}`}
        />
        {selected && (
          <rect
            x={o.x - 4 / zoom} y={o.y - 4 / zoom}
            width={o.w + 8 / zoom} height={o.h + 8 / zoom}
            fill="none" stroke="#00f0ff" strokeWidth={selW}
            strokeDasharray={`${4 / zoom} ${3 / zoom}`}
            pointerEvents="none"
          />
        )}
      </g>
    );
  }

  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const common = {
    opacity: op,
    onMouseDown: (e: React.MouseEvent) => onDown(e, o.id),
    style: { cursor: o.locked ? "not-allowed" : "move" },
  };

  let body: React.ReactNode = null;
  switch (o.kind) {
    case "rect":
      body = (
        <rect
          x={o.x} y={o.y} width={Math.max(0, o.w)} height={Math.max(0, o.h)}
          rx={Math.min(Math.max(0, o.rx), Math.min(o.w, o.h) / 2)} fill={o.fill} stroke={o.stroke} strokeWidth={o.strokeWidth}
        />
      );
      break;
    case "ellipse":
      body = (
        <ellipse
          cx={cx} cy={cy} rx={Math.max(0, o.w / 2)} ry={Math.max(0, o.h / 2)}
          fill={o.fill} stroke={o.stroke} strokeWidth={o.strokeWidth}
        />
      );
      break;
    case "line": {
      // invisible fat hit-stroke: a hairline is nearly impossible to click
      // or double-click (node insert) at low zoom without a padded target
      const hitW = Math.max(o.strokeWidth, 8 / zoom);
      body = (
        <>
          {o.stroke !== "none" && (
            <line
              x1={o.x} y1={o.y} x2={o.x + o.w} y2={o.y + o.h}
              stroke="transparent" strokeWidth={hitW} strokeLinecap="round"
              style={{ pointerEvents: "stroke" }}
            />
          )}
          <line
            x1={o.x} y1={o.y} x2={o.x + o.w} y2={o.y + o.h}
            stroke={o.stroke} strokeWidth={o.stroke === "none" ? 0 : o.strokeWidth}
            strokeLinecap="round"
          />
        </>
      );
      break;
    }
    case "text": {
      const lines = (o.lines && o.lines.length ? o.lines : [o.text ?? ""]) as string[];
      // outline: stroke painted UNDER the fill (paint-order) so glyphs stay crisp
      const outlineOn =
        o.outlineOn === true && o.stroke !== "none" && o.stroke !== "transparent" && o.strokeWidth > 0;
      // per-letter spans: map raw-text ranges onto the laid-out lines
      const starts = lineStarts(o.text ?? "", lines);
      const spans = o.spans ?? [];
      body = (
        <text
          x={o.x} y={o.y + o.fontSize * 0.85}
          fontFamily={fontCss(o.fontFamily)}
          fontSize={o.fontSize} fontWeight={o.fontWeight}
          fill={o.fill}
          stroke={outlineOn ? o.stroke : "none"}
          strokeWidth={outlineOn ? o.strokeWidth : 0}
          paintOrder={outlineOn ? "stroke" : undefined}
          strokeLinejoin="round"
        >
          {lines.map((l, li) => {
            const runs = styledRuns(l, starts[li] ?? 0, spans);
            return (
              <tspan key={li} x={o.x} dy={li === 0 ? 0 : o.fontSize * LINE_H}>
                {runs.map((r, ri) =>
                  r.style ? (
                    <tspan
                      key={ri}
                      fill={r.style.fill}
                      fontWeight={r.style.fontWeight}
                      fontSize={r.style.fontSize}
                      fontFamily={r.style.fontFamily}
                    >
                      {r.text || " "}
                    </tspan>
                  ) : (
                    (r.text || " ")
                  )
                )}
              </tspan>
            );
          })}
        </text>
      );
      break;
    }
    case "path": {
      // closed paths (converted shapes) keep their fill; open strokes stay hollow
      const d = o.d ?? "";
      const showFill = d.trimEnd().endsWith("Z") && o.fill !== "transparent" ? o.fill : "none";
      // invisible fat hit-stroke for open paths: hairline strokes are nearly
      // impossible to hit at low zoom (click select + dbl-click node insert)
      const hitW = Math.max(o.strokeWidth, 8 / zoom);
      body = (
        <g transform={`translate(${o.x} ${o.y})`}>
          {!d.trimEnd().endsWith("Z") && (
            <path
              d={d} fill="none" stroke="transparent" strokeWidth={hitW}
              strokeLinecap="round" strokeLinejoin="round"
              style={{ pointerEvents: "stroke" }}
            />
          )}
          <path d={d} fill={showFill} stroke={o.stroke} strokeWidth={o.stroke === "none" ? 0 : o.strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      );
      break;
    }
    case "polygon":
      body = (
        <polygon
          points={polygonPoints(cx, cy, Math.max(0, o.w / 2), Math.max(0, o.h / 2), o.sides)}
          fill={o.fill} stroke={o.stroke} strokeWidth={o.strokeWidth}
          strokeLinejoin="round"
        />
      );
      break;
    case "star":
      body = (
        <polygon
          points={starPoints(cx, cy, Math.max(0, o.w / 2), Math.max(0, o.h / 2), o.points, o.innerRatio)}
          fill={o.fill} stroke={o.stroke} strokeWidth={o.strokeWidth}
          strokeLinejoin="round"
        />
      );
      break;
    case "image":
      body = (
        <image
          href={o.src}
          x={o.x} y={o.y} width={Math.max(1, o.w)} height={Math.max(1, o.h)}
          preserveAspectRatio="xMidYMid meet"
        />
      );
      break;
  }

  return (
    <g
      className="vl-obj"
      data-oid={o.id}
      transform={o.rotation ? `rotate(${o.rotation} ${cx} ${cy})` : undefined}
      opacity={dimmed ? 0.45 : 1}
    >
      <g {...common}>{body}</g>
      {selected && (
        <rect
          x={o.x - 4 / zoom} y={o.y - 4 / zoom}
          width={o.w + 8 / zoom} height={Math.max(o.h, o.kind === "text" ? o.fontSize : 0) + 8 / zoom}
          fill="none" stroke="#00f0ff" strokeWidth={selW}
          strokeDasharray={`${4 / zoom} ${3 / zoom}`}
          pointerEvents="none"
        />
      )}
    </g>
  );
}

// callbacks ignored: behavior comes from event args + store/refs, and any
// state they close over (e.g. spaceHeld) is mirrored to a ref (see viewport)
export default memo(
  ObjectNodeInner,
  (a, b) =>
    a.o === b.o && a.selected === b.selected && a.zoom === b.zoom && a.dimmed === b.dimmed
);
