import { useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDoc, type AlignMode } from "../store/doc";
import { FONTS } from "../canvas/text";
import { editablePathNodes, pathNodeWorld } from "../canvas/types";

function Num(props: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  onChange: (v: number) => void;
  undoable?: boolean;
}) {
  // local draft: typing never touches the store; commit lands once
  const [txt, setTxt] = useState<string | null>(null);
  const armed = useRef(true);
  const initial = useRef<number | null>(null);
  const done = (raw: string) => {
    setTxt(null);
    armed.current = true;
    if (raw.trim() === "") return;
    const v = Number(raw);
    if (Number.isNaN(v)) return;
    const lo = props.min ?? -Infinity;
    const hi = props.max ?? Infinity;
    const c = Math.min(hi, Math.max(lo, v));
    if (c === props.value) return;
    if (props.undoable) {
      const st = useDoc.getState();
      if (!st.gestureActive && st.selection.length > 0) st.checkpoint();
    }
    props.onChange(c);
  };
  return (
    <label className="vl-opt">
      <span>{props.label}</span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        placeholder={props.placeholder}
        value={txt ?? (Number.isNaN(props.value) ? "" : String(props.value))}
        onFocus={() => {
          armed.current = true;
          initial.current = props.value;
        }}
        onChange={(e) => {
          // WIDTH slider-style scrubbing stays live but checkpoints once
          if (props.undoable && armed.current) {
            const st = useDoc.getState();
            if (!st.gestureActive && st.selection.length > 0) st.checkpoint();
            armed.current = false;
          }
          setTxt(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() === "" || Number.isNaN(v)) return;
          const lo = props.min ?? -Infinity;
          const hi = props.max ?? Infinity;
          props.onChange(Math.min(hi, Math.max(lo, v)));
        }}
        onBlur={(e) => done(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            // revert live-applied scrub back to the focus-time value
            if (initial.current != null && initial.current !== props.value) {
              props.onChange(initial.current);
            }
            setTxt(null);
            armed.current = true;
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}

function Act(props: { label: string; title: string; onClick: () => void; disabled?: boolean; on?: boolean }) {
  return (
    <button
      className={`vl-act${props.on ? " on" : ""}`}
      title={props.title}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      {props.label}
    </button>
  );
}

const HINTS: Partial<Record<string, string>> = {
  move: "CLICK SELECT · SHIFT MULTI · DRAG MOVE · ARROWS NUDGE",
  zoom: "CLICK + · ALT-CLICK − · DRAG MARQUEE",
  eye: "CLICK AN OBJECT TO PICK ITS COLOR",
  image: "CLICK CANVAS TO PLACE AN IMAGE",
  break: "CLICK A SHAPE TO MAKE IT EDITABLE",
  node: "ARROWS NUDGE · CTRL CONSTRAINS · DBL-CLICK SEGMENT ADDS/DRAGS · MARQUEE SELECTS · TAB CYCLES · CTRL+A ALL · DEL KEEPS SHAPE",
  eraser: "DRAG ACROSS STROKES TO SPLIT · SHAPES DELETE WHOLE",
};

export default function OptionsBar() {
  const tool = useDoc((s) => s.tool);
  const selCount = useDoc((s) => s.selection.length);
  const rotateMode = useDoc((s) => s.rotateMode);
  const strokeWidth = useDoc((s) => s.strokeWidth);
  const setStrokeWidth = useDoc((s) => s.setStrokeWidth);
  const opts = useDoc((s) => s.toolOpts);
  const setToolOpt = useDoc((s) => s.setToolOpt);
  const textFont = useDoc((s) => s.textFont);
  const setTextFont = useDoc((s) => s.setTextFont);
  const nodeHandlesAll = useDoc((s) => s.nodeHandlesAll);
  const nodeSnap = useDoc((s) => s.nodeSnap);
  // live position of the first selected node (world coords) for the readout
  // rotation-aware: rotated paths report the true world point, not o.x+n.x
  const nodePos = useDoc(
    useShallow((s) => {
      const info = s.nodeSelInfo;
      if (!info || info.idx.length === 0) return null;
      const o = s.objects.find((x) => x.id === info.objId);
      if (!o || o.kind !== "path") return null;
      const ns = editablePathNodes(o);
      const n = ns[info.idx[0]];
      if (!n) return null;
      const w = pathNodeWorld(o, n);
      return {
        x: Math.round(w.x * 10) / 10,
        y: Math.round(w.y * 10) / 10,
        count: info.idx.length,
      };
    })
  );
  // hooks before any early return: hook order must be stable per render
  const widthObjs = useDoc(
    useShallow((s) =>
      s.objects.filter((o) => s.selection.includes(o.id) && !o.locked && !o.hidden && o.kind !== "image")
    )
  );

  // arrange actions own their history (exactly one step, only when changed)
  const align = (m: AlignMode) => () => useDoc.getState().alignSelection(m);
  const distr = (axis: "x" | "y") => () => useDoc.getState().distributeSelection(axis);
  // node ops travel to the viewport (which owns the node selection) by event,
  // the same bridge the IMAGE import button uses
  const nodeOp = (op: string) =>
    window.dispatchEvent(new CustomEvent("vl:node-op", { detail: op }));
  // payload variant for ops that carry values (e.g. the X/Y node fields):
  // unedited axes travel as null so the viewport keeps the live value —
  // filling them here from a possibly stale readout would lose precision
  // and break rotated paths (readout is world, node math is local).
  const nodeOpData = (op: string, x: number | null, y: number | null) => {
    const st = useDoc.getState();
    const info = st.nodeSelInfo;
    if (!info || info.idx.length === 0) return;
    window.dispatchEvent(
      new CustomEvent("vl:node-op", {
        detail: { op, x, y },
      })
    );
  };

  // selection action mode absorbs the old BOOL/GROUP/ALIGN rail slots
  if (selCount >= 2 && tool === "move") {
    return (
      <div className="vl-opts" aria-label="Arrange actions">
        <span className="vl-opts-tag">ARRANGE</span>
        <Act label="L" title="Align left" onClick={align("left")} />
        <Act label="CX" title="Center horizontally" onClick={align("centerX")} />
        <Act label="R" title="Align right" onClick={align("right")} />
        <span className="vl-opts-sep" />
        <Act label="T" title="Align top" onClick={align("top")} />
        <Act label="CY" title="Center vertically" onClick={align("centerY")} />
        <Act label="B" title="Align bottom" onClick={align("bottom")} />
        <span className="vl-opts-sep" />
        <Act label="DH" title="Distribute horizontally (3+)" onClick={distr("x")} disabled={selCount < 3} />
        <Act label="DV" title="Distribute vertically (3+)" onClick={distr("y")} disabled={selCount < 3} />
        <span className="vl-opts-sep" />
        <Act
          label="SCALE"
          title="Show scale handles"
          on={!rotateMode}
          onClick={() => useDoc.getState().setRotateMode(false)}
        />
        <Act
          label="ROTATE"
          title="Show rotate handles (Esc exits)"
          on={rotateMode}
          onClick={() => useDoc.getState().setRotateMode(true)}
        />
        <span className="vl-opts-sep" />
        <Act label="DUPL" title="Duplicate (Ctrl+D)" onClick={() => useDoc.getState().duplicateSelection()} />
        <Act label="DEL" title="Delete (Del)" onClick={() => useDoc.getState().deleteSelection()} />
      </div>
    );
  }

  const widthUniform =
    widthObjs.length === 0 ||
    widthObjs.every((o) => o.strokeWidth === widthObjs[0].strokeWidth);
  // uniform selection value, mixed shows "—", empty shows the default
  const widthShown =
    widthObjs.length === 0
      ? strokeWidth
      : widthUniform
        ? widthObjs[0].strokeWidth
        : NaN;

  const width = (
    <Num key="w" label="WIDTH" value={widthShown} min={0} max={64} step={0.5}
      placeholder={Number.isNaN(widthShown) ? "—" : undefined}
      undoable onChange={setStrokeWidth} />
  );

  let controls: React.ReactNode = null;
  switch (tool) {
    case "rect":
      controls = (
        <>
          <Num label="RX" value={opts.rectRx} min={0} max={500} onChange={(v) => setToolOpt("rectRx", v)} />
          {width}
        </>
      );
      break;
    case "ellipse":
    case "line":
    case "pen":
    case "bezier":
      controls = width;
      break;
    case "eraser":
      controls = (
        <Num label="SIZE" value={opts.eraserSize} min={4} max={200} onChange={(v) => setToolOpt("eraserSize", v)} />
      );
      break;
    case "polygon":
      controls = (
        <>
          <Num label="SIDES" value={opts.polySides} min={3} max={24} onChange={(v) => setToolOpt("polySides", Math.round(v))} />
          {width}
        </>
      );
      break;
    case "star":
      controls = (
        <>
          <Num label="POINTS" value={opts.starPoints} min={3} max={24} onChange={(v) => setToolOpt("starPoints", Math.round(v))} />
          {width}
        </>
      );
      break;
    case "spiral":
      controls = (
        <Num label="TURNS" value={opts.spiralTurns} min={1} max={12} step={0.5} onChange={(v) => setToolOpt("spiralTurns", v)} />
      );
      break;
    case "text":
      controls = (
        <>
          <label className="vl-opt">
            <span>FONT</span>
            <select
              value={textFont}
              onChange={(e) => setTextFont(e.target.value)}
              aria-label="Font for new text"
            >
              {FONTS.map((f) => (
                <option key={f.key} value={f.key} style={{ fontFamily: f.css }}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <Num label="SIZE" value={opts.textSize} min={4} max={400} onChange={(v) => setToolOpt("textSize", v)} />
        </>
      );
      break;
    case "image":
      controls = (
        <>
          <span className="vl-opts-hint">{HINTS.image}</span>
          <button
            className="vl-act"
            title="Choose an image file (PNG/JPG, 12 MB max)"
            onClick={() => window.dispatchEvent(new CustomEvent("vl:import-image"))}
          >
            IMPORT…
          </button>
        </>
      );
      break;
    case "node":
      controls = (
        <>
          <span className="vl-opts-hint">{HINTS.node}</span>
          <span className="vl-opts-sep" />
          <Act label="◇ CUSP" title="Corner node — retracts the handles (! toggles)" onClick={() => nodeOp("cusp")} />
          <Act label="□ SMOOTH" title="Smooth node — collinear handles" onClick={() => nodeOp("smooth")} />
          <Act label="● SYM" title="Symmetrical node — equal-length handles" onClick={() => nodeOp("sym")} />
          <span className="vl-opts-sep" />
          <Act label="INS" title="Insert nodes at the midpoints of selected segments (Insert)" onClick={() => nodeOp("insert")} />
          <Act label="DUP" title="Duplicate selected nodes (Shift+D)" onClick={() => nodeOp("dup")} />
          <Act label="JOIN" title="Join two selected nodes (Shift+J)" onClick={() => nodeOp("join")} />
          <span className="vl-opts-sep" />
          <Act label="⇔" title="Align selected nodes horizontally" onClick={() => nodeOp("alignH")} />
          <Act label="⇕" title="Align selected nodes vertically" onClick={() => nodeOp("alignV")} />
          <Act label="REV" title="Reverse the path direction" onClick={() => nodeOp("reverse")} />
          {nodePos && (
            <>
              <span className="vl-opts-sep" />
              <Num
                key={`nx-${nodePos.x}`}
                label="X"
                value={nodePos.x}
                step={1}
                onChange={(v) => nodeOpData("moveNodeTo", v, null)}
                undoable
              />
              <Num
                key={`ny-${nodePos.y}`}
                label="Y"
                value={nodePos.y}
                step={1}
                onChange={(v) => nodeOpData("moveNodeTo", null, v)}
                undoable
              />
            </>
          )}
          <span className="vl-opts-sep" />
          <Act
            label={nodeSnap ? "SNAP: ON" : "SNAP: OFF"}
            title="Magnetic snapping for node drags (8px grid + every other node's nodes)"
            on={nodeSnap}
            onClick={() => useDoc.getState().setNodeSnap(!nodeSnap)}
          />
          <span className="vl-opts-sep" />
          <Act
            label={nodeHandlesAll ? "HANDLES: ALL" : "HANDLES: SEL"}
            title="Show bezier handles for every node, or only for selected/hovered nodes"
            on={nodeHandlesAll}
            onClick={() => useDoc.getState().setNodeHandlesAll(!nodeHandlesAll)}
          />
        </>
      );
      break;
    default: {
      // move tool with a selection: handle mode is an explicit, visible
      // choice — never a hidden click-toggle
      const modeBtns =
        tool === "move" && selCount > 0 ? (
          <>
            <span className="vl-opts-sep" />
            <Act
              label="SCALE"
              title="Scale handles"
              on={!rotateMode}
              onClick={() => useDoc.getState().setRotateMode(false)}
            />
            <Act
              label="ROTATE"
              title="Rotate handles (Esc exits)"
              on={rotateMode}
              onClick={() => useDoc.getState().setRotateMode(true)}
            />
          </>
        ) : null;
      controls = (
        <>
          <span className="vl-opts-hint">{HINTS[tool] ?? ""}</span>
          {modeBtns}
        </>
      );
      break;
    }
  }

  return (
    <div className="vl-opts" aria-label="Tool options">
      <span className="vl-opts-tag">{tool.toUpperCase()}</span>
      {controls}
    </div>
  );
}
