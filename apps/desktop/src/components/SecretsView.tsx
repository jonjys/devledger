import { useCallback, useEffect, useState } from "react";

import * as api from "../lib/api";
import {
  environmentName,
  formatTime,
  plural,
  secretHeadline,
  secretKindColumn,
} from "../lib/format";
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

/** Every secret in the vault -- on projects, resources and accounts -- in one table. */
export default function SecretsView({ onNotify, refreshKey }: Props) {
  const { dev } = useMode();
  const [rows, setRows] = useState<Row[]>([]);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setRevealed({});
    try {
      // One call for the whole vault. Walking projects missed a password on an
      // account and a key on a resource no project uses.
      const listed = await api.listAllSecrets();
      setRows(listed.map((l) => ({ entry: l.entry, projectName: l.owner })));
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
    if (!window.confirm(`Delete ${name}? The stored value is destroyed and cannot be recovered.`)) {
      return;
    }
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
                <th>Environment</th>
                <th>Belongs to</th>
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
                      {(() => {
                        const head = secretHeadline(entry.secret.kind, entry.secret.name, dev);
                        return (
                          <>
                            <div className="nm">{head.title}</div>
                            {head.sub && (
                              <div className="mono muted" style={{ fontSize: 11.5 }}>
                                {head.sub}
                              </div>
                            )}
                            {dev && entry.client_unsafe && (
                              <span className="tag unsafe">server only</span>
                            )}
                          </>
                        );
                      })()}
                    </td>
                    <td style={{ color: "var(--text-dim)", fontSize: 12.5 }}>
                      {secretKindColumn(entry.secret.kind, entry.provider, dev)}
                    </td>
                    <td style={{ fontSize: 12.5 }}>
                      {entry.secret.environment !== "unknown" && (
                        <span className={`env env-${entry.secret.environment}`}>
                          {environmentName(entry.secret.environment)}
                        </span>
                      )}
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
