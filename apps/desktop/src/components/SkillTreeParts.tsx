// The pieces the skill tree is drawn with: its nodes and edges, the right-click
// menu, the Cmd+K palette and the add dialog. SkillTree.tsx wires them to data.

import { BaseEdge, Handle, Position, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { knownServiceNames } from "../lib/providers";
import type { NodeKind, Status, TreeItem } from "../lib/skillTree";

import Modal from "./Modal";
import ProviderIcon from "./ProviderIcon";

// --- nodes -------------------------------------------------------------------------

export interface SkillNodeData extends Record<string, unknown> {
  item: TreeItem;
  lit: boolean;
  selected: boolean;
  renaming: boolean;
  /** Pulses red: a person with no email, whose accounts need a home. */
  pulsing: boolean;
  onRename: (key: string, value: string | null) => void;
}

export type SkillFlowNode = Node<SkillNodeData, "skill">;

const STATUS_LABEL: Record<Status, string> = {
  healthy: "Healthy",
  missing: "Missing",
  attention: "Needs attention",
};

const KIND_LABEL: Record<NodeKind, string> = {
  primary: "Primary",
  identity: "Identity",
  category: "Category",
  account: "Account",
  field: "Field",
  project: "Project",
};

// Every edge meets a node at its centre. xyflow draws edges between handles, so
// each node carries one invisible handle of each type, pinned to the middle.
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

function Anchors() {
  return (
    <>
      <Handle type="target" position={Position.Top} style={CENTRE} isConnectable={false} />
      <Handle type="source" position={Position.Top} style={CENTRE} isConnectable={false} />
    </>
  );
}

function RenameInput({ item, onRename }: { item: TreeItem; onRename: SkillNodeData["onRename"] }) {
  const [value, setValue] = useState(item.kind === "primary" ? (item.sub ?? "") : item.label);
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
      className="st-rename nodrag nopan"
      aria-label={`Rename ${item.label}`}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onRename(item.key, value);
        if (e.key === "Escape") onRename(item.key, null);
      }}
      onBlur={() => onRename(item.key, value)}
    />
  );
}

function StatusDot({ status }: { status: Status }) {
  return <span className={`st-dot ${status}`} title={STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]} />;
}

/** One node of the tree. Memoised: panning re-renders the viewport, not these. */
export const SkillNode = memo(function SkillNode({ data }: NodeProps<SkillFlowNode>) {
  const { item, lit, selected, renaming, pulsing, onRename } = data;
  const cls = [
    "st-node",
    `st-${item.kind}`,
    item.tone ? `tone-${item.tone}` : "",
    lit ? "lit" : "",
    selected ? "selected" : "",
    pulsing ? "pulse" : "",
    item.children.length > 0 ? "has-children" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (item.kind === "primary") {
    return (
      <div className={cls} data-testid={item.key}>
        <Anchors />
        <div className="st-core">
          <span className="st-core-tag">PRIMARY</span>
        </div>
        <div className="st-core-label">
          {renaming ? <RenameInput item={item} onRename={onRename} /> : <strong>{item.label}</strong>}
          {item.sub && !renaming && <span>{item.sub}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className={cls} data-testid={item.key} title={item.sub ?? undefined}>
      <Anchors />
      {item.kind === "account" && item.provider && <ProviderIcon provider={item.provider} size={16} />}
      <span className="st-text">
        {renaming ? (
          <RenameInput item={item} onRename={onRename} />
        ) : (
          <span className="st-label">{item.label}</span>
        )}
        {item.sub && !renaming && (
          <span className={`st-sub${item.kind === "field" && item.source === "secret" ? " mono" : ""}`}>
            {item.sub}
          </span>
        )}
      </span>
      <StatusDot status={item.status} />
      {item.children.length > 0 && !lit && <span className="st-more">+{item.children.length}</span>}
    </div>
  );
});

// --- edges ------------------------------------------------------------------------

export interface SkillEdgeData extends Record<string, unknown> {
  lit: boolean;
}

/**
 * A curve from parent to child that leaves the parent heading away from the
 * centre and arrives the same way, which is what makes the tree read as rings
 * rather than a hairball. Lit edges get a soft second stroke as their glow:
 * cheaper than an SVG filter, so panning stays smooth.
 */
export function SkillEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps) {
  const lit = Boolean((data as SkillEdgeData | undefined)?.lit);
  const path = useMemo(() => {
    const dx = targetX - sourceX;
    const dy = targetY - sourceY;
    const dist = Math.hypot(dx, dy) || 1;
    const out = (x: number, y: number, fx: number, fy: number) => {
      const r = Math.hypot(x, y);
      return r < 1 ? [fx / dist, fy / dist] : [x / r, y / r];
    };
    const [sx, sy] = out(sourceX, sourceY, dx, dy);
    const [tx, ty] = out(targetX, targetY, dx, dy);
    const k = dist * 0.38;
    return `M ${sourceX},${sourceY} C ${sourceX + (sx ?? 0) * k},${sourceY + (sy ?? 0) * k} ${
      targetX - (tx ?? 0) * k
    },${targetY - (ty ?? 0) * k} ${targetX},${targetY}`;
  }, [sourceX, sourceY, targetX, targetY]);

  return (
    <>
      {lit && <path d={path} className="st-edge-glow" fill="none" />}
      <BaseEdge id={id} path={path} className={lit ? "st-edge lit" : "st-edge"} />
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
  const top = Math.min(y, window.innerHeight - 40 * (items.length + 1));

  const run = (item: MenuItem) => {
    if (item.disabled || item.items) return;
    onClose();
    item.onSelect?.();
  };

  return (
    <div ref={ref} className="st-menu" role="menu" aria-label={title} style={{ left, top }}>
      <div className="st-menu-title">{title}</div>
      {items.map((item) => (
        <div
          key={item.label}
          className="st-menu-row"
          onMouseEnter={() => setOpen(item.items ? item.label : null)}
        >
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

// --- the palette ----------------------------------------------------------------------

export interface PaletteEntry {
  key: string;
  kind: NodeKind;
  label: string;
  sub: string | null;
}

export function Palette({
  entries,
  onPick,
  onClose,
}: {
  entries: PaletteEntry[];
  onPick: (entry: PaletteEntry) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? entries.filter((e) => `${e.label} ${e.sub ?? ""}`.toLowerCase().includes(q))
      : entries.filter((e) => e.kind === "project");
    return matched.slice(0, 30);
  }, [entries, query]);

  useEffect(() => setCursor(0), [query]);

  return (
    <Modal label="Find" onClose={onClose} maxWidth={560}>
      <div className="st-palette">
        <input
          autoFocus
          aria-label="Find project, account or field"
          placeholder="Find Project, account, field…"
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

export type AddKind = "category" | "account" | "api" | "password" | "secret" | "field" | "project" | "identity";

const ADD_TITLE: Record<AddKind, string> = {
  category: "Add category",
  account: "Add account",
  api: "Add API key",
  password: "Add password",
  secret: "Add secret",
  field: "Add field",
  project: "Add project",
  identity: "Add your email",
};

const DEFAULT_NAME: Partial<Record<AddKind, string>> = {
  api: "API key",
  password: "Password",
  secret: "Secret",
};

export interface AddValues {
  name: string;
  value: string;
  /** Account label, or the identity's name. */
  label: string;
}

/**
 * One small form for everything the tree can add.
 *
 * Secret values are typed into a password field and handed straight to the
 * save call; the dialog keeps nothing once it closes.
 */
export function AddDialog({
  kind,
  parentLabel,
  projectNames,
  onCancel,
  onSubmit,
}: {
  kind: AddKind;
  /** What the new node goes under; null for the first email, which is the centre. */
  parentLabel: string | null;
  projectNames: string[];
  onCancel: () => void;
  onSubmit: (values: AddValues) => Promise<void>;
}) {
  const [name, setName] = useState(DEFAULT_NAME[kind] ?? "");
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
    category: "Category name",
    account: "Service",
    api: "Name",
    password: "Name",
    secret: "Name",
    field: "Field name",
    project: "Project name",
    identity: "Email address",
  };

  let extra: ReactNode = null;
  if (kind === "account") {
    extra = (
      <div className="field">
        <label htmlFor="st-add-label">Label (optional)</label>
        <input
          id="st-add-label"
          placeholder="e.g. work account"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
    );
  }
  if (kind === "identity") {
    extra = (
      <div className="field">
        <label htmlFor="st-add-label">Your name (optional)</label>
        <input id="st-add-label" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
    );
  }

  return (
    <Modal label={ADD_TITLE[kind]} onClose={onCancel} maxWidth={460}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <header>
          <h2>{ADD_TITLE[kind]}</h2>
          <p>
            {parentLabel === null ? (
              "It becomes the centre of your tree. Everything you add hangs off it."
            ) : (
              <>
                Under <strong>{parentLabel}</strong>
                {secret ? ". Stored encrypted in your vault; it is never shown here again." : "."}
              </>
            )}
          </p>
        </header>
        <div className="scroll">
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <div className="field">
            <label htmlFor="st-add-name">{nameLabel[kind]}</label>
            <input
              id="st-add-name"
              autoFocus
              list={kind === "account" ? "st-services" : kind === "project" ? "st-projects" : undefined}
              placeholder={kind === "account" ? "e.g. Resend, Claude, GitHub" : undefined}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {kind === "account" && (
              <datalist id="st-services">
                {knownServiceNames().map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            )}
            {kind === "project" && (
              <datalist id="st-projects">
                {projectNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            )}
          </div>
          {extra}
          {needsValue && (
            <div className="field">
              <label htmlFor="st-add-value">Value</label>
              <input
                id="st-add-value"
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

export { KIND_LABEL, STATUS_LABEL };
