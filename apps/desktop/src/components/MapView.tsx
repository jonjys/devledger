import { useCallback, useEffect, useMemo, useState } from "react";

import * as api from "../lib/api";
import { plural } from "../lib/format";
import type {
  AttentionItem,
  IdentityNode,
  Organization,
  ProjectSummary,
  ServiceProjectSummary,
} from "../lib/types";

interface Props {
  projects: ProjectSummary[];
  onNotify: (message: string, bad?: boolean) => void;
  onChanged: () => void;
}

/**
 * The map: every identity, the provider accounts it holds, the organizations
 * inside them and the resources inside those.
 *
 * This is the view that answers "which of my three Supabase accounts is this
 * project actually on?". Anything DevLedger could not work out is shown as a
 * gap with a control to close it, rather than filled in with a guess.
 */
export default function MapView({ projects, onNotify, onChanged }: Props) {
  const [graph, setGraph] = useState<IdentityNode[]>([]);
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [g, a] = await Promise.all([api.identityGraph(), api.needsAttention()]);
      setGraph(g);
      setAttention(a);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refreshAll() {
    await load();
    onChanged();
  }

  if (loading) return <div className="empty">Loading…</div>;

  if (graph.length === 0) {
    return (
      <div className="empty">
        <p style={{ margin: 0, fontWeight: 600 }}>Nothing mapped yet</p>
        <p style={{ marginBottom: 0 }}>
          Paste something that names an email, a provider and a project to start
          building the picture.
        </p>
      </div>
    );
  }

  return (
    <div>
      {attention.length > 0 && (
        <section className="section">
          <h3>Needs attention ({attention.length})</h3>
          {attention.map((item, i) => (
            <div key={`${item.entity.id}-${item.kind}-${i}`} className="finding warning">
              <div className="t">{item.title}</div>
              <div className="d">{item.detail}</div>
            </div>
          ))}
        </section>
      )}

      <section className="section">
        <h3>Identities</h3>
        {graph.map((node) => (
          <div key={node.identity.id} className="map-identity">
            <div className="map-head">
              <span className="map-kind">Identity</span>
              <span className="map-name">
                {node.identity.email ?? node.identity.label}
              </span>
              {!node.identity.email && (
                <span className="tag heuristic">no email</span>
              )}
            </div>

            {node.accounts.length === 0 && (
              <p className="map-empty">No provider accounts yet.</p>
            )}

            {node.accounts.map((account) => (
              <div key={account.account.id} className="map-account">
                <div className="map-head">
                  <span className="map-kind">Account</span>
                  <span className="map-name">{account.account.label}</span>
                  {account.subscriptions.length > 0 && (
                    <span className="tag strong">
                      {plural(account.subscriptions.length, "subscription")}
                    </span>
                  )}
                  <NewOrganization
                    accountId={account.account.id}
                    onNotify={onNotify}
                    onCreated={refreshAll}
                  />
                </div>

                {account.organizations.map((org) => (
                  <div key={org.organization.id} className="map-org">
                    <div className="map-head">
                      <span className="map-kind">Organization</span>
                      <span className="map-name">{org.organization.name}</span>
                    </div>
                    {org.service_projects.map((sp) => (
                      <ResourceRow
                        key={sp.service_project.id}
                        resource={sp}
                        projects={projects}
                        organizations={account.organizations.map((o) => o.organization)}
                        onNotify={onNotify}
                        onChanged={refreshAll}
                      />
                    ))}
                  </div>
                ))}

                {account.unassigned.length > 0 && (
                  <div className="map-org unassigned">
                    <div className="map-head">
                      <span className="map-kind">Organization</span>
                      <span className="map-name muted">Not assigned</span>
                      <span className="tag heuristic">needs attention</span>
                    </div>
                    {account.unassigned.map((sp) => (
                      <ResourceRow
                        key={sp.service_project.id}
                        resource={sp}
                        projects={projects}
                        organizations={account.organizations.map((o) => o.organization)}
                        onNotify={onNotify}
                        onChanged={refreshAll}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}

interface ResourceProps {
  resource: ServiceProjectSummary;
  projects: ProjectSummary[];
  organizations: Organization[];
  onNotify: (message: string, bad?: boolean) => void;
  onChanged: () => void;
}

/** One provider resource, with controls to correct where it sits. */
function ResourceRow({
  resource,
  projects,
  organizations,
  onNotify,
  onChanged,
}: ResourceProps) {
  const sp = resource.service_project;
  const linkedIds = useMemo(
    () => new Set(resource.used_by.map((p) => p.id)),
    [resource.used_by],
  );

  async function run(action: () => Promise<unknown>, message: string) {
    try {
      await action();
      onNotify(message);
      onChanged();
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  return (
    <div className="map-resource">
      <div className="map-head">
        <span className="map-kind">Resource</span>
        <span className="map-name mono">{sp.name}</span>
        <span className="tag">{sp.provider}</span>
        <span className="map-meta">{plural(resource.secret_count, "secret")}</span>
      </div>

      <div className="map-controls">
        <label>
          Organization
          <select
            value={sp.organization_id ?? ""}
            onChange={(e) =>
              run(
                () =>
                  api.assignOrganization(sp.id, e.target.value === "" ? null : e.target.value),
                "Organization updated",
              )
            }
          >
            <option value="">Not assigned</option>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Used by
          <select
            value=""
            onChange={(e) => {
              const projectId = e.target.value;
              if (!projectId) return;
              void run(
                () => api.linkServiceProject(sp.id, projectId),
                "Linked to project",
              );
            }}
          >
            <option value="">Link a project…</option>
            {projects
              .filter((p) => !linkedIds.has(p.project.id))
              .map((p) => (
                <option key={p.project.id} value={p.project.id}>
                  {p.project.name}
                </option>
              ))}
          </select>
        </label>
      </div>

      {resource.used_by.length > 0 ? (
        <div className="map-links">
          {resource.used_by.map((p) => (
            <span key={p.id} className="chip">
              {p.name}
              <button
                type="button"
                aria-label={`Unlink ${p.name}`}
                onClick={() =>
                  run(() => api.unlinkServiceProject(sp.id, p.id), "Unlinked")
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="map-links muted">Not used by any project yet.</div>
      )}
    </div>
  );
}

interface NewOrgProps {
  accountId: string;
  onNotify: (message: string, bad?: boolean) => void;
  onCreated: () => void;
}

function NewOrganization({ accountId, onNotify, onCreated }: NewOrgProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await api.createOrganization(accountId, trimmed);
      setName("");
      setOpen(false);
      onNotify(`Added organization ${trimmed}`);
      onCreated();
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  if (!open) {
    return (
      <button type="button" className="ghost tiny" onClick={() => setOpen(true)}>
        + organization
      </button>
    );
  }

  return (
    <span className="inline-form">
      <input
        autoFocus
        value={name}
        placeholder="Organization name"
        aria-label="Organization name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void create();
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <button type="button" onClick={create} disabled={!name.trim()}>
        Add
      </button>
      <button type="button" className="ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </span>
  );
}
