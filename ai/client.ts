import type { CanvasSummary } from "./summary";
import { buildCanvasSummary } from "./summary";
import { applyAgentActions } from "./actions";
import { useDoc } from "../store/doc";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

/** Object refs are stable ids (preferred) or indexes into the round's summary `objects` array.
 *  The client maps them to live ids fresh every round; stale refs drop. */
export type Ref = number | string;

export type CanvasAction =
  | { op: "add"; kind: "rect" | "ellipse" | "line" | "polygon" | "star" | "text"; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; strokeWidth?: number; opacity?: number; rotation?: number; rx?: number; text?: string; fontSize?: number; fontFamily?: string; fontWeight?: number; wrapW?: number | null; sides?: number; points?: number }
  | { op: "move"; dx: number; dy: number; refs?: Ref[] }
  | { op: "style"; refs: Ref[]; fill?: string; stroke?: string; strokeWidth?: number; opacity?: number; fontSize?: number; fontFamily?: string; fontWeight?: number }
  | { op: "transform"; refs: Ref[]; dx?: number; dy?: number; w?: number; h?: number; rotation?: number }
  | { op: "arrange"; refs?: Ref[]; to?: "front" | "back"; align?: "left" | "centerX" | "right" | "top" | "centerY" | "bottom"; distribute?: "x" | "y" }
  | { op: "align"; mode: "left" | "centerX" | "right" | "top" | "centerY" | "bottom" }
  | { op: "distribute"; axis: "x" | "y" }
  | { op: "select"; refs: Ref[] }
  | { op: "duplicateSelection" }
  | { op: "duplicate"; refs: Ref[] }
  | { op: "deleteSelection" }
  | { op: "delete"; refs: Ref[] }
  | { op: "setPage"; presetId: string }
  | { op: "newProject"; title: string; fresh: boolean }
  | { op: "suggestPalette"; colors: string[] }
  /** layout primitive: place items sequentially from (x,y) — the client does
   *  the geometry. Text measures naturally; align = cross-axis alignment. */
  | { op: "stack"; dir: "x" | "y"; x: number; y: number; gap?: number; align?: "start" | "center" | "end"; items: StackItem[] };

export interface StackItem {
  kind: "rect" | "ellipse" | "line" | "text";
  w?: number;
  h?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  rotation?: number;
  rx?: number;
  wrapW?: number | null;
}

export interface ProjectPhase {
  i: number;
  n: number;
  label: string;
}

export interface ChatResult {
  reply: string;
  palette?: string[];
  actions?: CanvasAction[];
  /** Agentic loop: more rounds to come. Absent/false = done. */
  cont?: boolean;
  phase?: ProjectPhase;
  /** Fresh-canvas gate on non-empty canvas. Client shows confirm card. */
  needsConfirm?: "fresh-canvas";
  projectTitle?: string;
  sessionId?: string;
  dropped?: string[];
  /** true = the live provider failed and the offline mock brain answered */
  fallback?: boolean;
}

export const MAX_ROUNDS = 6;
export const MAX_OPS_PER_PROJECT = 60;

export type Provider = "gemini" | "mock" | "offline";

let healthCache: { at: number; value: Provider } | null = null;
export async function checkHealth(): Promise<Provider> {
  if (healthCache && Date.now() - healthCache.at < 15000) return healthCache.value;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch("/api/health", { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) {
      healthCache = { at: Date.now(), value: "offline" };
      return "offline";
    }
    const data = await res.json().catch(() => null);
    if (!data || data.ok !== true) {
      healthCache = { at: Date.now(), value: "offline" };
      return "offline";
    }
    const v: Provider = data.provider === "gemini" ? "gemini" : "mock";
    healthCache = { at: Date.now(), value: v };
    return v;
  } catch {
    healthCache = { at: Date.now(), value: "offline" };
    return "offline";
  }
}

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export async function listSessions(): Promise<SessionMeta[]> {
  const res = await fetch("/api/sessions");
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  return Array.isArray(data?.sessions) ? data.sessions : [];
}

export async function createSession(title?: string): Promise<string | null> {
  try {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title || "Untitled project", docKey: "default" }),
    });
    const data = await res.json().catch(() => null);
    return typeof data?.session?.id === "string" ? data.session.id : null;
  } catch {
    return null;
  }
}

/** Compact canvas serializer: whole objects only, never mid-JSON cut.
 *  Prioritizes selected + recent; drops oldest with explicit droppedCount. */
export function compactCanvas(canvas: CanvasSummary, maxChars = 9000): Record<string, unknown> {
  const raw = JSON.stringify(canvas);
  if (raw.length <= maxChars) return canvas as unknown as Record<string, unknown>;
  const sel = new Set(canvas.selIdx);
  const ranked = [...canvas.objects].sort((a, b) => {
    const sa = sel.has(a.i) ? 0 : 1;
    const sb = sel.has(b.i) ? 0 : 1;
    return sa - sb || b.i - a.i;
  });
  const kept: typeof ranked = [];
  let size = 0;
  const overhead = 600;
  for (const o of ranked) {
    const s = JSON.stringify(o).length;
    if (size + s + overhead > maxChars && kept.length >= 12) break;
    kept.push(o);
    size += s;
  }
  kept.sort((a, b) => a.i - b.i);
  return {
    ...canvas,
    objects: kept,
    truncated: true,
    droppedCount: canvas.objects.length - kept.length,
  };
}

/** POST /api/jimoo/chat and stream SSE deltas. Resolves with the final
 *  done payload. Throws with a human message on failure/abort. */
export async function sendChat(
  messages: ChatMessage[],
  canvas: CanvasSummary,
  opts: { signal?: AbortSignal; onDelta?: (d: string) => void; round?: number; loop?: boolean; sessionId?: string | null; timeoutMs?: number } = {}
): Promise<ChatResult> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const forward = () => ctrl.abort();
  opts.signal?.addEventListener("abort", forward, { once: true });
  let res: Response;
  try {
    res = await fetch("/api/jimoo/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        canvas: compactCanvas(canvas),
        ...(opts.round && opts.round > 1 ? { round: opts.round, loop: true } : {}),
        ...(opts.loop ? { loop: true } : {}),
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new Error(opts.signal?.aborted ? "stopped" : "brain timed out — try again");
    }
    throw new Error("backend not running — start it with run.bat");
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", forward);
  }
  if (res.status === 429) throw new Error("slow down — 30 requests per minute max");
  if (res.status === 413) throw new Error("canvas too large to send");
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(
      data && typeof data.error === "string" ? data.error : `backend error (${res.status})`
    );
  }
  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("text/event-stream") || !res.body) {
    const data = (await res.json().catch(() => null)) as ChatResult | null;
    if (!data || typeof data.reply !== "string") throw new Error("bad backend reply");
    return data;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let reply = "";
  let palette: string[] | undefined;
  let actions: CanvasAction[] | undefined;
  let sessionId: string | undefined;
  let dropped: string[] | undefined;
  let fallback = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(t.slice(5).trim());
        } catch {
          continue;
        }
        if (typeof ev.delta === "string") {
          reply += ev.delta;
          opts.onDelta?.(ev.delta);
        }
        if (ev.done === true) {
          if (typeof ev.reply === "string" && ev.reply) reply = ev.reply;
          if (Array.isArray(ev.palette)) palette = ev.palette as string[];
          if (Array.isArray(ev.actions)) actions = ev.actions as CanvasAction[];
          if (typeof ev.sessionId === "string") sessionId = ev.sessionId;
          if (Array.isArray(ev.dropped)) dropped = ev.dropped as string[];
          if (ev.fallback === true) fallback = true;
        }
      }
    }
  }
  if (!reply) throw new Error("empty backend reply");
  const out: ChatResult = { reply };
  if (palette) out.palette = palette;
  if (actions) out.actions = actions;
  if (sessionId) out.sessionId = sessionId;
  if (dropped) out.dropped = dropped;
  if (fallback) out.fallback = true;
  return out;
}

export type ConfirmChoice = "new" | "beside" | "cancel";

export interface LoopHooks {
  signal?: AbortSignal;
  onDelta?: (d: string) => void;
  /** fired after each round is applied (append reply + progress in UI) */
  onRound?: (result: ChatResult, round: number) => void;
  /** fresh-canvas gate on non-empty canvas; resolves the user's choice */
  needsConfirm?: (title: string) => Promise<ConfirmChoice>;
  sessionId?: string | null;
}

export interface LoopOutcome {
  rounds: number;
  appliedOps: number;
  done: boolean;
  capped: boolean;
  projectTitle?: string;
}

/** Full-agent loop: send → apply → resummarize → continue until the brain
 *  stops asking (cont absent) or caps hit. History squashes at the end so
 *  one Ctrl+Z removes everything the loop built — even when stopped early. */
export async function runAgentLoop(
  seedMessages: ChatMessage[],
  hooks: LoopHooks = {}
): Promise<LoopOutcome> {
  const history: ChatMessage[] = seedMessages.map((m) => ({ ...m }));
  const projectIds = new Set<string>();
  const pastKeep = useDoc.getState().past.length;
  let appliedOps = 0;
  let rounds = 0;
  let capped = false;
  let projectTitle: string | undefined;
  let confirmedFresh: "new" | "beside" | null = null;
  try {
    while (rounds < MAX_ROUNDS) {
      rounds++;
      const result = await sendChat(history, buildCanvasSummary(projectIds), {
        signal: hooks.signal,
        onDelta: hooks.onDelta,
        round: rounds,
        loop: rounds > 1,
        sessionId: hooks.sessionId ?? undefined,
      });
      if (result.projectTitle) projectTitle = result.projectTitle;
      // fresh-canvas gate: non-empty canvas + model wants blank page
      const wantsFresh =
        result.needsConfirm === "fresh-canvas" ||
        (rounds === 1 &&
          (result.actions ?? []).some((a) => a.op === "newProject" && (a.fresh !== false)));
      let acts = result.actions ?? [];
      if (wantsFresh && confirmedFresh === null) {
        const canvasNow = buildCanvasSummary();
        if (canvasNow.count > 0) {
          const choice = hooks.needsConfirm
            ? await hooks.needsConfirm(result.projectTitle ?? "Untitled project")
            : "beside";
          if (choice === "cancel") {
            hooks.onRound?.({ reply: "Project cancelled — canvas untouched." }, rounds);
            return { rounds, appliedOps, done: true, capped, projectTitle };
          }
          confirmedFresh = choice;
          if (choice === "new") {
            useDoc.getState().newDoc();
            // re-anchor squash point: newDoc pushed its own step; the loop's
            // work squashes to just after it (one more undo restores the old doc)
          }
        } else {
          confirmedFresh = "beside";
        }
      }
      acts = acts.filter((a) => a.op !== "newProject");
      if (result.palette && result.palette.length >= 3) {
        useDoc.getState().setJimooPalette(result.palette);
      }
      const n = applyAgentActions(acts, { strict: true, projectIds });
      appliedOps += n;
      history.push({ role: "assistant", text: result.reply });
      hooks.onRound?.(result, rounds);
      if (appliedOps >= MAX_OPS_PER_PROJECT) {
        capped = true;
        history.push({ role: "assistant", text: "Built the core (60-op cap) — say continue for polish." });
        hooks.onRound?.(
          { reply: "Built the core (60-op cap) — say continue for polish." },
          rounds
        );
        break;
      }
      if (!result.cont) break;
    }
    return { rounds, appliedOps, done: true, capped, projectTitle };
  } finally {
    if (appliedOps > 0) {
      useDoc.getState().squashProjectHistory(pastKeep);
    }
  }
}
