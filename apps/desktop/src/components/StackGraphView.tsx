import { useCallback, useEffect, useMemo, useState } from "react";

import * as api from "../lib/api";
import { plural } from "../lib/format";
import type {
  AttentionItem,
  IdentityNode,
  ProjectSummary,
  ServiceProjectSummary,
  VaultEntry,
} from "../lib/types";
import QuickAddDialog, { type AddKind } from "./QuickAddDialog";

type ViewMode = "stack" | "identity" | "project" | "apis" | "attention";

interface Props {
  projects: ProjectSummary[];
  onNotify: (message: string, bad?: boolean) => void;
  onChanged: () => void;
}

type SelectedNode =
  | { kind: "identity"; title: string; subtitle: string }
  | { kind: "account"; title: string; subtitle: string }
  | { kind: "organization"; title: string; subtitle: string }
  | { kind: "resource"; title: string; subtitle: string; resource: ServiceProjectSummary }
  | { kind: "project"; title: string; subtitle: string; projectId: string };

export default function StackGraphView({ projects, onNotify, onChanged }: Props) {
  const [graph, setGraph] = useState<IdentityNode[]>([]);
  const [attention, setAttention] = useState<AttentionItem[]>([]);
  const [resources, setResources] = useState<ServiceProjectSummary[]>([]);
  const [apiEntries, setApiEntries] = useState<Record<string, VaultEntry[]>>({});
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<ViewMode>("stack");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<SelectedNode | null>(null);
  const [addKind, setAddKind] = useState<AddKind | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [g, a, r, secretRows] = await Promise.all([
        api.identityGraph(),
        api.needsAttention(),
        api.listServiceProjects(),
        Promise.all(
          projects.map(async (project) => [
            project.project.id,
            await api.listSecrets(project.project.id),
          ] as const),
        ),
      ]);
      setGraph(g);
      setAttention(a);
      setResources(r);
      setApiEntries(Object.fromEntries(secretRows));
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setLoading(false);
    }
  }, [onNotify, projects]);

  useEffect(() => {
    void load();
  }, [load]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleGraph = useMemo(() => {
    if (!normalizedQuery) return graph;
    return graph.filter((identity) => {
      const text = [
        identity.identity.label,
        identity.identity.email,
        ...identity.accounts.flatMap((a) => [
          a.account.label,
          a.account.provider,
          ...a.organizations.flatMap((o) => [
            o.organization.name,
            ...o.service_projects.flatMap((r) => [
              r.service_project.name,
              r.service_project.provider_ref,
              ...r.used_by.map((p) => p.name),
            ]),
          ]),
          ...a.unassigned.flatMap((r) => [
            r.service_project.name,
            r.service_project.provider_ref,
            ...r.used_by.map((p) => p.name),
          ]),
        ]),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return text.includes(normalizedQuery);
    });
  }, [graph, normalizedQuery]);

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function changed() {
    await load();
    onChanged();
  }

  if (loading) return <div className="empty">Building your stack…</div>;

  return (
    <div className="stack-page">
      <div className="stack-toolbar">
        <div>
          <h1>My Stack</h1>
          <p>Your identities, services, projects and resources — one graph.</p>
        </div>
        <div className="stack-actions">
          <button type="button" className="primary" onClick={() => setAddKind("identity")}>+ Add</button>
          <div className="add-menu">
            <button type="button" onClick={() => setAddKind("account")}>+ Service account</button>
            <button type="button" onClick={() => setAddKind("resource")}>+ Resource</button>
            <button type="button" onClick={() => setAddKind("secret")}>+ API / Secret</button>
          </div>
        </div>
      </div>

      <div className="stack-controls">
        <div className="view-switcher">
          {([
            ["stack", "My Stack"],
            ["identity", "By identity"],
            ["project", "By project"],
            ["apis", "APIs / Secrets"],
            ["attention", `Needs attention ${attention.length ? `(${attention.length})` : ""}`],
          ] as [ViewMode, string][]).map(([id, label]) => (
            <button
              type="button"
              key={id}
              className={mode === id ? "active" : ""}
              onClick={() => setMode(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          className="stack-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search email, service, project, ref…"
          aria-label="Search stack"
        />
      </div>

      {mode === "attention" ? (
        <AttentionView items={attention} />
      ) : mode === "apis" ? (
        <ApiProjection projects={projects} entries={apiEntries} onNotify={onNotify} />
      ) : mode === "project" ? (
        <ProjectProjection
          projects={projects}
          resources={resources}
          onSelect={(p) =>
            setSelected({
              kind: "project",
              title: p.project.name,
              subtitle: `${plural(p.service_project_count, "resource")} · ${plural(p.secret_count, "secret")}`,
              projectId: p.project.id,
            })
          }
        />
      ) : visibleGraph.length === 0 ? (
        <div className="stack-empty">
          <strong>{graph.length ? "No matching nodes" : "Your stack is empty"}</strong>
          <span>Add an email, connect a service, or use Smart Paste above.</span>
          {!graph.length && (
            <button type="button" className="primary" onClick={() => setAddKind("identity")}>
              Add first identity
            </button>
          )}
        </div>
      ) : (
        <div className={`stack-canvas ${mode === "identity" ? "identity-focus" : ""}`}>
          <div className="lane-heads" aria-hidden="true">
            <span>IDENTITIES</span>
            <span>SERVICES / ACCOUNTS</span>
            <span>RESOURCES</span>
            <span>YOUR PROJECTS</span>
          </div>

          {visibleGraph.map((identity) => {
            const identityId = identity.identity.id;
            const isCollapsed = collapsed.has(identityId);
            return (
              <section className="skill-tree-row" key={identityId}>
                <div className="tree-identity-col">
                  <GraphNode
                    tone="identity"
                    eyebrow="Identity"
                    title={identity.identity.email ?? identity.identity.label}
                    meta={identity.identity.email ? identity.identity.label : "email unknown"}
                    warning={!identity.identity.email}
                    collapsed={isCollapsed}
                    onToggle={() => toggle(identityId)}
                    onClick={() =>
                      setSelected({
                        kind: "identity",
                        title: identity.identity.email ?? identity.identity.label,
                        subtitle: `${plural(identity.accounts.length, "service account")}`,
                      })
                    }
                  />
                </div>

                {!isCollapsed && (
                  <div className="tree-branches">
                    {identity.accounts.length === 0 ? (
                      <div className="tree-gap">+ No service accounts yet</div>
                    ) : (
                      identity.accounts.map((account) => (
                        <div className="account-branch" key={account.account.id}>
                          <div className="tree-account-col">
                            <GraphNode
                              tone="service"
                              eyebrow={account.account.provider === "unknown" ? "Custom service" : account.account.provider}
                              title={account.account.label}
                              meta={
                                account.organizations.length
                                  ? plural(account.organizations.length, "organization")
                                  : "No organization"
                              }
                              onClick={() =>
                                setSelected({
                                  kind: "account",
                                  title: account.account.label,
                                  subtitle: `${account.account.provider} · ${identity.identity.email ?? identity.identity.label}`,
                                })
                              }
                            />
                          </div>

                          <div className="tree-resource-col">
                            {[
                              ...account.organizations.flatMap((org) =>
                                org.service_projects.map((resource) => ({
                                  resource,
                                  orgName: org.organization.name,
                                })),
                              ),
                              ...account.unassigned.map((resource) => ({
                                resource,
                                orgName: null as string | null,
                              })),
                            ].map(({ resource, orgName }) => (
                              <ResourceBranch
                                key={resource.service_project.id}
                                resource={resource}
                                orgName={orgName}
                                onSelect={(r) =>
                                  setSelected({
                                    kind: "resource",
                                    title: r.service_project.name,
                                    subtitle: `${r.account_label}${r.organization_name ? ` · ${r.organization_name}` : ""}`,
                                    resource: r,
                                  })
                                }
                                onProject={(p) =>
                                  setSelected({
                                    kind: "project",
                                    title: p.name,
                                    subtitle: `Used by ${resource.service_project.name}`,
                                    projectId: p.id,
                                  })
                                }
                              />
                            ))}
                            {account.organizations.length > 0 &&
                              account.organizations.every((o) => o.service_projects.length === 0) &&
                              account.unassigned.length === 0 && (
                                <div className="tree-gap">No resources yet</div>
                              )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {selected && <NodeInspector node={selected} onClose={() => setSelected(null)} />}

      {addKind && (
        <QuickAddDialog
          kind={addKind}
          graph={graph}
          projects={projects}
          onClose={() => setAddKind(null)}
          onCreated={changed}
          onNotify={onNotify}
        />
      )}
    </div>
  );
}

function ResourceBranch({
  resource,
  orgName,
  onSelect,
  onProject,
}: {
  resource: ServiceProjectSummary;
  orgName: string | null;
  onSelect: (resource: ServiceProjectSummary) => void;
  onProject: (project: { id: string; name: string }) => void;
}) {
  return (
    <div className="resource-branch">
      <GraphNode
        tone={orgName ? "resource" : "warning"}
        eyebrow={orgName ?? "Unassigned"}
        title={resource.service_project.name}
        meta={resource.service_project.provider_ref ?? resource.service_project.provider}
        warning={!orgName}
        onClick={() => onSelect(resource)}
      />
      <div className="tree-project-col">
        {resource.used_by.length ? (
          resource.used_by.map((project) => (
            <GraphNode
              key={project.id}
              tone="project"
              eyebrow="Project"
              title={project.name}
              meta={plural(resource.secret_count, "secret")}
              onClick={() => onProject(project)}
            />
          ))
        ) : (
          <div className="tree-gap warning-gap">Needs project link</div>
        )}
      </div>
    </div>
  );
}

function GraphNode({
  tone,
  eyebrow,
  title,
  meta,
  warning,
  collapsed,
  onToggle,
  onClick,
}: {
  tone: "identity" | "service" | "resource" | "project" | "warning";
  eyebrow: string;
  title: string;
  meta?: string;
  warning?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  onClick: () => void;
}) {
  return (
    <div className={`graph-node ${tone}${warning ? " has-warning" : ""}`}>
      <button type="button" className="graph-node-main" onClick={onClick}>
        <span className="node-eyebrow">{eyebrow}</span>
        <strong>{title}</strong>
        {meta && <span className="node-meta">{meta}</span>}
      </button>
      {onToggle && (
        <button
          type="button"
          className="node-toggle"
          aria-label={collapsed ? "Expand branch" : "Collapse branch"}
          onClick={onToggle}
        >
          {collapsed ? "+" : "−"}
        </button>
      )}
    </div>
  );
}

function ProjectProjection({
  projects,
  resources,
  onSelect,
}: {
  projects: ProjectSummary[];
  resources: ServiceProjectSummary[];
  onSelect: (project: ProjectSummary) => void;
}) {
  if (!projects.length) return <div className="stack-empty"><strong>No projects yet</strong></div>;
  return (
    <div className="project-projection">
      {projects.map((project) => {
        const linked = resources.filter((r) => r.used_by.some((p) => p.id === project.project.id));
        return (
          <button type="button" className="project-card" key={project.project.id} onClick={() => onSelect(project)}>
            <div className="project-orb" />
            <div>
              <span className="node-eyebrow">Project</span>
              <strong>{project.project.name}</strong>
              <span className="node-meta">
                {linked.length
                  ? linked.map((r) => `${r.service_project.provider}: ${r.service_project.name}`).join(" · ")
                  : "No provider resources linked"}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function ApiProjection({
  projects,
  entries,
  onNotify,
}: {
  projects: ProjectSummary[];
  entries: Record<string, VaultEntry[]>;
  onNotify: (message: string, bad?: boolean) => void;
}) {
  if (!projects.length) {
    return <div className="stack-empty"><strong>No projects yet</strong><span>Add a project before filing API keys.</span></div>;
  }

  async function copy(secretId: string, name: string) {
    try {
      await api.copySecret(secretId);
      onNotify(`Copied ${name}`);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  return (
    <div className="api-projection">
      {projects.map((project) => {
        const rows = entries[project.project.id] ?? [];
        return (
          <section className="api-project" key={project.project.id}>
            <div className="api-project-head">
              <div>
                <span className="node-eyebrow">Project</span>
                <h3>{project.project.name}</h3>
              </div>
              <span className="tag">{plural(rows.length, "secret")}</span>
            </div>
            {rows.length ? (
              <div className="api-list">
                {rows.map((entry) => (
                  <div className="api-row" key={entry.secret.id}>
                    <div className="api-icon">KEY</div>
                    <div className="api-copy">
                      <strong>{entry.secret.name}</strong>
                      <span>
                        {entry.service_project_name ?? "Project-level"} · {entry.secret.environment}
                      </span>
                    </div>
                    <code>{entry.secret.preview}</code>
                    <button type="button" onClick={() => copy(entry.secret.id, entry.secret.name)}>Copy</button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="api-empty">No APIs or secrets filed here yet.</div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function AttentionView({ items }: { items: AttentionItem[] }) {
  if (!items.length) {
    return <div className="stack-empty"><strong>Everything is connected.</strong><span>No unresolved branches.</span></div>;
  }
  return (
    <div className="attention-grid">
      {items.map((item, index) => (
        <div className="attention-card" key={`${item.entity.id}-${item.kind}-${index}`}>
          <span className="attention-dot" />
          <div>
            <strong>{item.title}</strong>
            <p>{item.detail}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function NodeInspector({ node, onClose }: { node: SelectedNode; onClose: () => void }) {
  return (
    <aside className="node-inspector">
      <button type="button" className="ghost inspector-close" onClick={onClose}>×</button>
      <span className="node-eyebrow">{node.kind}</span>
      <h2>{node.title}</h2>
      <p>{node.subtitle}</p>
      {node.kind === "resource" && (
        <div className="inspector-list">
          <div><span>Provider</span><strong>{node.resource.service_project.provider}</strong></div>
          <div><span>Environment</span><strong>{node.resource.service_project.environment}</strong></div>
          <div><span>Secrets</span><strong>{node.resource.secret_count}</strong></div>
          <div><span>Used by</span><strong>{node.resource.used_by.map((p) => p.name).join(", ") || "Unlinked"}</strong></div>
        </div>
      )}
      <div className="note">The graph is semantic. Visual position never changes a relationship by accident.</div>
    </aside>
  );
}
