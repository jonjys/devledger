import { useEffect, useState } from "react";

import * as api from "../lib/api";
import { environmentLabel, formatTime, plural, secretKindLabel } from "../lib/format";
import type { ProjectSummary, VaultEntry } from "../lib/types";

interface Props {
  summary: ProjectSummary;
  onNotify: (message: string, bad?: boolean) => void;
}

/**
 * The Project Vault.
 *
 * The table renders only masked previews. "Copy" never brings the value into
 * this component -- Rust writes it straight to the clipboard. "Reveal" is the
 * one path that pulls plaintext into the frontend, and it is per-row, explicit,
 * and cleared when the row is collapsed again.
 */
export default function ProjectVault({ summary, onNotify }: Props) {
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const projectId = summary.project.id;

  useEffect(() => {
    let live = true;
    setLoading(true);
    // Revealed plaintext must not survive a switch to another project.
    setRevealed({});
    api
      .listSecrets(projectId)
      .then((rows) => {
        if (live) setEntries(rows);
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
      onNotify(`Copied ${name}`);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function copyAll() {
    try {
      const count = await api.copyEnv(projectId);
      onNotify(`Copied ${plural(count, "variable")} as .env`);
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

  const environment = environmentLabel(summary.project.environment);

  return (
    <div>
      <div className="vault-head">
        <div>
          <h1>{summary.project.name}</h1>
          <div className="sub">
            {summary.organization_name}
            {summary.project.provider_project_ref
              ? ` · ${summary.project.provider_project_ref}`
              : ""}
            {environment ? ` · ${environment}` : ""} · {plural(entries.length, "secret")}
          </div>
        </div>
        <span className="spacer" />
        <div className="acts">
          <button type="button" onClick={copyAll} disabled={entries.length === 0}>
            Copy .env
          </button>
        </div>
      </div>

      {loading ? (
        <div className="empty">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="empty">
          No secrets in this project yet. Paste a <code>.env</code> block above to fill it.
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
                    <div className="nm">{entry.secret.name}</div>
                    {entry.client_unsafe && <span className="tag unsafe">server only</span>}
                  </td>
                  <td style={{ color: "var(--text-dim)", fontSize: 12.5 }}>
                    {secretKindLabel(entry.secret.kind)}
                  </td>
                  <td>
                    {plaintext !== undefined ? (
                      <span className="revealed">{plaintext}</span>
                    ) : (
                      <span className="pv">{entry.secret.preview}</span>
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
