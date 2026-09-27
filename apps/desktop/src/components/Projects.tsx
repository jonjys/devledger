import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import * as api from "../lib/api";
import { formatTime, plural } from "../lib/format";
import { pasteHints } from "../lib/pasteHints";
import type { ProjectSummary } from "../lib/types";

import Modal from "./Modal";
import ProjectVault from "./ProjectVault";
import ProviderIcon from "./ProviderIcon";
import type { WordKind } from "./AddAnythingDialog";

const SkillTree = lazy(() => import("./SkillTree"));

interface Props {
  projects: ProjectSummary[];
  /** The project open, or null for the list. */
  openId: string | null;
  onOpen: (projectId: string | null) => void;
  onNotify: (message: string, bad?: boolean) => void;
  onChanged: () => void;
  refreshKey: number;
  /** Send pasted text for analysis, filed into `projectId`. */
  onPaste: (text: string, projectId: string | null) => void;
  analyzing: boolean;
  onAdd: (kind: WordKind) => void;
}

// Which projects were opened last, newest first. A per-viewer convenience:
// storage can be unavailable, and the list then falls back to newest created.
const RECENT_KEY = "devledger.recentProjects";

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function remember(projectId: string) {
  try {
    const next = [projectId, ...readRecent().filter((id) => id !== projectId)].slice(0, 10);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Nothing to do: the list just will not remember.
  }
}

/** Five projects: the ones opened most recently, then the newest. */
export function recentProjects(projects: ProjectSummary[], opened: string[]): ProjectSummary[] {
  const byId = new Map(projects.map((p) => [p.project.id, p]));
  const out: ProjectSummary[] = [];
  for (const id of opened) {
    const hit = byId.get(id);
    if (hit) out.push(hit);
  }
  const rest = [...projects]
    .filter((p) => !out.includes(p))
    .sort((a, b) => b.project.created_at.localeCompare(a.project.created_at));
  return [...out, ...rest].slice(0, 5);
}

function initials(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase() || "?";
}

/** A stable hue per project name, for its avatar. */
function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/**
 * Projects, laid out the way a deploy dashboard does it: find or switch at the
 * top, a card per project, the latest few on the side. Opening one shows its
 * slice of the skill tree, a paste box that files straight into it, and its
 * variables.
 */
export default function Projects(props: Props) {
  const { projects, openId } = props;
  const open = projects.find((p) => p.project.id === openId) ?? null;

  useEffect(() => {
    if (openId) remember(openId);
  }, [openId]);

  return open ? <ProjectDetail {...props} summary={open} /> : <ProjectList {...props} />;
}

function ProjectList({ projects, onOpen, onNotify, onChanged, onAdd }: Props) {
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<"switch" | "add" | null>(null);
  const [creating, setCreating] = useState(false);
  const recent = useMemo(() => recentProjects(projects, readRecent()), [projects]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? projects.filter((p) => p.project.name.toLowerCase().includes(q)) : projects;
  }, [projects, query]);

  return (
    <div className="vp">
      <div className="vp-bar">
        <Dropdown
          label="All Projects"
          open={menu === "switch"}
          onToggle={() => setMenu(menu === "switch" ? null : "switch")}
          onClose={() => setMenu(null)}
        >
          <button type="button" role="menuitem" className="active" onClick={() => setMenu(null)}>
            All Projects
          </button>
          {projects.map((p) => (
            <button key={p.project.id} type="button" role="menuitem" onClick={() => onOpen(p.project.id)}>
              {p.project.name}
            </button>
          ))}
        </Dropdown>

        <input
          className="vp-find"
          type="search"
          aria-label="Find Project"
          placeholder="Find Project…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && shown[0]) onOpen(shown[0].project.id);
          }}
        />

        <Dropdown
          label="Add New…"
          primary
          open={menu === "add"}
          onToggle={() => setMenu(menu === "add" ? null : "add")}
          onClose={() => setMenu(null)}
          align="right"
        >
          <button type="button" role="menuitem" onClick={() => { setMenu(null); setCreating(true); }}>
            Project
          </button>
          <button type="button" role="menuitem" onClick={() => { setMenu(null); onAdd("service"); }}>
            Account
          </button>
          <button type="button" role="menuitem" onClick={() => { setMenu(null); onAdd("api_key"); }}>
            API key
          </button>
          <button type="button" role="menuitem" onClick={() => { setMenu(null); onAdd("variable"); }}>
            Env variable
          </button>
        </Dropdown>
      </div>

      <div className="vp-body">
        <section className="vp-main" aria-label="Projects">
          {projects.length === 0 ? (
            <div className="vp-empty">
              <h2>No projects yet</h2>
              <p>A project is what you build: the accounts, keys and variables it runs on hang off it.</p>
              <button type="button" className="primary" onClick={() => setCreating(true)}>
                Create Project
              </button>
            </div>
          ) : shown.length === 0 ? (
            <p className="muted-p">No project matches “{query}”.</p>
          ) : (
            <div className="vp-grid">
              {shown.map((p) => (
                <button
                  key={p.project.id}
                  type="button"
                  className="vp-card"
                  onClick={() => onOpen(p.project.id)}
                >
                  <span className="vp-card-head">
                    <span className="vp-avatar" style={{ background: `hsl(${hue(p.project.name)} 55% 42%)` }}>
                      {initials(p.project.name)}
                    </span>
                    <span className="vp-card-name">{p.project.name}</span>
                  </span>
                  {p.project.description && <span className="vp-card-desc">{p.project.description}</span>}
                  <span className="vp-card-icons">
                    {p.providers.slice(0, 6).map((provider) => (
                      <ProviderIcon key={provider} provider={provider} size={15} />
                    ))}
                  </span>
                  <span className="vp-card-meta">
                    {plural(p.service_project_count, "resource")} · {plural(p.secret_count, "secret")}
                  </span>
                  <span className="vp-card-date">Created {formatTime(p.project.created_at)}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <aside className="vp-side" aria-label="Recent Previews">
          <h3>Recent Previews</h3>
          {recent.length === 0 ? (
            <p className="muted-p">Projects you open show up here.</p>
          ) : (
            recent.map((p) => (
              <button key={p.project.id} type="button" className="vp-recent" onClick={() => onOpen(p.project.id)}>
                <span className="vp-avatar sm" style={{ background: `hsl(${hue(p.project.name)} 55% 42%)` }}>
                  {initials(p.project.name)}
                </span>
                <span className="vp-recent-text">
                  <span className="vp-recent-name">{p.project.name}</span>
                  <span className="vp-recent-meta">{plural(p.secret_count, "secret")}</span>
                </span>
              </button>
            ))
          )}
        </aside>
      </div>

      {creating && (
        <CreateProject
          onCancel={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            onChanged();
            onOpen(id);
          }}
          onNotify={onNotify}
        />
      )}
    </div>
  );
}

function ProjectDetail({
  summary,
  projects,
  onOpen,
  onNotify,
  onChanged,
  refreshKey,
  onPaste,
  analyzing,
}: Props & { summary: ProjectSummary }) {
  const [tab, setTab] = useState<"overview" | "variables">("overview");
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const hints = useMemo(() => pasteHints(text), [text]);
  const name = summary.project.name;

  function analyze() {
    if (!text.trim() || analyzing) return;
    onPaste(text, summary.project.id);
    // The text now lives only in the analysis on the Rust side.
    setText("");
  }

  return (
    <div className="vp">
      <div className="vp-bar">
        <Dropdown
          label={name}
          open={menu}
          onToggle={() => setMenu(!menu)}
          onClose={() => setMenu(false)}
        >
          <button type="button" role="menuitem" onClick={() => onOpen(null)}>
            All Projects
          </button>
          {projects.map((p) => (
            <button
              key={p.project.id}
              type="button"
              role="menuitem"
              className={p.project.id === summary.project.id ? "active" : ""}
              onClick={() => {
                setMenu(false);
                onOpen(p.project.id);
              }}
            >
              {p.project.name}
            </button>
          ))}
        </Dropdown>
        <nav className="vp-crumbs" aria-label="Breadcrumb">
          <button type="button" className="link" onClick={() => onOpen(null)}>
            All Projects
          </button>
          <span>/</span>
          <span>{name}</span>
        </nav>
      </div>

      <div className="vp-head">
        <span className="vp-avatar lg" style={{ background: `hsl(${hue(name)} 55% 42%)` }}>
          {initials(name)}
        </span>
        <div>
          <h1>{name}</h1>
          <div className="vp-card-meta">
            {plural(summary.service_project_count, "resource")} · {plural(summary.secret_count, "secret")}
          </div>
        </div>
      </div>

      <div className="vp-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "overview"} className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>
          Overview
        </button>
        <button type="button" role="tab" aria-selected={tab === "variables"} className={tab === "variables" ? "active" : ""} onClick={() => setTab("variables")}>
          Variables
        </button>
      </div>

      {tab === "overview" ? (
        <div className="vp-overview">
          <section className="vp-paste" aria-label="Paste">
            <textarea
              aria-label={`Paste into ${name}`}
              placeholder={`Paste a .env file, an API key (re_…, sk_…) or a few lines about ${name}. DevLedger works out what it is and files it here.`}
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) analyze();
              }}
            />
            <div className="vp-paste-foot">
              <span className="vp-hints" aria-live="polite">
                {hints.length === 0
                  ? text.trim()
                    ? "Nothing recognised yet — analysis may still find something."
                    : "Detects .env lines, Resend, Stripe, Anthropic, OpenAI and GitHub keys."
                  : hints.map((h) => (
                      <span key={h.label} className="vp-hint">
                        {h.count > 1 ? `${h.count} × ` : ""}
                        {h.label}
                      </span>
                    ))}
              </span>
              <span className="spacer" />
              <button type="button" className="primary" onClick={analyze} disabled={!text.trim() || analyzing}>
                {analyzing ? "Analyzing…" : `Add to ${name}`}
              </button>
            </div>
          </section>

          <section className="vp-tree" aria-label={`${name} in the skill tree`}>
            <Suspense fallback={<div className="empty">Loading…</div>}>
              <SkillTree
                onNotify={onNotify}
                onChanged={onChanged}
                refreshKey={refreshKey}
                projectId={summary.project.id}
              />
            </Suspense>
          </section>
        </div>
      ) : (
        <ProjectVault summary={summary} onNotify={onNotify} onChanged={onChanged} />
      )}
    </div>
  );
}

function Dropdown({
  label,
  open,
  onToggle,
  onClose,
  children,
  primary,
  align = "left",
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: React.ReactNode;
  primary?: boolean;
  align?: "left" | "right";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div className="vp-dropdown" ref={ref}>
      <button
        type="button"
        className={primary ? "primary" : "vp-switch"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
      >
        {label} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className={`vp-menu ${align}`} role="menu" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}

function CreateProject({
  onCancel,
  onCreated,
  onNotify,
}: {
  onCancel: () => void;
  onCreated: (projectId: string) => void;
  onNotify: (message: string, bad?: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const project = await api.createProject(trimmed, description.trim() || null);
      onNotify(`Created ${project.name}`);
      onCreated(project.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal label="Create Project" onClose={onCancel} maxWidth={460}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <header>
          <h2>Create Project</h2>
          <p>Any name. Accounts, keys and variables can be attached to it afterwards.</p>
        </header>
        <div className="scroll">
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <div className="field">
            <label htmlFor="vp-name">Project name</label>
            <input id="vp-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="vp-desc">Description (optional)</label>
            <input id="vp-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>
        <footer>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!name.trim() || busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
