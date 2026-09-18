import { useDoc } from "../store/doc";

export default function StatusBar() {
  const camera = useDoc((s) => s.camera);
  const cursor = useDoc((s) => s.cursor);
  const sel = useDoc((s) => s.selection.length);
  const page = useDoc((s) => s.page);
  return (
    <footer className="vl-status">
      <span>{Math.round(camera.zoom * 100)}%</span>
      <span>PAGE {page.name} {page.w}×{page.h}</span>
      <span>{sel === 0 ? "nothing selected" : `${sel} selected`}</span>
      <span className="right">x {Math.round(cursor.x)} · y {Math.round(cursor.y)}</span>
    </footer>
  );
}
