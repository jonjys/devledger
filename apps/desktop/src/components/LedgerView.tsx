import { lazy, Suspense, useState } from "react";

import LedgerList from "./LedgerList";

// The canvas library is most of the tree's weight; load it with the Ledger
// rather than with the app.
const SkillTree = lazy(() => import("./SkillTree"));

interface Props {
  onNotify: (message: string, bad?: boolean) => void;
  onChanged: () => void;
  refreshKey?: number;
}

type Mode = "tree" | "list";

/**
 * The Ledger: the skill tree, with the older list one click away.
 *
 * The list is still where a person's several email addresses are managed, so
 * it stays; the tree is what opens.
 */
export default function LedgerView({ onNotify, onChanged, refreshKey }: Props) {
  const [mode, setMode] = useState<Mode>("tree");
  return (
    <div className={`ledger-view ${mode}`}>
      <div className="ledger-switch" role="group" aria-label="Ledger view">
        <button
          type="button"
          className={mode === "tree" ? "active" : ""}
          aria-pressed={mode === "tree"}
          onClick={() => setMode("tree")}
        >
          Tree
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
      {mode === "tree" ? (
        <Suspense fallback={<div className="empty">Loading…</div>}>
          <SkillTree onNotify={onNotify} onChanged={onChanged} refreshKey={refreshKey} />
        </Suspense>
      ) : (
        <div className="ledger-list-pane">
          <LedgerList onNotify={onNotify} onChanged={onChanged} refreshKey={refreshKey} />
        </div>
      )}
    </div>
  );
}
