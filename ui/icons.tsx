import {
  Circle,
  Eraser,
  Hexagon,
  ImagePlus,
  LoaderPinwheel,
  MousePointer2,
  Pencil,
  PenTool,
  Pipette,
  Scissors,
  Slash,
  Square,
  Star,
  Type,
  Waypoints,
  ZoomIn,
  type LucideIcon,
} from "lucide-react";
import type { ToolId } from "../store/doc";

export const TOOL_ICONS: Record<ToolId, LucideIcon> = {
  move: MousePointer2,
  zoom: ZoomIn,
  rect: Square,
  ellipse: Circle,
  line: Slash,
  polygon: Hexagon,
  star: Star,
  spiral: LoaderPinwheel,
  pen: Pencil,
  bezier: PenTool,
  node: Waypoints,
  text: Type,
  eye: Pipette,
  break: Scissors,
  eraser: Eraser,
  image: ImagePlus,
};

export const ICON_SIZE = 18;
export const ICON_STROKE = 1.8;
