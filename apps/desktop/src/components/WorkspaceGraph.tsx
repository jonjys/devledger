import "@xyflow/react/dist/style.css";
import "./WorkspaceGraph.css";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
  type XYPosition,
} from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as api from "../lib/api";
import { providerLabel } from "../lib/format";
import { catalogProviders, providerForName, providerInfo, type ProviderInfo } from "../lib/providers";
import type { Account, AccountDetails, LedgerIdentity, ProjectSummary, Provider, ServiceProjectSummary } from "../lib/types";
import Modal from "./Modal";
import ProviderIcon from "./ProviderIcon";
import { ContextMenu, type MenuItem } from "./SkillTreeParts";

interface Props {
  onNotify: (message: string, bad?: boolean) => void;
  onChanged: () => void;
  refreshKey?: number;
}

type GraphKind = "identity" | "account" | "project";
interface GraphNodeData extends Record<string, unknown> {
  kind: GraphKind;
  label: string;
  sub: string | null;
  provider: Provider | null;
  locked: boolean;
}
type GraphNode = Node<GraphNodeData, "workspace">;
interface GraphEdgeData extends Record<string, unknown> {
  kind: "owns" | "project-link";
  resourceIds?: string[];
}
type GraphEdge = Edge<GraphEdgeData>;
interface GraphData {
  people: LedgerIdentity[];
  resources: ServiceProjectSummary[];
  projects: ProjectSummary[];
}
interface MenuState {
  x: number;
  y: number;
  nodeId: string | null;
  edgeId?: string;
  at?: XYPosition;
}
type DialogState =
  | { kind: "project"; at: XYPosition }
  | { kind: "identity"; at: XYPosition }
  | { kind: "service"; at: XYPosition; identityId?: string; service?: string }
  | { kind: "edit"; nodeId: string };

const POSITION_KEY = "devledger.workspaceGraph.positions.v1";
const LOCK_KEY = "devledger.workspaceGraph.locked.v1";
const FIT_MAX_ZOOM = 1.25;

function err(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function nodeKey(kind: GraphKind, id: string): string { return `${kind}:${id}`; }
function nodeId(key: string): string { return key.slice(key.indexOf(":") + 1); }
function nodeKind(key: string): GraphKind | null {
  const kind = key.slice(0, key.indexOf(":"));
  return kind === "identity" || kind === "account" || kind === "project" ? kind : null;
}
function defaultPosition(kind: GraphKind, index: number): XYPosition {
  const y = 90 + index * 112;
  return kind === "identity" ? { x: 70, y } : kind === "account" ? { x: 410, y } : { x: 760, y };
}
function readPositions(): Record<string, XYPosition> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(POSITION_KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, XYPosition> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") continue;
      const { x, y } = value as { x?: unknown; y?: unknown };
      if (typeof x === "number" && typeof y === "number") out[key] = { x, y };
    }
    return out;
  } catch { return {}; }
}
function savePositions(value: Record<string, XYPosition>) {
  try { window.localStorage.setItem(POSITION_KEY, JSON.stringify(value)); } catch { /* visual preference only */ }
}
function readLocked(): boolean {
  try { return window.localStorage.getItem(LOCK_KEY) === "1"; } catch { return false; }
}
function saveLocked(value: boolean) {
  try { window.localStorage.setItem(LOCK_KEY, value ? "1" : "0"); } catch { /* session state still works */ }
}

const GraphNodeView = memo(function GraphNodeView({ data, selected }: NodeProps<GraphNode>) {
  return (
    <div className={`wg-node ${data.kind}${selected ? " selected" : ""}${data.locked ? " locked" : ""}`}>
      <Handle type="target" position={Position.Left} className="wg-handle" isConnectable={!data.locked} />
      <div className="wg-node-icon">
        {data.kind === "account" && data.provider ? <ProviderIcon provider={data.provider} size={20} /> : data.kind === "project" ? "◆" : "@"}
      </div>
      <div className="wg-node-copy">
        <div className="wg-node-kind">{data.kind === "identity" ? "Identity" : data.kind === "account" ? "Service" : "Project"}</div>
        <div className="wg-node-label">{data.label}</div>
        {data.sub && <div className="wg-node-sub">{data.sub}</div>}
      </div>
      <Handle type="source" position={Position.Right} className="wg-handle" isConnectable={!data.locked} />
    </div>
  );
});
const nodeTypes = { workspace: GraphNodeView };

export default function WorkspaceGraph(props: Props) {
  return <ReactFlowProvider><WorkspaceGraphCanvas {...props} /></ReactFlowProvider>;
}

function WorkspaceGraphCanvas({ onNotify, onChanged, refreshKey }: Props) {
  const flow = useReactFlow<GraphNode, GraphEdge>();
  const [data, setData] = useState<GraphData | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([]);
  const [locked, setLocked] = useState(readLocked);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [serviceQuery, setServiceQuery] = useState("");
  const positions = useRef<Record<string, XYPosition>>(readPositions());

  const reload = useCallback(async () => {
    try {
      const [people, resources, projects] = await Promise.all([api.ledgerOverview(), api.listServiceProjects(), api.listProjects()]);
      setData({ people, resources, projects });
    } catch (e: unknown) { onNotify(err(e), true); }
  }, [onNotify]);
  useEffect(() => { void reload(); }, [reload, refreshKey]);

  const accounts = useMemo(() => {
    const out = new Map<string, { account: Account; owner: LedgerIdentity }>();
    for (const person of data?.people ?? []) for (const item of person.accounts) out.set(item.account.id, { account: item.account, owner: person });
    return out;
  }, [data]);

  useEffect(() => {
    if (!data) return;
    const next: GraphNode[] = [];
    data.people.forEach((person, i) => {
      const id = nodeKey("identity", person.identity.id);
      next.push({ id, type: "workspace", position: positions.current[id] ?? defaultPosition("identity", i), draggable: !locked, data: {
        kind: "identity", label: person.identity.email ?? person.identity.label,
        sub: person.identity.email && person.identity.label !== person.identity.email ? person.identity.label : null,
        provider: null, locked,
      }});
    });
    [...accounts.values()].forEach(({ account }, i) => {
      const id = nodeKey("account", account.id);
      next.push({ id, type: "workspace", position: positions.current[id] ?? defaultPosition("account", i), draggable: !locked, data: {
        kind: "account", label: account.label, sub: account.login_email ?? account.username ?? providerLabel(account.provider), provider: account.provider, locked,
      }});
    });
    data.projects.forEach((summary, i) => {
      const id = nodeKey("project", summary.project.id);
      next.push({ id, type: "workspace", position: positions.current[id] ?? defaultPosition("project", i), draggable: !locked, data: {
        kind: "project", label: summary.project.name, sub: `${summary.service_project_count} resources · ${summary.secret_count} secrets`, provider: null, locked,
      }});
    });
    setNodes(next);
  }, [accounts, data, locked, setNodes]);

  const edges = useMemo<GraphEdge[]>(() => {
    if (!data) return [];
    const out: GraphEdge[] = [];
    for (const person of data.people) for (const item of person.accounts) out.push({
      id: `owns:${person.identity.id}:${item.account.id}`, source: nodeKey("identity", person.identity.id), target: nodeKey("account", item.account.id),
      type: "smoothstep", data: { kind: "owns" }, className: "wg-edge owns", selectable: false,
    });
    const links = new Map<string, { accountId: string; projectId: string; resourceIds: string[] }>();
    for (const resource of data.resources) for (const project of resource.used_by) {
      const id = `${resource.service_project.account_id}:${project.id}`;
      const link = links.get(id) ?? { accountId: resource.service_project.account_id, projectId: project.id, resourceIds: [] };
      link.resourceIds.push(resource.service_project.id); links.set(id, link);
    }
    for (const link of links.values()) out.push({
      id: `uses:${link.accountId}:${link.projectId}`, source: nodeKey("account", link.accountId), target: nodeKey("project", link.projectId),
      type: "smoothstep", data: { kind: "project-link", resourceIds: link.resourceIds }, className: "wg-edge project-link",
    });
    return out;
  }, [data]);

  const changed = useCallback(async () => { await reload(); onChanged(); }, [reload, onChanged]);
  const setMapLocked = useCallback((value: boolean) => {
    setLocked(value); saveLocked(value); setMenu(null);
    onNotify(value ? "Map locked · moving, editing, connecting and deleting are disabled" : "Map unlocked · edit mode is on");
  }, [onNotify]);
  const fit = useCallback(() => void flow.fitView({ padding: .18, duration: 300, maxZoom: FIT_MAX_ZOOM }), [flow]);
  const autoLayout = useCallback(() => {
    if (locked) return;
    const count: Record<GraphKind, number> = { identity: 0, account: 0, project: 0 };
    setNodes((current) => current.map((node) => {
      const position = defaultPosition(node.data.kind, count[node.data.kind]++); positions.current[node.id] = position; return { ...node, position };
    }));
    savePositions(positions.current); window.setTimeout(fit, 30);
  }, [fit, locked, setNodes]);

  const connectAccountProject = useCallback(async (accountId: string, project: ProjectSummary) => {
    if (!data) return;
    if (data.resources.some((r) => r.service_project.account_id === accountId && r.used_by.some((p) => p.id === project.project.id))) {
      onNotify(`${project.project.name} is already connected to this service`); return;
    }
    const unlinked = data.resources.find((r) => r.service_project.account_id === accountId && r.used_by.length === 0);
    if (unlinked) await api.linkServiceProject(unlinked.service_project.id, project.project.id);
    else {
      const account = accounts.get(accountId)?.account; if (!account) throw new Error("Account not found.");
      const resource = await api.createServiceProjectManual(account.id, null, account.provider, project.project.name, null, "unknown");
      await api.linkServiceProject(resource.id, project.project.id);
    }
    onNotify(`Connected ${accounts.get(accountId)?.account.label ?? "service"} → ${project.project.name}`); await changed();
  }, [accounts, changed, data, onNotify]);

  const onConnect = useCallback(async (connection: Connection) => {
    if (locked || !data || !connection.source || !connection.target) return;
    const sk = nodeKind(connection.source), tk = nodeKind(connection.target), sid = nodeId(connection.source), tid = nodeId(connection.target);
    try {
      if (sk === "identity" && tk === "account") {
        const account = accounts.get(tid)?.account; if (!account || account.identity_id === sid) return;
        await api.moveAccount(tid, sid); onNotify(`Connected ${account.label} to the selected identity`); await changed(); return;
      }
      if (sk === "account" && tk === "project") { const p = data.projects.find((x) => x.project.id === tid); if (p) await connectAccountProject(sid, p); return; }
      if (sk === "project" && tk === "account") { const p = data.projects.find((x) => x.project.id === sid); if (p) await connectAccountProject(tid, p); return; }
      onNotify("Connect identity → service → project. Projects do not live under an email.", true);
    } catch (e: unknown) { onNotify(err(e), true); }
  }, [accounts, changed, connectAccountProject, data, locked, onNotify]);

  async function disconnect(edge: GraphEdge) {
    if (locked || edge.data?.kind !== "project-link") return;
    try {
      const projectId = nodeId(edge.target);
      for (const resourceId of edge.data.resourceIds ?? []) await api.unlinkServiceProject(resourceId, projectId);
      onNotify("Disconnected from project · provider resources were kept"); await changed();
    } catch (e: unknown) { onNotify(err(e), true); }
  }
  async function removeNode(id: string) {
    if (locked || !data) return;
    const kind = nodeKind(id), raw = nodeId(id);
    try {
      if (kind === "account") { const a = accounts.get(raw)?.account; if (!a || !window.confirm(`Delete ${a.label} and everything stored directly under that account?`)) return; await api.deleteAccount(raw); }
      if (kind === "identity") { const p = data.people.find((x) => x.identity.id === raw); if (!p || !window.confirm(`Delete ${p.identity.email ?? p.identity.label} and all accounts under it?`)) return; await api.deleteIdentity(raw); }
      if (kind === "project") { const p = data.projects.find((x) => x.project.id === raw); if (!p || !window.confirm(`Delete project ${p.project.name} and its own variables? Provider resources are kept.`)) return; await api.deleteProject(raw); }
      delete positions.current[id]; savePositions(positions.current); setSelected(null); onNotify("Deleted"); await changed();
    } catch (e: unknown) { onNotify(err(e), true); }
  }

  function connectMenu(node: GraphNode): MenuItem[] {
    if (!data || locked) return [];
    if (node.data.kind === "project") {
      const project = data.projects.find((p) => p.project.id === nodeId(node.id)); if (!project) return [];
      return [...accounts.values()].map(({ account }) => ({ label: account.label, hint: providerLabel(account.provider), onSelect: () => void connectAccountProject(account.id, project) }));
    }
    if (node.data.kind === "account") {
      const accountId = nodeId(node.id); return data.projects.map((p) => ({ label: p.project.name, onSelect: () => void connectAccountProject(accountId, p) }));
    }
    return [];
  }
  function nodeMenu(node: GraphNode): MenuItem[] {
    if (locked) return [{ label: "Unlock map to edit", onSelect: () => setMapLocked(false) }, { label: "Fit map", onSelect: fit }];
    const items: MenuItem[] = [{ label: "Edit", onSelect: () => setDialog({ kind: "edit", nodeId: node.id }) }];
    if (node.data.kind === "identity") items.push({ label: "Add service account", onSelect: () => setDialog({ kind: "service", at: node.position, identityId: nodeId(node.id) }) });
    const connect = connectMenu(node); if (connect.length) items.push({ label: "Connect to", items: connect });
    items.push({ label: "Delete", danger: true, onSelect: () => void removeNode(node.id) }); return items;
  }

  const onNodeContextMenu: NodeMouseHandler<GraphNode> = (event, node) => { event.preventDefault(); setSelected(node.id); setMenu({ x: event.clientX, y: event.clientY, nodeId: node.id }); };
  const paneMenu: MenuItem[] = locked ? [{ label: "Unlock map to edit", onSelect: () => setMapLocked(false) }, { label: "Fit map", onSelect: fit }] : [
    { label: "Add project", onSelect: () => setDialog({ kind: "project", at: menu?.at ?? { x: 760, y: 250 } }) },
    { label: "Add email / identity", onSelect: () => setDialog({ kind: "identity", at: menu?.at ?? { x: 70, y: 250 } }) },
    { label: "Add service", onSelect: () => setDialog({ kind: "service", at: menu?.at ?? { x: 410, y: 250 } }) },
    { label: "Auto layout", onSelect: autoLayout }, { label: "Lock map", onSelect: () => setMapLocked(true) },
  ];
  const menuNode = menu?.nodeId ? nodes.find((n) => n.id === menu.nodeId) ?? null : null;
  const menuEdge = menu?.edgeId ? edges.find((e) => e.id === menu.edgeId) ?? null : null;
  const providers = useMemo(() => catalogProviders(), []);
  const shownProviders = providers.filter((p) => p.name.toLowerCase().includes(serviceQuery.trim().toLowerCase())).slice(0, 20);

  if (!data) return <div className="empty">Loading map…</div>;
  return (
    <div className="wg-shell">
      <div className="wg-toolbar">
        <div className="wg-title"><strong>Workspace map</strong><span>Projects are products. Emails are identities. Services sit between them.</span></div>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={fit}>Fit</button>
        <button type="button" className="ghost" onClick={autoLayout} disabled={locked}>Auto layout</button>
        <button type="button" className={locked ? "wg-lock locked" : "wg-lock editing"} onClick={() => setMapLocked(!locked)}>{locked ? "🔒 Map locked" : "🔓 Editing map"}</button>
      </div>
      <div className="wg-body">
        <div className="wg-canvas" onContextMenu={(e) => e.preventDefault()}>
          {nodes.length === 0 ? <div className="wg-empty"><strong>Start with a project, an email, or a service.</strong><span>Nothing is forced to be the root. Connect only what actually belongs together.</span>{!locked && <div><button className="primary" onClick={() => setDialog({ kind: "project", at: { x: 760, y: 150 } })}>+ Project</button><button className="ghost" onClick={() => setDialog({ kind: "identity", at: { x: 70, y: 150 } })}>+ Email</button></div>}</div> :
          <ReactFlow<GraphNode, GraphEdge>
            nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
            onNodeDragStop={(_, node) => { positions.current[node.id] = node.position; savePositions(positions.current); }}
            onNodeClick={(_, node) => setSelected(node.id)} onPaneClick={() => setSelected(null)} onNodeContextMenu={onNodeContextMenu}
            onPaneContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, nodeId: null, at: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }) }); }}
            onEdgeContextMenu={(event, edge) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, nodeId: null, edgeId: edge.id }); }}
            onConnect={(c) => void onConnect(c)} nodesConnectable={!locked} nodesDraggable={!locked} elementsSelectable minZoom={.25} maxZoom={2.5} fitView fitViewOptions={{ padding: .2, maxZoom: FIT_MAX_ZOOM }} proOptions={{ hideAttribution: true }} colorMode="dark">
            <Background variant={BackgroundVariant.Dots} color="#1A1A1A" bgColor="#09090B" gap={22} size={1.4} />
            <Controls showInteractive={false} position="bottom-left" fitViewOptions={{ padding: .2, maxZoom: FIT_MAX_ZOOM }} />
          </ReactFlow>}
        </div>
        <aside className="wg-library" aria-label="Add to map">
          <div className="wg-library-head"><strong>Add to map</strong><span>Pick, place, connect.</span></div>
          <button className="wg-library-main" disabled={locked} onClick={() => setDialog({ kind: "project", at: { x: 760, y: 140 + data.projects.length * 70 } })}><span className="wg-library-symbol project">◆</span><span><strong>Project</strong><small>Your product, e.g. MAKEIT.REAL</small></span><b>+</b></button>
          <button className="wg-library-main" disabled={locked} onClick={() => setDialog({ kind: "identity", at: { x: 70, y: 140 + data.people.length * 70 } })}><span className="wg-library-symbol identity">@</span><span><strong>Email / identity</strong><small>{data.people.length} in ledger</small></span><b>+</b></button>
          <div className="wg-library-section"><div className="wg-library-label">Services</div><input type="search" placeholder="Find service…" value={serviceQuery} onChange={(e) => setServiceQuery(e.target.value)} /><div className="wg-provider-list">
            {shownProviders.map((provider) => <button key={provider.provider} disabled={locked} onClick={() => setDialog({ kind: "service", at: { x: 410, y: 140 + accounts.size * 60 }, service: provider.name })}><ProviderIcon provider={provider.provider} size={16} /><span>{provider.name}</span><b>+</b></button>)}
          </div><button className="wg-custom" disabled={locked} onClick={() => setDialog({ kind: "service", at: { x: 410, y: 140 + accounts.size * 60 } })}>+ Custom service</button></div>
          <div className="wg-library-foot"><span>{data.projects.length} projects</span><span>Visual movement never changes relationships.</span></div>
        </aside>
      </div>
      {selected && <div className="wg-selection"><strong>{nodes.find((n) => n.id === selected)?.data.label}</strong><span>{locked ? "Map locked" : "Right-click to edit · drag to arrange · drag a connector to connect"}</span></div>}
      {menu && menuNode && <ContextMenu x={menu.x} y={menu.y} title={menuNode.data.label} items={nodeMenu(menuNode)} onClose={() => setMenu(null)} />}
      {menu && menuEdge && <ContextMenu x={menu.x} y={menu.y} title="Connection" items={locked ? [{ label: "Unlock map to edit", onSelect: () => setMapLocked(false) }] : [{ label: "Disconnect", danger: true, onSelect: () => void disconnect(menuEdge) }]} onClose={() => setMenu(null)} />}
      {menu && !menuNode && !menuEdge && <ContextMenu x={menu.x} y={menu.y} title="Workspace" items={paneMenu} onClose={() => setMenu(null)} />}
      {dialog && <GraphDialog state={dialog} data={data} accounts={accounts} onClose={() => setDialog(null)} onNotify={onNotify} onCreated={async (kind, id, at) => { positions.current[nodeKey(kind, id)] = at; savePositions(positions.current); setDialog(null); await changed(); }} onSaved={async () => { setDialog(null); await changed(); }} />}
    </div>
  );
}

function GraphDialog({ state, data, accounts, onClose, onNotify, onCreated, onSaved }: {
  state: DialogState; data: GraphData; accounts: Map<string, { account: Account; owner: LedgerIdentity }>;
  onClose: () => void; onNotify: Props["onNotify"];
  onCreated: (kind: GraphKind, id: string, at: XYPosition) => Promise<void>; onSaved: () => Promise<void>;
}) {
  const editKind = state.kind === "edit" ? nodeKind(state.nodeId) : null;
  const editId = state.kind === "edit" ? nodeId(state.nodeId) : "";
  const editAccount = editKind === "account" ? accounts.get(editId)?.account ?? null : null;
  const editPerson = editKind === "identity" ? data.people.find((p) => p.identity.id === editId) ?? null : null;
  const editProject = editKind === "project" ? data.projects.find((p) => p.project.id === editId) ?? null : null;
  const [name, setName] = useState(editAccount?.label ?? editPerson?.identity.label ?? editProject?.project.name ?? "");
  const [email, setEmail] = useState("");
  const [service, setService] = useState(state.kind === "service" ? state.service ?? "" : "");
  const [identityId, setIdentityId] = useState(state.kind === "service" ? state.identityId ?? data.people.find((p) => p.identity.email)?.identity.id ?? "" : "");
  const [loginEmail, setLoginEmail] = useState(editAccount?.login_email ?? "");
  const [username, setUsername] = useState(editAccount?.username ?? "");
  const [url, setUrl] = useState(editAccount?.url ?? "");
  const [busy, setBusy] = useState(false);
  const title = state.kind === "project" ? "Add project" : state.kind === "identity" ? "Add email / identity" : state.kind === "service" ? "Add service account" : `Edit ${editKind ?? "item"}`;
  async function save() {
    if (busy) return; setBusy(true);
    try {
      if (state.kind === "project") { if (!name.trim()) return setBusy(false); const p = await api.createProject(name.trim(), null); onNotify(`Added project ${p.name}`); await onCreated("project", p.id, state.at); return; }
      if (state.kind === "identity") { if (!email.trim()) return setBusy(false); const p = await api.createIdentityManual(name.trim() || email.trim(), email.trim()); onNotify(`Added ${email.trim()}`); await onCreated("identity", p.id, state.at); return; }
      if (state.kind === "service") {
        if (!identityId || !service.trim()) return setBusy(false);
        const provider = providerForName(service.trim()); const label = name.trim() || providerInfo(provider)?.name || service.trim();
        const details: AccountDetails = { login_email: loginEmail.trim() || null, username: username.trim() || null, url: null, notes: null };
        const a = await api.createAccountManual(identityId, provider, label, details); onNotify(`Added ${a.label}`); await onCreated("account", a.id, state.at); return;
      }
      if (editAccount) await api.updateAccount(editAccount.id, name.trim(), { login_email: loginEmail.trim() || null, username: username.trim() || null, url: url.trim() || null, notes: editAccount.notes });
      else if (editPerson) await api.updateIdentity(editPerson.identity.id, name.trim());
      else if (editProject) await api.updateProject(editProject.project.id, name.trim(), editProject.project.description);
      onNotify(`Saved ${name.trim()}`); await onSaved();
    } catch (e: unknown) { onNotify(err(e), true); setBusy(false); }
  }
  return <Modal label={title} onClose={onClose} maxWidth={500}><div className="wg-dialog"><h2>{title}</h2>
    {state.kind === "project" && <><p>A project is the product you build — MAKEIT.REAL, CycleTag, DevLedger. It is independent from your email.</p><label>Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="MAKEIT.REAL" /></label></>}
    {state.kind === "identity" && <><p>An identity owns/signs into service accounts. It is not the root of every project.</p><label>Email<input autoFocus type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" /></label><label>Name <span className="muted">optional</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Work" /></label></>}
    {state.kind === "service" && <>{data.people.filter((p) => p.identity.email).length === 0 ? <div className="wg-dialog-warning">Add an email / identity first.</div> : <><p>One GitHub/Vercel/etc. account stays one account. Connect it to every project that uses it.</p><label>Owned by<select value={identityId} onChange={(e) => setIdentityId(e.target.value)}>{data.people.filter((p) => p.identity.email).map((p) => <option key={p.identity.id} value={p.identity.id}>{p.identity.email ?? p.identity.label}</option>)}</select></label><label>Service<input autoFocus value={service} onChange={(e) => setService(e.target.value)} placeholder="GitHub, Vercel, Stripe…" /></label><label>Account label <span className="muted">optional</span><input value={name} onChange={(e) => setName(e.target.value)} /></label><div className="wg-dialog-row"><label>Login email <span className="muted">optional</span><input value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} /></label><label>Username <span className="muted">optional</span><input value={username} onChange={(e) => setUsername(e.target.value)} /></label></div></>}</>}
    {state.kind === "edit" && <><label>{editKind === "project" ? "Project name" : editKind === "identity" ? "Name" : "Account label"}<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>{editAccount && <><div className="wg-dialog-row"><label>Login email<input value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} /></label><label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} /></label></div><label>URL<input value={url} onChange={(e) => setUrl(e.target.value)} /></label></>}{editPerson && <p className="wg-dialog-note">Email addresses themselves are managed in List view; this changes the identity label.</p>}</>}
    <div className="modal-actions"><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || (state.kind === "identity" ? !email.trim() : state.kind === "service" ? !identityId || !service.trim() : !name.trim())} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button></div>
  </div></Modal>;
}
