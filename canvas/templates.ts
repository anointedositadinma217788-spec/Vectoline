import { uid, type VecObject, type RectObj, type TextObj, type EllipseObj } from "./types";
import { DEFAULT_FONT } from "./text";

export interface PagePreset {
  id: string;
  name: string;
  w: number;
  h: number;
  group: "Print" | "Social" | "Web";
}

export const PRESETS: PagePreset[] = [
  { id: "a3", name: "A3", w: 1123, h: 1587, group: "Print" },
  { id: "a4", name: "A4", w: 794, h: 1123, group: "Print" },
  { id: "a5", name: "A5", w: 559, h: 794, group: "Print" },
  { id: "letter", name: "US Letter", w: 816, h: 1056, group: "Print" },
  { id: "flyer", name: "Flyer", w: 630, h: 891, group: "Print" },
  { id: "bizcard", name: "Business card", w: 336, h: 192, group: "Print" },
  { id: "poster", name: "Poster", w: 1587, h: 2245, group: "Print" },
  { id: "sq", name: "Square post", w: 1080, h: 1080, group: "Social" },
  { id: "portrait", name: "Portrait post", w: 1080, h: 1350, group: "Social" },
  { id: "story", name: "Story / Reel", w: 1080, h: 1920, group: "Social" },
  { id: "yt", name: "YouTube thumb", w: 1280, h: 720, group: "Social" },
  { id: "xhead", name: "X header", w: 1500, h: 500, group: "Social" },
  { id: "fbcover", name: "FB cover", w: 851, h: 315, group: "Social" },
  { id: "link", name: "Link preview", w: 1200, h: 630, group: "Social" },
  { id: "hd", name: "HD 16:9", w: 1920, h: 1080, group: "Web" },
  { id: "logo", name: "Logo master", w: 1200, h: 1200, group: "Web" },
];

// page is centered at world origin: page-space (0,0) -> world (-w/2, -h/2)
const X0 = (w: number) => -w / 2;
const Y0 = (h: number) => -h / 2;

function rect(
  x: number, y: number, w: number, h: number,
  fill: string, name: string, extra?: Partial<RectObj>
): RectObj {
  return {
    id: uid(), name, kind: "rect", x: Math.round(x), y: Math.round(y),
    w: Math.round(w), h: Math.round(h), rotation: 0,
    fill, stroke: "none", strokeWidth: 0, opacity: 100, rx: 0, ...extra,
  };
}

function text(
  x: number, y: number, content: string, fontSize: number, fill: string,
  name: string, fontWeight = 700, wrapW: number | null = null
): TextObj {
  // wrap long copy to the available width so narrow pages never overflow;
  // runtime line-height is 1.2 (see text.ts LINE_H)
  let lines = [content];
  let w = Math.round(content.length * fontSize * 0.55);
  if (wrapW != null) {
    const words = content.split(/\s+/);
    lines = [];
    let line = "";
    const est = (s: string) => s.length * fontSize * 0.55;
    for (const wd of words) {
      const trial = line ? `${line} ${wd}` : wd;
      if (!line || est(trial) <= wrapW) line = trial;
      else {
        lines.push(line);
        line = wd;
      }
    }
    lines.push(line);
    w = Math.round(Math.min(wrapW, Math.max(...lines.map((l) => l.length * fontSize * 0.55), 1)));
  }
  return {
    id: uid(), name, kind: "text", x: Math.round(x), y: Math.round(y),
    w, h: Math.round(lines.length * fontSize * 1.2),
    rotation: 0, fill, stroke: "none", strokeWidth: 0, opacity: 100,
    text: content, lines, wrapW, fontSize, fontWeight, fontFamily: DEFAULT_FONT,
  };
}

function ellipse(
  x: number, y: number, w: number, h: number, fill: string, name: string
): EllipseObj {
  return {
    id: uid(), name, kind: "ellipse", x: Math.round(x), y: Math.round(y),
    w: Math.round(w), h: Math.round(h), rotation: 0,
    fill, stroke: "none", strokeWidth: 0, opacity: 100,
  };
}

const INK = "#111214";
const CYAN = "#00f0ff";
const VIOLET = "#7c3aed";
const PAPER = "#ffffff";
const WASH = "#dbe1e8";
const MUTED = "#5c5f66";

function buildFlyer(w: number, h: number): VecObject[] {
  const x0 = X0(w), y0 = Y0(h), m = 48;
  const inner = w - m * 2;
  return [
    rect(x0, y0, w, 190, VIOLET, "headline bar"),
    text(x0 + m, y0 + 66, "GRAND OPENING", 64, PAPER, "headline", 700, Math.min(inner, 534)),
    text(x0 + m, y0 + 150, "SATURDAY · 10AM · MAIN STREET", 22, PAPER, "subline", 500, inner),
    { ...rect(x0 + m, y0 + 238, w - m * 2, 260, WASH, "hero frame"), stroke: CYAN, strokeWidth: 2 },
    text(x0 + m, y0 + 360, "IMAGE HERE", 28, MUTED, "hero label", 500),
    text(x0 + m, y0 + 540, "Fresh coffee, live music and 20% off everything on opening day. Bring a friend.", 20, INK, "body", 400, inner),
    rect(x0, y0 + h - 96, w, 96, INK, "footer strip"),
    text(x0 + m, y0 + h - 62, "hello@shop.com · @shop", 20, PAPER, "contact", 500, inner),
  ];
}

function buildPoster(w: number, h: number): VecObject[] {
  const x0 = X0(w), y0 = Y0(h), m = 80;
  return [
    rect(x0, y0, w, h, "#0a0a0a", "poster bg"),
    rect(x0, y0, 24, h, CYAN, "edge bar"),
    text(x0 + m + 40, y0 + 200, "NOISE", 220, PAPER, "title a"),
    text(x0 + m + 40, y0 + 420, "FEST", 220, CYAN, "title b"),
    text(x0 + m + 40, y0 + 560, "AUG 24 · HARBOR STAGE · 8PM", 40, "#9a9da3", "date", 500),
    { ...rect(x0 + m + 40, y0 + 660, w - (m + 40) * 2, 380, WASH, "artwork well"), stroke: VIOLET, strokeWidth: 3 },
    rect(x0 + m + 40, y0 + h - 220, w - (m + 40) * 2, 10, VIOLET, "rule"),
    text(x0 + m + 40, y0 + h - 180, "TICKETS AT THE DOOR", 44, PAPER, "cta"),
  ];
}

function buildSquare(w: number, h: number): VecObject[] {
  const x0 = X0(w), y0 = Y0(h);
  return [
    ellipse(x0 + w - 320, y0 + 120, 220, 220, CYAN, "accent dot"),
    rect(x0 + 120, y0 + 440, 120, 120, VIOLET, "accent block"),
    text(x0 + 120, y0 + 620, "LESS, BUT", 110, INK, "line 1"),
    text(x0 + 120, y0 + 770, "BETTER.", 110, INK, "line 2"),
    text(x0 + 120, y0 + 930, "@studio — new work", 36, "#5c5f66", "handle", 500),
  ];
}

function buildStory(w: number, h: number): VecObject[] {
  const x0 = X0(w), y0 = Y0(h), m = 90;
  const barY = y0 + h - 420;
  return [
    text(x0 + m, y0 + 300, "MORNING", 120, INK, "title a"),
    text(x0 + m, y0 + 450, "RITUALS", 120, VIOLET, "title b"),
    { ...rect(x0 + m, y0 + 640, w - m * 2, 680, WASH, "photo well"), stroke: CYAN, strokeWidth: 3 },
    text(x0 + m, y0 + 940, "PHOTO", 48, MUTED, "photo label", 500),
    rect(x0 + m, barY, w - m * 2, 130, INK, "cta bar"),
    text(x0 + m + 40, barY + 38, "SWIPE UP →", 56, CYAN, "cta"),
  ];
}

function buildBizcard(w: number, h: number): VecObject[] {
  const x0 = X0(w), y0 = Y0(h);
  return [
    rect(x0, y0, 10, h, VIOLET, "spine"),
    text(x0 + 32, y0 + 40, "Ada Okafor", 34, INK, "name"),
    text(x0 + 32, y0 + 88, "PRINT DESIGNER", 15, "#5c5f66", "role", 500),
    text(x0 + 32, y0 + 120, "ada@studio.com · +1 555 0100", 14, "#5c5f66", "contact", 400),
    ellipse(x0 + w - 70, y0 + 40, 36, 36, CYAN, "mark"),
  ];
}

function buildLogo(w: number, h: number): VecObject[] {
  const x0 = X0(w), y0 = Y0(h), cx = x0 + w / 2, cy = y0 + h / 2 - 60;
  return [
    { ...rect(x0 + 200, y0 + 200, w - 400, h - 400, "transparent", "grid"), stroke: VIOLET, strokeWidth: 1, guide: true },
    { ...ellipse(cx - 190, cy - 190, 380, 380, "transparent", "outer ring"), stroke: CYAN, strokeWidth: 6, guide: false },
    ellipse(cx - 110, cy - 110, 220, 220, VIOLET, "core"),
    text(cx - 200, cy + 280, "VECTOLINE", 72, INK, "wordmark"),
  ];
}

export interface Template {
  id: string;
  name: string;
  presetId: string;
  build: (w: number, h: number) => VecObject[];
}

export const TEMPLATES: Template[] = [
  { id: "flyer", name: "Event flyer", presetId: "a5", build: buildFlyer },
  { id: "poster", name: "Gig poster", presetId: "portrait", build: buildPoster },
  { id: "square", name: "Social square", presetId: "sq", build: buildSquare },
  { id: "story", name: "Story", presetId: "story", build: buildStory },
  { id: "bizcard", name: "Business card", presetId: "bizcard", build: buildBizcard },
  { id: "logo", name: "Logo master", presetId: "logo", build: buildLogo },
];

export function presetById(id: string): PagePreset | undefined {
  return PRESETS.find((p) => p.id === id);
}
