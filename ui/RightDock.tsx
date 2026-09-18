import { useCallback, useEffect, useRef, useState } from "react";
import { useDoc } from "../store/doc";
import {
  checkHealth,
  runAgentLoop,
  createSession,
  type ChatMessage,
  type ConfirmChoice,
} from "../ai/client";

const DOCK_W_KEY = "gimoo.dock.w";
const DOCK_W_DEFAULT = 300;
const DOCK_W_MIN = 240;
const DOCK_W_MAX = 600;

const clampDockW = (v: number) =>
  Math.min(DOCK_W_MAX, Math.max(DOCK_W_MIN, Math.round(v)));

const readDockW = (): number => {
  try {
    const raw = localStorage.getItem(DOCK_W_KEY);
    if (!raw) return DOCK_W_DEFAULT;
    const v = Number(raw);
    return Number.isFinite(v) ? clampDockW(v) : DOCK_W_DEFAULT;
  } catch {
    return DOCK_W_DEFAULT;
  }
};
import type { VecObject } from "../canvas/types";
import { syncTextBox, FONTS, nearestWeight } from "../canvas/text";

/** Number field: edits locally, commits once on blur/Enter. Empty cancels. */
function Num(props: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onCommit: (v: number) => void;
}) {
  const [txt, setTxt] = useState<string | null>(null);
  const done = (raw: string) => {
    setTxt(null);
    if (raw.trim() === "") return;
    const v = Number(raw);
    if (Number.isNaN(v)) return;
    const lo = props.min ?? -Infinity;
    const hi = props.max ?? Infinity;
    const c = Math.min(hi, Math.max(lo, v));
    if (c !== props.value) {
      const st = useDoc.getState();
      if (!st.gestureActive) st.checkpoint();
      props.onCommit(c);
    }
  };
  return (
    <div className="vl-field">
      <span>{props.label}</span>
      <input
        type="number"
        step={props.step ?? 1}
        value={txt ?? String(props.value)}
        onChange={(e) => setTxt(e.target.value)}
        onBlur={(e) => done(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setTxt(null);
        }}
      />
    </div>
  );
}

/** Text field: commits once on blur/Enter when changed. */
function Str(props: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  rows?: number;
}) {
  const [txt, setTxt] = useState<string | null>(null);
  const done = (raw: string) => {
    setTxt(null);
    if (raw !== props.value) {
      const st = useDoc.getState();
      if (!st.gestureActive) st.checkpoint();
      props.onCommit(raw);
    }
  };
  const shared = {
    value: txt ?? props.value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setTxt(e.target.value),
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      done(e.target.value),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !props.rows) (e.target as HTMLElement).blur();
      if (e.key === "Escape") setTxt(null);
    },
  };
  return (
    <div className="vl-field">
      <span>{props.label}</span>
      {props.rows ? (
        <textarea rows={props.rows} {...shared} style={{ resize: "vertical" }} />
      ) : (
        <input {...shared} />
      )}
    </div>
  );
}

/** Font picker: options preview in their own face; switching snaps the
 *  weight to the closest one the new family ships. */
function FontField(props: { label: string; value: string; onCommit: (v: string) => void }) {
  return (
    <div className="vl-field">
      <span>{props.label}</span>
      <select
        value={props.value}
        onChange={(e) => props.onCommit(e.target.value)}
        aria-label={props.label}
      >
        {FONTS.map((f) => (
          <option key={f.key} value={f.key} style={{ fontFamily: f.css }}>
            {f.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function SingleProps({ o }: { o: VecObject }) {
  const updateObject = useDoc((s) => s.updateObject);
  const patch = (p: Partial<VecObject>) => updateObject(o.id, p);
  const checkpoint = () => {
    const st = useDoc.getState();
    if (!st.gestureActive) st.checkpoint();
  };
  return (
    <div>
      <Str label="NAME" value={o.name} onCommit={(v) => patch({ name: v || o.name })} />
      <Num label="X" value={Math.round(o.x)} onCommit={(v) => patch({ x: v })} />
      <Num label="Y" value={Math.round(o.y)} onCommit={(v) => patch({ y: v })} />
      <Num label="W" value={Math.round(o.w)} min={1} onCommit={(v) => patch({ w: v })} />
      <Num label="H" value={Math.round(o.h)} min={1} onCommit={(v) => patch({ h: v })} />
      <Num label="ROT" value={o.rotation} onCommit={(v) => patch({ rotation: v })} />
      {o.kind !== "image" && (
        <Num label="STROKE" value={o.strokeWidth} min={0} step={0.5} onCommit={(v) => patch({ strokeWidth: v })} />
      )}
      {o.kind === "image" && (
        <div style={{ fontSize: 10, color: "var(--faint)" }}>
          NATURAL {o.naturalW}×{o.naturalH}
        </div>
      )}
      {o.kind === "rect" && (
        <Num label="RADIUS" value={o.rx} min={0} onCommit={(v) => patch({ rx: v })} />
      )}
      {o.kind === "text" && (
        <>
          <Str
            label="TEXT" rows={3} value={o.text}
            onCommit={(v) => patch({ text: v, ...syncTextBox({ ...o, text: v }) })}
          />
          <FontField
            label="FONT" value={o.fontFamily}
            onCommit={(f) => {
              checkpoint();
              const w = nearestWeight(f, o.fontWeight);
              patch({ fontFamily: f, fontWeight: w, ...syncTextBox({ ...o, fontFamily: f, fontWeight: w }) });
            }}
          />
          <Num
            label="WEIGHT" value={o.fontWeight} min={100} max={900} step={100}
            onCommit={(v) => {
              checkpoint();
              const w = nearestWeight(o.fontFamily, v);
              if (w !== o.fontWeight) {
                patch({ fontWeight: w, ...syncTextBox({ ...o, fontWeight: w }) });
              }
            }}
          />
          <Num
            label="SIZE" value={o.fontSize} min={4}
            onCommit={(v) => patch({ fontSize: v, ...syncTextBox({ ...o, fontSize: v }) })}
          />
          <div className="vl-field">
            <span>OUTLINE</span>
            <button
              className={`vl-btn vl-outline-btn${o.outlineOn ? " primary" : ""}`}
              title={o.outlineOn ? "Turn the text outline off" : "Stroke the glyphs with the outline color"}
              onClick={() => {
                checkpoint();
                if (o.outlineOn) {
                  patch({ outlineOn: false });
                } else {
                  // first enable: make sure there is a visible stroke to paint
                  const stroke = o.stroke === "none" || o.stroke === "transparent" ? "#00f0ff" : o.stroke;
                  patch({ outlineOn: true, stroke, strokeWidth: o.strokeWidth > 0 ? o.strokeWidth : 2 });
                }
              }}
            >
              {o.outlineOn ? "ON" : "OFF"}
            </button>
          </div>
        </>
      )}
      {o.kind === "polygon" && (
        <Num label="SIDES" value={o.sides} min={3} max={24} onCommit={(v) => patch({ sides: Math.round(v) } as Partial<VecObject>)} />
      )}
      {o.kind === "star" && (
        <Num label="POINTS" value={o.points} min={3} max={24} onCommit={(v) => patch({ points: Math.round(v) } as Partial<VecObject>)} />
      )}
      <div style={{ fontSize: 10, color: "var(--faint)" }}>{o.kind.toUpperCase()} · {o.id}</div>
    </div>
  );
}

const JIMOO_PREVIEW_PALETTE = ["#00f0ff", "#7c3aed", "#f4f4f4", "#22c55e", "#eab308"];

interface JimooMsg {
  role: "user" | "assistant";
  text: string;
}

const JIMOO_SUGGESTIONS = ["Design a gig poster", "Dusk palette", "Explain canvas", "Tidy alignment"];

const THREADS_KEY = "gimoo.jimoo.threads.v1";
const ACTIVE_THREAD_KEY = "gimoo.jimoo.active.v1";

interface Thread {
  id: string;
  title: string;
  msgs: JimooMsg[];
  sessionId: string | null;
}

function loadThreads(): { threads: Thread[]; activeId: string } {
  try {
    const raw = localStorage.getItem(THREADS_KEY);
    const active = localStorage.getItem(ACTIVE_THREAD_KEY) || "default";
    if (!raw) {
      return { threads: [{ id: "default", title: "Project chat", msgs: [], sessionId: null }], activeId: "default" };
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("empty");
    const threads = parsed
      .filter((t) => t && typeof t.id === "string")
      .map((t) => ({
        id: t.id,
        title: typeof t.title === "string" ? t.title.slice(0, 80) : "Project chat",
        msgs: Array.isArray(t.msgs) ? t.msgs.slice(-40) : [],
        sessionId: typeof t.sessionId === "string" ? t.sessionId : null,
      }));
    void active;
    const activeId = threads.some((t) => t.id === active) ? active : threads[0].id;
    return { threads, activeId };
  } catch {
    return { threads: [{ id: "default", title: "Project chat", msgs: [], sessionId: null }], activeId: "default" };
  }
}

function JimooPanel({ count, err }: { count: number; err: string }) {
  const livePalette = useDoc((s) => s.jimooPalette);
  const palette = livePalette.length > 0 ? livePalette : JIMOO_PREVIEW_PALETTE;
  const isPreviewPalette = livePalette.length === 0;
  const [threads, setThreads] = useState<Thread[]>(() => loadThreads().threads);
  const [activeId, setActiveId] = useState<string>(() => loadThreads().activeId);
  const active = threads.find((t) => t.id === activeId) ?? threads[0];
  const msgs = active?.msgs ?? [];
  const setMsgs = (next: JimooMsg[] | ((m: JimooMsg[]) => JimooMsg[])) => {
    setThreads((prev) =>
      prev.map((t) =>
        t.id === activeId ? { ...t, msgs: typeof next === "function" ? next(t.msgs) : next } : t
      )
    );
  };
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [provider, setProvider] = useState<"gemini" | "mock" | "offline" | "checking">("checking");
  const [phase, setPhase] = useState<{ i: number; n: number; label: string; title?: string } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string } | null>(null);
  const confirmRef = useRef<((c: ConfirmChoice) => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const histRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    void checkHealth().then((p) => {
      if (alive) setProvider(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const el = histRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, streaming, pending, phase, confirm]);

  // persist threads locally so tab switches / reloads never wipe chat
  useEffect(() => {
    try {
      localStorage.setItem(THREADS_KEY, JSON.stringify(threads));
      localStorage.setItem(ACTIVE_THREAD_KEY, activeId);
    } catch {
      // private mode: keep working in memory
    }
  }, [threads, activeId]);

  // coalesced streaming: batch deltas ~100ms to stop per-token re-render + scroll churn
  const deltaBuf = useRef("");
  const deltaTimer = useRef<number | undefined>(undefined);
  const flushDelta = () => {
    const d = deltaBuf.current;
    deltaBuf.current = "";
    if (d) setStreaming((s) => s + d);
  };
  const onDelta = (d: string) => {
    deltaBuf.current += d;
    if (deltaTimer.current) return;
    deltaTimer.current = window.setTimeout(() => {
      deltaTimer.current = undefined;
      flushDelta();
    }, 100);
  };

  const ensureSession = async (thread: Thread, firstText: string): Promise<string | null> => {
    if (thread.sessionId) return thread.sessionId;
    const title = firstText.slice(0, 60) || thread.title;
    const id = await createSession(title);
    if (id) {
      setThreads((prev) => prev.map((t) => (t.id === thread.id ? { ...t, sessionId: id, title } : t)));
    }
    return id;
  };

  const newThread = () => {
    const id = `t${Date.now().toString(36)}`;
    setThreads((prev) => [...prev, { id, title: `Project ${prev.length + 1}`, msgs: [], sessionId: null }]);
    setActiveId(id);
  };

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim().slice(0, 2000);
      if (!text || pending) return;
      const threadNow = threads.find((t) => t.id === activeId) ?? threads[0];
      const next: JimooMsg[] = [...msgs, { role: "user", text }];
      setMsgs(next);
      setDraft("");
      setPending(true);
      setStreaming("");
      setPhase(null);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        if (provider === "offline") {
          const p = await checkHealth();
          setProvider(p);
          if (p === "offline") throw new Error("backend not running — start it with run.bat");
        }
        const sessionId = await ensureSession(threadNow, text);
        const history: ChatMessage[] = next.map((m) => ({ role: m.role, text: m.text }));
        const outcome = await runAgentLoop(history, {
          signal: ctrl.signal,
          onDelta,
          sessionId,
          onRound: (result, round) => {
            void round;
            deltaBuf.current = "";
            if (deltaTimer.current) {
              window.clearTimeout(deltaTimer.current);
              deltaTimer.current = undefined;
            }
            setStreaming("");
            if (result.phase) {
              setPhase({
                i: result.phase.i,
                n: result.phase.n,
                label: result.phase.label,
                title: result.projectTitle,
              });
            } else {
              setPhase(null);
            }
            setMsgs((m) => [...m, { role: "assistant", text: result.reply }]);
          },
          needsConfirm: (title) =>
            new Promise<ConfirmChoice>((resolve) => {
              confirmRef.current = resolve;
              setConfirm({ title });
            }),
        });
        if (outcome.appliedOps > 0 && outcome.rounds > 1) {
          setMsgs((m) => [
            ...m,
            {
              role: "assistant",
              text: `Done — "${outcome.projectTitle ?? "project"}" built in ${outcome.rounds} rounds. One undo removes it all.`,
            },
          ]);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "request failed";
        if (msg !== "stopped") {
          useDoc.setState({ jimooError: msg });
          setTimeout(() => useDoc.setState({ jimooError: "" }), 3000);
          setMsgs((m) => [...m, { role: "assistant", text: `Hmm — ${msg}.` }]);
        }
      } finally {
        confirmRef.current = null;
        setConfirm(null);
        abortRef.current = null;
        setPending(false);
        setStreaming("");
        setPhase(null);
      }
    },
    [msgs, pending, provider, threads, activeId]
  );

  const answerConfirm = (c: ConfirmChoice) => {
    setConfirm(null);
    confirmRef.current?.(c);
    confirmRef.current = null;
  };

  const stop = () => {
    abortRef.current?.abort();
    // stuck on the fresh-canvas card with no fetch in flight: treat Stop as cancel
    if (confirmRef.current) {
      setConfirm(null);
      confirmRef.current("cancel");
      confirmRef.current = null;
    }
  };
  const pill =
    provider === "gemini"
      ? { label: "gemini live", title: "Gemini brain connected" }
      : provider === "mock"
        ? { label: "mock brain", title: "Offline mock brain — set GEMINI_API_KEY for Gemini" }
        : provider === "offline"
          ? { label: "offline", title: "Backend not running — start it with run.bat" }
          : { label: "…", title: "Checking backend" };
  const fallbackActive = msgs.some((m) => m.role === "assistant" && m.text.startsWith("[Gemini unavailable"));

  return (
    <>
      <div className="vl-jimoo-head">
        <span className="vl-jimoo-orb" aria-hidden="true">
          <span className="vl-jimoo-orb-core" />
        </span>
        <span className="vl-jimoo-head-txt">
          <span className="vl-jimoo-name">Jimoo</span>
          <span className="vl-jimoo-sub">
            canvas-aware · {count} object{count === 1 ? "" : "s"}
            {fallbackActive ? " · ⚠ mock brain replying (Gemini failed — retry)" : ""}
          </span>
        </span>
        <span className="vl-jimoo-pill" title={pill.title}>
          {pill.label}
        </span>
      </div>
      <div className="vl-jimoo-chips" aria-label="Project threads" style={{ paddingBottom: 4 }}>
        <select
          value={activeId}
          onChange={(e) => setActiveId(e.target.value)}
          aria-label="Project chat thread"
          title="Per-project chat thread (backend-persisted)"
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--bg)",
            border: "1px solid var(--line)",
            borderRadius: "var(--radius)",
            color: "var(--ink)",
            fontFamily: "var(--mono)",
            fontSize: 10,
            padding: "5px 7px",
            outline: "none",
          }}
        >
          {threads.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title} ({t.msgs.length})
            </option>
          ))}
        </select>
        <button
          className="vl-jimoo-chip live"
          title="New project thread"
          onClick={newThread}
          disabled={pending}
        >
          + NEW
        </button>
      </div>
      <div
        className="vl-jimoo-history"
        ref={histRef}
        role="log"
        aria-live="polite"
        aria-label="Jimoo conversation"
      >
        <div className="vl-jimoo-msg ai">
          <span className="vl-jimoo-orb mini" aria-hidden="true">
            <span className="vl-jimoo-orb-core" />
          </span>
          <div className="vl-jimoo-bubble">
            <p>I read the canvas and suggest palettes you can apply in one click.</p>
            <div className="vl-jimoo-palcard">
              <span className="vl-jimoo-palcard-tag">
                {isPreviewPalette ? "Palette preview" : "Jimoo palette"}
              </span>
              <div className="vl-swatches">
                {palette.map((c) => (
                  <span
                    key={c}
                    className="vl-swatch"
                    style={{ background: c, cursor: "default" }}
                    title={isPreviewPalette ? "Ask for a palette to get live colors" : c}
                  />
                ))}
              </div>
              <span className="vl-jimoo-palcard-note">
                {isPreviewPalette
                  ? "Ask for a palette — live colors land here."
                  : "Served live from the backend."}
              </span>
            </div>
          </div>
        </div>
        {msgs.map((m, i) => (
          <div key={i} className={`vl-jimoo-msg ${m.role}`}>
            {m.role === "assistant" && (
              <span className="vl-jimoo-orb mini" aria-hidden="true">
                <span className="vl-jimoo-orb-core" />
              </span>
            )}
            <div className="vl-jimoo-bubble">{m.text}</div>
          </div>
        ))}
        {pending && (
          <div className="vl-jimoo-msg ai streaming">
            <span className="vl-jimoo-orb mini" aria-hidden="true">
              <span className="vl-jimoo-orb-core" />
            </span>
            <div className="vl-jimoo-bubble">
              {streaming ? (
                streaming
              ) : (
                <span className="vl-jimoo-typing" aria-label="Jimoo is typing">
                  <i />
                  <i />
                  <i />
                </span>
              )}
            </div>
          </div>
        )}
        {confirm && (
          <div className="vl-jimoo-msg ai">
            <span className="vl-jimoo-orb mini" aria-hidden="true">
              <span className="vl-jimoo-orb-core" />
            </span>
            <div className="vl-jimoo-bubble">
              <p>
                “{confirm.title}” wants a blank page, but this canvas has work on it. How should I
                proceed?
              </p>
              <div className="vl-jimoo-confirm-row">
                <button className="vl-btn primary" onClick={() => answerConfirm("new")}>
                  New doc
                </button>
                <button className="vl-btn" onClick={() => answerConfirm("beside")}>
                  Build beside
                </button>
                <button className="vl-btn" onClick={() => answerConfirm("cancel")}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      {phase && (
        <div className="vl-jimoo-progress" aria-live="polite">
          <span className="vl-jimoo-orb mini spin" aria-hidden="true">
            <span className="vl-jimoo-orb-core" />
          </span>
          <span>
            {phase.title ? `${phase.title} · ` : ""}{phase.label} · {phase.i}/{phase.n}
          </span>
        </div>
      )}
      <div className="vl-jimoo-chips" aria-label="Suggested prompts">
        {JIMOO_SUGGESTIONS.map((s) => (
          <button
            key={s}
            className="vl-jimoo-chip live"
            disabled={pending}
            title={pending ? "Waiting for Jimoo…" : `Ask: ${s}`}
            onClick={() => void send(s)}
          >
            {s}
          </button>
        ))}
      </div>
      <form
        className="vl-jimoo-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={pending ? "Jimoo is thinking…" : "Ask Jimoo… palettes, layout, meaning"}
          aria-label="Ask Jimoo"
          disabled={pending}
          maxLength={2000}
        />
        {pending ? (
          <button type="button" className="vl-btn" onClick={stop} aria-label="Stop Jimoo">
            Stop
          </button>
        ) : (
          <button
            type="submit"
            className="vl-btn primary"
            disabled={!draft.trim()}
            aria-label="Send to Jimoo"
          >
            Send
          </button>
        )}
      </form>
      <div className="vl-jimoo-foot">
        {provider === "offline"
          ? "Backend offline · start it with run.bat"
          : "Undo-safe edits · palette never auto-paints"}
      </div>
      <div className="vl-jimoo-err">{err}</div>
    </>
  );
}

export default function RightDock() {
  const [tab, setTab] = useState<"jimoo" | "design">("jimoo");
  const [dockW, setDockW] = useState<number>(() => readDockW());
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const err = useDoc((s) => s.jimooError);
  const objects = useDoc((s) => s.objects);
  const selection = useDoc((s) => s.selection);
  const setSelection = useDoc((s) => s.setSelection);
  const updateObject = useDoc((s) => s.updateObject);
  const deleteSelection = useDoc((s) => s.deleteSelection);
  const duplicateSelection = useDoc((s) => s.duplicateSelection);

  const sel = objects.filter((o) => selection.includes(o.id));

  const toggleFlag = (id: string, key: "hidden" | "locked") => {
    const st = useDoc.getState();
    const o = st.objects.find((x) => x.id === id);
    if (!o) return;
    if (!st.gestureActive) st.checkpoint();
    updateObject(id, { [key]: !o[key] } as Partial<VecObject>);
  };

  // publish width to the shell grid (inherits via :root) + persist
  useEffect(() => {
    document.documentElement.style.setProperty("--dock-w", `${dockW}px`);
    try {
      localStorage.setItem(DOCK_W_KEY, String(dockW));
    } catch {
      // private mode: keep working in memory
    }
  }, [dockW]);

  const onResizerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      dragRef.current = { startX: e.clientX, startW: dockW };
      setResizing(true);
      document.body.classList.add("vl-dock-resizing");
    },
    [dockW]
  );

  useEffect(() => {
    if (!resizing) return;
    const move = (e: PointerEvent) => {
      const g = dragRef.current;
      if (!g) return;
      setDockW(clampDockW(g.startW + (g.startX - e.clientX)));
    };
    const up = () => {
      dragRef.current = null;
      setResizing(false);
      document.body.classList.remove("vl-dock-resizing");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [resizing]);

  const resetDockW = () => setDockW(DOCK_W_DEFAULT);
  const toggleWide = () =>
    setDockW((w) => (w > DOCK_W_DEFAULT + 40 ? DOCK_W_DEFAULT : 460));

  return (
    <aside className="vl-dock" aria-label="Right dock">
      <div
        className={`vl-dock-resizer${resizing ? " dragging" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize AI panel"
        aria-valuemin={DOCK_W_MIN}
        aria-valuemax={DOCK_W_MAX}
        aria-valuenow={dockW}
        tabIndex={0}
        title="Drag to resize · double-click resets"
        onPointerDown={onResizerDown}
        onDoubleClick={resetDockW}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); setDockW((w) => clampDockW(w + 8)); }
          else if (e.key === "ArrowRight") { e.preventDefault(); setDockW((w) => clampDockW(w - 8)); }
          else if (e.key === "Home") { e.preventDefault(); resetDockW(); }
        }}
      />
      <div className="vl-tabs">
        <button className={`vl-tab${tab === "jimoo" ? " active" : ""}`} onClick={() => setTab("jimoo")}>
          JIMOO
        </button>
        <button className={`vl-tab${tab === "design" ? " active" : ""}`} onClick={() => setTab("design")}>
          DESIGN
        </button>
        <button
          className="vl-dock-toggle"
          onClick={toggleWide}
          title={dockW > DOCK_W_DEFAULT + 40 ? "Shrink panel to default" : "Expand panel wide"}
          aria-label={dockW > DOCK_W_DEFAULT + 40 ? "Shrink AI panel" : "Expand AI panel"}
        >
          {dockW > DOCK_W_DEFAULT + 40 ? "»" : "«"}
        </button>
      </div>
      <div className="vl-dock-body">
        {tab === "jimoo" ? (
          <JimooPanel count={objects.length} err={err} />
        ) : (
          <div className="vl-props">
            {sel.length === 1 ? (
              <SingleProps key={sel[0].id} o={sel[0]} />
            ) : sel.length > 1 ? (
              <div>
                <div style={{ marginBottom: 8 }}>{sel.length} selected</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button className="vl-btn" onClick={duplicateSelection}>DUPLICATE</button>
                  <button className="vl-btn" onClick={deleteSelection}>DELETE</button>
                </div>
              </div>
            ) : (
              <div style={{ color: "var(--faint)" }}>
                {objects.length === 0 ? "nothing on canvas yet" : `${objects.length} object${objects.length === 1 ? "" : "s"} — click one to edit`}
              </div>
            )}
            <div style={{ margin: "14px 0 8px", color: "var(--faint)", fontSize: 10, letterSpacing: "0.12em" }}>
              LAYERS
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }} role="listbox" aria-label="Layers">
              {[...objects].reverse().map((o) => (
                <div
                  key={o.id}
                  role="option"
                  aria-selected={selection.includes(o.id)}
                  tabIndex={0}
                  onClick={(e) => {
                    if (e.shiftKey) useDoc.getState().toggleSelect(o.id);
                    else setSelection([o.id]);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      if (e.shiftKey) useDoc.getState().toggleSelect(o.id);
                      else setSelection([o.id]);
                    }
                  }}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    border: selection.includes(o.id) ? "1px solid var(--cyan)" : "1px solid var(--line)",
                    borderRadius: "var(--radius)", padding: "5px 7px", cursor: "pointer",
                    opacity: o.hidden ? 0.45 : 1,
                  }}
                >
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {o.name}
                  </span>
                  <button
                    className="vl-btn" style={{ padding: "2px 6px" }}
                    title={o.hidden ? "Show" : "Hide"}
                    onClick={(e) => { e.stopPropagation(); toggleFlag(o.id, "hidden"); }}
                  >
                    {o.hidden ? "○" : "●"}
                  </button>
                  <button
                    className="vl-btn" style={{ padding: "2px 6px" }}
                    title={o.locked ? "Unlock" : "Lock"}
                    onClick={(e) => { e.stopPropagation(); toggleFlag(o.id, "locked"); }}
                  >
                    {o.locked ? "L" : "·"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
