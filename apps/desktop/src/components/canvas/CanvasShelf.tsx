// The list on the right: what can be added, and what is not connected yet.

import { useMemo, useState } from "react";

import { type Ball, type Point } from "../../lib/canvas";
import { PROVIDERS } from "../../lib/providers";
import type { Provider } from "../../lib/types";
import ProviderIcon from "../ProviderIcon";

import { kindLabel, serviceName } from "./labels";

export type ShelfItem =
  | { kind: "email" }
  | { kind: "project" }
  | { kind: "service"; provider: Provider; name: string }
  | { kind: "other"; name: string }
  | { kind: "existing"; key: string };

export function Shelf({
  locked,
  focus,
  existing,
  whereIs,
  have,
  loose,
  onFind,
  canvas,
  onPlace,
  onUnlock,
}: {
  locked: boolean;
  focus: Ball | null;
  /** On a project's page: services and projects in services it does not use yet. */
  existing: Ball[];
  /** The email a service belongs to, or what a project in a service is in. */
  whereIs: (ball: Ball) => string | null;
  /** Providers there is already an account for. */
  have: Set<string>;
  /** Balls with no line to anything yet. */
  loose: Ball[];
  onFind: (key: string) => void;
  canvas: React.RefObject<HTMLDivElement | null>;
  /** Add an item: where it was dropped, or null when it was clicked. */
  onPlace: (item: ShelfItem, client: Point | null) => void;
  onUnlock: () => void;
}) {
  const [query, setQuery] = useState("");
  const [ghost, setGhost] = useState<{ item: ShelfItem; label: string; x: number; y: number } | null>(null);

  const services = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PROVIDERS.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.aliases ?? []).some((a) => a.includes(q)));
  }, [query]);
  const typed = query.trim();
  const exact = PROVIDERS.some((p) => p.name.toLowerCase() === typed.toLowerCase());

  // Dragging is done with pointer events rather than HTML drag and drop, which
  // the desktop webview intercepts for file drops.
  function startDrag(e: React.PointerEvent, item: ShelfItem, label: string) {
    if (locked || e.button > 0) return;
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) dragging = true;
      if (dragging) setGhost({ item, label, x: ev.clientX, y: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setGhost(null);
      if (!dragging) {
        onPlace(item, null);
        return;
      }
      const flowEl = canvas.current?.querySelector(".cv-flow");
      const rect = flowEl?.getBoundingClientRect();
      if (rect && ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
        onPlace(item, { x: ev.clientX, y: ev.clientY });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const chip = (item: ShelfItem, label: string, icon: React.ReactNode, sub?: string | null) => (
    <button
      type="button"
      key={`${item.kind}:${label}`}
      className="cv-chip"
      disabled={locked}
      onPointerDown={(e) => startDrag(e, item, label)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPlace(item, null);
        }
      }}
      title={locked ? "Unlock the map to add" : "Click to add, or drag onto the map"}
    >
      <span className="cv-chip-icon">{icon}</span>
      <span className="cv-chip-text">
        <span>{label}</span>
        {sub && <small>{sub}</small>}
      </span>
    </button>
  );

  return (
    <aside className="cv-shelf" aria-label="Add to the map">
      <div className="cv-shelf-head">
        <strong>{focus ? `Services for ${focus.label}` : "Add to your map"}</strong>
        <small>{locked ? "The layout is locked." : "Click to add, or drag onto the map."}</small>
        {locked && (
          <button type="button" onClick={onUnlock}>
            ✎ Edit map
          </button>
        )}
      </div>

      {!focus && (
        <div className="cv-shelf-row">
          {chip({ kind: "email" }, "Email", <span className="cv-chip-glyph email">@</span>)}
          {chip({ kind: "project" }, "Project", <span className="cv-chip-glyph project">P</span>)}
        </div>
      )}

      {loose.length > 0 && (
        <>
          <div className="cv-shelf-title">Not connected yet</div>
          <div className="cv-shelf-list" aria-label="Not connected yet">
            {loose.map((b) => (
              <button
                type="button"
                key={b.key}
                className="cv-chip"
                onClick={() => onFind(b.key)}
                title="Show it on the map"
              >
                <span className="cv-chip-icon">
                  {b.provider ? (
                    <ProviderIcon provider={b.provider} name={b.label} size={18} />
                  ) : (
                    <span className={`cv-chip-glyph ${b.kind}`}>{b.kind === "email" ? "@" : "P"}</span>
                  )}
                </span>
                <span className="cv-chip-text">
                  <span>{b.label}</span>
                  <small>{kindLabel(b)}</small>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {focus && existing.length > 0 && (
        <>
          <div className="cv-shelf-title">Already in your vault</div>
          <div className="cv-shelf-list">
            {existing.map((a) =>
              chip(
                { kind: "existing", key: a.key },
                a.label,
                a.provider ? <ProviderIcon provider={a.provider} name={a.label} size={18} /> : null,
                a.kind === "resource" ? `${serviceName(a)} project · ${whereIs(a) ?? ""}` : whereIs(a),
              ),
            )}
          </div>
        </>
      )}

      <div className="cv-shelf-title">{focus ? "A new service" : "Services"}</div>
      <input
        className="cv-shelf-search"
        aria-label="Search services"
        placeholder="Search, or type any name…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={locked}
      />
      <div className="cv-shelf-list">
        {typed && !exact && chip({ kind: "other", name: typed }, `Add “${typed}”`, <span className="cv-chip-glyph">+</span>)}
        {services.map((p) =>
          chip(
            { kind: "service", provider: p.provider, name: p.name },
            p.name,
            <ProviderIcon provider={p.provider} name={p.name} size={18} />,
            have.has(p.provider) ? "On your map" : null,
          ),
        )}
      </div>

      {ghost && (
        <div className="cv-ghost" style={{ left: ghost.x, top: ghost.y }} aria-hidden>
          {ghost.label}
        </div>
      )}
    </aside>
  );
}
