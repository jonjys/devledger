import { lazy, Suspense, useState } from "react";

import LedgerList from "./LedgerList";

// The canvas library is most of the map's weight; load it with the Ledger
// rather than with the app.
const LedgerCanvas = lazy(() => import("./LedgerCanvas"));

interface Props {
  onNotify: (message: string, bad?: boolean) => void;
  onChanged: () => void;
  refreshKey?: number;
  onOpenProject?: (projectId: string) => void;
}

type Mode = "map" | "list";

const ZOOM_KEY = "devledger.listZoom";
const ZOOMS = [0.7, 0.8, 0.9, 1, 1.1];

function readZoom(): number {
  try {
    const z = Number(window.localStorage.getItem(ZOOM_KEY));
    return ZOOMS.includes(z) ? z : 0.9;
  } catch {
    return 0.9;
  }
}

/**
 * The Ledger: the map you draw, with the list one click away.
 *
 * The list is still where a person's several email addresses are managed, so
 * it stays; the map is what opens. The list can be zoomed out to see more.
 */
export default function LedgerView({ onNotify, onChanged, refreshKey, onOpenProject }: Props) {
  const [mode, setMode] = useState<Mode>("map");
  const [zoom, setZoom] = useState(readZoom);

  function zoomBy(step: number) {
    const i = Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.indexOf(zoom) + step));
    const next = ZOOMS[i] ?? 1;
    setZoom(next);
    try {
      window.localStorage.setItem(ZOOM_KEY, String(next));
    } catch {
      // Not remembered; nothing else to do.
    }
  }

  return (
    <div className={`ledger-view ${mode}`}>
      <div className="ledger-switch" role="group" aria-label="Ledger view">
        {mode === "list" && (
          <>
            <button type="button" aria-label="Zoom out" onClick={() => zoomBy(-1)} disabled={zoom === ZOOMS[0]}>
              −
            </button>
            <span className="ledger-zoom">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              aria-label="Zoom in"
              onClick={() => zoomBy(1)}
              disabled={zoom === ZOOMS[ZOOMS.length - 1]}
            >
              +
            </button>
          </>
        )}
        <button
          type="button"
          className={mode === "map" ? "active" : ""}
          aria-pressed={mode === "map"}
          onClick={() => setMode("map")}
        >
          Map
        </button>
        <button
          type="button"
          className={mode === "list" ? "active" : ""}
          aria-pressed={mode === "list"}
          onClick={() => setMode("list")}
        >
          List
        </button>
      </div>
      {mode === "map" ? (
        <Suspense fallback={<div className="empty">Loading…</div>}>
          <LedgerCanvas
            onNotify={onNotify}
            onChanged={onChanged}
            refreshKey={refreshKey}
            onOpenProject={onOpenProject}
          />
        </Suspense>
      ) : (
        <div className="ledger-list-pane" style={{ zoom }}>
          <LedgerList onNotify={onNotify} onChanged={onChanged} refreshKey={refreshKey} />
        </div>
      )}
    </div>
  );
}
