import { useRef, useState } from "react";
import { Pipette } from "lucide-react";
import { useDoc } from "../store/doc";
import { isClosedPath } from "../canvas/types";

const SWATCHES = [
  "#0a0a0a", "#1e2024", "#5c5f66", "#9a9da3", "#f4f4f4",
  "#00f0ff", "#7c3aed", "#ff4d4d", "#22c55e", "#eab308",
];

/** Canonical compare: case + 3-digit insensitive. */
export const normHex = (v: string) =>
  v
    .replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i, "#$1$1$2$2$3$3")
    .toLowerCase();

const isHexColor = (v: string) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);

/** Hex field with local draft: typing survives re-renders, commits once. */
function HexInput(props: {
  selKey: string;
  mixed: boolean;
  active: string;
  target: "fill" | "stroke";
  onCommit: (v: string) => void;
  onNone: () => void;
  onTransparent: () => void;
}) {
  const [txt, setTxt] = useState<string | null>(null);
  const shown = txt ?? (props.mixed ? "" : props.active);
  const commit = (raw: string) => {
    setTxt(null);
    const v = raw.trim();
    if (isHexColor(v)) {
      if (props.mixed || normHex(v) !== normHex(props.active)) props.onCommit(v);
    } else if (v.toLowerCase() === "none" && props.target === "stroke") {
      props.onNone();
    } else if (v.toLowerCase() === "transparent") {
      props.onTransparent();
    }
  };
  return (
    <input
      className="vl-hex"
      key={props.selKey}
      value={shown}
      placeholder={props.mixed ? "— mixed" : "#______"}
      spellCheck={false}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setTxt(null);
      }}
      aria-label="Hex color"
    />
  );
}

export default function ColorBar() {
  const target = useDoc((s) => s.colorTarget);
  const setTarget = useDoc((s) => s.setColorTarget);
  const fill = useDoc((s) => s.fill);
  const stroke = useDoc((s) => s.stroke);
  const applyColor = useDoc((s) => s.applyColor);
  const opacity = useDoc((s) => s.opacity);
  const setOpacity = useDoc((s) => s.setOpacity);
  const objects = useDoc((s) => s.objects);
  const selection = useDoc((s) => s.selection);
  const recents = useDoc((s) => s.recents);
  const jimooPalette = useDoc((s) => s.jimooPalette);
  const tool = useDoc((s) => s.tool);
  const setTool = useDoc((s) => s.setTool);

  const sel = objects.filter((o) => selection.includes(o.id));
  const editableSel = objects.filter(
    (o) => selection.includes(o.id) && !o.locked && !o.hidden && o.kind !== "image"
  );
  const allLines = sel.length > 0 && sel.every((o) => o.kind === "line");
  const allOpenPath =
    sel.length > 0 &&
    sel.every((o) => o.kind === "path" && !isClosedPath(o.d));
  const clearOutline = useDoc((s) => s.clearOutline);

  // Dead channels reroute to a visible one: open paths have no fill. Text
  // strokes are alive — they paint the glyph outline (store handles it).
  const effTarget =
    (allOpenPath || allLines) && target === "fill"
      ? "stroke"
      : target;

  // selection-aware active color ("—" when mixed)
  let active: string;
  let mixed = false;
  if (sel.length === 0) {
    active = effTarget === "fill" ? fill : stroke;
  } else {
    const vals = sel.map((o) => (effTarget === "fill" ? o.fill : o.stroke));
    mixed = vals.some((v) => normHex(v) !== normHex(vals[0]));
    active = mixed ? "" : vals[0];
  }

  const selOpacity =
    sel.length === 0
      ? opacity
      : sel.every((o) => o.opacity === sel[0].opacity)
        ? sel[0].opacity
        : -1;
  const opAvg =
    sel.length === 0
      ? opacity
      : Math.round(sel.reduce((a, o) => a + o.opacity, 0) / sel.length);
  const selKey = selection.join(",");

  const checkpointIfSel = () => {
    const st = useDoc.getState();
    // mid-gesture paints join the gesture's undo step instead of interleaving
    if (st.gestureActive) return;
    // no editable targets (all locked/hidden/images): no history, no paint
    const editable = st.objects.filter(
      (o) => st.selection.includes(o.id) && !o.locked && !o.hidden && o.kind !== "image"
    );
    if (st.selection.length > 0 && editable.length === 0) return;
    if (st.selection.length > 0) st.checkpoint();
  };
  // arm-then-fire: exactly one history step per picker/slider gesture
  const armRef = useRef({ color: true, op: true });
  const fireOnce = (which: "color" | "op") => {
    if (armRef.current[which]) {
      armRef.current[which] = false;
      checkpointIfSel();
    }
  };
  const paint = (hex: string) => {
    // no-op paints write no history; non-editable selections paint nothing
    if (sel.length > 0 && editableSel.length === 0) return;
    if (!mixed && normHex(hex) === normHex(active)) return;
    if (effTarget !== target) setTarget(effTarget);
    checkpointIfSel();
    applyColor(hex);
  };
  const noOutline = () => {
    if (
      sel.length > 0 &&
      sel.every(
        (o) => o.stroke === "none" && o.strokeWidth === 0 &&
          !(o.kind === "text" && o.outlineOn === true)
      )
    )
      return;
    if (sel.length > 0 && editableSel.length === 0) return;
    checkpointIfSel();
    clearOutline();
  };

  const isHex6 = (v: string) => /^#[0-9a-f]{6}$/i.test(v);
  const pickerValue = isHex6(active)
    ? active
    : isHex6(effTarget === "fill" ? fill : stroke)
      ? effTarget === "fill" ? fill : stroke
      : "#111214";

  return (
    <div className="vl-colorbar" aria-label="Color bar">
      <div className="vl-seg">
        <button
          className={effTarget === "fill" ? "active" : ""}
          onClick={() => setTarget("fill")}
          disabled={allLines || allOpenPath}
          title={allLines || allOpenPath ? "Strokes only — fill reroutes" : "Paint fill (X swaps)"}
        >
          FILL
        </button>
        <button
          className={effTarget === "stroke" ? "active" : ""}
          onClick={() => setTarget("stroke")}
          title="Paint stroke — on text this colors the outline (X swaps)"
        >
          STROKE
        </button>
      </div>

      <div className="vl-swatches">
        {SWATCHES.map((c) => (
          <button
            key={c}
            className={`vl-swatch${!mixed && normHex(active) === c ? " active" : ""}`}
            style={{ background: c }}
            onClick={() => paint(c)}
            aria-label={c}
          />
        ))}
        <button
          className={`vl-swatch transparent${!mixed && active === "transparent" ? " active" : ""}`}
          onClick={() => paint("transparent")}
          aria-label="transparent"
          title="Transparent"
        />
        <button
          className={`vl-swatch no-outline${!mixed && active === "none" ? " active" : ""}`}
          onClick={noOutline}
          aria-label="no outline"
          title="No outline (stroke none)"
        />
      </div>

      <HexInput
        selKey={selKey}
        mixed={mixed}
        active={active}
        target={effTarget}
        onCommit={(v) => {
          if (effTarget !== target) setTarget(effTarget);
          checkpointIfSel();
          applyColor(v);
        }}
        onNone={noOutline}
        onTransparent={() => paint("transparent")}
      />
      <input
        type="color"
        value={pickerValue}
        onFocus={() => {
          armRef.current.color = true;
        }}
        onChange={(e) => {
          if (effTarget !== target) setTarget(effTarget);
          fireOnce("color");
          applyColor(e.target.value);
        }}
        aria-label="Custom color"
      />

      <div
        className="vl-opacity"
        title={sel.length === 0 ? "Default opacity for new objects" : "Opacity of selection"}
      >
        <span>OP {selOpacity === -1 ? "—" : selOpacity}</span>
        <input
          type="range" min={0} max={100}
          value={selOpacity === -1 ? opAvg : selOpacity}
          onPointerDown={() => {
            armRef.current.op = true;
          }}
          onFocus={() => {
            armRef.current.op = true;
          }}
          onChange={(e) => {
            fireOnce("op");
            setOpacity(Number(e.target.value));
          }}
        />
      </div>

      {recents.filter((c) => c !== "none" && c !== "transparent").length > 0 && (
        <>
          <span className="vl-cb-label">RECENT</span>
          <div className="vl-swatches">
            {recents.filter((c) => c !== "none" && c !== "transparent").map((c) => (
              <button
                key={c}
                className={`vl-swatch${!mixed && normHex(active) === normHex(c) ? " active" : ""}`}
                style={{ background: c }}
                onClick={() => paint(c)}
                aria-label={`recent ${c}`}
              />
            ))}
          </div>
        </>
      )}

      {jimooPalette.length > 0 && (
        <>
          <span className="vl-cb-label">JIMOO</span>
          <div className="vl-swatches">
            {jimooPalette.map((c) => (
              <button key={c} className="vl-swatch" style={{ background: c }} onClick={() => paint(c)} aria-label={`jimoo ${c}`} />
            ))}
          </div>
        </>
      )}

      <button
        className={`vl-btn${tool === "eye" ? " primary" : ""}`}
        onClick={() => setTool(tool === "eye" ? "move" : "eye")}
        title="Eyedropper (I) — pull fill/stroke from any object"
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <Pipette size={14} strokeWidth={1.8} aria-hidden="true" /> PICK
      </button>
    </div>
  );
}
