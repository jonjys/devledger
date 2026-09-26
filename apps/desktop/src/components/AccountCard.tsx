import { useEffect, useState } from "react";

import * as api from "../lib/api";
import {
  environmentName,
  isCustomProvider,
  plural,
  providerLabel,
  secretKindLabel,
} from "../lib/format";
import type {
  AccountNode,
  Environment,
  IdentityEmail,
  SecretKind,
  ServiceProjectSummary,
  VaultEntry,
} from "../lib/types";

interface Props {
  node: AccountNode;
  emails: IdentityEmail[];
  onNotify: (message: string, bad?: boolean) => void;
  onChanged: () => Promise<void>;
}

/**
 * One account: which service, how to sign in, what lives under it, and the
 * credentials that belong to the account itself.
 *
 * Secret handling matches the Project Vault exactly. The list shows masked
 * previews; Copy goes Rust-to-clipboard without the value entering JavaScript;
 * Reveal is per row, explicit, and forgotten when the card is collapsed.
 */
export default function AccountCard({ node, emails, onNotify, onChanged }: Props) {
  const { account } = node;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [secrets, setSecrets] = useState<VaultEntry[] | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [addingSecret, setAddingSecret] = useState(false);

  const resources: ServiceProjectSummary[] = [
    ...node.organizations.flatMap((o) => o.service_projects),
    ...node.unassigned,
  ];

  useEffect(() => {
    if (!open) {
      // Plaintext never outlives the view that asked for it.
      setRevealed({});
      return;
    }
    let live = true;
    api
      .accountSecrets(account.id)
      .then((rows) => {
        if (live) setSecrets(rows);
      })
      .catch((e: unknown) => onNotify(e instanceof Error ? e.message : String(e), true));
    return () => {
      live = false;
    };
  }, [open, account.id, onNotify]);

  async function reloadSecrets() {
    setSecrets(await api.accountSecrets(account.id));
  }

  async function run(action: () => Promise<unknown>, done: string) {
    try {
      await action();
      onNotify(done);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function toggleReveal(secretId: string) {
    if (revealed[secretId] !== undefined) {
      setRevealed(({ [secretId]: _gone, ...rest }) => rest);
      return;
    }
    try {
      const value = await api.revealSecret(secretId);
      setRevealed((prev) => ({ ...prev, [secretId]: value }));
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  const signIn = [account.login_email, account.username && `user ${account.username}`]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="ledger-account" aria-label={`Account ${account.label}`}>
      <div className="map-head">
        <button
          type="button"
          className="tree-toggle"
          aria-expanded={open}
          aria-label={open ? `Collapse ${account.label}` : `Expand ${account.label}`}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "▾" : "▸"}
        </button>
        <span className="map-kind">{providerLabel(account.provider)}</span>
        {isCustomProvider(account.provider) && <span className="tag">custom service</span>}
        <span className="map-name">{account.label}</span>
        {signIn && <span className="map-meta mono">{signIn}</span>}
        <span className="spacer" />
        <span className="map-meta">
          {plural(resources.length, "resource")}
          {node.subscriptions.length > 0 && ` · ${plural(node.subscriptions.length, "subscription")}`}
        </span>
      </div>

      {open && (
        <div className="tree-children">
          {editing ? (
            <EditAccountForm
              node={node}
              emails={emails}
              onCancel={() => setEditing(false)}
              onSaved={async () => {
                setEditing(false);
                await onChanged();
              }}
              onNotify={onNotify}
            />
          ) : (
            <div className="ledger-details">
              {account.url && (
                <div>
                  <span className="muted">Sign in at </span>
                  <span className="mono">{account.url}</span>
                </div>
              )}
              {account.notes && <div className="muted">{account.notes}</div>}
              <div className="row-acts">
                <button type="button" className="ghost tiny" onClick={() => setEditing(true)}>
                  Edit details
                </button>
                <button
                  type="button"
                  className="ghost tiny danger"
                  onClick={() => {
                    const extra =
                      resources.length > 0
                        ? ` and ${plural(resources.length, "resource")} with their secrets`
                        : "";
                    if (window.confirm(`Delete ${account.label}${extra}? This cannot be undone.`)) {
                      void run(() => api.deleteAccount(account.id), `Deleted ${account.label}`).then(
                        onChanged,
                      );
                    }
                  }}
                >
                  Delete account
                </button>
              </div>
            </div>
          )}

          <div className="ledger-label">Resources</div>
          {resources.length === 0 ? (
            <div className="muted">Nothing recorded under this account yet.</div>
          ) : (
            <ul className="ledger-resources">
              {resources.map((r) => (
                <li key={r.service_project.id}>
                  <span className="nm">{r.service_project.name}</span>
                  <span className="muted">
                    {" "}
                    {r.organization_name ? `in ${r.organization_name}` : "no organization"}
                    {r.service_project.environment !== "unknown" &&
                      ` · ${environmentName(r.service_project.environment)}`}
                  </span>
                  <span className="muted">
                    {" → "}
                    {r.used_by.length === 0
                      ? "no project"
                      : r.used_by.map((p) => p.name).join(", ")}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="ledger-label">Credentials on this account</div>
          {secrets === null ? (
            <div className="muted">Loading…</div>
          ) : secrets.length === 0 ? (
            <div className="muted">No password or key stored for this account.</div>
          ) : (
            <table className="secrets compact">
              <tbody>
                {secrets.map((entry) => {
                  const plaintext = revealed[entry.secret.id];
                  return (
                    <tr key={entry.secret.id}>
                      <td>
                        <div className="nm">{entry.secret.name}</div>
                        <div className="muted">{secretKindLabel(entry.secret.kind)}</div>
                      </td>
                      <td>
                        {plaintext !== undefined ? (
                          <span className="revealed">{plaintext}</span>
                        ) : (
                          <span className="pv">{entry.secret.preview}</span>
                        )}
                      </td>
                      <td>
                        <div className="row-acts">
                          <button
                            type="button"
                            onClick={() =>
                              void run(
                                () => api.copySecret(entry.secret.id),
                                `Copied ${entry.secret.name}`,
                              )
                            }
                          >
                            Copy
                          </button>
                          <button type="button" onClick={() => void toggleReveal(entry.secret.id)}>
                            {plaintext !== undefined ? "Hide" : "Reveal"}
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => {
                              if (window.confirm(`Delete ${entry.secret.name}?`)) {
                                void run(
                                  () => api.deleteSecret(entry.secret.id),
                                  `Deleted ${entry.secret.name}`,
                                )
                                  .then(reloadSecrets)
                                  .then(onChanged);
                              }
                            }}
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
          {addingSecret ? (
            <AddCredentialForm
              accountId={account.id}
              onNotify={onNotify}
              onCancel={() => setAddingSecret(false)}
              onSaved={async () => {
                setAddingSecret(false);
                await reloadSecrets();
                await onChanged();
              }}
            />
          ) : (
            <button type="button" className="ghost tiny" onClick={() => setAddingSecret(true)}>
              + Password or key
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function EditAccountForm({
  node,
  emails,
  onCancel,
  onSaved,
  onNotify,
}: {
  node: AccountNode;
  emails: IdentityEmail[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onNotify: Props["onNotify"];
}) {
  const { account } = node;
  const [label, setLabel] = useState(account.label);
  const [loginEmail, setLoginEmail] = useState(account.login_email ?? "");
  const [username, setUsername] = useState(account.username ?? "");
  const [url, setUrl] = useState(account.url ?? "");
  const [notes, setNotes] = useState(account.notes ?? "");

  async function save() {
    try {
      await api.updateAccount(account.id, label, {
        login_email: loginEmail.trim() || null,
        username: username.trim() || null,
        url: url.trim() || null,
        notes: notes.trim() || null,
      });
      onNotify(`Saved ${label}`);
      await onSaved();
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  return (
    <form
      className="form-stack ledger-form"
      aria-label="Edit account"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        Label
        <input value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label>
        Signs in with
        <input
          type="email"
          list={`addr-${account.id}`}
          value={loginEmail}
          onChange={(e) => setLoginEmail(e.target.value)}
        />
        <datalist id={`addr-${account.id}`}>
          {emails.map((e) => (
            <option key={e.id} value={e.address} />
          ))}
        </datalist>
      </label>
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label>
        Sign-in URL
        <input value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label>
        Notes
        <input
          placeholder="Not for passwords — use + Password or key"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <div className="row-acts">
        <button type="submit" className="primary" disabled={!label.trim()}>
          Save
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const CREDENTIAL_KINDS: { value: SecretKind; label: string }[] = [
  { value: "password", label: "Password" },
  { value: "generic_api_key", label: "API key or token" },
  { value: "env_var", label: "Other value" },
];

const ENVIRONMENTS: Environment[] = ["unknown", "development", "staging", "production"];

function AddCredentialForm({
  accountId,
  onNotify,
  onCancel,
  onSaved,
}: {
  accountId: string;
  onNotify: Props["onNotify"];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [kind, setKind] = useState<SecretKind>("password");
  const [name, setName] = useState("Password");
  const [value, setValue] = useState("");
  const [environment, setEnvironment] = useState<Environment>("unknown");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (busy || !name.trim() || !value) return;
    setBusy(true);
    try {
      await api.storeSecret(
        {
          owner: { project_id: null, service_project_id: null, account_id: accountId },
          kind,
          name: name.trim(),
          environment,
          notes: null,
        },
        value,
      );
      // Drop the typed value from component state the moment it is stored.
      setValue("");
      onNotify(`Stored ${name.trim()}`);
      await onSaved();
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="form-stack ledger-form"
      aria-label="New credential"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        Kind
        <select
          value={kind}
          onChange={(e) => {
            const next = e.target.value as SecretKind;
            setKind(next);
            if (name === "Password" && next !== "password") setName("");
          }}
        >
          {CREDENTIAL_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Value
        <input
          type="password"
          autoComplete="off"
          aria-label="Secret value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <label>
        Environment
        <select value={environment} onChange={(e) => setEnvironment(e.target.value as Environment)}>
          {ENVIRONMENTS.map((env) => (
            <option key={env} value={env}>
              {env === "unknown" ? "Not specific" : environmentName(env)}
            </option>
          ))}
        </select>
      </label>
      <div className="row-acts">
        <button type="submit" className="primary" disabled={busy || !name.trim() || !value}>
          Store encrypted
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
