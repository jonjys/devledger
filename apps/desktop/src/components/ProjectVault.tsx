import { useEffect, useState } from "react";

import * as api from "../lib/api";
import {
  environmentName,
  formatTime,
  plural,
  providerLabel,
  secretHeadline,
  secretKindColumn,
} from "../lib/format";
import { useMode } from "../lib/mode";
import type {
  EnvConflict,
  Environment,
  ProjectSummary,
  ServiceProject,
  VaultEntry,
} from "../lib/types";
import FieldsEditor from "./FieldsEditor";

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
  const [conflicts, setConflicts] = useState<EnvConflict[]>([]);
  const [addingVariable, setAddingVariable] = useState(false);

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

  // Ask before the user presses Copy whether the chosen export would be refused,
  // so a clash is something they see and fix rather than an error they hit.
  // Decided from blind indexes in Rust: nothing is decrypted to answer it.
  useEffect(() => {
    let live = true;
    api
      .envConflicts(projectId, exportEnvironment === "all" ? null : exportEnvironment)
      .then((found) => {
        if (live) setConflicts(found);
      })
      .catch(() => {
        if (live) setConflicts([]);
      });
    return () => {
      live = false;
    };
  }, [projectId, exportEnvironment, entries]);

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
    // Deleting a secret destroys its sealed value; there is no undo.
    if (!window.confirm(`Delete ${name}? The stored value is destroyed and cannot be recovered.`)) {
      return;
    }
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
    // The old prompt said only "its resources are kept", which is true and
    // leaves out that secrets filed directly on the project are destroyed.
    // Ask Rust for the actual count and say it.
    let message = `Delete project "${summary.project.name}"?`;
    try {
      const impact = await api.projectDeletionImpact(projectId);
      message +=
        impact.secrets_deleted > 0
          ? ` ${plural(impact.secrets_deleted, "secret")} filed on this project will be destroyed and cannot be recovered.`
          : " No secrets are filed directly on it.";
      if (impact.resources_unlinked > 0) {
        message += ` ${plural(impact.resources_unlinked, "linked resource")} and their own secrets are kept.`;
      }
    } catch {
      message += " Secrets filed directly on it will be destroyed.";
    }
    if (!window.confirm(message)) {
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
              : [
                  ...new Set(
                    resources.map((r) =>
                      dev
                        ? `${providerLabel(r.provider)}${r.provider_ref ? ` ${r.provider_ref}` : ""}`
                        : providerLabel(r.provider),
                    ),
                  ),
                ].join(", ")}
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
          <button
            type="button"
            onClick={copyAll}
            disabled={entries.length === 0 || conflicts.length > 0}
            title={
              conflicts.length > 0
                ? "Some variables are defined more than once with different values"
                : undefined
            }
          >
            Copy .env
          </button>
          <button type="button" onClick={() => setAddingVariable((v) => !v)}>
            {addingVariable ? "Cancel" : "+ Variable"}
          </button>
          <button type="button" className="danger" onClick={removeProject}>
            Delete project
          </button>
        </div>
      </div>

      <div className="project-fields">
        <FieldsEditor
          entity={{ kind: "project", id: projectId }}
          secretOwner={{ project_id: projectId, service_project_id: null, account_id: null }}
          onNotify={onNotify}
          onSecretStored={() => void reload()}
        />
      </div>

      {conflicts.length > 0 && (
        <div className="warn" role="alert">
          <strong>Copy .env is blocked.</strong> A .env file keeps only one value per name, so
          exporting{" "}
          {exportEnvironment === "all" ? "every environment at once" : "this environment"} would
          silently drop one of these:
          <ul>
            {conflicts.map((c) => (
              <li key={c.name}>
                <span className="mono">{c.name}</span> —{" "}
                {c.definitions
                  .map(
                    (d) =>
                      `${environmentName(d.environment)}${d.source ? ` via ${d.source}` : ""}`,
                  )
                  .join(", ")}
              </li>
            ))}
          </ul>
          Choose a single environment above, or rename one of them.
        </div>
      )}

      {addingVariable && (
        <AddVariableForm
          projectId={projectId}
          defaultEnvironment={exportEnvironment === "all" ? "development" : exportEnvironment}
          onNotify={onNotify}
          onSaved={async () => {
            setAddingVariable(false);
            await reload();
            onChanged();
          }}
        />
      )}

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
              <th>Environment</th>
              <th>Value</th>
              {dev && <th>Updated</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
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
                    {entry.service_project_name && (
                      <div style={{ color: "var(--text-faint)", fontSize: 11.5 }}>
                        via {entry.service_project_name}
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 12.5 }}>
                    <span className={`env env-${entry.secret.environment}`}>
                      {environmentName(entry.secret.environment)}
                    </span>
                  </td>
                  <td>
                    {plaintext !== undefined ? (
                      <span className="revealed">{plaintext}</span>
                    ) : (
                      <span className="pv">{dev ? entry.secret.preview : "••••••••"}</span>
                    )}
                  </td>
                  {dev && (
                    <td style={{ color: "var(--text-faint)", fontSize: 12 }}>
                      {formatTime(entry.secret.updated_at)}
                    </td>
                  )}
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

/**
 * Add a variable to this project by hand.
 *
 * The value is sent to Rust once and sealed there; nothing comes back but the
 * row's metadata, and the typed value is cleared from state as soon as it is
 * stored.
 */
function AddVariableForm({
  projectId,
  defaultEnvironment,
  onNotify,
  onSaved,
}: {
  projectId: string;
  defaultEnvironment: Environment;
  onNotify: (message: string, bad?: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [environment, setEnvironment] = useState<Environment>(defaultEnvironment);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy || !name.trim() || !value) return;
    setBusy(true);
    try {
      await api.storeSecret(
        {
          owner: { project_id: projectId, service_project_id: null, account_id: null },
          kind: "env_var",
          name: name.trim(),
          environment,
          notes: null,
        },
        value,
      );
      setValue("");
      onNotify(`Stored ${name.trim()} for ${environmentName(environment)}`);
      await onSaved();
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="inline-form vault-add"
      aria-label="New variable"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input
        autoFocus
        aria-label="Variable name"
        placeholder="DATABASE_URL"
        className="mono"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        type="password"
        autoComplete="off"
        aria-label="Variable value"
        placeholder="value"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <select
        aria-label="Variable environment"
        value={environment}
        onChange={(e) => setEnvironment(e.target.value as Environment)}
      >
        <option value="development">Development</option>
        <option value="staging">Staging</option>
        <option value="production">Production</option>
        <option value="unknown">Unassigned</option>
      </select>
      <button type="submit" className="primary" disabled={busy || !name.trim() || !value}>
        Store encrypted
      </button>
    </form>
  );
}
