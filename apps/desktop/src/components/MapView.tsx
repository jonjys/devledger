import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import * as api from "../lib/api";
import { plural, providerLabel } from "../lib/format";
import { useMode } from "../lib/mode";
import type {
  AccountNode,
  AttentionItem,
  IdentityNode,
  OrganizationNode,
  ProjectSummary,
  Provider,
  ServiceProjectSummary,
  Subscription,
} from "../lib/types";

interface Props {
  projects: ProjectSummary[];
  onNotify: (message: string, bad?: boolean) => void;
  onChanged: () => void;
}

/** Providers offered when adding an account by hand. */
const PROVIDER_CHOICES: Provider[] = [
  "supabase",
  "git_hub",
  "vercel",
  "stripe",
  "open_ai",
  "anthropic",
  "aws",
  "postgres",
  "unknown",
];

/** A flat (id, label) option for a Move-to dropdown. */
interface MoveOption {
  id: string;
  label: string;
}

/**
 * The map, as an interactive skill tree.
 *
 * Identity → account → organization → resource, each node collapsible and each
 * able to grow a child or be re-parented. It answers "which of my accounts is
 * this on?" and lets the answer be corrected in place rather than only by
 * re-pasting.
 */
export default function MapView({ projects, onNotify, onChanged }: Props) {
  const [graph, setGraph] = useState<IdentityNode[]>([]);
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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

  const refreshAll = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  const run = useCallback(
    async (action: () => Promise<unknown>, message: string) => {
      try {
        await action();
        onNotify(message);
        await refreshAll();
      } catch (e: unknown) {
        onNotify(e instanceof Error ? e.message : String(e), true);
      }
    },
    [onNotify, refreshAll],
  );

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Flat lists that power the Move-to dropdowns.
  const identityOptions = useMemo<MoveOption[]>(
    () =>
      graph.map((n) => ({
        id: n.identity.id,
        label: n.identity.email ?? n.identity.label,
      })),
    [graph],
  );
  const accountOptions = useMemo<MoveOption[]>(
    () =>
      graph.flatMap((n) =>
        n.accounts.map((a) => ({
          id: a.account.id,
          label: `${a.account.label} · ${providerLabel(a.account.provider)}`,
        })),
      ),
    [graph],
  );

  const ctx: TreeCtx = {
    projects,
    identityOptions,
    accountOptions,
    isCollapsed: (id) => collapsed.has(id),
    toggle,
    run,
  };

  if (loading) return <div className="empty">Loading…</div>;

  if (graph.length === 0) {
    return (
      <div className="empty">
        <p style={{ margin: 0, fontWeight: 600 }}>Nothing mapped yet</p>
        <p style={{ marginBottom: 0 }}>
          Paste something that names an email, a provider and a project, or add a service
          from the Connections tab, to start building the picture.
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
        <h3>Skill tree</h3>
        {graph.map((node) => (
          <IdentityBranch key={node.identity.id} node={node} ctx={ctx} />
        ))}
      </section>
    </div>
  );
}

/** Shared plumbing threaded through the tree. */
interface TreeCtx {
  projects: ProjectSummary[];
  identityOptions: MoveOption[];
  accountOptions: MoveOption[];
  isCollapsed: (id: string) => boolean;
  toggle: (id: string) => void;
  run: (action: () => Promise<unknown>, message: string) => Promise<void>;
}

/** The chevron + label header shared by every node. */
function NodeToggle({
  id,
  hasChildren,
  ctx,
  children,
}: {
  id: string;
  hasChildren: boolean;
  ctx: TreeCtx;
  children: ReactNode;
}) {
  const open = !ctx.isCollapsed(id);
  return (
    <button
      type="button"
      className="tree-toggle"
      aria-expanded={open}
      onClick={() => hasChildren && ctx.toggle(id)}
      style={{ visibility: hasChildren ? "visible" : "hidden" }}
      aria-label={open ? "Collapse" : "Expand"}
    >
      {hasChildren ? (open ? "▾" : "▸") : "•"}
      {children}
    </button>
  );
}

function IdentityBranch({ node, ctx }: { node: IdentityNode; ctx: TreeCtx }) {
  const id = node.identity.id;
  const open = !ctx.isCollapsed(id);
  const hasChildren = node.accounts.length > 0;

  return (
    <div className="map-identity tree-node">
      <div className="map-head">
        <NodeToggle id={id} hasChildren={hasChildren} ctx={ctx}>
          <span className="map-kind">Identity</span>
        </NodeToggle>
        <span className="map-name">{node.identity.email ?? node.identity.label}</span>
        {!node.identity.email && <span className="tag heuristic">no email</span>}
        <span className="spacer" />
        <AddAccount identityId={id} ctx={ctx} />
      </div>

      {open && (
        <div className="tree-children">
          {node.accounts.length === 0 && (
            <p className="map-empty">No provider accounts yet.</p>
          )}
          {node.accounts.map((account) => (
            <AccountBranch key={account.account.id} node={account} ctx={ctx} />
          ))}
        </div>
      )}
    </div>
  );
}

function AccountBranch({ node, ctx }: { node: AccountNode; ctx: TreeCtx }) {
  const { dev } = useMode();
  const id = node.account.id;
  const open = !ctx.isCollapsed(id);
  const organizations = node.organizations.map((o) => o.organization);
  const hasChildren =
    node.organizations.length > 0 ||
    node.unassigned.length > 0 ||
    node.subscriptions.length > 0;

  const moveTargets = ctx.identityOptions;

  return (
    <div className="map-account tree-node">
      <div className="map-head">
        <NodeToggle id={id} hasChildren={hasChildren} ctx={ctx}>
          <span className="map-kind">Account</span>
        </NodeToggle>
        <span className="map-name">{node.account.label}</span>
        <span className="tag">{providerLabel(node.account.provider)}</span>
        {dev && node.account.external_ref && (
          <span className="map-meta mono">{node.account.external_ref}</span>
        )}
        {node.subscriptions.length > 0 && (
          <span className="tag strong">
            {plural(node.subscriptions.length, "subscription")}
          </span>
        )}
        <span className="spacer" />
        <MoveTo
          label="Move to identity"
          options={moveTargets}
          onMove={(identityId) =>
            ctx.run(() => api.moveAccount(id, identityId), "Account moved")
          }
        />
        <AddAccountChild account={node} ctx={ctx} />
        <button
          type="button"
          className="ghost tiny danger"
          aria-label={`Delete account ${node.account.label}`}
          onClick={() => {
            if (
              window.confirm(
                `Delete account "${node.account.label}" and everything under it?`,
              )
            ) {
              void ctx.run(() => api.deleteAccount(id), "Account deleted");
            }
          }}
        >
          Delete
        </button>
      </div>

      {open && (
        <div className="tree-children">
          {node.subscriptions.map((sub) => (
            <SubscriptionLeaf key={sub.id} subscription={sub} ctx={ctx} />
          ))}

          {node.organizations.map((org) => (
            <OrgBranch
              key={org.organization.id}
              node={org}
              accountId={id}
              accountProvider={node.account.provider}
              organizations={organizations}
              ctx={ctx}
            />
          ))}

          {node.unassigned.length > 0 && (
            <div className="map-org unassigned tree-node">
              <div className="map-head">
                <span className="map-kind">Organization</span>
                <span className="map-name muted">Not assigned</span>
                <span className="tag heuristic">needs attention</span>
              </div>
              <div className="tree-children">
                {node.unassigned.map((sp) => (
                  <ResourceRow
                    key={sp.service_project.id}
                    resource={sp}
                    organizations={organizations}
                    ctx={ctx}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OrgBranch({
  node,
  accountId,
  accountProvider,
  organizations,
  ctx,
}: {
  node: OrganizationNode;
  accountId: string;
  accountProvider: Provider;
  organizations: { id: string; name: string }[];
  ctx: TreeCtx;
}) {
  const id = node.organization.id;
  const open = !ctx.isCollapsed(id);
  const hasChildren = node.service_projects.length > 0;

  return (
    <div className="map-org tree-node">
      <div className="map-head">
        <NodeToggle id={id} hasChildren={hasChildren} ctx={ctx}>
          <span className="map-kind">Organization</span>
        </NodeToggle>
        <span className="map-name">{node.organization.name}</span>
        <span className="spacer" />
        <MoveTo
          label="Move to account"
          options={ctx.accountOptions}
          onMove={(target) =>
            ctx.run(() => api.moveOrganization(id, target), "Organization moved")
          }
        />
        <AddResource
          accountId={accountId}
          organizationId={id}
          provider={accountProvider}
          ctx={ctx}
        />
        <button
          type="button"
          className="ghost tiny danger"
          aria-label={`Delete organization ${node.organization.name}`}
          onClick={() => {
            if (window.confirm(`Delete organization "${node.organization.name}"?`)) {
              void ctx.run(() => api.deleteOrganization(id), "Organization deleted");
            }
          }}
        >
          Delete
        </button>
      </div>

      {open && (
        <div className="tree-children">
          {node.service_projects.map((sp) => (
            <ResourceRow
              key={sp.service_project.id}
              resource={sp}
              organizations={organizations}
              ctx={ctx}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ResourceRow({
  resource,
  organizations,
  ctx,
}: {
  resource: ServiceProjectSummary;
  organizations: { id: string; name: string }[];
  ctx: TreeCtx;
}) {
  const { dev } = useMode();
  const sp = resource.service_project;
  const linkedIds = useMemo(
    () => new Set(resource.used_by.map((p) => p.id)),
    [resource.used_by],
  );

  return (
    <div className="map-resource tree-node">
      <div className="map-head">
        <span className="map-kind">Resource</span>
        <span className={dev ? "map-name mono" : "map-name"}>{sp.name}</span>
        <span className="tag">{providerLabel(sp.provider)}</span>
        {dev && sp.provider_ref && <code className="ref">{sp.provider_ref}</code>}
        <span className="map-meta">{plural(resource.secret_count, "secret")}</span>
        <span className="spacer" />
        <MoveTo
          label="Move to account"
          options={ctx.accountOptions}
          onMove={(target) =>
            ctx.run(() => api.moveServiceProject(sp.id, target, null), "Resource moved")
          }
        />
        <button
          type="button"
          className="ghost tiny danger"
          aria-label={`Delete resource ${sp.name}`}
          onClick={() => {
            if (window.confirm(`Delete resource "${sp.name}" and its secrets?`)) {
              void ctx.run(() => api.deleteServiceProject(sp.id), "Resource deleted");
            }
          }}
        >
          Delete
        </button>
      </div>

      <div className="map-controls">
        <label>
          Organization
          <select
            value={sp.organization_id ?? ""}
            onChange={(e) =>
              ctx.run(
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
          + Child: link project
          <select
            value=""
            onChange={(e) => {
              const projectId = e.target.value;
              if (!projectId) return;
              void ctx.run(
                () => api.linkServiceProject(sp.id, projectId),
                "Linked to project",
              );
            }}
          >
            <option value="">Link a project…</option>
            {ctx.projects
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
                  ctx.run(() => api.unlinkServiceProject(sp.id, p.id), "Unlinked")
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

function SubscriptionLeaf({
  subscription,
  ctx,
}: {
  subscription: Subscription;
  ctx: TreeCtx;
}) {
  return (
    <div className="map-resource tree-node leaf">
      <div className="map-head">
        <span className="map-kind">Subscription</span>
        <span className="map-name">{subscription.plan}</span>
        <span className="tag strong">{subscription.status.replace("_", " ")}</span>
        {subscription.amount_cents !== null && (
          <span className="map-meta">
            {(subscription.amount_cents / 100).toFixed(2)} {subscription.currency ?? ""}
            {subscription.interval
              ? ` / ${subscription.interval === "monthly" ? "mo" : "yr"}`
              : ""}
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="ghost tiny danger"
          aria-label={`Delete subscription ${subscription.plan}`}
          onClick={() => {
            if (window.confirm(`Delete the "${subscription.plan}" subscription?`)) {
              void ctx.run(
                () => api.deleteSubscription(subscription.id),
                "Subscription deleted",
              );
            }
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

/** A dropdown that re-parents a node to whatever is chosen. */
function MoveTo({
  label,
  options,
  onMove,
}: {
  label: string;
  options: MoveOption[];
  onMove: (id: string) => void;
}) {
  if (options.length <= 1) return null;
  return (
    <select
      className="move-to"
      value=""
      aria-label={label}
      onChange={(e) => {
        if (e.target.value) onMove(e.target.value);
      }}
    >
      <option value="">{label}…</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** + Child on an identity: add a provider account. */
function AddAccount({ identityId, ctx }: { identityId: string; ctx: TreeCtx }) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<Provider>("git_hub");
  const [label, setLabel] = useState("");

  if (!open) {
    return (
      <button type="button" className="ghost tiny" onClick={() => setOpen(true)}>
        + Child node
      </button>
    );
  }

  return (
    <span className="inline-form">
      <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
        {PROVIDER_CHOICES.map((p) => (
          <option key={p} value={p}>
            {providerLabel(p)}
          </option>
        ))}
      </select>
      <input
        autoFocus
        value={label}
        placeholder="Account label"
        aria-label="Account label"
        onChange={(e) => setLabel(e.target.value)}
      />
      <button
        type="button"
        disabled={!label.trim()}
        onClick={() =>
          void ctx
            .run(() => api.addAccount(identityId, provider, label.trim(), null), "Account added")
            .then(() => {
              setLabel("");
              setOpen(false);
            })
        }
      >
        Add
      </button>
      <button type="button" className="ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </span>
  );
}

/** + Child on an account: add an organization or a resource. */
function AddAccountChild({ account, ctx }: { account: AccountNode; ctx: TreeCtx }) {
  const [open, setOpen] = useState(false);
  const [childKind, setChildKind] = useState<"organization" | "resource">("organization");
  const [name, setName] = useState("");

  if (!open) {
    return (
      <button type="button" className="ghost tiny" onClick={() => setOpen(true)}>
        + Child node
      </button>
    );
  }

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const action =
      childKind === "organization"
        ? () => api.createOrganization(account.account.id, trimmed)
        : () =>
            api.createServiceProjectManual(
              account.account.id,
              null,
              account.account.provider,
              trimmed,
              null,
            );
    void ctx.run(action, `Added ${childKind}`).then(() => {
      setName("");
      setOpen(false);
    });
  }

  return (
    <span className="inline-form">
      <select
        value={childKind}
        onChange={(e) => setChildKind(e.target.value as "organization" | "resource")}
      >
        <option value="organization">Organization</option>
        <option value="resource">Resource</option>
      </select>
      <input
        autoFocus
        value={name}
        placeholder={childKind === "organization" ? "Organization name" : "Resource name"}
        aria-label="Child name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <button type="button" disabled={!name.trim()} onClick={submit}>
        Add
      </button>
      <button type="button" className="ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </span>
  );
}

/** + Child on an organization: add a resource inside it. */
function AddResource({
  accountId,
  organizationId,
  provider,
  ctx,
}: {
  accountId: string;
  organizationId: string;
  provider: Provider;
  ctx: TreeCtx;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  if (!open) {
    return (
      <button type="button" className="ghost tiny" onClick={() => setOpen(true)}>
        + Child node
      </button>
    );
  }

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    void ctx
      .run(
        () =>
          api.createServiceProjectManual(accountId, organizationId, provider, trimmed, null),
        "Resource added",
      )
      .then(() => {
        setName("");
        setOpen(false);
      });
  }

  return (
    <span className="inline-form">
      <input
        autoFocus
        value={name}
        placeholder="Resource name"
        aria-label="Resource name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <button type="button" disabled={!name.trim()} onClick={submit}>
        Add
      </button>
      <button type="button" className="ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </span>
  );
}
