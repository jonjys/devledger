import { useCallback, useEffect, useState } from "react";

import * as api from "../lib/api";
import { plural } from "../lib/format";
import type { PasteAnalysis, ProjectSummary, ReviewSubmission } from "../lib/types";

import ProjectVault from "./ProjectVault";
import ReviewSheet from "./ReviewSheet";
import SmartPasteBar from "./SmartPasteBar";

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

  const notify = useCallback((text: string, bad = false) => {
    setToast({ text, bad });
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  const refresh = useCallback(async () => {
    const rows = await api.listProjects();
    setProjects(rows);
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
      if (touched) setSelected(touched);
      notify(
        `Saved ${plural(outcome.secrets_created, "new secret")}` +
          (outcome.secrets_updated > 0 ? `, updated ${outcome.secrets_updated}` : "") +
          (outcome.entities_skipped > 0 ? `, skipped ${outcome.entities_skipped}` : ""),
      );
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
        <span style={{ color: "var(--text-faint)", fontSize: 12 }}>
          Local only · no network
        </span>
        <button type="button" onClick={onLock}>
          Lock
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateRows: "auto 1fr", minHeight: 0 }}>
        <SmartPasteBar onAnalyze={analyze} busy={analyzing} />

        <div className="body">
          <nav className="sidebar">
            <h2>Projects</h2>
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
                    {summary.organization_name} · {plural(summary.secret_count, "secret")}
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
                  Paste a <code>.env</code> block, a Supabase URL or a connection string
                  into the box above to get started.
                </p>
              </div>
            )}
          </main>
        </div>
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
