import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "../lib/api";
import { plural } from "../lib/format";
import { parseLayout, recommendedLayout, serializeLayout, type Layout, type ViewId } from "../lib/layout";
import { ModeProvider, useMode } from "../lib/mode";
import { trialsFrom } from "../lib/overview";
import type { PasteAnalysis, ProjectSummary, ReviewSubmission } from "../lib/types";

import AssistantView from "./AssistantView";
import AttentionView from "./AttentionView";
import ConnectionsView from "./ConnectionsView";
import HomeView from "./HomeView";
import LayoutPanel, { VIEW_LABEL } from "./LayoutPanel";
import AddAnythingDialog, { type WordKind } from "./AddAnythingDialog";
import LedgerView from "./LedgerView";
import Projects from "./Projects";
import ReviewSheet from "./ReviewSheet";
import SecretsView from "./SecretsView";
import SmartPasteBar from "./SmartPasteBar";
import SubscriptionsView from "./SubscriptionsView";

type View = ViewId;

type IconName = View;

type BadgeKind = "trials" | "attention";

interface NavItem {
  label: string;
  /** What the phone tab bar shows when the full label does not fit. */
  short?: string;
  badge?: BadgeKind;
}

/** Every tab there is. Which ones show, and in what order, is the user's layout. */
const NAV: Record<View, NavItem> = {
  home: { label: VIEW_LABEL.home },
  projects: { label: VIEW_LABEL.projects },
  ledger: { label: VIEW_LABEL.ledger },
  assistant: { label: VIEW_LABEL.assistant, short: "AI" },
  connections: { label: VIEW_LABEL.connections, short: "Services" },
  subscriptions: { label: VIEW_LABEL.subscriptions, short: "Billing", badge: "trials" },
  secrets: { label: VIEW_LABEL.secrets },
  attention: { label: VIEW_LABEL.attention, short: "Alerts", badge: "attention" },
};

/** How many tabs fit in the phone's bottom bar before the rest go under More. */
const PHONE_TABS = 4;

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
    case "home":
      return (
        <svg {...common}>
          <path d="M3 11 12 4l9 7" />
          <path d="M5 10v10h14V10" />
          <path d="M10 20v-5h4v5" />
        </svg>
      );
    case "ledger":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="2.2" />
          <path d="M8.2 6H13" />
          <rect x="13" y="3.5" width="8" height="5" rx="1" />
          <path d="M17 8.5v4" />
          <rect x="13" y="12.5" width="8" height="5" rx="1" />
          <path d="M17 17.5V21" />
        </svg>
      );
    case "projects":
      return (
        <svg {...common}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
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
    case "assistant":
      return (
        <svg {...common}>
          <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
          <path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
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
  // The user's layout: home boxes, which tabs show and where the app opens.
  // Until it loads, the recommended one.
  const [layout, setLayout] = useState<Layout>(recommendedLayout);
  const [view, setView] = useState<View>(() => recommendedLayout().start);
  const [panel, setPanel] = useState(false);
  const [more, setMore] = useState(false);
  const pendingLayout = useRef<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const [leakId, setLeakId] = useState<string | null>(null);
  // The project a paste was made inside, so the review files it there.
  const [pasteTarget, setPasteTarget] = useState<string | null>(null);
  const [attentionCount, setAttentionCount] = useState(0);
  // Entries with no email hold accounts filed under no one: the badge pulses.
  const [unidentified, setUnidentified] = useState(0);
  const [trialsCount, setTrialsCount] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  // false = closed; true = open with nothing chosen; a kind = open with it chosen.
  const [addingAnything, setAddingAnything] = useState<WordKind | boolean>(false);

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
    setUnidentified(attention.filter((a) => a.kind === "identity_without_email").length);
    setTrialsCount(trialsFrom(subs).length);
    // `selected` is the project open on the Projects page; the list is the default.
    setSelected((current) => (current && rows.some((r) => r.project.id === current) ? current : null));
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    refresh().catch((e: unknown) => notify(e instanceof Error ? e.message : String(e), true));
  }, [refresh, notify]);

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.uiLayoutGet())
      .then(({ layout: saved }) => {
        if (!live) return;
        const l = parseLayout(saved);
        setLayout(l);
        setView(l.start);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const flushLayout = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    const json = pendingLayout.current;
    pendingLayout.current = null;
    if (json === null) return;
    try {
      await api.uiLayoutSet(json);
    } catch (e: unknown) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
  }, [notify]);

  /** Show the change at once; save it shortly after, so typing in a note is one write. */
  const changeLayout = useCallback(
    (next: Layout) => {
      setLayout(next);
      pendingLayout.current = serializeLayout(next);
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flushLayout(), 500);
    },
    [flushLayout],
  );

  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  // Hiding the open tab moves to the start page. (A box on Home may still open
  // a hidden view; that is a deliberate tap, not a menu.)
  useEffect(() => {
    setView((v) => (layout.tabs.includes(v) ? v : layout.start));
  }, [layout.tabs, layout.start]);

  async function lock() {
    await flushLayout();
    onLock();
  }

  function go(id: View) {
    // Projects in the menu always means the list, even from inside a project.
    if (id === "projects") setSelected(null);
    setView(id);
    setMore(false);
  }

  async function analyze(text: string, projectId: string | null = null) {
    setPasteTarget(projectId);
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

        <nav className="side-nav" aria-label="Menu">
          <div className="nav-group">
            <div className="nav-section">Menu</div>
            {layout.tabs.map((id, index) => {
              const item = NAV[id];
              const count = item.badge ? badgeValue(item.badge) : 0;
              return (
                <button
                  key={id}
                  type="button"
                  className={`nav-item${view === id ? " active" : ""}${index >= PHONE_TABS ? " nav-overflow" : ""}`}
                  aria-current={view === id}
                  onClick={() => go(id)}
                >
                  <span className="nav-icon">
                    <Icon name={id} />
                  </span>
                  <span className={`nav-label${item.short ? " has-short" : ""}`}>{item.label}</span>
                  {item.short && (
                    <span className="nav-label nav-short" aria-hidden="true">
                      {item.short}
                    </span>
                  )}
                  {count > 0 && (
                    <span
                      className={`nav-badge${item.badge === "attention" ? " alert" : ""}${
                        item.badge === "attention" && unidentified > 0 ? " pulse" : ""
                      }`}
                      title={
                        item.badge === "attention" && unidentified > 0
                          ? `${plural(unidentified, "entry", "entries")} with no email`
                          : undefined
                      }
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
            <button
              type="button"
              className={`nav-item nav-more${more ? " active" : ""}`}
              aria-expanded={more}
              onClick={() => setMore((m) => !m)}
            >
              <span className="nav-icon" aria-hidden="true">
                ⋯
              </span>
              <span className="nav-label">More</span>
            </button>
          </div>
        </nav>

        <div className="side-foot">
          <ModeToggle />
          <button type="button" className="link-btn customize-btn" onClick={() => setPanel(true)}>
            Customize menu & layout
          </button>
          <button type="button" className="lock-btn" onClick={() => void lock()}>
            Lock vault
          </button>
        </div>
      </aside>

      {more && (
        <div className="more-backdrop" onClick={() => setMore(false)}>
          <div className="more-sheet" role="dialog" aria-label="More" onClick={(e) => e.stopPropagation()}>
            {layout.tabs.slice(PHONE_TABS).map((id) => (
              <button key={id} type="button" className={`more-item${view === id ? " active" : ""}`} onClick={() => go(id)}>
                <Icon name={id} />
                <span>{NAV[id].label}</span>
                {NAV[id].badge && badgeValue(NAV[id].badge!) > 0 && (
                  <span className={`nav-badge${NAV[id].badge === "attention" ? " alert" : ""}`}>
                    {badgeValue(NAV[id].badge!)}
                  </span>
                )}
              </button>
            ))}
            <button
              type="button"
              className="more-item"
              onClick={() => {
                setMore(false);
                setPanel(true);
              }}
            >
              <span aria-hidden="true">✎</span>
              <span>Customize menu & layout</span>
            </button>
            <button type="button" className="more-item" onClick={() => void lock()}>
              <span aria-hidden="true">🔒</span>
              <span>Lock vault</span>
            </button>
          </div>
        </div>
      )}

      {panel && (
        <LayoutPanel layout={layout} onLayout={changeLayout} onClose={() => setPanel(false)} onNotify={notify} />
      )}

      <div className="app-main">
        <SmartPasteBar
          onAnalyze={(text) => analyze(text)}
          busy={analyzing}
          extra={
            <button
              type="button"
              className="add-anything-btn"
              onClick={() => setAddingAnything(true)}
              title="Type a word and say what it is: project, email, username, password…"
            >
              + Add
            </button>
          }
        />
        {addingAnything && (
          <AddAnythingDialog
            initialKind={typeof addingAnything === "string" ? addingAnything : undefined}
            onClose={() => setAddingAnything(false)}
            onDone={() => void refresh()}
            onNotify={notify}
          />
        )}

        <div className={`content${view === "ledger" ? " full" : ""}`}>
          {view === "home" && (
            <HomeView
              layout={layout}
              onLayout={changeLayout}
              onOpenLayoutPanel={() => setPanel(true)}
              onNotify={notify}
              onNavigate={(v) => go(v as View)}
              onOpenProject={(id) => {
                setSelected(id);
                setView("projects");
              }}
              onChanged={refresh}
              refreshKey={refreshKey}
              onAdd={(kind) => setAddingAnything(kind)}
            />
          )}

          {view === "projects" && (
            <Projects
              projects={projects}
              openId={selected}
              onOpen={setSelected}
              onNotify={notify}
              onChanged={refresh}
              refreshKey={refreshKey}
              onPaste={(text, projectId) => void analyze(text, projectId)}
              analyzing={analyzing}
              onAdd={(kind) => setAddingAnything(kind)}
            />
          )}

          {view === "ledger" && (
            <LedgerView
              onNotify={notify}
              onChanged={refresh}
              refreshKey={refreshKey}
              onOpenProject={(id) => {
                setSelected(id);
                setView("projects");
              }}
            />
          )}

          {view === "connections" && (
            <ConnectionsView
              onNotify={notify}
              onChanged={refresh}
              onAddOther={() => setAddingAnything("service")}
            />
          )}

          {view === "subscriptions" && (
            <SubscriptionsView onNotify={notify} onChanged={refresh} />
          )}

          {view === "secrets" && (
            <SecretsView
              onNotify={notify}
              refreshKey={refreshKey}
              onLeak={(id) => {
                setLeakId(id);
                setView("assistant");
              }}
            />
          )}

          {view === "assistant" && <AssistantView onNotify={notify} leakSecretId={leakId} />}

          {view === "attention" && (
            <AttentionView onNotify={notify} refreshKey={refreshKey} onChanged={refresh} />
          )}
        </div>
      </div>

      {analysis && (
        <ReviewSheet
          analysis={analysis}
          onCancel={cancelReview}
          onSave={save}
          saving={saving}
          targetProjectId={pasteTarget}
        />
      )}

      {toast && <div className={`toast${toast.bad ? " bad" : ""}`}>{toast.text}</div>}
    </div>
  );
}
