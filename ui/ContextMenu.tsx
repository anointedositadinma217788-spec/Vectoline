import { useEffect, useRef } from "react";

/** One entry in the right-click menu. sep=true renders a divider row. */
export interface CtxItem {
  label?: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  sep?: boolean;
  run?: () => void;
}

interface Menu {
  x: number;
  y: number;
  items: CtxItem[];
}

interface Props {
  menu: Menu | null;
  onClose: () => void;
}

function ContextMenuInner({ menu, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    // any pointer-down outside the menu closes it (inside clicks run first)
    const down = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const wipe = () => onClose();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    window.addEventListener("wheel", wipe, { passive: true });
    window.addEventListener("blur", wipe);
    window.addEventListener("resize", wipe);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("wheel", wipe);
      window.removeEventListener("blur", wipe);
      window.removeEventListener("resize", wipe);
    };
  }, [menu, onClose]);

  if (!menu || menu.items.length === 0) return null;

  // keep the menu inside the viewport
  const W = 190;
  const H = menu.items.length * 29 + 10;
  const x = Math.max(4, Math.min(menu.x, window.innerWidth - W - 8));
  const y = Math.max(4, Math.min(menu.y, window.innerHeight - H - 8));

  return (
    <div ref={ref} className="vl-ctx" role="menu" style={{ left: x, top: y }}>
      {menu.items.map((it, i) =>
        it.sep ? (
          <div key={i} className="vl-ctx-sep" role="separator" />
        ) : (
          <button
            key={i}
            className={`vl-ctx-item${it.danger ? " danger" : ""}`}
            disabled={it.disabled}
            role="menuitem"
            onClick={() => {
              it.run?.();
              onClose();
            }}
          >
            <span>{it.label}</span>
            {it.hint && <em>{it.hint}</em>}
          </button>
        )
      )}
    </div>
  );
}

export default ContextMenuInner;