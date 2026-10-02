// The pieces the Ledger canvas is drawn with: its balls and lines, the
// right-click menu, the Cmd+K finder and the add dialog. LedgerCanvas.tsx
// wires them to data.

import { BaseEdge, Handle, Position, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Ball, BallKind, LineKind } from "../lib/canvas";
import { knownServiceNames } from "../lib/providers";

import Modal from "./Modal";
import ProviderIcon from "./ProviderIcon";

export const KIND_LABEL: Record<BallKind, string> = {
  email: "Email",
  account: "Service",
  org: "Organization",
  resource: "Project in a service",
  project: "Project",
};

/** How big each kind of ball draws: its node is exactly the ball. */
export const BALL_SIZE: Record<BallKind, number> = { email: 76, account: 60, org: 54, resource: 46, project: 68 };
export const PRIMARY_SIZE = 96;

export function ballSize(ball: Ball): number {
  return ball.primary ? PRIMARY_SIZE : BALL_SIZE[ball.kind];
}

/** A stable hue per name, for a project's ball. */
export function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

// --- balls ------------------------------------------------------------------------

export interface BallData extends Record<string, unknown> {
  ball: Ball;
  selected: boolean;
  /** Not connected to what is selected: drawn faint. */
  dim: boolean;
  renaming: boolean;
  locked: boolean;
  onRename: (key: string, value: string | null) => void;
}

export type BallNode = Node<BallData, "ball">;

// Lines run from centre to centre, so every ball has an invisible handle of
// each type pinned to its middle. The visible port on the right edge is where
// a new line is dragged from; the centre target catches it anywhere on the
// ball, because the canvas snaps to the nearest handle within reach.
const CENTRE = {
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  border: 0,
  opacity: 0,
  pointerEvents: "none" as const,
};

function RenameInput({ ball, onRename }: { ball: Ball; onRename: BallData["onRename"] }) {
  const [value, setValue] = useState(ball.kind === "email" ? (ball.sub && !ball.noEmail ? ball.sub : "") : ball.label);
  const ref = useRef<HTMLInputElement>(null);
  // autoFocus is not reliable inside the canvas under WebKit: the double-click
  // that opened this is still settling when it mounts. Take focus once the
  // event is over, retrying briefly, with the old name selected so typing
  // replaces it.
  useEffect(() => {
    let tries = 0;
    let timer = 0;
    const grab = () => {
      const input = ref.current;
      if (!input) return;
      if (document.activeElement !== input) {
        input.focus();
        input.select();
      }
      tries += 1;
      if (document.activeElement !== input && tries < 8) timer = window.setTimeout(grab, 40);
    };
    timer = window.setTimeout(grab, 0);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <input
      ref={ref}
      className="cv-rename nodrag nopan"
      aria-label={`Rename ${ball.label}`}
      placeholder={ball.kind === "email" ? "Your name" : undefined}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onRename(ball.key, value);
        if (e.key === "Escape") onRename(ball.key, null);
      }}
      onBlur={() => onRename(ball.key, value)}
    />
  );
}

const initial = (label: string) => label.replace(/[^A-Za-z0-9]/g, "").charAt(0).toUpperCase() || "?";

function Glyph({ ball }: { ball: Ball }) {
  if (ball.kind === "account" && ball.provider) return <ProviderIcon provider={ball.provider} name={ball.label} size={26} />;
  if (ball.kind === "resource" && ball.provider) return <ProviderIcon provider={ball.provider} name={ball.label} size={18} />;
  if (ball.kind === "org") return <span className="cv-initial">{initial(ball.label)}</span>;
  if (ball.kind === "project") return <span className="cv-initial">{initial(ball.label)}</span>;
  if (ball.noEmail) return <span className="cv-initial">?</span>;
  return ball.primary ? <span className="cv-tag">YOU</span> : <span className="cv-initial">@</span>;
}

/** One ball. Memoised: panning re-renders the viewport, not these. */
export const BallView = memo(function BallView({ data }: NodeProps<BallNode>) {
  const { ball, selected, dim, renaming, locked, onRename } = data;
  const size = ballSize(ball);
  const cls = [
    "cv-ball",
    `cv-${ball.kind}`,
    ball.primary ? "primary" : "",
    selected ? "selected" : "",
    dim ? "dim" : "",
    ball.noEmail ? "pulse" : "",
    ball.attention ? "attention" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const style =
    ball.kind === "project" ? ({ "--hue": hue(ball.label), width: size, height: size } as React.CSSProperties) : { width: size, height: size };

  return (
    <div className={cls} style={style} data-testid={ball.key} title={ball.sub ?? undefined}>
      <Handle type="target" id="in" position={Position.Top} style={CENTRE} isConnectableStart={false} />
      <Handle type="source" id="c" position={Position.Top} style={CENTRE} isConnectable={false} />
      <div className="cv-orb">
        <Glyph ball={ball} />
      </div>
      <div className="cv-label">
        {renaming ? <RenameInput ball={ball} onRename={onRename} /> : <strong>{ball.label}</strong>}
        {ball.sub && !renaming && <span>{ball.sub}</span>}
      </div>
      {!locked && (
        <Handle
          type="source"
          id="out"
          position={Position.Right}
          className="cv-port"
          title="Drag to another ball to connect"
          aria-label={`Connect ${ball.label}`}
        />
      )}
    </div>
  );
});

// --- lines ------------------------------------------------------------------------

export interface LineData extends Record<string, unknown> {
  kind: LineKind;
  lit: boolean;
  dim: boolean;
  selected: boolean;
}

/** A straight line from ball to ball. Lit lines get a soft second stroke as their glow. */
export function LineView({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps) {
  const d = data as LineData | undefined;
  const path = `M ${sourceX},${sourceY} L ${targetX},${targetY}`;
  const cls = ["cv-line", d?.kind ?? "", d?.lit ? "lit" : "", d?.dim ? "dim" : "", d?.selected ? "selected" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      {(d?.lit || d?.selected) && <path d={path} className="cv-line-glow" fill="none" />}
      <BaseEdge id={id} path={path} className={cls} interactionWidth={18} />
    </>
  );
}

// --- the right-click menu -------------------------------------------------------------

export interface MenuItem {
  label: string;
  /** Shown dimmed after the label, e.g. a masked preview. */
  hint?: string;
  onSelect?: () => void;
  items?: MenuItem[];
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
}

export function ContextMenu({
  x,
  y,
  title,
  items,
  onClose,
}: {
  x: number;
  y: number;
  title: string;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  // Keep the menu on screen near the right and bottom edges.
  const left = Math.min(x, window.innerWidth - 240);
  const top = Math.max(8, Math.min(y, window.innerHeight - 36 * (items.length + 1)));

  const run = (item: MenuItem) => {
    if (item.disabled || item.items) return;
    onClose();
    item.onSelect?.();
  };

  return (
    <div ref={ref} className="st-menu" role="menu" aria-label={title} style={{ left, top }}>
      <div className="st-menu-title">{title}</div>
      {items.map((item) => (
        <div key={item.label} className="st-menu-row" onMouseEnter={() => setOpen(item.items ? item.label : null)}>
          <button
            type="button"
            role="menuitem"
            aria-haspopup={item.items ? "menu" : undefined}
            aria-expanded={item.items ? open === item.label : undefined}
            className={`st-menu-item${item.danger ? " danger" : ""}`}
            disabled={item.disabled}
            // Hovering already opened a submenu, so a click must not close it again.
            onClick={() => (item.items ? setOpen(item.label) : run(item))}
          >
            <span>{item.label}</span>
            {item.hint && <span className="st-menu-hint">{item.hint}</span>}
            {item.items && <span className="st-menu-caret">›</span>}
          </button>
          {item.items && open === item.label && (
            <div className="st-submenu" role="menu" aria-label={item.label}>
              {item.items.length === 0 && <div className="st-menu-empty">Nothing here yet</div>}
              {item.items.map((sub) => (
                <button
                  key={sub.label}
                  type="button"
                  role="menuitem"
                  className={`st-menu-item${sub.danger ? " danger" : ""}${sub.checked ? " checked" : ""}`}
                  disabled={sub.disabled}
                  onClick={() => run(sub)}
                >
                  <span>{sub.label}</span>
                  {sub.hint && <span className="st-menu-hint">{sub.hint}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// --- the finder ---------------------------------------------------------------------

export interface FindEntry {
  key: string;
  kind: BallKind;
  label: string;
  sub: string | null;
}

export function Finder({
  entries,
  onPick,
  onClose,
}: {
  entries: FindEntry[];
  onPick: (entry: FindEntry) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q ? entries.filter((e) => `${e.label} ${e.sub ?? ""}`.toLowerCase().includes(q)) : entries;
    return matched.slice(0, 30);
  }, [entries, query]);

  useEffect(() => setCursor(0), [query]);

  return (
    <Modal label="Find" onClose={onClose} maxWidth={560}>
      <div className="st-palette">
        <input
          autoFocus
          aria-label="Find an email, service, organization or project"
          placeholder="Find an email, service, organization or project…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, hits.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              const hit = hits[cursor];
              if (hit) onPick(hit);
            }
          }}
        />
        <div className="st-palette-list" role="listbox" aria-label="Results">
          {hits.length === 0 && <div className="st-menu-empty">No match</div>}
          {hits.map((hit, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === cursor}
              key={hit.key}
              className={`st-palette-item${i === cursor ? " active" : ""}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => onPick(hit)}
            >
              <span className={`st-kind k-${hit.kind}`}>{KIND_LABEL[hit.kind]}</span>
              <span className="st-palette-label">{hit.label}</span>
              {hit.sub && <span className="st-menu-hint">{hit.sub}</span>}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

// --- adding ---------------------------------------------------------------------------

export type AddKind = "email" | "project" | "service" | "org" | "resource" | "api" | "password" | "secret" | "field";

const ADD_TITLE: Record<AddKind, string> = {
  email: "Add an email",
  project: "Add a project",
  service: "Add a service",
  org: "Add an organization",
  resource: "Add a project in the service",
  api: "Add API key",
  password: "Add password",
  secret: "Add secret",
  field: "Add field",
};

const ADD_HELP: Record<AddKind, string> = {
  email: "An address you sign up to services with. Services you use hang off it.",
  project: "Something you build, e.g. make-it-real. Draw a line from it to each service it runs on.",
  service: "An account you have with a service: GitHub, Vercel, Claude, your domain host…",
  org: "A team or organization inside the service, e.g. a Supabase organization or a Vercel team. Its projects go under it.",
  resource: "A project as the service knows it: a Supabase project, a Vercel project, a GitHub repo. Draw a line from your own project to it.",
  api: "Stored encrypted in your vault; it is never shown here again.",
  password: "Stored encrypted in your vault; it is never shown here again.",
  secret: "Stored encrypted in your vault; it is never shown here again.",
  field: "Any detail worth keeping, with a name you choose: customer number, region, plan…",
};

const PLACEHOLDER: Partial<Record<AddKind, string>> = {
  service: "e.g. GitHub, Vercel, Claude",
  project: "e.g. make-it-real",
  org: "e.g. acme's Org",
  resource: "e.g. make-it-real",
  field: "e.g. Customer number",
};

const DEFAULT_NAME: Partial<Record<AddKind, string>> = { api: "API key", password: "Password", secret: "Secret" };

export interface AddValues {
  name: string;
  value: string;
  /** The person's name for an email, or a label for a service. */
  label: string;
}

/**
 * One small form for everything the canvas can add.
 *
 * Secret values are typed into a password field and handed straight to the
 * save call; the dialog keeps nothing once it closes.
 */
export function AddDialog({
  kind,
  title,
  under,
  initialName = "",
  onCancel,
  onSubmit,
}: {
  kind: AddKind;
  /** In place of the kind's own title, e.g. "Add a Supabase project". */
  title?: string;
  /** What it is added to, when that is worth saying. */
  under: string | null;
  initialName?: string;
  onCancel: () => void;
  onSubmit: (values: AddValues) => Promise<void>;
}) {
  const [name, setName] = useState(initialName || DEFAULT_NAME[kind] || "");
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const secret = kind === "api" || kind === "password" || kind === "secret";
  const needsValue = secret || kind === "field";
  const ready = name.trim().length > 0 && (!needsValue || value.length > 0);

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: name.trim(), value, label: label.trim() });
      setValue("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const nameLabel: Record<AddKind, string> = {
    email: "Email address",
    project: "Project name",
    service: "Service",
    org: "Organization name",
    resource: "Project name",
    api: "Name",
    password: "Name",
    secret: "Name",
    field: "Field name",
  };

  let extra: ReactNode = null;
  if (kind === "email" || kind === "resource") {
    extra = (
      <div className="field">
        <label htmlFor="cv-add-label">{kind === "email" ? "Your name (optional)" : "Region (optional)"}</label>
        <input
          id="cv-add-label"
          placeholder={kind === "resource" ? "e.g. eu-west-1" : undefined}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
    );
  }

  return (
    <Modal label={title ?? ADD_TITLE[kind]} onClose={onCancel} maxWidth={460}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <header>
          <h2>{title ?? ADD_TITLE[kind]}</h2>
          <p>
            {under && (
              <>
                On <strong>{under}</strong>.{" "}
              </>
            )}
            {ADD_HELP[kind]}
          </p>
        </header>
        <div className="scroll">
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <div className="field">
            <label htmlFor="cv-add-name">{nameLabel[kind]}</label>
            <input
              id="cv-add-name"
              autoFocus
              type={kind === "email" ? "email" : "text"}
              list={kind === "service" ? "cv-services" : undefined}
              placeholder={
                PLACEHOLDER[kind]
              }
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {kind === "service" && (
              <datalist id="cv-services">
                {knownServiceNames().map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            )}
          </div>
          {extra}
          {needsValue && (
            <div className="field">
              <label htmlFor="cv-add-value">Value</label>
              <input
                id="cv-add-value"
                type={secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
          )}
        </div>
        <footer>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!ready || busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
