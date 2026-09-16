import { useCallback, useEffect, useState } from "react";

import * as api from "../lib/api";
import {
  byConnector,
  countToImport,
  groupReport,
  initialSelection,
  isSelectable,
  statusTone,
  summarise,
} from "../lib/connections";
import { formatTime, plural } from "../lib/format";
import type {
  ConnectionSummary,
  ConnectorDescriptor,
  ReconcileItem,
  ReconcileReport,
} from "../lib/types";
import { MATCH_STATUS_LABEL } from "../lib/types";

interface Props {
  onNotify: (message: string, bad?: boolean) => void;
  onChanged: () => void;
}

/**
 * Services / Connections.
 *
 * The second way information reaches DevLedger: instead of pasting, you connect
 * a provider account and DevLedger reads its structure. Everything here is
 * explicit — a request only happens because a button was pressed, and nothing
 * reaches the graph until the import is confirmed.
 */
export default function ConnectionsView({ onNotify, onChanged }: Props) {
  const [connectors, setConnectors] = useState<ConnectorDescriptor[]>([]);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [review, setReview] = useState<ReconcileReport | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [descriptors, existing] = await Promise.all([
        api.listConnectors(),
        api.listConnections(),
      ]);
      setConnectors(descriptors);
      setConnections(existing);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh(connectionId: string) {
    setBusy(true);
    try {
      const report = await api.connectorRefresh(connectionId);
      setReview(report);
      await load();
      onNotify(`Refreshed: ${summarise(report)}`);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(summary: ConnectionSummary) {
    try {
      await api.connectorDisconnect(summary.connection.id);
      await load();
      onChanged();
      onNotify(`Disconnected ${summary.connection.label}. Imported data kept.`);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  if (loading) return <div className="empty">Loading…</div>;

  const grouped = byConnector(connections);

  return (
    <div>
      <div className="vault-head">
        <div>
          <h1>Services &amp; connections</h1>
          <div className="sub">
            Connect an account and DevLedger reads its structure directly. Read-only,
            and nothing is saved until you review it.
          </div>
        </div>
      </div>

      {connectors.map((connector) => {
        const existing = grouped.get(connector.id) ?? [];
        return (
          <section key={connector.id} className="connector">
            <div className="connector-head">
              <span className="connector-name">{connector.display_name}</span>
              {connector.read_only && <span className="tag explicit">read-only</span>}
              <span className="spacer" />
              <button type="button" onClick={() => setConnecting(connector.id)}>
                {existing.length === 0 ? "Connect" : "+ Connect another account"}
              </button>
            </div>
            <p className="connector-summary">{connector.summary}</p>

            {existing.length === 0 ? (
              <p className="connector-empty">No accounts connected yet.</p>
            ) : (
              existing.map((summary) => (
                <div key={summary.connection.id} className="connection">
                  <div className="map-head">
                    <span className="map-kind">Account</span>
                    <span className="map-name">{summary.connection.label}</span>
                    {summary.identity_email &&
                      summary.identity_email !== summary.connection.label && (
                        <span className="map-meta">{summary.identity_email}</span>
                      )}
                  </div>
                  <div className="connection-meta">
                    {plural(summary.organization_count, "organization")} ·{" "}
                    {plural(summary.resource_count, "project")} · Last checked:{" "}
                    {summary.connection.last_checked_at
                      ? formatTime(summary.connection.last_checked_at)
                      : "never"}
                  </div>
                  <div className="connection-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => refresh(summary.connection.id)}
                    >
                      {busy ? "Checking…" : "Refresh"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        try {
                          setReview(await api.connectorReport(summary.connection.id));
                        } catch (e: unknown) {
                          onNotify(e instanceof Error ? e.message : String(e), true);
                        }
                      }}
                    >
                      Review import
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() => disconnect(summary)}
                    >
                      Disconnect
                    </button>
                  </div>
                </div>
              ))
            )}
          </section>
        );
      })}

      {connecting && (
        <ConnectDialog
          connector={connectors.find((c) => c.id === connecting)!}
          onCancel={() => setConnecting(null)}
          onNotify={onNotify}
          onConnected={async (report) => {
            setConnecting(null);
            setReview(report);
            await load();
          }}
        />
      )}

      {review && (
        <ImportReview
          report={review}
          onCancel={() => setReview(null)}
          onNotify={onNotify}
          onImported={async () => {
            setReview(null);
            await load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

interface ConnectProps {
  connector: ConnectorDescriptor;
  onCancel: () => void;
  onConnected: (report: ReconcileReport) => void;
  onNotify: (message: string, bad?: boolean) => void;
}

/**
 * The connect dialog.
 *
 * Deliberately not a password box. DevLedger sends you to the provider's own
 * dashboard to mint a scoped, revocable token, and never sits in the
 * authentication path.
 */
function ConnectDialog({ connector, onCancel, onConnected, onNotify }: ConnectProps) {
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createUrl =
    connector.auth.sort === "personal_access_token" ? connector.auth.create_url : null;
  const guidance =
    connector.auth.sort === "personal_access_token" ? connector.auth.guidance : "";

  async function submit() {
    if (!token.trim() || !label.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await api.connectorConnect(connector.id, token.trim(), label.trim());
      // Drop the token from component state the moment it has been used.
      setToken("");
      onNotify(
        outcome.reconnected
          ? `Reconnected ${outcome.connection.label}`
          : `Connected ${outcome.connection.label}: ${summarise(outcome.report)}`,
      );
      onConnected(outcome.report);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Connect">
      <div className="sheet" style={{ maxWidth: 560 }}>
        <header>
          <h2>Connect {connector.display_name}</h2>
          <p>DevLedger will read your organizations and projects. It cannot change them.</p>
        </header>

        <div className="scroll">
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}

          <ol className="connect-steps">
            <li>
              Open{" "}
              {createUrl ? (
                <code>{createUrl}</code>
              ) : (
                <span>your provider&apos;s token settings</span>
              )}{" "}
              in your browser and create an access token.
            </li>
            <li>{guidance}</li>
            <li>Paste it below. DevLedger checks it, then stores it encrypted.</li>
          </ol>

          <div className="field">
            <label htmlFor="connect-label">Label this account</label>
            <input
              id="connect-label"
              autoFocus
              placeholder="e.g. the email this account uses"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <p className="q-note">
              {connector.display_name} does not tell DevLedger which account a token
              belongs to, so name it yourself. Using the email keeps your accounts
              distinguishable.
            </p>
          </div>

          <div className="field">
            <label htmlFor="connect-token">Access token</label>
            <input
              id="connect-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={
                connector.auth.sort === "personal_access_token"
                  ? `${connector.auth.expected_prefix}…`
                  : ""
              }
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
          </div>

          <div className="note">
            Never paste your {connector.display_name} password here. DevLedger only
            accepts a token you created yourself, and you can revoke it at any time from
            the same page. Requests go only to{" "}
            <code>{connector.allowed_hosts.join(", ")}</code>.
          </div>
        </div>

        <footer>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={submit}
            disabled={busy || !token.trim() || !label.trim()}
          >
            {busy ? "Checking…" : "Connect"}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface ReviewProps {
  report: ReconcileReport;
  onCancel: () => void;
  onImported: () => void;
  onNotify: (message: string, bad?: boolean) => void;
}

/** What importing would do, before it does it. */
function ImportReview({ report, onCancel, onImported, onNotify }: ReviewProps) {
  const [selected, setSelected] = useState<Set<string>>(() => initialSelection(report));
  const [busy, setBusy] = useState(false);

  function toggle(providerId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(providerId)) next.delete(providerId);
      else next.add(providerId);
      return next;
    });
  }

  async function apply() {
    setBusy(true);
    try {
      const outcome = await api.connectorImport(report.connection_id, [...selected]);
      const parts: string[] = [];
      if (outcome.resources_created > 0) parts.push(`${outcome.resources_created} added`);
      if (outcome.resources_updated > 0) parts.push(`${outcome.resources_updated} updated`);
      if (outcome.organizations_created + outcome.organizations_updated > 0) {
        parts.push(
          `${outcome.organizations_created + outcome.organizations_updated} organizations`,
        );
      }
      if (outcome.conflicts_refused > 0) {
        parts.push(`${outcome.conflicts_refused} refused as conflicts`);
      }
      onNotify(parts.length > 0 ? `Imported: ${parts.join(", ")}` : "Nothing to import");
      onImported();
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  const groups = groupReport(report);
  const toImport = countToImport(report, selected);

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Review import">
      <div className="sheet">
        <header>
          <h2>Review import</h2>
          <p>{summarise(report)} · nothing is saved until you confirm.</p>
        </header>

        <div className="scroll">
          {report.conflicts > 0 && (
            <div className="finding critical">
              <div className="t">
                {plural(report.conflicts, "conflict")} cannot be imported
              </div>
              <div className="d">
                These already belong to a different connected account. DevLedger will not
                move them between accounts — resolve it at the provider, or disconnect the
                other account first.
              </div>
            </div>
          )}

          {groups.length === 0 && <div className="empty">Nothing was discovered.</div>}

          {groups.map((group, i) => (
            <section key={group.organization?.provider_id ?? `orphans-${i}`} className="section">
              <h3>
                {group.organization
                  ? group.organization.name
                  : "Projects with no visible organization"}
              </h3>

              {group.organization && (
                <ImportRow
                  item={group.organization}
                  checked={selected.has(group.organization.provider_id)}
                  onToggle={() => toggle(group.organization!.provider_id)}
                />
              )}

              {group.projects.map((project) => (
                <ImportRow
                  key={project.provider_id}
                  item={project}
                  indented
                  checked={selected.has(project.provider_id)}
                  onToggle={() => toggle(project.provider_id)}
                />
              ))}
            </section>
          ))}
        </div>

        <footer>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={apply}
            disabled={busy || toImport === 0}
          >
            {busy ? "Importing…" : toImport === 0 ? "Nothing selected" : `Import ${toImport}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface RowProps {
  item: ReconcileItem;
  checked: boolean;
  indented?: boolean;
  onToggle: () => void;
}

function ImportRow({ item, checked, indented, onToggle }: RowProps) {
  const selectable = isSelectable(item);
  return (
    <label className={`import-row${indented ? " indented" : ""}${selectable ? "" : " fixed"}`}>
      <input
        type="checkbox"
        checked={checked && selectable}
        disabled={!selectable}
        onChange={onToggle}
      />
      <span className="txt">
        <span className="r">
          <span className="nm">{item.name}</span>
          <span className={`tag ${statusTone(item.status)}`}>
            {MATCH_STATUS_LABEL[item.status]}
          </span>
          {!item.active_at_provider && (
            <span className="tag heuristic" title={item.status_at_provider ?? undefined}>
              paused
            </span>
          )}
          {item.region && <span className="map-meta">{item.region}</span>}
          <code className="ref">{item.provider_id}</code>
        </span>
        <span className="e">{item.detail}</span>
      </span>
    </label>
  );
}
