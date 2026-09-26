import { useEffect, useState } from "react";

import * as api from "../lib/api";
import { formatTime, plural, providerLabel, secretKindLabel } from "../lib/format";
import { useMode } from "../lib/mode";
import type { Environment, ProjectSummary, ServiceProject, VaultEntry } from "../lib/types";

interface Props {
  summary: ProjectSummary;
  onNotify: (message: string, bad?: boolean) => void;
  onChanged: () => void;
}

/**
 * The Project Vault.
 *
 * The table renders only masked previews. "Copy" never brings the value into
 * this component -- Rust writes it straight to the clipboard. "Reveal" is the
 * one path that pulls plaintext into the frontend, and it is per-row, explicit,
 * and cleared when the row is collapsed again.
 */
export default function ProjectVault({ summary, onNotify, onChanged }: Props) {
  const { dev } = useMode();
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [resources, setResources] = useState<ServiceProject[]>([]);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [exportEnvironment, setExportEnvironment] = useState<Environment | "all">("all");

  const projectId = summary.project.id;

  useEffect(() => {
    let live = true;
    setLoading(true);
    // Revealed plaintext must not survive a switch to another project.
    setRevealed({});
    Promise.all([api.listSecrets(projectId), api.serviceProjectsForProject(projectId)])
      .then(([rows, linked]) => {
        if (!live) return;
        setEntries(rows);
        setResources(linked);
      })
      .catch((e: unknown) => onNotify(e instanceof Error ? e.message : String(e), true))
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [projectId, onNotify]);

  async function reload() {
    setEntries(await api.listSecrets(projectId));
  }

  async function toggleReveal(secretId: string) {
    if (revealed[secretId] !== undefined) {
      setRevealed(({ [secretId]: _dropped, ...rest }) => rest);
      return;
    }
    try {
      const value = await api.revealSecret(secretId);
      setRevealed((prev) => ({ ...prev, [secretId]: value }));
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function copyOne(secretId: string, name: string) {
    try {
      await api.copySecret(secretId);
      onNotify(`Copied ${name} · clipboard clears in 30 seconds`);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function copyAll() {
    try {
      const count = await api.copyEnv(
        projectId,
        exportEnvironment === "all" ? null : exportEnvironment,
      );
      onNotify(`Copied ${plural(count, "variable")} as .env · clipboard clears in 30 seconds`);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function remove(secretId: string, name: string) {
    try {
      await api.deleteSecret(secretId);
      setRevealed(({ [secretId]: _dropped, ...rest }) => rest);
      await reload();
      onNotify(`Deleted ${name}`);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function removeProject() {
    if (!window.confirm(`Delete project "${summary.project.name}"? Its resources are kept.`)) {
      return;
    }
    try {
      await api.deleteProject(projectId);
      onNotify(`Deleted ${summary.project.name}`);
      onChanged();
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  return (
    <div>
      <div className="vault-head">
        <div>
          <h1>{summary.project.name}</h1>
          <div className="sub">
            {summary.project.description ? `${summary.project.description} · ` : ""}
            {plural(entries.length, "secret")} ·{" "}
            {resources.length === 0
              ? "no linked resources"
              : resources
                  .map((r) =>
                    dev
                      ? `${providerLabel(r.provider)}${r.provider_ref ? ` ${r.provider_ref}` : ""}`
                      : providerLabel(r.provider),
                  )
                  .join(", ")}
          </div>
        </div>
        <span className="spacer" />
        <div className="acts">
          <select
            aria-label="Environment to export"
            value={exportEnvironment}
            onChange={(event) =>
              setExportEnvironment(event.target.value as Environment | "all")
            }
          >
            <option value="all">All environments</option>
            <option value="development">Development</option>
            <option value="staging">Staging</option>
            <option value="production">Production</option>
            <option value="unknown">Unassigned</option>
          </select>
          <button type="button" onClick={copyAll} disabled={entries.length === 0}>
            Copy .env
          </button>
          <button type="button" className="danger" onClick={removeProject}>
            Delete project
          </button>
        </div>
      </div>

      {loading ? (
        <div className="empty">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="empty">
          No secrets in this project yet. Paste a <code>.env</code> block above, or link a
          provider resource to it from the Map.
        </div>
      ) : (
        <table className="secrets">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Value</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const plaintext = revealed[entry.secret.id];
              return (
                <tr key={entry.secret.id}>
                  <td>
                    {dev ? (
                      <>
                        <div className="nm">{entry.secret.name}</div>
                        {entry.client_unsafe && <span className="tag unsafe">server only</span>}
                      </>
                    ) : (
                      <div className="nm">{secretKindLabel(entry.secret.kind)}</div>
                    )}
                  </td>
                  <td style={{ color: "var(--text-dim)", fontSize: 12.5 }}>
                    {dev ? secretKindLabel(entry.secret.kind) : providerLabel(entry.provider)}
                    {entry.service_project_name && (
                      <div style={{ color: "var(--text-faint)", fontSize: 11.5 }}>
                        via {entry.service_project_name}
                      </div>
                    )}
                  </td>
                  <td>
                    {plaintext !== undefined ? (
                      <span className="revealed">{plaintext}</span>
                    ) : (
                      <span className="pv">{dev ? entry.secret.preview : "••••••••"}</span>
                    )}
                  </td>
                  <td style={{ color: "var(--text-faint)", fontSize: 12 }}>
                    {formatTime(entry.secret.updated_at)}
                  </td>
                  <td>
                    <div className="row-acts">
                      <button type="button" onClick={() => copyOne(entry.secret.id, entry.secret.name)}>
                        Copy
                      </button>
                      <button type="button" onClick={() => toggleReveal(entry.secret.id)}>
                        {plaintext !== undefined ? "Hide" : "Reveal"}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => remove(entry.secret.id, entry.secret.name)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
