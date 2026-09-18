import { useRef, useState } from "react";
import { useDoc } from "../store/doc";
import { downloadSVG, objectsToSVG } from "../canvas/export";
import { downloadVL, openVLFile } from "../store/persist";
import { PRESETS, TEMPLATES, presetById } from "../canvas/templates";

type Menu = null | "file" | "templates" | "size";

export default function TopBar() {
  const canUndo = useDoc((s) => s.past.length > 0);
  const canRedo = useDoc((s) => s.future.length > 0);
  const undo = useDoc((s) => s.undo);
  const redo = useDoc((s) => s.redo);
  const count = useDoc((s) => s.objects.length);
  const page = useDoc((s) => s.page);
  const dirty = useDoc((s) => s.dirty);
  const [menu, setMenu] = useState<Menu>(null);
  const [cw, setCw] = useState("794");
  const [ch, setCh] = useState("1123");
  const fileRef = useRef<HTMLInputElement>(null);

  const close = () => setMenu(null);

  const copy = async () => {
    const st = useDoc.getState();
    const svg = objectsToSVG(st.objects, st.page);
    try {
      await navigator.clipboard.writeText(svg);
    } catch {
      useDoc.setState({ jimooError: "clipboard blocked by browser" });
      setTimeout(() => useDoc.setState({ jimooError: "" }), 3000);
    }
  };

  const applyPreset = (id: string) => {
    const p = presetById(id);
    if (!p) return;
    useDoc.getState().setPage({ w: p.w, h: p.h, name: p.name, presetId: p.id });
    close();
  };

  const applyCustom = () => {
    const w = Math.round(Number(cw));
    const h = Math.round(Number(ch));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 72 || h < 72 || w > 4800 || h > 4800) {
      useDoc.setState({ jimooError: "canvas size must be 72–4800 px" });
      setTimeout(() => useDoc.setState({ jimooError: "" }), 3000);
      return;
    }
    useDoc.getState().setPage({ w, h, name: `${w}×${h}`, presetId: "custom" });
    close();
  };

  const applyTemplate = (id: string) => {
    const t = TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    const p = presetById(t.presetId);
    if (!p) return;
    useDoc.getState().applyTemplate(
      { w: p.w, h: p.h, name: p.name, presetId: p.id },
      t.build(p.w, p.h)
    );
    close();
  };

  const openSize = () => {
    const st = useDoc.getState();
    setCw(String(st.page.w));
    setCh(String(st.page.h));
    setMenu("size");
  };

  const groups = ["Print", "Social", "Web"] as const;

  return (
    <header className="vl-top">
      <button
        className={`vl-wordmark-btn${menu ? " active" : ""}`}
        onClick={() => setMenu(menu ? null : "file")}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
      >
        VECT<em>O</em>LINE ▾
      </button>
      <span className="vl-project">
        untitled.vl{dirty ? " •" : ""} · {count} · {page.name} {page.w}×{page.h}
      </span>

      {menu && (
        <>
          <div className="vl-menu-scrim" onClick={close} />
          <div className="vl-menu" role="menu" aria-label="File menu">
            {menu === "file" && (
              <>
                <button className="vl-menu-item" role="menuitem" onClick={() => { useDoc.getState().newDoc(); close(); }}>
                  NEW BLANK <span className="vl-menu-note">keeps size</span>
                </button>
                <button className="vl-menu-item" role="menuitem" onClick={() => { downloadVL(); close(); }}>
                  SAVE .VL <span className="vl-menu-note">download</span>
                </button>
                <button className="vl-menu-item" role="menuitem" onClick={() => fileRef.current?.click()}>
                  OPEN .VL… <span className="vl-menu-note">load file</span>
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".vl,.json,application/json"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (!f) return;
                    if (await openVLFile(f)) close();
                  }}
                />
                <button className="vl-menu-item" role="menuitem" onClick={() => setMenu("templates")}>
                  NEW FROM TEMPLATE <span>▸</span>
                </button>
                <button className="vl-menu-item" role="menuitem" onClick={openSize}>
                  CANVAS SIZE… <span className="vl-menu-note">{page.w}×{page.h}</span>
                </button>
              </>
            )}
            {menu === "templates" && (
              <>
                <button className="vl-menu-item back" role="menuitem" onClick={() => setMenu("file")}>◂ BACK</button>
                <div className="vl-menu-sep" />
                {TEMPLATES.map((t) => {
                  const p = presetById(t.presetId);
                  return (
                    <button key={t.id} className="vl-menu-item" role="menuitem" onClick={() => applyTemplate(t.id)}>
                      {t.name.toUpperCase()}
                      <span className="vl-menu-note">{p ? `${p.w}×${p.h}` : ""}</span>
                    </button>
                  );
                })}
              </>
            )}
            {menu === "size" && (
              <>
                <button className="vl-menu-item back" role="menuitem" onClick={() => setMenu("file")}>◂ BACK</button>
                <div className="vl-menu-sep" />
                {groups.map((g) => (
                  <div key={g}>
                    <div className="vl-menu-group">{g.toUpperCase()}</div>
                    <div className="vl-size-grid">
                      {PRESETS.filter((p) => p.group === g).map((p) => (
                        <button
                          key={p.id}
                          className={`vl-size-btn${page.presetId === p.id ? " active" : ""}`}
                          onClick={() => applyPreset(p.id)}
                          title={`${p.w}×${p.h}`}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <div className="vl-menu-sep" />
                <div className="vl-size-custom">
                  <input value={cw} onChange={(e) => setCw(e.target.value)} aria-label="Width px" />
                  <span>×</span>
                  <input value={ch} onChange={(e) => setCh(e.target.value)} aria-label="Height px" />
                  <button className="vl-btn primary" onClick={applyCustom}>SET</button>
                </div>
                <div className="vl-menu-note" style={{ padding: "6px 10px" }}>
                  72–4800 px · 96dpi · resize never moves objects
                </div>
              </>
            )}
          </div>
        </>
      )}

      <div className="vl-top-spacer" />
      <button className="vl-btn" disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)">UNDO</button>
      <button className="vl-btn" disabled={!canRedo} onClick={redo} title="Redo (Ctrl+Y)">REDO</button>
      <button className="vl-btn" onClick={copy} title="Copy page SVG code">COPY</button>
      <button
        className="vl-btn primary"
        onClick={() => {
          const st = useDoc.getState();
          downloadSVG(st.objects, st.page);
        }}
        title="Download page SVG"
      >
        EXPORT SVG
      </button>
    </header>
  );
}
