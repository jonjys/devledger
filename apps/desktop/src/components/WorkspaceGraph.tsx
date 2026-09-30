import "@xyflow/react/dist/style.css";
import "./WorkspaceGraph.css";

import {
  Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, ReactFlowProvider,
  useNodesState, useReactFlow, type Connection, type Edge, type Node, type NodeMouseHandler,
  type NodeProps, type XYPosition,
} from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import { providerLabel } from "../lib/format";
import { catalogProviders, providerForName, providerInfo } from "../lib/providers";
import type { Account, AccountDetails, LedgerIdentity, ProjectSummary, Provider, ServiceProjectSummary } from "../lib/types";
import Modal from "./Modal";
import ProviderIcon from "./ProviderIcon";
import { ContextMenu, type MenuItem } from "./SkillTreeParts";

interface Props { onNotify: (message: string, bad?: boolean) => void; onChanged: () => void; refreshKey?: number; }
type Kind = "identity" | "account" | "project";
interface NData extends Record<string, unknown> { kind: Kind; label: string; sub: string | null; provider: Provider | null; locked: boolean; }
type GNode = Node<NData, "workspace">;
interface EData extends Record<string, unknown> { kind: "owns" | "project-link"; resourceIds?: string[]; }
type GEdge = Edge<EData>;
interface Data { people: LedgerIdentity[]; resources: ServiceProjectSummary[]; projects: ProjectSummary[]; }
type Dialog = { kind: "project" | "identity" | "service"; at: XYPosition; identityId?: string; service?: string } | { kind: "edit"; nodeId: string };
interface Menu { x: number; y: number; nodeId: string | null; edgeId?: string; at?: XYPosition; }

const POS_KEY = "devledger.workspaceGraph.positions.v1";
const LOCK_KEY = "devledger.workspaceGraph.locked.v1";
const MAX_ZOOM = 1.25;
const msg = (e: unknown) => e instanceof Error ? e.message : String(e);
const nk = (kind: Kind, id: string) => `${kind}:${id}`;
const rawId = (key: string) => key.slice(key.indexOf(":") + 1);
const kindOf = (key: string): Kind | null => { const k = key.slice(0, key.indexOf(":")); return k === "identity" || k === "account" || k === "project" ? k : null; };
const autoPos = (kind: Kind, i: number): XYPosition => ({ x: kind === "identity" ? 70 : kind === "account" ? 410 : 760, y: 90 + i * 112 });
function readPos(): Record<string, XYPosition> { try { return JSON.parse(localStorage.getItem(POS_KEY) ?? "{}"); } catch { return {}; } }
function storePos(v: Record<string, XYPosition>) { try { localStorage.setItem(POS_KEY, JSON.stringify(v)); } catch { /* visual only */ } }
function readLock() { try { return localStorage.getItem(LOCK_KEY) === "1"; } catch { return false; } }
function storeLock(v: boolean) { try { localStorage.setItem(LOCK_KEY, v ? "1" : "0"); } catch { /* session still works */ } }

const NodeView = memo(function NodeView({ data, selected }: NodeProps<GNode>) {
  return <div className={`wg-node ${data.kind}${selected ? " selected" : ""}${data.locked ? " locked" : ""}`}>
    <Handle type="target" position={Position.Left} className="wg-handle" isConnectable={!data.locked} />
    <div className="wg-node-icon">{data.kind === "account" && data.provider ? <ProviderIcon provider={data.provider} size={20} /> : data.kind === "project" ? "◆" : "@"}</div>
    <div className="wg-node-copy"><div className="wg-node-kind">{data.kind === "identity" ? "Identity" : data.kind === "account" ? "Service" : "Project"}</div><div className="wg-node-label">{data.label}</div>{data.sub && <div className="wg-node-sub">{data.sub}</div>}</div>
    <Handle type="source" position={Position.Right} className="wg-handle" isConnectable={!data.locked} />
  </div>;
});
const nodeTypes = { workspace: NodeView };

export default function WorkspaceGraph(props: Props) { return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>; }

function Canvas({ onNotify, onChanged, refreshKey }: Props) {
  const flow = useReactFlow<GNode, GEdge>();
  const [data, setData] = useState<Data | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<GNode>([]);
  const [locked, setLocked] = useState(readLock);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [query, setQuery] = useState("");
  const positions = useRef<Record<string, XYPosition>>(readPos());

  const reload = useCallback(async () => {
    try { const [people, resources, projects] = await Promise.all([api.ledgerOverview(), api.listServiceProjects(), api.listProjects()]); setData({ people, resources, projects }); }
    catch (e: unknown) { onNotify(msg(e), true); }
  }, [onNotify]);
  useEffect(() => { void reload(); }, [reload, refreshKey]);

  const accounts = useMemo(() => {
    const m = new Map<string, { account: Account; owner: LedgerIdentity }>();
    for (const p of data?.people ?? []) for (const a of p.accounts) m.set(a.account.id, { account: a.account, owner: p });
    return m;
  }, [data]);
  const providers = useMemo(() => catalogProviders(), []);
  const shownProviders = useMemo(() => providers.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 20), [providers, query]);

  useEffect(() => {
    if (!data) return;
    const next: GNode[] = [];
    data.people.forEach((p, i) => { const id = nk("identity", p.identity.id); next.push({ id, type: "workspace", position: positions.current[id] ?? autoPos("identity", i), draggable: !locked, data: { kind: "identity", label: p.identity.email ?? p.identity.label, sub: p.identity.email && p.identity.label !== p.identity.email ? p.identity.label : null, provider: null, locked } }); });
    [...accounts.values()].forEach(({ account }, i) => { const id = nk("account", account.id); next.push({ id, type: "workspace", position: positions.current[id] ?? autoPos("account", i), draggable: !locked, data: { kind: "account", label: account.label, sub: account.login_email ?? account.username ?? providerLabel(account.provider), provider: account.provider, locked } }); });
    data.projects.forEach((p, i) => { const id = nk("project", p.project.id); next.push({ id, type: "workspace", position: positions.current[id] ?? autoPos("project", i), draggable: !locked, data: { kind: "project", label: p.project.name, sub: `${p.service_project_count} resources · ${p.secret_count} secrets`, provider: null, locked } }); });
    setNodes(next);
  }, [accounts, data, locked, setNodes]);

  const edges = useMemo<GEdge[]>(() => {
    if (!data) return [];
    const out: GEdge[] = [];
    for (const p of data.people) for (const a of p.accounts) out.push({ id: `owns:${p.identity.id}:${a.account.id}`, source: nk("identity", p.identity.id), target: nk("account", a.account.id), type: "smoothstep", data: { kind: "owns" }, className: "wg-edge owns", selectable: false });
    const links = new Map<string, { account: string; project: string; resources: string[] }>();
    for (const r of data.resources) for (const p of r.used_by) { const id = `${r.service_project.account_id}:${p.id}`; const x = links.get(id) ?? { account: r.service_project.account_id, project: p.id, resources: [] }; x.resources.push(r.service_project.id); links.set(id, x); }
    for (const x of links.values()) out.push({ id: `uses:${x.account}:${x.project}`, source: nk("account", x.account), target: nk("project", x.project), type: "smoothstep", data: { kind: "project-link", resourceIds: x.resources }, className: "wg-edge project-link" });
    return out;
  }, [data]);

  const changed = useCallback(async () => { await reload(); onChanged(); }, [reload, onChanged]);
  const fit = useCallback(() => void flow.fitView({ padding: .18, duration: 300, maxZoom: MAX_ZOOM }), [flow]);
  const lock = useCallback((v: boolean) => { setLocked(v); storeLock(v); setMenu(null); onNotify(v ? "Map locked · moving, editing, connecting and deleting are disabled" : "Map unlocked · edit mode is on"); }, [onNotify]);
  const layout = useCallback(() => {
    if (locked) return; const count: Record<Kind, number> = { identity: 0, account: 0, project: 0 };
    setNodes((all) => all.map((n) => { const position = autoPos(n.data.kind, count[n.data.kind]++); positions.current[n.id] = position; return { ...n, position }; })); storePos(positions.current); setTimeout(fit, 30);
  }, [fit, locked, setNodes]);

  const linkProject = useCallback(async (accountId: string, project: ProjectSummary) => {
    if (!data) return;
    if (data.resources.some((r) => r.service_project.account_id === accountId && r.used_by.some((p) => p.id === project.project.id))) { onNotify(`${project.project.name} is already connected to this service`); return; }
    const spare = data.resources.find((r) => r.service_project.account_id === accountId && r.used_by.length === 0);
    if (spare) await api.linkServiceProject(spare.service_project.id, project.project.id);
    else { const account = accounts.get(accountId)?.account; if (!account) throw new Error("Account not found"); const resource = await api.createServiceProjectManual(account.id, null, account.provider, project.project.name, null, "unknown"); await api.linkServiceProject(resource.id, project.project.id); }
    onNotify(`Connected ${accounts.get(accountId)?.account.label ?? "service"} → ${project.project.name}`); await changed();
  }, [accounts, changed, data, onNotify]);

  const connect = useCallback(async (c: Connection) => {
    if (locked || !data || !c.source || !c.target) return;
    const sk = kindOf(c.source), tk = kindOf(c.target), sid = rawId(c.source), tid = rawId(c.target);
    try {
      if (sk === "identity" && tk === "account") { const a = accounts.get(tid)?.account; if (!a || a.identity_id === sid) return; await api.moveAccount(tid, sid); onNotify(`Connected ${a.label} to the selected identity`); await changed(); return; }
      if (sk === "account" && tk === "project") { const p = data.projects.find((x) => x.project.id === tid); if (p) await linkProject(sid, p); return; }
      if (sk === "project" && tk === "account") { const p = data.projects.find((x) => x.project.id === sid); if (p) await linkProject(tid, p); return; }
      onNotify("Connect identity → service → project. Projects do not live under an email.", true);
    } catch (e: unknown) { onNotify(msg(e), true); }
  }, [accounts, changed, data, linkProject, locked, onNotify]);

  async function unlink(edge: GEdge) {
    if (locked || edge.data?.kind !== "project-link") return;
    try { for (const id of edge.data.resourceIds ?? []) await api.unlinkServiceProject(id, rawId(edge.target)); onNotify("Disconnected from project · provider resources were kept"); await changed(); }
    catch (e: unknown) { onNotify(msg(e), true); }
  }
  async function remove(id: string) {
    if (locked || !data) return; const kind = kindOf(id), raw = rawId(id);
    try {
      if (kind === "account") { const a = accounts.get(raw)?.account; if (!a || !confirm(`Delete ${a.label} and everything stored directly under that account?`)) return; await api.deleteAccount(raw); }
      if (kind === "identity") { const p = data.people.find((x) => x.identity.id === raw); if (!p || !confirm(`Delete ${p.identity.email ?? p.identity.label} and all accounts under it?`)) return; await api.deleteIdentity(raw); }
      if (kind === "project") { const p = data.projects.find((x) => x.project.id === raw); if (!p || !confirm(`Delete project ${p.project.name} and its own variables? Provider resources are kept.`)) return; await api.deleteProject(raw); }
      delete positions.current[id]; storePos(positions.current); setSelected(null); await changed();
    } catch (e: unknown) { onNotify(msg(e), true); }
  }

  function nodeMenu(n: GNode): MenuItem[] {
    if (locked) return [{ label: "Unlock map to edit", onSelect: () => lock(false) }, { label: "Fit map", onSelect: fit }];
    const items: MenuItem[] = [{ label: "Edit", onSelect: () => setDialog({ kind: "edit", nodeId: n.id }) }];
    if (n.data.kind === "identity") items.push({ label: "Add service account", onSelect: () => setDialog({ kind: "service", at: n.position, identityId: rawId(n.id) }) });
    if (n.data.kind === "account" && data) items.push({ label: "Connect to project", items: data.projects.map((p) => ({ label: p.project.name, onSelect: () => void linkProject(rawId(n.id), p) })) });
    if (n.data.kind === "project" && data) items.push({ label: "Connect service", items: [...accounts.values()].map(({ account }) => ({ label: account.label, hint: providerLabel(account.provider), onSelect: () => void linkProject(account.id, data.projects.find((p) => p.project.id === rawId(n.id)) as ProjectSummary) })) });
    items.push({ label: "Delete", danger: true, onSelect: () => void remove(n.id) }); return items;
  }
  const onNodeMenu: NodeMouseHandler<GNode> = (e, n) => { e.preventDefault(); setSelected(n.id); setMenu({ x: e.clientX, y: e.clientY, nodeId: n.id }); };
  const paneMenu: MenuItem[] = locked ? [{ label: "Unlock map to edit", onSelect: () => lock(false) }, { label: "Fit map", onSelect: fit }] : [
    { label: "Add project", onSelect: () => setDialog({ kind: "project", at: menu?.at ?? { x: 760, y: 250 } }) },
    { label: "Add email / identity", onSelect: () => setDialog({ kind: "identity", at: menu?.at ?? { x: 70, y: 250 } }) },
    { label: "Add service", onSelect: () => setDialog({ kind: "service", at: menu?.at ?? { x: 410, y: 250 } }) },
    { label: "Auto layout", onSelect: layout }, { label: "Lock map", onSelect: () => lock(true) },
  ];
  const menuNode = menu?.nodeId ? nodes.find((n) => n.id === menu.nodeId) ?? null : null;
  const menuEdge = menu?.edgeId ? edges.find((e) => e.id === menu.edgeId) ?? null : null;

  if (!data) return <div className="empty">Loading map…</div>;
  return <div className="wg-shell">
    <div className="wg-toolbar"><div className="wg-title"><strong>Workspace map</strong><span>Projects are products. Emails are identities. Services sit between them.</span></div><span className="spacer" /><button className="ghost" onClick={fit}>Fit</button><button className="ghost" onClick={layout} disabled={locked}>Auto layout</button><button className={locked ? "wg-lock locked" : "wg-lock editing"} onClick={() => lock(!locked)}>{locked ? "🔒 Map locked" : "🔓 Editing map"}</button></div>
    <div className="wg-body"><div className="wg-canvas" onContextMenu={(e) => e.preventDefault()}>
      {nodes.length === 0 ? <div className="wg-empty"><strong>Start with a project, an email, or a service.</strong><span>Nothing is forced to be the root. Connect only what actually belongs together.</span></div> : <ReactFlow<GNode, GEdge>
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
        onNodeDragStop={(_, n) => { positions.current[n.id] = n.position; storePos(positions.current); }} onNodeClick={(_, n) => setSelected(n.id)} onPaneClick={() => setSelected(null)} onNodeContextMenu={onNodeMenu}
        onPaneContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, nodeId: null, at: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }) }); }}
        onEdgeContextMenu={(e, edge) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, nodeId: null, edgeId: edge.id }); }} onConnect={(c) => void connect(c)} nodesConnectable={!locked} nodesDraggable={!locked} elementsSelectable minZoom={.25} maxZoom={2.5} fitView fitViewOptions={{ padding: .2, maxZoom: MAX_ZOOM }} proOptions={{ hideAttribution: true }} colorMode="dark">
        <Background variant={BackgroundVariant.Dots} color="#1A1A1A" bgColor="#09090B" gap={22} size={1.4} /><Controls showInteractive={false} position="bottom-left" fitViewOptions={{ padding: .2, maxZoom: MAX_ZOOM }} />
      </ReactFlow>}
    </div><aside className="wg-library" aria-label="Add to map"><div className="wg-library-head"><strong>Add to map</strong><span>Pick, place, connect.</span></div>
      <button className="wg-library-main" disabled={locked} onClick={() => setDialog({ kind: "project", at: autoPos("project", data.projects.length) })}><span className="wg-library-symbol project">◆</span><span><strong>Project</strong><small>Your product, e.g. MAKEIT.REAL</small></span><b>+</b></button>
      <button className="wg-library-main" disabled={locked} onClick={() => setDialog({ kind: "identity", at: autoPos("identity", data.people.length) })}><span className="wg-library-symbol identity">@</span><span><strong>Email / identity</strong><small>{data.people.length} in ledger</small></span><b>+</b></button>
      <div className="wg-library-section"><div className="wg-library-label">Services</div><input type="search" placeholder="Find service…" value={query} onChange={(e) => setQuery(e.target.value)} /><div className="wg-provider-list">{shownProviders.map((p) => <button key={p.provider} disabled={locked} onClick={() => setDialog({ kind: "service", at: autoPos("account", accounts.size), service: p.name })}><ProviderIcon provider={p.provider} size={16} /><span>{p.name}</span><b>+</b></button>)}</div><button className="wg-custom" disabled={locked} onClick={() => setDialog({ kind: "service", at: autoPos("account", accounts.size) })}>+ Custom service</button></div>
      <div className="wg-library-foot"><span>{data.projects.length} projects</span><span>Visual movement never changes relationships.</span></div>
    </aside></div>
    {selected && <div className="wg-selection"><strong>{nodes.find((n) => n.id === selected)?.data.label}</strong><span>{locked ? "Map locked" : "Right-click to edit · drag to arrange · drag a connector to connect"}</span></div>}
    {menu && menuNode && <ContextMenu x={menu.x} y={menu.y} title={menuNode.data.label} items={nodeMenu(menuNode)} onClose={() => setMenu(null)} />}
    {menu && menuEdge && <ContextMenu x={menu.x} y={menu.y} title="Connection" items={locked ? [{ label: "Unlock map to edit", onSelect: () => lock(false) }] : [{ label: "Disconnect", danger: true, onSelect: () => void unlink(menuEdge) }]} onClose={() => setMenu(null)} />}
    {menu && !menuNode && !menuEdge && <ContextMenu x={menu.x} y={menu.y} title="Workspace" items={paneMenu} onClose={() => setMenu(null)} />}
    {dialog && <Editor state={dialog} data={data} accounts={accounts} onClose={() => setDialog(null)} onNotify={onNotify} onCreated={async (kind, id, at) => { positions.current[nk(kind, id)] = at; storePos(positions.current); setDialog(null); await changed(); }} onSaved={async () => { setDialog(null); await changed(); }} />}
  </div>;
}

function Editor({ state, data, accounts, onClose, onNotify, onCreated, onSaved }: {
  state: Dialog; data: Data; accounts: Map<string, { account: Account; owner: LedgerIdentity }>; onClose: () => void; onNotify: Props["onNotify"];
  onCreated: (kind: Kind, id: string, at: XYPosition) => Promise<void>; onSaved: () => Promise<void>;
}) {
  const ek = state.kind === "edit" ? kindOf(state.nodeId) : null, id = state.kind === "edit" ? rawId(state.nodeId) : "";
  const account = ek === "account" ? accounts.get(id)?.account ?? null : null, person = ek === "identity" ? data.people.find((p) => p.identity.id === id) ?? null : null, project = ek === "project" ? data.projects.find((p) => p.project.id === id) ?? null : null;
  const [name, setName] = useState(account?.label ?? person?.identity.label ?? project?.project.name ?? ""), [email, setEmail] = useState(""), [service, setService] = useState(state.kind === "service" ? state.service ?? "" : ""), [identity, setIdentity] = useState(state.kind === "service" ? state.identityId ?? data.people.find((p) => p.identity.email)?.identity.id ?? "" : ""), [login, setLogin] = useState(account?.login_email ?? ""), [username, setUsername] = useState(account?.username ?? ""), [url, setUrl] = useState(account?.url ?? ""), [busy, setBusy] = useState(false);
  const title = state.kind === "project" ? "Add project" : state.kind === "identity" ? "Add email / identity" : state.kind === "service" ? "Add service account" : `Edit ${ek ?? "item"}`;
  async function save() {
    if (busy) return; setBusy(true);
    try {
      if (state.kind === "project") { if (!name.trim()) return setBusy(false); const p = await api.createProject(name.trim(), null); onNotify(`Added project ${p.name}`); return void await onCreated("project", p.id, state.at); }
      if (state.kind === "identity") { if (!email.trim()) return setBusy(false); const p = await api.createIdentityManual(name.trim() || email.trim(), email.trim()); onNotify(`Added ${email.trim()}`); return void await onCreated("identity", p.id, state.at); }
      if (state.kind === "service") { if (!identity || !service.trim()) return setBusy(false); const provider = providerForName(service.trim()), label = name.trim() || providerInfo(provider)?.name || service.trim(); const details: AccountDetails = { login_email: login.trim() || null, username: username.trim() || null, url: null, notes: null }; const a = await api.createAccountManual(identity, provider, label, details); onNotify(`Added ${a.label}`); return void await onCreated("account", a.id, state.at); }
      if (!name.trim()) return setBusy(false);
      if (account) await api.updateAccount(account.id, name.trim(), { login_email: login.trim() || null, username: username.trim() || null, url: url.trim() || null, notes: account.notes }); else if (person) await api.updateIdentity(person.identity.id, name.trim()); else if (project) await api.updateProject(project.project.id, name.trim(), project.project.description); onNotify(`Saved ${name.trim()}`); await onSaved();
    } catch (e: unknown) { onNotify(msg(e), true); setBusy(false); }
  }
  return <Modal label={title} onClose={onClose} maxWidth={500}><div className="wg-dialog"><h2>{title}</h2>
    {state.kind === "project" && <><p>A project is the product you build — MAKEIT.REAL, CycleTag, DevLedger. It is independent from your email.</p><label>Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="MAKEIT.REAL" /></label></>}
    {state.kind === "identity" && <><p>An identity owns/signs into service accounts. It is not the root of every project.</p><label>Email<input autoFocus type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label><label>Name <span className="muted">optional</span><input value={name} onChange={(e) => setName(e.target.value)} /></label></>}
    {state.kind === "service" && <>{data.people.filter((p) => p.identity.email).length === 0 ? <div className="wg-dialog-warning">Add an email / identity first.</div> : <><p>One GitHub/Vercel/etc. account stays one account. Connect it to every project that uses it.</p><label>Owned by<select value={identity} onChange={(e) => setIdentity(e.target.value)}>{data.people.filter((p) => p.identity.email).map((p) => <option key={p.identity.id} value={p.identity.id}>{p.identity.email}</option>)}</select></label><label>Service<input autoFocus value={service} onChange={(e) => setService(e.target.value)} /></label><label>Account label <span className="muted">optional</span><input value={name} onChange={(e) => setName(e.target.value)} /></label><div className="wg-dialog-row"><label>Login email<input value={login} onChange={(e) => setLogin(e.target.value)} /></label><label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} /></label></div></>}</>}
    {state.kind === "edit" && <><label>{ek === "project" ? "Project name" : ek === "identity" ? "Name" : "Account label"}<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>{account && <><div className="wg-dialog-row"><label>Login email<input value={login} onChange={(e) => setLogin(e.target.value)} /></label><label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} /></label></div><label>URL<input value={url} onChange={(e) => setUrl(e.target.value)} /></label></>}{person && <p className="wg-dialog-note">Email addresses themselves are managed in List view; this changes the identity label.</p>}</>}
    <div className="modal-actions"><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" disabled={busy || (state.kind === "identity" ? !email.trim() : state.kind === "service" ? !identity || !service.trim() : !name.trim())} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button></div>
  </div></Modal>;
}
