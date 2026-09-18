import { useDoc } from "./doc";
import type { VecObject } from "../canvas/types";
import type { Page } from "./doc";

const KEY = "vectoline.doc.v1";
const BACKUP_KEY = "vectoline.doc.v1.backup";
const SAVE_DEBOUNCE_MS = 600;

let errTimer: number | undefined;
function flashErr(m: string) {
  useDoc.setState({ jimooError: m });
  if (errTimer) window.clearTimeout(errTimer);
  errTimer = window.setTimeout(() => useDoc.setState({ jimooError: "" }), 3000);
}

interface SavedDoc {
  version: 1;
  page: Page;
  objects: VecObject[];
  savedAt: string;
}

const VALID_KINDS = new Set([
  "rect",
  "ellipse",
  "line",
  "text",
  "path",
  "polygon",
  "star",
  "image",
]);

function isValidDoc(d: unknown): d is SavedDoc {
  if (!d || typeof d !== "object") return false;
  const v = d as Record<string, unknown>;
  if (v.version !== 1) return false;
  const page = v.page as Record<string, unknown> | undefined;
  if (!page || typeof page.w !== "number" || typeof page.h !== "number") return false;
  if (!Number.isFinite(page.w) || !Number.isFinite(page.h)) return false;
  if (page.w < 72 || page.h < 72 || page.w > 4800 || page.h > 4800) return false;
  if (typeof page.name !== "string" || page.name.length === 0 || page.name.length > 64) return false;
  if (typeof page.presetId !== "string" || page.presetId.length > 64) return false;
  if (!Array.isArray(v.objects)) return false;
  if (v.objects.length > 2000) return false;
  const seen = new Set<string>();
  const numOk = (n: unknown, lo = -100000, hi = 100000) =>
    typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;
  for (const o of v.objects as Record<string, unknown>[]) {
    if (!o || typeof o !== "object") return false;
    if (typeof o.id !== "string" || o.id.length === 0 || o.id.length > 128) return false;
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    if (typeof o.kind !== "string") return false;
    if (!VALID_KINDS.has(o.kind)) return false;
    if (!numOk(o.x) || !numOk(o.y)) return false;
    if (typeof o.w !== "number" || typeof o.h !== "number") return false;
    if (!Number.isFinite(o.w) || !Number.isFinite(o.h)) return false;
    if (o.w < 0 || o.h < 0 || o.w > 10000 || o.h > 10000) return false;
    if (typeof o.rotation !== "undefined" && !numOk(o.rotation, -3600, 3600)) return false;
    if (typeof o.opacity !== "undefined" && !numOk(o.opacity, 0, 100)) return false;
    if (typeof o.strokeWidth !== "undefined" && !numOk(o.strokeWidth, 0, 500)) return false;
    if (typeof o.fill === "string" && o.fill.length > 8_000_000) return false;
    if (typeof o.stroke === "string" && o.stroke.length > 100) return false;
    if (o.kind === "image" && typeof o.src !== "string") return false;
    if (typeof o.src === "string" && o.src.length > 8_000_000) return false;
    if (o.kind === "text") {
      if (typeof o.text !== "string" || o.text.length > 20000) return false;
      if (!Array.isArray(o.lines)) return false;
      if ((o.lines as unknown[]).length > 2000) return false;
      for (const l of o.lines as unknown[]) {
        if (typeof l !== "string" || l.length > 5000) return false;
      }
      if (typeof o.fontSize !== "number" || !Number.isFinite(o.fontSize) || o.fontSize < 1 || o.fontSize > 1000) return false;
      if (typeof o.fontFamily !== "undefined" && (typeof o.fontFamily !== "string" || o.fontFamily.length > 64)) return false;
      if (typeof o.outlineOn !== "undefined" && typeof o.outlineOn !== "boolean") return false;
      if (typeof o.spans !== "undefined") {
        if (!Array.isArray(o.spans) || (o.spans as unknown[]).length > 400) return false;
        for (const sp of o.spans as Record<string, unknown>[]) {
          if (!sp || typeof sp !== "object") return false;
          if (typeof sp.start !== "number" || !Number.isFinite(sp.start)) return false;
          if (typeof sp.end !== "number" || !Number.isFinite(sp.end)) return false;
          if (sp.start < 0 || sp.end <= sp.start) return false;
          if (typeof sp.fill !== "undefined" && (typeof sp.fill !== "string" || sp.fill.length > 100)) return false;
          if (typeof sp.fontFamily !== "undefined" && (typeof sp.fontFamily !== "string" || sp.fontFamily.length > 64)) return false;
          if (typeof sp.fontWeight !== "undefined" && (typeof sp.fontWeight !== "number" || !Number.isFinite(sp.fontWeight))) return false;
          if (typeof sp.fontSize !== "undefined" && (typeof sp.fontSize !== "number" || !Number.isFinite(sp.fontSize) || sp.fontSize < 1 || sp.fontSize > 1000)) return false;
        }
      }
    }
    if (o.kind === "path") {
      if (typeof o.d !== "string" || o.d.length > 500000) return false;
      if (typeof o.nodes !== "undefined") {
        if (!Array.isArray(o.nodes) || (o.nodes as unknown[]).length > 10000) return false;
      }
    }
    if ((o.kind === "polygon" || o.kind === "star") && typeof o.sides !== "undefined" && typeof o.points !== "undefined") {
      // ok
    }
  }
  return true;
}

/** Load autosaved doc once at boot. Returns true when something was restored. */
export function restoreAutosave(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidDoc(parsed)) {
      // Never delete a large-but-valid doc as "corrupt": quarantine instead.
      // Oversize (>2000) is a guard, not corruption — keep a backup.
      try {
        localStorage.setItem(BACKUP_KEY, raw);
      } catch {
        // ignore quota
      }
      try {
        localStorage.removeItem(KEY);
      } catch {
        // ignore
      }
      flashErr("autosave was corrupt — started fresh (backup kept)");
      return false;
    }
    useDoc.getState().loadDoc(parsed.page, parsed.objects);
    return true;
  } catch {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) localStorage.setItem(BACKUP_KEY, raw);
    } catch {
      // ignore
    }
    try {
      localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
    return false;
  }
}

let timer: number | undefined;
let unsub: (() => void) | null = null;

function flushAutosave() {
  try {
    const st = useDoc.getState();
    if (!st.dirty) return;
    const doc: SavedDoc = {
      version: 1,
      page: st.page,
      objects: st.objects,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(KEY, JSON.stringify(doc));
    st.markClean();
  } catch {
    // quota or private mode: keep working in memory
  }
}

/** Subscribe to objects/page and debounce-write to localStorage. */
export function startAutosave() {
  // HMR-safe: never double-subscribe
  if (unsub) unsub();
  unsub = useDoc.subscribe((s, prev) => {
    if (s.objects === prev.objects && s.page === prev.page) return;
    if (!s.dirty) s.setDirty(true);
    window.clearTimeout(timer);
    timer = window.setTimeout(flushAutosave, SAVE_DEBOUNCE_MS);
  });
  // Closing within the debounce window must not lose work
  window.addEventListener("beforeunload", flushAutosave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAutosave();
  });
}

export function downloadVL() {
  const st = useDoc.getState();
  const doc: SavedDoc = {
    version: 1,
    page: st.page,
    objects: st.objects,
    savedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "untitled.vl.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  try {
    localStorage.setItem(KEY, JSON.stringify(doc));
  } catch {
    // ignore quota errors
  }
  st.markClean();
}

export async function openVLFile(file: File): Promise<boolean> {
  try {
    const raw = await file.text();
    const parsed: unknown = JSON.parse(raw);
    if (!isValidDoc(parsed)) {
      flashErr("not a valid .vl file");
      return false;
    }
    useDoc.getState().loadDoc(parsed.page, parsed.objects);
    try {
      localStorage.setItem(KEY, JSON.stringify(parsed));
    } catch {
      // ignore
    }
    return true;
  } catch {
    flashErr("could not open that file");
    return false;
  }
}
