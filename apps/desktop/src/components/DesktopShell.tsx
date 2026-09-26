import { useCallback, useEffect, useState } from "react";

import * as api from "../lib/api";
import { plural } from "../lib/format";
import { ModeProvider, useMode } from "../lib/mode";
import { trialsFrom } from "../lib/overview";
import type { PasteAnalysis, ProjectSummary, ReviewSubmission } from "../lib/types";

import AttentionView from "./AttentionView";
import ConnectionsView from "./ConnectionsView";
import MapView from "./MapView";
import StackGraphView from "./StackGraphView";
import NewProjectForm from "./NewProjectForm";
import OverviewView from "./OverviewView";
import ProjectVault from "./ProjectVault";
import ReviewSheet from "./ReviewSheet";
import SecretsView from "./SecretsView";
import SmartPasteBar from "./SmartPasteBar";
import SubscriptionsView from "./SubscriptionsView";

type View =
  | "overview"
  | "projects"
  | "identities"
  | "stack"
  | "connections"
  | "subscriptions"
  | "secrets"
  | "attention";

type IconName = View;

type BadgeKind = "trials" | "attention";

interface NavItem {
  id: View;
  label: string;
  icon: IconName;
  badge?: BadgeKind;
}

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Workspace",
    items: [
      { id: "overview", label: "Overview", icon: "overview" },
      { id: "projects", label: "Projects", icon: "projects" },
      { id: "identities", label: "Identities", icon: "identities" },
      { id: "stack", label: "Stack", icon: "stack" },
      { id: "connections", label: "Connections", icon: "connections" },
    ],
  },
  {
    section: "Finance",
    items: [{ id: "subscriptions", label: "Subscriptions", icon: "subscriptions", badge: "trials" }],
  },
  { section: "Vault", items: [{ id: "secrets", label: "Secrets", icon: "secrets" }] },
  {
    section: "Alerts",
    items: [{ id: "attention", label: "Needs attention", icon: "attention", badge: "attention" }],
  },
];

/** Minimal line icons, kept inline so the app pulls in no icon dependency. */
function Icon({ name }: { name: IconName }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "overview":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      );
    case "projects":
      return (
        <svg {...common}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      );
    case "identities":
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.2" />
          <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
        </svg>
      );
    case "stack":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="2" />
          <circle cx="18" cy="7" r="2" />
          <circle cx="12" cy="18" r="2" />
          <path d="M8 7.2 16.2 7.8" />
          <path d="M7.2 8 11 16.2" />
          <path d="M16.8 9 13 16.2" />
        </svg>
      );
    case "connections":
      return (
        <svg {...common}>
          <path d="M9 15 15 9" />
          <path d="M13 5.5 15 3.5a3.5 3.5 0 0 1 5 5l-2 2" />
          <path d="M11 18.5 9 20.5a3.5 3.5 0 0 1-5-5l2-2" />
        </svg>
      );
    case "subscriptions":
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 10h18" />
        </svg>
      );
    case "secrets":
      return (
        <svg {...common}>
          <circle cx="8" cy="12" r="3.2" />
          <path d="M11 12h9" />
          <path d="M17 12v3" />
          <path d="M20 12v3" />
        </svg>
      );
    case "attention":
      return (
        <svg {...common}>
          <path d="M12 4 2.5 20h19z" />
          <path d="M12 10v4" />
          <path d="M12 17h.01" />
        </svg>
      );
  }
}

interface Props {
  onLock: () => void;
}

function ModeToggle() {
  const { mode, setMode } = useMode();
  return (
    <div className="mode-toggle" role="group" aria-label="Display mode">
      <button
        type="button"
        className={mode === "indie" ? "active" : ""}
        aria-pressed={mode === "indie"}
        onClick={() => setMode("indie")}
        title="Clean, human-readable view"
      >
        Indie
      </button>
      <button
        type="button"
        className={mode === "dev" ? "active" : ""}
        aria-pressed={mode === "dev"}
        onClick={() => setMode("dev")}
        title="Full technical detail"
      >
        Dev
      </button>
    </div>
  );
}

export default function DesktopShell(props: Props) {
  return (
    <ModeProvider>
      <DesktopShellInner {...props} />
    </ModeProvider>
  );
}

function DesktopShellInner({ onLock }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<PasteAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ text: string; bad: boolean } | null>(null);
  const [view, setView] = useState<View>("overview");
  const [stackQuery, setStackQuery] = useState("");
  const [attentionCount, setAttentionCount] = useState(0);
  const [trialsCount, setTrialsCount] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  const notify = useCallback((text: string, bad = false) => {
    setToast({ text, bad });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const refresh = useCallback(async () => {
    const [rows, attention, subs] = await Promise.all([
      api.listProjects(),
      api.needsAttention(),
      api.listSubscriptions(),
    ]);
    setProjects(rows);
    setAttentionCount(attention.length);
    setTrialsCount(trialsFrom(subs).length);
    setSelected((current) => {
      if (current && rows.some((r) => r.project.id === current)) return current;
      return rows[0]?.project.id ?? null;
    });
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    refresh().catch((e: unknown) => notify(e instanceof Error ? e.message : String(e), true));
  }, [refresh, notify]);

  async function analyze(text: string) {
    setAnalyzing(true);
    try {
      setAnalysis(await api.analyzePaste(text));
    } catch (e: unknown) {
      notify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setAnalyzing(false);
    }
  }

  async function cancelReview() {
    if (!analysis) return;
    const id = analysis.analysis_id;
    setAnalysis(null);
    await api.discardAnalysis(id).catch(() => undefined);
  }

  async function save(submission: ReviewSubmission) {
    setSaving(true);
    try {
      const outcome = await api.commitReview(submission);
      setAnalysis(null);
      await refresh();
      const touched = outcome.touched_project_ids[0];
      if (touched) {
        setSelected(touched);
        setView("projects");
      }
      const parts = [`Saved ${plural(outcome.secrets_created, "new secret")}`];
      if (outcome.secrets_updated > 0) parts.push(`updated ${outcome.secrets_updated}`);
      if (outcome.entities_skipped > 0) parts.push(`skipped ${outcome.entities_skipped}`);
      if (outcome.left_unassigned > 0) parts.push(`${outcome.left_unassigned} needs attention`);
      notify(parts.join(", "));
    } catch (e: unknown) {
      notify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setSaving(false);
    }
  }

  const current = projects.find((p) => p.project.id === selected) ?? null;

  function badgeValue(kind: BadgeKind): number {
    return kind === "trials" ? trialsCount : attentionCount;
  }

  return (
    <div className="app-shell">
      <aside className="app-side">
        <div className="side-brand">
          <span className="side-logo">D</span>
          <span className="side-name">DevLedger</span>
          <span className="beta">BETA</span>
        </div>

        <nav className="side-nav">
          {NAV.map((group) => (
            <div key={group.section} className="nav-group">
              <div className="nav-section">{group.section}</div>
              {group.items.map((item) => {
                const count = item.badge ? badgeValue(item.badge) : 0;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`nav-item${view === item.id ? " active" : ""}`}
                    aria-current={view === item.id}
                    onClick={() => setView(item.id)}
                  >
                    <span className="nav-icon">
                      <Icon name={item.icon} />
                    </span>
                    <span className="nav-label">{item.label}</span>
                    {count > 0 && (
                      <span className={`nav-badge${item.badge === "attention" ? " alert" : ""}`}>
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="side-foot">
          <ModeToggle />
          <button type="button" className="lock-btn" onClick={onLock}>
            Lock vault
          </button>
        </div>
      </aside>

      <div className="app-main">
        <SmartPasteBar onAnalyze={analyze} busy={analyzing} />

        <div className="content">
          {view === "overview" && (
            <OverviewView
              onNotify={notify}
              onNavigate={(v) => setView(v as View)}
              onSearch={(q) => {
                setStackQuery(q);
                setView("stack");
              }}
              onChanged={refresh}
              refreshKey={refreshKey}
            />
          )}

          {view === "projects" && (
            <div className="dash">
              <div className="dash-head column">
                <h1>Projects</h1>
                <NewProjectForm
                  onCreated={(id) => {
                    void refresh();
                    setSelected(id);
                  }}
                  onNotify={notify}
                />
              </div>
              <div className="proj-pane">
                <nav className="proj-list">
                  {projects.length === 0 ? (
                    <p className="muted-p">Nothing yet.</p>
                  ) : (
                    projects.map((summary) => (
                      <button
                        key={summary.project.id}
                        type="button"
                        className={`proj${summary.project.id === selected ? " active" : ""}`}
                        onClick={() => setSelected(summary.project.id)}
                      >
                        <div className="name">{summary.project.name}</div>
                        <div className="meta">
                          {plural(summary.secret_count, "secret")}
                          {summary.service_project_count > 0
                            ? ` · ${plural(summary.service_project_count, "resource")}`
                            : ""}
                        </div>
                      </button>
                    ))
                  )}
                </nav>
                <div className="proj-main">
                  {current ? (
                    <ProjectVault summary={current} onNotify={notify} onChanged={refresh} />
                  ) : (
                    <div className="empty">
                      <p style={{ margin: 0, fontWeight: 600 }}>Your ledger is empty</p>
                      <p style={{ marginBottom: 0 }}>
                        Paste a <code>.env</code> block, a Supabase URL, or a few lines naming
                        your project, organization and email to get started.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {view === "identities" && (
            <div className="dash">
              <div className="dash-head">
                <h1>Identities</h1>
              </div>
              <MapView projects={projects} onNotify={notify} onChanged={refresh} />
            </div>
          )}

          {view === "stack" && (
            <StackGraphView
              projects={projects}
              query={stackQuery}
              onQueryChange={setStackQuery}
              onNotify={notify}
              onChanged={refresh}
            />
          )}

          {view === "connections" && <ConnectionsView onNotify={notify} onChanged={refresh} />}

          {view === "subscriptions" && (
            <SubscriptionsView onNotify={notify} onChanged={refresh} />
          )}

          {view === "secrets" && <SecretsView onNotify={notify} refreshKey={refreshKey} />}

          {view === "attention" && <AttentionView onNotify={notify} refreshKey={refreshKey} />}
        </div>
      </div>

      {analysis && (
        <ReviewSheet analysis={analysis} onCancel={cancelReview} onSave={save} saving={saving} />
      )}

      {toast && <div className={`toast${toast.bad ? " bad" : ""}`}>{toast.text}</div>}
    </div>
  );
}
