import { useEffect, useId, useRef, useState } from "react";
import { useDoc, type ToolId } from "../store/doc";
import { ICON_SIZE, ICON_STROKE, TOOL_ICONS } from "./icons";

interface RailTool {
  id: ToolId;
  label: string;
  tip: string;
  key: string;
}

interface RailGroup {
  id: string;
  label: string;
  tools: RailTool[];
}

const GROUPS: RailGroup[] = [
  {
    id: "select",
    label: "SELECT",
    tools: [
      { id: "move", label: "MOVE", tip: "Select / move (V)", key: "V" },
      { id: "zoom", label: "ZOOM", tip: "Zoom in/out (Z)", key: "Z" },
    ],
  },
  {
    id: "draw",
    label: "DRAW",
    tools: [
      { id: "rect", label: "RECT", tip: "Rectangle (R)", key: "R" },
      { id: "ellipse", label: "ELLIPSE", tip: "Circle / ellipse (O)", key: "O" },
      { id: "line", label: "LINE", tip: "Line (L)", key: "L" },
      { id: "polygon", label: "POLY", tip: "Polygon (U)", key: "U" },
      { id: "star", label: "STAR", tip: "Star", key: "" },
      { id: "spiral", label: "SPIRAL", tip: "Spiral", key: "" },
    ],
  },
  {
    id: "curve",
    label: "CURVE",
    tools: [
      { id: "pen", label: "FREEHAND", tip: "Freehand path (P)", key: "P" },
      { id: "bezier", label: "BEZIER", tip: "Bezier pen (B)", key: "B" },
      { id: "node", label: "NODE", tip: "Edit path nodes (N)", key: "N" },
    ],
  },
  {
    id: "text",
    label: "TEXT",
    tools: [{ id: "text", label: "TEXT", tip: "Click-to-place text (T)", key: "T" }],
  },
  {
    id: "paint",
    label: "PAINT",
    tools: [{ id: "eye", label: "PICK", tip: "Eyedropper (I)", key: "I" }],
  },
  {
    id: "modify",
    label: "MODIFY",
    tools: [
      { id: "break", label: "BREAK", tip: "Shape to editable path", key: "" },
      { id: "eraser", label: "ERASER", tip: "Erase from shape (E)", key: "E" },
    ],
  },
  {
    id: "import",
    label: "IMPORT",
    tools: [{ id: "image", label: "IMAGE", tip: "Import image", key: "" }],
  },
];

function ToolIcon({ id }: { id: ToolId }) {
  const Icon = TOOL_ICONS[id];
  return <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" focusable="false" />;
}

function Slot({ group }: { group: RailGroup }) {
  const tool = useDoc((s) => s.tool);
  const setTool = useDoc((s) => s.setTool);
  const memory = useDoc((s) => s.railMemory[group.id]);
  const rememberTool = useDoc((s) => s.rememberTool);
  const [open, setOpen] = useState(false);
  const slotRef = useRef<HTMLDivElement>(null);
  const flyoutId = useId();

  const current = group.tools.find((t) => t.id === memory) ?? group.tools[0];
  const isActive = group.tools.some((t) => t.id === tool);
  const hasFlyout = group.tools.length > 1;

  const pick = (t: RailTool) => {
    setTool(t.id);
    rememberTool(group.id, t.id);
    setOpen(false);
  };

  // Touch: first tap opens flyout, second activates. Also gives keyboard/Esc control.
  const onMainClick = () => {
    if (hasFlyout && current.id !== tool && !open) {
      // If tapping a non-active group, open the flyout first on coarse pointers
      if (window.matchMedia?.("(pointer: coarse)").matches) {
        setOpen(true);
        return;
      }
    }
    pick(current);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!slotRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open ]);

  return (
    <div ref={slotRef} className={`vl-slot${isActive ? " active" : ""}${open ? " open" : ""}`}>
      <button
        className={`vl-tool${tool === current.id ? " active" : ""}`}
        title={current.tip}
        onClick={onMainClick}
        onDoubleClick={() => hasFlyout && setOpen((v) => !v)}
        aria-haspopup={hasFlyout ? "menu" : undefined}
        aria-expanded={hasFlyout ? open : undefined}
        aria-controls={hasFlyout ? flyoutId : undefined}
        aria-label={`${current.label} — ${current.tip}`}
      >
        <span className="glyph">
          <ToolIcon id={current.id} />
        </span>
        <span className="lbl">{current.label}</span>
        {hasFlyout && <span className="fly-arrow">▸</span>}
      </button>
      {hasFlyout && (
        <div
          id={flyoutId}
          className="vl-flyout"
          role="menu"
          aria-label={`${group.label} tools`}
          data-open={open ? "true" : undefined}
        >
          {group.tools.map((t) => (
            <button
              key={t.id}
              role="menuitem"
              className={`vl-tool${tool === t.id ? " active" : ""}`}
              title={t.tip}
              aria-label={`${t.label} — ${t.tip}`}
              onClick={() => pick(t)}
            >
              <span className="glyph">
                <ToolIcon id={t.id} />
              </span>
              <span className="lbl">{t.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function LeftRail() {
  // canvas gestures lock the rail: no hover-expand, no flyouts mid-drag
  const gestureActive = useDoc((s) => s.gestureActive);
  return (
    <nav className={`vl-rail${gestureActive ? " vl-rail-locked" : ""}`} aria-label="Tools">
      {GROUPS.map((g) => (
        <Slot key={g.id} group={g} />
      ))}
    </nav>
  );
}
