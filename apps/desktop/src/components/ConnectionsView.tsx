import { useCallback, useEffect, useMemo, useState } from "react";

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
import { useMode } from "../lib/mode";
import { catalogProviders, providerInfo, type ProviderInfo } from "../lib/providers";
import type {
  ConnectionSummary,
  ConnectorDescriptor,
  IdentityNode,
  Provider,
  ReconcileItem,
  ReconcileReport,
} from "../lib/types";
import { MATCH_STATUS_LABEL } from "../lib/types";

import Modal from "./Modal";
import ProviderIcon from "./ProviderIcon";

interface Props {
  onNotify: (message: string, bad?: boolean) => void;
  onChanged: () => void;
  /** Add a service that is not in the catalog. */
  onAddOther?: () => void;
}

/** What the unified Add / Connect modal is currently opened for. */
type ModalTarget =
  | { kind: "connector"; connector: ConnectorDescriptor }
  | { kind: "catalog"; entry: ProviderInfo };

/** One card in the grid: a service, and its reader if DevLedger has one. */
interface Card {
  info: ProviderInfo;
  connector: ConnectorDescriptor | null;
}

/**
 * Services / Connections.
 *
 * Every service is a card, and every card can be added by hand. Supabase is a
 * card like the rest; it just also has a reader behind its button, which asks
 * for a token and reads the account's structure. A request only happens
 * because that button was pressed, and nothing reaches the graph until the
 * review is confirmed.
 */
export default function ConnectionsView({ onNotify, onChanged, onAddOther }: Props) {
  const { dev } = useMode();
  const [connectors, setConnectors] = useState<ConnectorDescriptor[]>([]);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [graph, setGraph] = useState<IdentityNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalTarget | null>(null);
  const [review, setReview] = useState<ReconcileReport | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [descriptors, existing, g] = await Promise.all([
        api.listConnectors(),
        api.listConnections(),
        api.identityGraph(),
      ]);
      setConnectors(descriptors);
      setConnections(existing);
      setGraph(g ?? []);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void load();
  }, [load]);

  // How many accounts already exist per provider, so a card can say so.
  const accountsByProvider = useMemo(() => {
    const counts = new Map<Provider, number>();
    for (const identity of graph) {
      for (const account of identity.accounts) {
        counts.set(account.account.provider, (counts.get(account.account.provider) ?? 0) + 1);
      }
    }
    return counts;
  }, [graph]);

  // The catalog, with each connector attached to its service's card. A
  // connector for a service the catalog does not list still gets a card.
  const cards = useMemo<Card[]>(() => {
    const list: Card[] = catalogProviders().map((info) => ({
      info,
      connector: connectors.find((c) => c.provider === info.provider) ?? null,
    }));
    for (const connector of connectors) {
      if (!list.some((card) => card.connector?.id === connector.id)) {
        list.unshift({
          info: providerInfo(connector.provider) ?? {
            provider: connector.provider,
            name: connector.display_name,
            summary: connector.summary,
            keyPlaceholder: "",
            icon: null,
          },
          connector,
        });
      }
    }
    return list;
  }, [connectors]);

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
            Add any service by hand — nothing here needs a token. Where a card says{" "}
            <strong>Connect</strong>, DevLedger can also read the account&apos;s structure for you;
            it only ever reads, and nothing is saved until you review it.
          </div>
        </div>
      </div>

      <section className="section catalog">
        <h3>Add a service</h3>
        <div className="catalog-grid">
          {cards.map(({ info, connector }) => {
            const count = accountsByProvider.get(info.provider) ?? 0;
            const linked = connector ? (grouped.get(connector.id) ?? []) : [];
            return (
              <div key={info.provider} className="catalog-card">
                <div className="catalog-head">
                  <ProviderIcon provider={info.provider} size={18} />
                  <span className="catalog-name">{info.name}</span>
                  {dev && <code className="ref">{info.provider}</code>}
                  {connector?.read_only && (
                    // This describes what DevLedger does, not what the token can
                    // do. DevLedger cannot inspect a token's permissions, so it
                    // must not imply the token itself is limited.
                    <span
                      className="tag explicit"
                      title="DevLedger only sends read requests. It cannot see what your token is allowed to do — limit that when you create the token."
                    >
                      DevLedger only reads
                    </span>
                  )}
                </div>
                <p className="catalog-summary">{connector?.summary ?? info.summary}</p>
                <div className="catalog-foot">
                  <span className="catalog-count">
                    {count === 0 && linked.length === 0
                      ? connector
                        ? "No accounts connected yet."
                        : "Not added yet."
                      : [
                          count > 0 ? plural(count, "account") : null,
                          connector && linked.length > 0
                            ? `${linked.length} connected`
                            : connector
                              ? "none connected"
                              : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                  </span>
                  <span className="spacer" />
                  {connector ? (
                    <button type="button" onClick={() => setModal({ kind: "connector", connector })}>
                      {linked.length === 0 ? "Connect" : "+ Connect another account"}
                    </button>
                  ) : (
                    <button type="button" onClick={() => setModal({ kind: "catalog", entry: info })}>
                      + Add
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          <div className="catalog-card other">
            <div className="catalog-head">
              <span className="catalog-name">Something else</span>
            </div>
            <p className="catalog-summary">
              Any service not listed: a registrar, a hosting panel, your bank, a forum.
            </p>
            <div className="catalog-foot">
              <span className="spacer" />
              <button type="button" onClick={() => onAddOther?.()} disabled={!onAddOther}>
                + Add
              </button>
            </div>
          </div>
        </div>
      </section>

      {connections.length > 0 && (
        <section className="section">
          <h3>Connected accounts</h3>
          {connections.map((summary) => {
            const connector = connectors.find((c) => c.id === summary.connection.connector_id);
            return (
              <div key={summary.connection.id} className="connection">
                <div className="map-head">
                  {connector && <ProviderIcon provider={connector.provider} size={16} />}
                  <span className="map-kind">{connector?.display_name ?? "Account"}</span>
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
            );
          })}
        </section>
      )}

      {modal && (
        <ServiceModal
          target={modal}
          onCancel={() => setModal(null)}
          onNotify={onNotify}
          onConnected={async (report) => {
            setModal(null);
            setReview(report);
            await load();
          }}
          onSavedManually={async () => {
            setModal(null);
            await load();
            onChanged();
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

interface ServiceModalProps {
  target: ModalTarget;
  onCancel: () => void;
  onConnected: (report: ReconcileReport) => void;
  onSavedManually: () => void;
  onNotify: (message: string, bad?: boolean) => void;
}

type TabKey = "api" | "manual";

/**
 * The unified Add / Connect modal.
 *
 * Two tabs, always: **API Connection** verifies a token against a live
 * connector when one exists (Supabase), and **Manual Connection** records an
 * account by hand from an email and a note — no real secret required. Services
 * without a connector still offer both, but the API tab saves rather than
 * fetches, because there is nothing to fetch from yet.
 */
function ServiceModal({
  target,
  onCancel,
  onConnected,
  onSavedManually,
  onNotify,
}: ServiceModalProps) {
  const connector = target.kind === "connector" ? target.connector : null;
  const provider: Provider =
    target.kind === "connector" ? target.connector.provider : target.entry.provider;
  const displayName =
    target.kind === "connector" ? target.connector.display_name : target.entry.name;
  // Kept exactly "Connect" for the live connector so existing flows and tests
  // that open it by name keep working.
  const dialogLabel = target.kind === "connector" ? "Connect" : `Add ${displayName}`;

  const [tab, setTab] = useState<TabKey>("api");

  // API tab state.
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  // Manual tab state.
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createUrl =
    connector?.auth.sort === "personal_access_token" ? connector.auth.create_url : null;
  const guidance =
    connector?.auth.sort === "personal_access_token" ? connector.auth.guidance : "";
  const expectedPrefix =
    connector?.auth.sort === "personal_access_token" ? connector.auth.expected_prefix : "";
  const keyPlaceholder =
    target.kind === "catalog" ? target.entry.keyPlaceholder : `${expectedPrefix}…`;

  async function submitApi() {
    if (!label.trim() || !token.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (connector) {
        const outcome = await api.connectorConnect(connector.id, token.trim(), label.trim());
        setToken("");
        onNotify(
          outcome.reconnected
            ? `Reconnected ${outcome.connection.label}`
            : `Connected ${outcome.connection.label}: ${summarise(outcome.report)}`,
        );
        onConnected(outcome.report);
      } else {
        // No live connector for this service. The form requires a key, so it
        // must not be thrown away: it used to be, while the toast said the
        // account was added, which left people believing their key was stored.
        // It is sealed onto the new account like any hand-entered credential.
        // DevLedger cannot check it against the provider, and says so.
        const account = await api.createAccountForEmail(null, provider, label.trim(), null);
        await api.storeSecret(
          {
            owner: { project_id: null, service_project_id: null, account_id: account.id },
            kind: "generic_api_key",
            name: `${displayName} API key`,
            environment: "unknown",
            notes: null,
          },
          token.trim(),
        );
        setToken("");
        onNotify(
          `Added ${displayName} account ${label.trim()} · key stored encrypted, not verified`,
        );
        onSavedManually();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitManual() {
    const finalLabel = email.trim() || displayName;
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.createAccountForEmail(
        email.trim() || null,
        provider,
        finalLabel,
        note.trim() || null,
      );
      onNotify(`Saved ${displayName} account`);
      onSavedManually();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal label={dialogLabel} onClose={onCancel} maxWidth={560}>
      <header>
        <h2>
          {connector ? "Connect" : "Add"} {displayName}
        </h2>
        <p>
          {connector
            ? "DevLedger will read your organizations and projects. It cannot change them."
            : "Record this service in your ledger. Nothing here leaves your machine."}
        </p>
      </header>

      <div className="modal-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "api"}
          className={tab === "api" ? "active" : ""}
          onClick={() => setTab("api")}
        >
          API Connection
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "manual"}
          className={tab === "manual" ? "active" : ""}
          onClick={() => setTab("manual")}
        >
          Manual Connection
        </button>
      </div>

      <div className="scroll">
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}

        {tab === "api" ? (
          <>
            {connector ? (
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
            ) : (
              <div className="note">
                DevLedger cannot read {displayName} for you, so it cannot check this key.
                It is stored encrypted on the new account, exactly as you enter it.
              </div>
            )}

            <div className="field">
              <label htmlFor="svc-label">Label this account</label>
              <input
                id="svc-label"
                autoFocus
                placeholder="e.g. the email this account uses"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="svc-token">{connector ? "Access token" : "API key / token"}</label>
              <input
                id="svc-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={keyPlaceholder}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitApi();
                }}
              />
            </div>

            {connector && (
              <div className="note">
                Never paste your {displayName} password here. DevLedger only accepts a token
                you created yourself, and you can revoke it at any time from the same page.
                Requests go only to <code>{connector.allowed_hosts.join(", ")}</code>.
              </div>
            )}
          </>
        ) : (
          <>
            <div className="note">
              Save any service without an API secret. Enter the account email and, if you
              like, a note or link — a dashboard URL, a webhook, anything worth remembering.
            </div>

            <div className="field">
              <label htmlFor="svc-email">Account email</label>
              <input
                id="svc-email"
                autoFocus
                placeholder="test@gmail.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="svc-note">Custom note / link</label>
              <input
                id="svc-note"
                placeholder="github.com/test or a webhook URL"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </>
        )}
      </div>

      <footer>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {tab === "api" ? (
          <button
            type="button"
            className="primary"
            onClick={submitApi}
            disabled={busy || !token.trim() || !label.trim()}
          >
            {busy ? "Checking…" : connector ? "Connect" : "Save"}
          </button>
        ) : (
          <button type="button" className="primary" onClick={submitManual} disabled={busy}>
            {busy ? "Saving…" : "Save account"}
          </button>
        )}
      </footer>
    </Modal>
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
    <Modal label="Review import" onClose={onCancel}>
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
    </Modal>
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
