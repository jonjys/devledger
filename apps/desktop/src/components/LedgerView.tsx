import { lazy, Suspense, useState } from "react";

import LedgerList from "./LedgerList";

// The canvas library is most of the map's weight; load it with the Ledger
// rather than with the app.
const WorkspaceGraph = lazy(() => import("./WorkspaceGraph"));

interface Props {
  onNotify: (message: string, bad?: boolean) => void;
  onChanged: () => void;
  refreshKey?: number;
}

type Mode = "map" | "list";

/**
 * The Ledger: a free connection map, with the dense list one click away.
 *
 * Projects, identities and service accounts are separate first-class things.
 * Moving a node only changes its visual position; relationships change only
 * when the user explicitly connects/disconnects them. The list remains the
 * compact place to manage several addresses on one identity.
 */
export default function LedgerView({ onNotify, onChanged, refreshKey }: Props) {
  const [mode, setMode] = useState<Mode>("map");
  return (
    <div className={`ledger-view ${mode}`}>
      <div className="ledger-switch" role="group" aria-label="Ledger view">
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
        <Suspense fallback={<div className="empty">Loading map…</div>}>
          <WorkspaceGraph onNotify={onNotify} onChanged={onChanged} refreshKey={refreshKey} />
        </Suspense>
      ) : (
        <div className="ledger-list-pane">
          <LedgerList onNotify={onNotify} onChanged={onChanged} refreshKey={refreshKey} />
        </div>
      )}
    </div>
  );
}
