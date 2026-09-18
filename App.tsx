import TopBar from "./ui/TopBar";
import OptionsBar from "./ui/OptionsBar";
import LeftRail from "./ui/LeftRail";
import CanvasViewport from "./ui/CanvasViewport";
import RightDock from "./ui/RightDock";
import ColorBar from "./ui/ColorBar";
import StatusBar from "./ui/StatusBar";

export default function App() {
  return (
    <div className="vl-shell">
      <TopBar />
      <OptionsBar />
      <LeftRail />
      <CanvasViewport />
      <RightDock />
      <ColorBar />
      <StatusBar />
    </div>
  );
}
