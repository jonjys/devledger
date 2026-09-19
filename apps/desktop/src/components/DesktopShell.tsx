import { useCallback, useEffect, useState } from "react";

import * as api from "../lib/api";
import { plural } from "../lib/format";
import type { PasteAnalysis, ProjectSummary, ReviewSubmission } from "../lib/types";

import ConnectionsView from "./ConnectionsView";
import StackGraphView from "./StackGraphView";
import NewProjectForm from "./NewProjectForm";
import ProjectVault from "./ProjectVault";
import ReviewSheet from "./ReviewSheet";
import SmartPasteBar from "./SmartPasteBar";
import SubscriptionsView from "./SubscriptionsView";

type Tab = "projects" | "map" | "connections" | "subscriptions";

const TABS: [Tab, string][] = [
  ["projects", "Projects"],
  ["map", "Stack"],
  ["connections", "Connections"],
  ["subscriptions", "Subscriptions"],
];

interface Props {
  onLock: () => void;
}

/** The main window: Smart Paste on top, projects on the left, vault on the right. */
export default function DesktopShell({ onLock }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<PasteAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ text: string; bad: boolean } | null>(null);
  const [tab, setTab] = useState<Tab>("projects");
  const [attentionCount, setAttentionCount] = useState(0);

  const notify = useCallback((text: string, bad = false) => {
    setToast({ text, bad });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const refresh = useCallback(async () => {
    const [rows, attention] = await Promise.all([
      api.listProjects(),
      api.needsAttention(),
    ]);
    setProjects(rows);
    setAttentionCount(attention.length);
    setSelected((current) => {
      if (current && rows.some((r) => r.project.id === current)) return current;
      return rows[0]?.project.id ?? null;
    });
  }, []);

  useEffect(() => {
    refresh().catch((e: unknown) =>
      notify(e instanceof Error ? e.message : String(e), true),
    );
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
    // Tell Rust to drop the staged plaintext rather than leaving it resident.
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
        setTab("projects");
      }
      const parts = [`Saved ${plural(outcome.secrets_created, "new secret")}`];
      if (outcome.secrets_updated > 0) parts.push(`updated ${outcome.secrets_updated}`);
      if (outcome.entities_skipped > 0) parts.push(`skipped ${outcome.entities_skipped}`);
      if (outcome.left_unassigned > 0) {
        parts.push(`${outcome.left_unassigned} needs attention`);
      }
      notify(parts.join(", "));
    } catch (e: unknown) {
      notify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setSaving(false);
    }
  }

  const current = projects.find((p) => p.project.id === selected) ?? null;

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <span className="dot" />
          DevLedger
        </div>
        <span className="spacer" />
        <nav className="tabs" role="tablist">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
            >
              {label}
              {id === "map" && attentionCount > 0 && (
                <span className="badge">{attentionCount}</span>
              )}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        {/*
          This label has to stay true. Before connectors existed it read "no
          network"; that stopped being accurate the moment Connect & Discover
          shipped, so it now states the actual rule.
        */}
        <span
          className="net-note"
          title="DevLedger stores everything locally and sends no telemetry. It contacts a provider only while you are connecting or refreshing a connection, and only ever reads."
        >
          Local-first · network only for connectors
        </span>
        <button type="button" onClick={onLock}>
          Lock
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateRows: "auto 1fr", minHeight: 0 }}>
        <SmartPasteBar onAnalyze={analyze} busy={analyzing} />

        {tab === "projects" ? (
          <div className="body">
            <nav className="sidebar">
              <h2>
                Projects
                <NewProjectForm
                  onCreated={(id) => {
                    void refresh();
                    setSelected(id);
                  }}
                  onNotify={notify}
                />
              </h2>
              {projects.length === 0 ? (
                <p style={{ color: "var(--text-faint)", fontSize: 12.5, padding: "0 8px" }}>
                  Nothing yet.
                </p>
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

            <main className="main">
              {current ? (
                <ProjectVault summary={current} onNotify={notify} />
              ) : (
                <div className="empty">
                  <p style={{ margin: 0, fontWeight: 600 }}>Your ledger is empty</p>
                  <p style={{ marginBottom: 0 }}>
                    Paste a <code>.env</code> block, a Supabase URL, or a few lines naming
                    your project, organization and email to get started.
                  </p>
                </div>
              )}
            </main>
          </div>
        ) : (
          <main className="main">
            {tab === "map" ? (
              <StackGraphView projects={projects} onNotify={notify} onChanged={refresh} />
            ) : tab === "connections" ? (
              <ConnectionsView projects={projects} onNotify={notify} onChanged={refresh} />
            ) : (
              <SubscriptionsView onNotify={notify} />
            )}
          </main>
        )}
      </div>

      {analysis && (
        <ReviewSheet
          analysis={analysis}
          onCancel={cancelReview}
          onSave={save}
          saving={saving}
        />
      )}

      {toast && <div className={`toast${toast.bad ? " bad" : ""}`}>{toast.text}</div>}
    </div>
  );
}
