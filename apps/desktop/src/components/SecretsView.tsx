import { useCallback, useEffect, useState } from "react";

import * as api from "../lib/api";
import { formatTime, plural, providerLabel, secretKindLabel } from "../lib/format";
import { useMode } from "../lib/mode";
import type { VaultEntry } from "../lib/types";

interface Props {
  onNotify: (message: string, bad?: boolean) => void;
  refreshKey: number;
}

interface Row {
  entry: VaultEntry;
  projectName: string;
}

/** Every secret across every project, in one flat vault table. */
export default function SecretsView({ onNotify, refreshKey }: Props) {
  const { dev } = useMode();
  const [rows, setRows] = useState<Row[]>([]);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setRevealed({});
    try {
      const projects = await api.listProjects();
      const seen = new Set<string>();
      const collected: Row[] = [];
      for (const p of projects) {
        const entries = await api.listSecrets(p.project.id);
        for (const entry of entries) {
          if (seen.has(entry.secret.id)) continue;
          seen.add(entry.secret.id);
          collected.push({ entry, projectName: p.project.name });
        }
      }
      collected.sort((a, b) => a.entry.secret.name.localeCompare(b.entry.secret.name));
      setRows(collected);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function toggleReveal(id: string) {
    if (revealed[id] !== undefined) {
      setRevealed(({ [id]: _drop, ...rest }) => rest);
      return;
    }
    try {
      const value = await api.revealSecret(id);
      setRevealed((prev) => ({ ...prev, [id]: value }));
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function copyOne(id: string, name: string) {
    try {
      await api.copySecret(id);
      onNotify(`Copied ${name}`);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function remove(id: string, name: string) {
    try {
      await api.deleteSecret(id);
      await load();
      onNotify(`Deleted ${name}`);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  return (
    <div className="dash">
      <div className="dash-head">
        <h1>Secrets</h1>
        <div className="dash-date">{plural(rows.length, "secret")} across your vault</div>
      </div>

      {loading ? (
        <div className="empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty">No secrets stored yet.</div>
      ) : (
        <section className="card">
          <table className="secrets">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Project</th>
                <th>Value</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ entry, projectName }) => {
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
                    </td>
                    <td style={{ color: "var(--text-dim)", fontSize: 12.5 }}>{projectName}</td>
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
        </section>
      )}
    </div>
  );
}
