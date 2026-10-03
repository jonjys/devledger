import "@xyflow/react/dist/style.css";

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type NodeChange,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import * as api from "../lib/api";
import {
  POS_FIELD,
  PRIMARY_FIELD,
  ballKey,
  besideSpot,
  buildCanvas,
  connectIntent,
  focusLayout,
  formatPos,
  freeSpot,
  isHiddenField,
  isImplicit,
  nearestEmail,
  neighbourhood,
  parseKey,
  posField,
  positions,
  primaryField,
  resourceToLink,
  resourcesToUnlink,
  savedPositions,
  type Ball,
  type CanvasData,
  type Intent,
  type Line,
  type Point,
} from "../lib/canvas";
import { normalizeSecretKind, providerLabel } from "../lib/format";
import { PROVIDERS, providerForName, providerInfo } from "../lib/providers";
import type {
  Account,
  CustomField,
  EntityRef,
  Organization,
  Provider,
  SecretKind,
  SecretListing,
  SecretOwner,
  ServiceProject,
  ServiceProjectSummary,
} from "../lib/types";

import {
  AddDialog,
  BallView,
  ContextMenu,
  Finder,
  KIND_LABEL,
  LineView,
  ballSize,
  type AddKind,
  type AddValues,
  type BallNode,
  type FindEntry,
  type LineData,
  type MenuItem,
} from "./CanvasParts";
import ProviderIcon from "./ProviderIcon";

interface Props {
  onNotify: (message: string, bad?: boolean) => void;
  onChanged: () => void;
  refreshKey?: number;
  /** Show only this project and what it is connected to. */
  projectId?: string | null;
  /** Open a project's own page. */
  onOpenProject?: (projectId: string) => void;
}

const nodeTypes = { ball: BallView };
const edgeTypes = { line: LineView };
// The margin is per side, as a share of the view. Fitting a map of one ball
// would otherwise zoom it to fill the screen.
const FIT = { padding: 0.15, maxZoom: 1.1 };
const LOCK_KEY = "devledger.mapLocked";
const KIND_ORDER: Record<Ball["kind"], number> = { account: 0, org: 1, resource: 2, project: 3, email: 4 };
/** Services offered first, in the right-click menu. */
const COMMON: Provider[] = ["github", "vercel", "supabase", "stripe", "openai", "anthropic", "other:Resend", "other:Cloudflare"];

/** Animated moves, unless the system asks for less motion (or cannot say). */
function motion(ms: number): number {
  if (typeof window.matchMedia !== "function") return 0;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : ms;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The layout lock as last left, or null on a fresh install. */
function readLocked(): boolean | null {
  try {
    const v = window.localStorage.getItem(LOCK_KEY);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
}

function writeLocked(locked: boolean) {
  try {
    window.localStorage.setItem(LOCK_KEY, locked ? "1" : "0");
  } catch {
    // The lock just will not be remembered.
  }
}

const ENTITY: Record<Ball["kind"], EntityRef["kind"]> = {
  email: "identity",
  account: "account",
  org: "organization",
  resource: "service_project",
  project: "project",
};

const entityOf = (ball: Ball): EntityRef => ({ kind: ENTITY[ball.kind], id: ball.id });

/** The service's own name for a ball that has one: "Supabase". */
function serviceName(ball: Ball): string {
  return ball.provider ? (providerInfo(ball.provider)?.name ?? providerLabel(ball.provider)) : "";
}

/** What a ball is, in words: "Service", "Supabase organization", "Vercel project". */
function kindLabel(ball: Ball): string {
  if (ball.primary) return "Main email";
  if (ball.kind === "org") return `${serviceName(ball)} organization`;
  if (ball.kind === "resource") return `${serviceName(ball)} project`;
  return KIND_LABEL[ball.kind];
}

interface Loaded extends CanvasData {
  accounts: Map<string, Account>;
  orgs: Map<string, Organization>;
  resourceById: Map<string, ServiceProjectSummary>;
}

async function load(): Promise<Loaded> {
  const [people, projects, resources, secrets, attention, worksOn] = await Promise.all([
    api.ledgerOverview(),
    api.listProjects(),
    api.listServiceProjects(),
    api.listAllSecrets(),
    api.needsAttention(),
    api.identityProjectLinks(),
  ]);
  const fields = new Map<string, CustomField[]>();
  const accounts = new Map<string, Account>();
  const orgs = new Map<string, Organization>();
  const fetches: Promise<unknown>[] = [];
  const fetch = (key: string, entity: EntityRef) =>
    fetches.push(api.customFields(entity).then((f) => fields.set(key, f)));
  for (const p of people) {
    fetch(ballKey("email", p.identity.id), { kind: "identity", id: p.identity.id });
    for (const { account, organizations } of p.accounts) {
      accounts.set(account.id, account);
      fetch(ballKey("account", account.id), { kind: "account", id: account.id });
      for (const { organization } of organizations) {
        orgs.set(organization.id, organization);
        fetch(ballKey("org", organization.id), { kind: "organization", id: organization.id });
      }
    }
  }
  for (const r of resources) {
    fetch(ballKey("resource", r.service_project.id), { kind: "service_project", id: r.service_project.id });
  }
  for (const p of projects) fetch(ballKey("project", p.project.id), { kind: "project", id: p.project.id });
  await Promise.all(fetches);
  return {
    people,
    projects: projects.map((p) => ({ id: p.project.id, name: p.project.name })),
    resources,
    secrets,
    attention,
    fields,
    worksOn: worksOn ?? [],
    accounts,
    orgs,
    resourceById: new Map(resources.map((r) => [r.service_project.id, r])),
  };
}

/** The label a service gets: the registry's spelling of what was typed. */
function serviceLabel(typed: string, provider: Provider): string {
  const info = providerInfo(provider);
  if (info && info.name.toLowerCase() === typed.trim().toLowerCase()) return info.name;
  const t = typed.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * The Ledger as a map you draw.
 *
 * Emails, the services you use and your projects are balls you place where you
 * like; lines between them are what the vault records -- which email owns a
 * service, which services a project runs on. Drag from a ball's port to
 * another ball to connect them, drag services in from the list on the right,
 * right-click anything, double-click to rename. Lock the map and nothing can be
 * moved, connected or deleted until it is unlocked again.
 */
export default function LedgerCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

/** One thing done on the map, and how to take it back and do it again. */
interface Step {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /** Whether the map reloads afterwards. A move does not need to. */
  reload?: boolean;
}
const MAX_STEPS = 50;
/** A line drawn between two balls that means something. */
type Act = Exclude<Intent, { kind: "none" } | { kind: "refuse" }>;

type Dialog = { kind: AddKind; ball: Ball | null; at: Point | null; name?: string; title?: string };
/** A right-click on a ball, a line or the background, or a line dragged from `drop` into empty space. */
type Menu = {
  x: number;
  y: number;
  at: Point;
  ball: string | null;
  line: string | null;
  /** A menu built in advance, e.g. for a line dragged into empty space. */
  title?: string;
  items?: MenuItem[];
};

function Canvas({ onNotify, onChanged, refreshKey, projectId = null, onOpenProject }: Props) {
  const flow = useReactFlow();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<Loaded | null>(null);
  // Locked unless someone chose otherwise: a map that has been drawn should
  // not change by accident. The one exception is an empty map, which is
  // being set up -- see the effect below.
  const [stored] = useState(readLocked);
  const [locked, setLocked] = useState(stored ?? true);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedLine, setSelectedLine] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [finder, setFinder] = useState(false);
  const [help, setHelp] = useState(false);
  // Where balls have been dragged this session, on top of what the vault says.
  const [moved, setMoved] = useState<Map<string, Point>>(new Map());
  const [nodes, setNodes] = useState<BallNode[]>([]);

  const reload = useCallback(async () => {
    try {
      setData(await load());
      setMoved(new Map());
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }, [onNotify]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const changed = useCallback(async () => {
    await reload();
    onChanged();
  }, [reload, onChanged]);

  // --- the model ------------------------------------------------------------------

  const model = useMemo(() => (data ? buildCanvas(data) : { balls: [], lines: [] }), [data]);

  // First run: nothing to protect yet, so start in edit mode. The choice is
  // not remembered, so the next start is locked like any other.
  const setupChecked = useRef(false);
  useEffect(() => {
    if (!data || setupChecked.current) return;
    setupChecked.current = true;
    if (stored === null && model.balls.length === 0) setLocked(false);
  }, [data, model, stored]);
  const projectKey = projectId ? ballKey("project", projectId) : null;
  const shown = useMemo(() => (projectKey ? neighbourhood(model.lines, projectKey) : null), [model, projectKey]);
  const balls = useMemo(() => (shown ? model.balls.filter((b) => shown.has(b.key)) : model.balls), [model, shown]);
  const lines = useMemo(
    () => (shown ? model.lines.filter((l) => shown.has(l.source) && shown.has(l.target)) : model.lines),
    [model, shown],
  );
  const byKey = useMemo(() => new Map(model.balls.map((b) => [b.key, b])), [model]);

  const place = useMemo(() => {
    const base =
      projectKey && data
        ? focusLayout(balls, lines, projectKey)
        : data
          ? positions(model.balls, savedPositions(data, model.balls))
          : new Map<string, Point>();
    for (const [k, p] of moved) base.set(k, p);
    return base;
  }, [data, model, balls, lines, projectKey, moved]);

  const lit = useMemo(() => (selected ? neighbourhood(model.lines, selected) : null), [model, selected]);

  // Nodes are memoised; they call the latest `rename` through a ref so a
  // rename never works on the data as it was when the ball was drawn.
  const renameRef = useRef<(key: string, value: string | null) => Promise<void>>(async () => undefined);
  const onRename = useCallback((key: string, value: string | null) => void renameRef.current(key, value), []);

  useEffect(() => {
    setNodes((prev) => {
      // A box- or shift-selection belongs to xyflow; keep it across redraws.
      const picked = new Set(locked ? [] : prev.filter((n) => n.selected).map((n) => n.id));
      return balls.map((b) => {
        const size = ballSize(b);
        return {
          id: b.key,
          type: "ball" as const,
          position: place.get(b.key) ?? { x: 0, y: 0 },
          // A size to draw with until the ball has been measured: xyflow hides
          // a node it has no size for.
          initialWidth: size,
          initialHeight: size,
          draggable: !locked && renaming !== b.key,
          selectable: !locked,
          selected: picked.has(b.key),
          data: {
            ball: b,
            selected: selected === b.key,
            dim: lit !== null && !lit.has(b.key),
            renaming: renaming === b.key,
            locked,
            onRename,
          },
        };
      });
    });
  }, [balls, place, selected, lit, renaming, locked, onRename]);

  const edges: Edge<LineData>[] = useMemo(
    () =>
      lines.map((l) => ({
        id: l.key,
        source: l.source,
        target: l.target,
        sourceHandle: "c",
        targetHandle: "in",
        type: "line",
        selectable: false,
        data: {
          kind: l.kind,
          lit: lit !== null && lit.has(l.source) && lit.has(l.target),
          dim: lit !== null && !(lit.has(l.source) && lit.has(l.target)),
          selected: selectedLine === l.key,
        },
      })),
    [lines, lit, selectedLine],
  );

  // Bring the whole map into view when it first has something on it. A
  // project's page lays itself out, so it refits as services are added; the
  // big map does not, because the user just put the new ball where they wanted.
  // Only once the balls have been measured: fitting earlier works from sizes
  // the canvas does not have yet and zooms far out.
  const shape = projectKey ? `${projectKey}|${balls.length}` : `map|${balls.length > 0}`;
  const measured = useNodesInitialized();
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (balls.length === 0 || !measured || fitted.current === shape) return;
    fitted.current = shape;
    // A frame later, once the canvas has also taken in its own size.
    const frame = window.requestAnimationFrame(() => void flow.fitView({ ...FIT, duration: motion(300) }));
    return () => window.cancelAnimationFrame(frame);
  }, [shape, measured, balls.length, flow]);

  // A project's page is laid out for it, so it is refitted when its box changes
  // size -- which it does while the page around it is still settling.
  useEffect(() => {
    const el = wrapRef.current?.querySelector(".cv-flow");
    if (!projectKey || !el || typeof ResizeObserver === "undefined") return;
    let last = "";
    const observer = new ResizeObserver(([entry]) => {
      const size = entry ? `${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}` : "";
      if (size === last) return;
      last = size;
      window.requestAnimationFrame(() => void flow.fitView(FIT));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [projectKey, flow, data]);

  // --- history ----------------------------------------------------------------------

  // Undo and redo run long after the step was recorded, so everything they
  // touch reads the vault as it is now, through these, not as it was then.
  const dataRef = useRef(data);
  dataRef.current = data;
  const byKeyRef = useRef(byKey);
  byKeyRef.current = byKey;
  const labelOf = (kind: Ball["kind"], id: string) => byKeyRef.current.get(ballKey(kind, id))?.label ?? "";

  const history = useRef<{ past: Step[]; future: Step[] }>({ past: [], future: [] });
  const replaying = useRef(false);
  const [, setHistoryTick] = useState(0);

  function record(step: Step) {
    if (replaying.current) return;
    const h = history.current;
    h.past = [...h.past, step].slice(-MAX_STEPS);
    h.future = [];
    setHistoryTick((t) => t + 1);
  }

  async function travel(back: boolean) {
    if (locked) return;
    const h = history.current;
    const step = back ? h.past.pop() : h.future.pop();
    if (!step) return;
    replaying.current = true;
    try {
      await (back ? step.undo() : step.redo());
      (back ? h.future : h.past).push(step);
      onNotify(`${back ? "Undid" : "Redid"} ${step.label}`);
    } catch (e: unknown) {
      onNotify(`Could not ${back ? "undo" : "redo"} ${step.label}: ${message(e)}`, true);
    } finally {
      replaying.current = false;
      setHistoryTick((t) => t + 1);
    }
    if (step.reload !== false) await changed();
  }

  // --- saving positions -------------------------------------------------------------

  async function savePosition(key: string, p: Point) {
    const d = dataRef.current;
    const ball = byKeyRef.current.get(key);
    if (!ball || !d || projectKey) return;
    const existing = posField(d, key);
    try {
      if (existing) {
        await api.updateCustomField(existing.id, POS_FIELD, formatPos(p));
      } else {
        const created = await api.addCustomField(entityOf(ball), POS_FIELD, formatPos(p));
        setData((cur) => {
          if (!cur) return cur;
          const fields = new Map(cur.fields);
          fields.set(key, [...(fields.get(key) ?? []), created]);
          return { ...cur, fields };
        });
      }
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  async function setPositions(to: Map<string, Point>) {
    setMoved((m) => {
      const next = new Map(m);
      for (const [k, p] of to) next.set(k, p);
      return next;
    });
    for (const [k, p] of to) await savePosition(k, p);
  }

  /** Put a ball that was just created where it was dropped. */
  async function placeNew(entity: EntityRef, at: Point | null) {
    if (!at || projectKey) return;
    try {
      await api.addCustomField(entity, POS_FIELD, formatPos(at));
    } catch {
      // It was made; it just lands in its column instead of where it was dropped.
    }
  }

  // --- lookups ----------------------------------------------------------------------

  const secretsOf = useCallback(
    (ball: Ball): SecretListing[] => {
      if (!data) return [];
      if (ball.kind === "project") return data.secrets.filter((s) => s.entry.secret.project_id === ball.id);
      if (ball.kind === "resource") return data.secrets.filter((s) => s.entry.secret.service_project_id === ball.id);
      if (ball.kind !== "account") return [];
      const mine = new Set(
        data.resources.filter((r) => r.service_project.account_id === ball.id).map((r) => r.service_project.id),
      );
      return data.secrets.filter(
        (s) =>
          s.entry.secret.account_id === ball.id ||
          (s.entry.secret.service_project_id !== null && mine.has(s.entry.secret.service_project_id)),
      );
    },
    [data],
  );

  const namedFields = useCallback(
    (ball: Ball): CustomField[] => (data?.fields.get(ball.key) ?? []).filter((f) => !isHiddenField(f.label)),
    [data],
  );

  const emails = useMemo(() => model.balls.filter((b) => b.kind === "email" && !b.noEmail), [model]);
  const projectBalls = useMemo(() => model.balls.filter((b) => b.kind === "project"), [model]);
  const accountBalls = useMemo(() => model.balls.filter((b) => b.kind === "account"), [model]);
  const orgBalls = useMemo(() => model.balls.filter((b) => b.kind === "org"), [model]);
  const resourceBalls = useMemo(() => model.balls.filter((b) => b.kind === "resource"), [model]);
  const ownerOf = (accountId: string) => {
    const owner = data?.accounts.get(accountId)?.identity_id;
    return owner ? byKey.get(ballKey("email", owner)) ?? null : null;
  };

  /** A spot near the middle of what is on screen that nothing sits on. */
  function spotInView(): Point {
    const rect = wrapRef.current?.getBoundingClientRect();
    const centre = rect
      ? flow.screenToFlowPosition({ x: rect.left + rect.width * 0.42, y: rect.top + rect.height / 2 })
      : { x: 0, y: 0 };
    return freeSpot(centre, place.values());
  }

  // --- actions ------------------------------------------------------------------------

  async function connect(a: Ball, b: Ball) {
    if (!dataRef.current) return;
    const intent = connectIntent(a, b, model.lines);
    if (intent.kind === "refuse") {
      onNotify(intent.reason, true);
      return;
    }
    if (intent.kind === "none") return;
    try {
      const step: Step = {
        label: "the new line",
        undo: async () => undefined,
        redo: async () => {
          step.undo = await apply(intent);
        },
      };
      step.undo = await apply(intent);
      record(step);
      await changed();
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  /** Carry out what a line means. Returns how to take it back. */
  async function apply(intent: Act): Promise<() => Promise<void>> {
    const d = dataRef.current;
    if (!d) throw new Error("The vault is not open.");
    switch (intent.kind) {
      case "own": {
        const before = d.accounts.get(intent.accountId)?.identity_id;
        await api.moveAccount(intent.accountId, intent.identityId);
        onNotify(`${labelOf("account", intent.accountId)} now belongs to ${labelOf("email", intent.identityId)}`);
        return async () => {
          if (before) await api.moveAccount(intent.accountId, before);
        };
      }
      case "use": {
        const made = await use(intent.accountId, intent.projectId);
        return async () => {
          if (made.created) await api.deleteServiceProject(made.resourceId);
          else await api.unlinkServiceProject(made.resourceId, intent.projectId);
        };
      }
      case "link": {
        await api.linkServiceProject(intent.resourceId, intent.projectId);
        // The line straight to the service said less than this one does. If
        // nothing is stored on what that line stood for, it goes.
        const account = d.resourceById.get(intent.resourceId)?.service_project.account_id;
        const dropped: ServiceProject[] = [];
        for (const r of account ? resourcesToUnlink(d, account, intent.projectId) : []) {
          if (!r.remove) continue;
          const sp = d.resourceById.get(r.id)?.service_project;
          await api.deleteServiceProject(r.id);
          if (sp) dropped.push(sp);
        }
        onNotify(`${labelOf("project", intent.projectId)} now runs on ${labelOf("resource", intent.resourceId)}`);
        return async () => {
          await api.unlinkServiceProject(intent.resourceId, intent.projectId);
          for (const sp of dropped) await relink(sp, intent.projectId);
        };
      }
      case "work":
        await api.linkIdentityProject(intent.identityId, intent.projectId);
        onNotify(`${labelOf("email", intent.identityId)} works on ${labelOf("project", intent.projectId)}`);
        return () => api.unlinkIdentityProject(intent.identityId, intent.projectId);
      case "moveOrg": {
        const before = d.orgs.get(intent.organizationId)?.account_id;
        await api.moveOrganization(intent.organizationId, intent.accountId);
        onNotify(`${labelOf("org", intent.organizationId)} is now under ${labelOf("account", intent.accountId)}`);
        return async () => {
          if (before) await api.moveOrganization(intent.organizationId, before);
        };
      }
      case "place": {
        const r = d.resourceById.get(intent.resourceId)?.service_project;
        if (!r) throw new Error("That project is no longer in your vault.");
        await placeResource(r.id, r.account_id, intent.accountId, intent.organizationId);
        const into = intent.organizationId ? labelOf("org", intent.organizationId) : labelOf("account", intent.accountId);
        onNotify(`${r.name} is now in ${into}`);
        return () => placeResource(r.id, intent.accountId, r.account_id, r.organization_id);
      }
    }
  }

  /** Put a resource under an organization, or straight under an account. */
  const placeResource = (id: string, fromAccount: string, toAccount: string, organizationId: string | null) =>
    fromAccount === toAccount
      ? api.assignOrganization(id, organizationId)
      : api.moveServiceProject(id, toAccount, organizationId);

  /** Bring back a resource a line stood for, and the line. */
  async function relink(sp: ServiceProject, projectId_: string) {
    const again = await api.createServiceProjectManual(sp.account_id, null, sp.provider, sp.name, null, sp.environment);
    await api.linkServiceProject(again.id, projectId_);
  }

  /**
   * Record that a project runs on a service: a resource under the account,
   * linked. `fresh` is an account created a moment ago, not in the data yet.
   */
  async function use(accountId: string, projectId_: string, fresh?: Account) {
    const d = dataRef.current;
    const account = fresh ?? d?.accounts.get(accountId);
    const project = d?.projects.find((p) => p.id === projectId_);
    if (!d || !account || !project) throw new Error("That service or project is no longer in your vault.");
    const existing = resourceToLink(d, accountId, project.name);
    const resourceId =
      existing ??
      (await api.createServiceProjectManual(accountId, null, account.provider, project.name, null, "unknown")).id;
    await api.linkServiceProject(resourceId, project.id);
    onNotify(`${project.name} now uses ${account.label}`);
    return { resourceId, created: existing === null };
  }

  async function removeLine(line: Line) {
    if (!dataRef.current || locked) return;
    const b = byKey.get(line.target)?.label;
    if (line.kind === "owns") {
      onNotify("A service always belongs to one email. Draw a line from it to another email to move it.");
      return;
    }
    if (line.kind === "holds" && parseKey(line.source)?.kind !== "org") {
      onNotify(
        parseKey(line.target)?.kind === "org"
          ? `${b} always belongs to a service. Draw it to another account to move it, or delete it.`
          : `${b} always belongs to a service. Draw it to an organization to put it there, or delete it.`,
      );
      return;
    }
    try {
      const step: Step = {
        label: "removing the line",
        undo: async () => undefined,
        redo: async () => {
          step.undo = await detach(line);
        },
      };
      step.undo = await detach(line);
      record(step);
      setSelectedLine(null);
      await changed();
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  /** Take a line away. Returns how to put it back. */
  async function detach(line: Line): Promise<() => Promise<void>> {
    const d = dataRef.current;
    const from = parseKey(line.source);
    const to = parseKey(line.target);
    if (!d || !from || !to) throw new Error("That line is no longer on the map.");
    const a = labelOf(from.kind, from.id);
    const b = labelOf(to.kind, to.id);
    if (line.kind === "works") {
      await api.unlinkIdentityProject(from.id, to.id);
      onNotify(`${a} no longer works on ${b}`);
      return () => api.linkIdentityProject(from.id, to.id);
    }
    if (line.kind === "holds") {
      await api.assignOrganization(to.id, null);
      onNotify(`${b} is no longer in ${a}`);
      return () => api.assignOrganization(to.id, from.id);
    }
    if (to.kind === "resource") {
      await api.unlinkServiceProject(to.id, from.id);
      onNotify(`${a} no longer runs on ${b}`);
      return () => api.linkServiceProject(to.id, from.id);
    }
    const touched = resourcesToUnlink(d, to.id, from.id);
    const gone: ServiceProject[] = [];
    for (const r of touched) {
      if (r.remove) {
        const sp = d.resourceById.get(r.id)?.service_project;
        await api.deleteServiceProject(r.id);
        if (sp) gone.push(sp);
      } else {
        await api.unlinkServiceProject(r.id, from.id);
      }
    }
    onNotify(`${a} no longer uses ${b}`);
    return async () => {
      for (const r of touched) if (!r.remove) await api.linkServiceProject(r.id, from.id);
      for (const sp of gone) await relink(sp, from.id);
    };
  }

  /** A step that takes back something just added, while nothing is stored on it. */
  function added(label: string, kind: Ball["kind"], id: string, again: () => Promise<string | null>): Step {
    let current = id;
    return {
      label: `adding ${label}`,
      undo: () => removeIfEmpty(kind, current, label),
      redo: async () => {
        const next = await again();
        if (next) current = next;
      },
    };
  }

  /** Delete something undo is taking back -- unless it now holds something. */
  async function removeIfEmpty(kind: Ball["kind"], id: string, label: string) {
    const d = dataRef.current;
    if (!d) throw new Error("The vault is not open.");
    const busy = new Error(`${label} holds things now. Delete it from its menu instead.`);
    switch (kind) {
      case "email":
        if ([...d.accounts.values()].some((a) => a.identity_id === id)) throw busy;
        await api.deleteIdentity(id);
        return;
      case "account": {
        const holds =
          d.secrets.some((s) => s.entry.secret.account_id === id) ||
          [...d.orgs.values()].some((o) => o.account_id === id) ||
          d.resources.some(
            (r) => r.service_project.account_id === id && (r.secret_count > 0 || !isImplicit(r)),
          );
        if (holds) throw busy;
        await api.deleteAccount(id);
        return;
      }
      case "org":
        if (d.resources.some((r) => r.service_project.organization_id === id)) throw busy;
        await api.deleteOrganization(id);
        return;
      case "resource":
        if ((d.resourceById.get(id)?.secret_count ?? 0) > 0) throw busy;
        await api.deleteServiceProject(id);
        return;
      case "project": {
        if (d.secrets.some((s) => s.entry.secret.project_id === id)) throw busy;
        // The resources only its own lines stood for go with it.
        for (const r of d.resources) {
          if (isImplicit(r) && r.secret_count === 0 && r.used_by[0]?.id === id) {
            await api.deleteServiceProject(r.service_project.id);
          }
        }
        await api.deleteProject(id);
        return;
      }
    }
  }

  async function addService(
    provider: Provider,
    typed: string,
    at: Point | null,
    owner: Ball | null = null,
    forProject: string | null = projectId,
  ): Promise<string | null> {
    if (locked) return null;
    const spot = at ?? spotInView();
    const to = owner ?? nearestEmail(emails, place, spot);
    if (!to) {
      onNotify("Add your email first: every service belongs to an email.");
      setDialog({ kind: "email", ball: null, at: freeSpot({ x: spot.x - 300, y: spot.y }, place.values()) });
      return null;
    }
    try {
      const label = serviceLabel(typed, provider);
      const account = await api.createAccountManual(to.id, provider, label);
      await placeNew({ kind: "account", id: account.id }, spot);
      if (forProject) await use(account.id, forProject, account);
      else onNotify(`Added ${label} under ${to.label} · draw a line to another email to move it`);
      record(added(label, "account", account.id, () => addService(provider, typed, spot, to, forProject)));
      // The list stays open, so several services can be added in a row.
      await changed();
      return account.id;
    } catch (e: unknown) {
      onNotify(message(e), true);
      return null;
    }
  }

  /** Add what a dialog asked for. Returns the new thing's id, where it is a ball. */
  async function add(d: Dialog, values: AddValues): Promise<string | null> {
    const cur = dataRef.current;
    let made: { kind: Ball["kind"]; id: string; label: string } | null = null;
    switch (d.kind) {
      case "email": {
        const identity = await api.createIdentityManual(values.label || values.name, values.name);
        await placeNew({ kind: "identity", id: identity.id }, d.at);
        onNotify(`Added ${values.name}`);
        made = { kind: "email", id: identity.id, label: values.name };
        break;
      }
      case "project": {
        const existing = cur?.projects.find((p) => p.name.toLowerCase() === values.name.toLowerCase());
        if (existing) throw new Error(`There is already a project called ${existing.name}.`);
        const project = await api.createProject(values.name, null);
        await placeNew({ kind: "project", id: project.id }, d.at);
        if (d.ball?.kind === "resource") {
          await api.linkServiceProject(d.ball.id, project.id);
        } else if (d.ball?.kind === "account") {
          const resource = await api.createServiceProjectManual(
            d.ball.id,
            null,
            cur?.accounts.get(d.ball.id)?.provider ?? "unknown",
            project.name,
            null,
            "unknown",
          );
          await api.linkServiceProject(resource.id, project.id);
        }
        onNotify(`Added ${project.name} · draw a line from it to each service it runs on`);
        made = { kind: "project", id: project.id, label: project.name };
        break;
      }
      case "service":
        setDialog(null);
        return addService(
          providerForName(values.name),
          values.name,
          d.at,
          d.ball?.kind === "email" ? d.ball : null,
          d.ball?.kind === "project" ? d.ball.id : projectId,
        );
      case "org": {
        const account = d.ball ? cur?.accounts.get(d.ball.id) : undefined;
        if (!account) return null;
        const taken = [...(cur?.orgs.values() ?? [])].find(
          (o) => o.account_id === account.id && o.name.toLowerCase() === values.name.toLowerCase(),
        );
        if (taken) throw new Error(`${account.label} already has an organization called ${taken.name}.`);
        const org = await api.createOrganization(account.id, values.name);
        await placeNew({ kind: "organization", id: org.id }, d.at);
        onNotify(`Added ${org.name} in ${account.label} · drag from it to add its projects`);
        made = { kind: "org", id: org.id, label: org.name };
        break;
      }
      case "resource": {
        const org = d.ball?.kind === "org" ? cur?.orgs.get(d.ball.id) : undefined;
        const account = cur?.accounts.get(org?.account_id ?? d.ball?.id ?? "");
        if (!account) return null;
        const taken = cur?.resources.find(
          (r) =>
            r.service_project.account_id === account.id &&
            r.service_project.name.toLowerCase() === values.name.toLowerCase(),
        );
        if (taken) throw new Error(`${account.label} already has a project called ${taken.service_project.name}.`);
        const resource = await api.createServiceProjectManual(
          account.id,
          org?.id ?? null,
          account.provider,
          values.name,
          null,
          "unknown",
        );
        if (values.label) {
          await api.updateResource(resource.id, {
            name: resource.name,
            provider_ref: null,
            region: values.label,
            environment: resource.environment,
            url: null,
            notes: null,
          });
        }
        await placeNew({ kind: "service_project", id: resource.id }, d.at);
        onNotify(`Added ${resource.name} in ${org?.name ?? account.label} · draw a line from your project to it`);
        made = { kind: "resource", id: resource.id, label: resource.name };
        break;
      }
      case "api":
      case "password":
      case "secret": {
        if (!d.ball) return null;
        const owner: SecretOwner = {
          project_id: d.ball.kind === "project" ? d.ball.id : null,
          service_project_id: d.ball.kind === "resource" ? d.ball.id : null,
          account_id: d.ball.kind === "account" ? d.ball.id : null,
        };
        const kind = d.kind === "api" ? "generic_api_key" : d.kind === "password" ? "password" : "env_var";
        await api.storeSecret({ owner, kind, name: values.name, environment: "unknown", notes: null }, values.value);
        onNotify(`Saved ${values.name} · encrypted in your vault`);
        break;
      }
      case "field":
        if (!d.ball) return null;
        await api.addCustomField(entityOf(d.ball), values.name, values.value);
        onNotify(`Added ${values.name}`);
        break;
    }
    setDialog(null);
    if (made) {
      const what = made;
      record(added(what.label, what.kind, what.id, () => add(d, values)));
    }
    await changed();
    return made?.id ?? null;
  }

  /** What a ball is called now, in the terms a rename to `value` would change. */
  function nameOf(kind: Ball["kind"], id: string, value: string): string | null {
    const d = dataRef.current;
    if (!d) return null;
    switch (kind) {
      case "email": {
        const person = d.people.find((p) => p.identity.id === id)?.identity;
        return (value.includes("@") ? person?.email : person?.label) ?? null;
      }
      case "account":
        return d.accounts.get(id)?.label ?? null;
      case "org":
        return d.orgs.get(id)?.name ?? null;
      case "resource":
        return d.resourceById.get(id)?.service_project.name ?? null;
      case "project":
        return d.projects.find((p) => p.id === id)?.name ?? null;
    }
  }

  /** Rename to `value`. For an email, a value with an @ is a new address and anything else the person's name. */
  async function renameTo(kind: Ball["kind"], id: string, value: string) {
    const d = dataRef.current;
    if (!d) throw new Error("The vault is not open.");
    switch (kind) {
      case "email": {
        if (value.includes("@")) {
          const current = d.people.find((p) => p.identity.id === id)?.identity.email;
          // A new address: add it as the person's main one, drop the old.
          const old = (await api.identityEmails(id)).find((e) => e.address === current);
          await api.addIdentityEmail(id, value, true);
          if (old) await api.removeIdentityEmail(id, old.id);
        } else {
          await api.updateIdentity(id, value);
        }
        return;
      }
      case "account": {
        const account = d.accounts.get(id);
        if (!account) throw new Error("That service is no longer in your vault.");
        await api.updateAccount(id, value, {
          login_email: account.login_email,
          username: account.username,
          url: account.url,
          notes: account.notes,
        });
        return;
      }
      case "org":
        await api.renameOrganization(id, value);
        return;
      case "resource": {
        const r = d.resourceById.get(id)?.service_project;
        if (!r) throw new Error("That project is no longer in your vault.");
        await api.updateResource(id, {
          name: value,
          provider_ref: r.provider_ref,
          region: r.region,
          environment: r.environment,
          url: r.url,
          notes: r.notes,
        });
        return;
      }
      case "project":
        await api.updateProject(id, value, null);
        return;
    }
  }

  async function rename(key: string, raw: string | null) {
    setRenaming(null);
    const ball = byKey.get(key);
    const value = raw?.trim();
    if (!ball || !value || locked) return;
    const before = nameOf(ball.kind, ball.id, value);
    if (before === null || before === value) return;
    try {
      await renameTo(ball.kind, ball.id, value);
      record({
        label: `renaming ${before}`,
        undo: () => renameTo(ball.kind, ball.id, before),
        redo: () => renameTo(ball.kind, ball.id, value),
      });
      onNotify(`Renamed to ${value}`);
      await changed();
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }
  renameRef.current = rename;

  async function remove(ball: Ball) {
    if (locked) return;
    try {
      if (ball.kind === "email") {
        const n = accountBalls.filter((a) => ownerOf(a.id)?.key === ball.key).length;
        const what = n > 0 ? ` and the ${n === 1 ? "service" : `${n} services`} under it` : "";
        if (!window.confirm(`Delete ${ball.label}${what}? This cannot be undone.`)) return;
        await api.deleteIdentity(ball.id);
      } else if (ball.kind === "account") {
        const n = secretsOf(ball).length;
        const what = n > 0 ? ` and the ${n === 1 ? "key" : `${n} keys`} stored under it` : "";
        if (!window.confirm(`Delete ${ball.label}${what}? This cannot be undone.`)) return;
        await api.deleteAccount(ball.id);
      } else if (ball.kind === "org") {
        const n = resourceBalls.filter((r) => r.parent === ball.key).length;
        const what = n > 0 ? ` The ${n === 1 ? "project" : `${n} projects`} in it stay, directly under ${serviceName(ball)}.` : "";
        if (!window.confirm(`Delete the organization ${ball.label}?${what}`)) return;
        await api.deleteOrganization(ball.id);
      } else if (ball.kind === "resource") {
        const n = secretsOf(ball).length;
        const what = n > 0 ? ` and the ${n === 1 ? "key" : `${n} keys`} stored on it` : "";
        if (!window.confirm(`Delete ${ball.label}${what} from your vault? This cannot be undone.`)) return;
        await api.deleteServiceProject(ball.id);
      } else {
        if (!window.confirm(`Delete the project ${ball.label} and its own variables? This cannot be undone.`)) return;
        await api.deleteProject(ball.id);
      }
      if (selected === ball.key) setSelected(null);
      onNotify(`Deleted ${ball.label}`);
      await changed();
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  async function makePrimary(ball: Ball) {
    if (!data) return;
    try {
      const current = primaryField(data);
      await api.addCustomField({ kind: "identity", id: ball.id }, PRIMARY_FIELD, current?.value ?? "{}");
      if (current) await api.deleteCustomField(current.id);
      onNotify(`${ball.label} is now your main email`);
      await changed();
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  async function copySecret(listing: SecretListing) {
    try {
      // Rust writes the value to the clipboard; it never enters JavaScript.
      await api.copySecret(listing.entry.secret.id);
      onNotify(`Copied ${listing.entry.secret.name} · clipboard clears in 30 seconds`);
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  async function copyText(label: string, text: string) {
    try {
      await writeText(text);
      onNotify(`Copied ${label}`);
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  function toggleLock() {
    const next = !locked;
    setLocked(next);
    writeLocked(next);
    setRenaming(null);
    onNotify(
      next
        ? "Layout locked: nothing can be moved, connected or deleted"
        : "Editing the map: drag, connect, rename and delete. Press Done when you are finished.",
    );
  }

  function focusOn(key: string) {
    setSelected(key);
    const p = place.get(key);
    if (p) void flow.setCenter(p.x, p.y, { zoom: Math.max(flow.getZoom(), 0.9), duration: motion(400) });
  }

  // --- menus --------------------------------------------------------------------------

  const serviceItems = (at: Point, owner: Ball | null): MenuItem[] => [
    ...COMMON.map((p) => {
      const info = providerInfo(p);
      return { label: info?.name ?? p, onSelect: () => void addService(p, info?.name ?? p, at, owner) };
    }),
    { label: "Other…", onSelect: () => setDialog({ kind: "service", ball: owner, at }) },
  ];

  function paneMenu(at: Point): { title: string; items: MenuItem[] } {
    const items: MenuItem[] = [];
    if (!locked) {
      if (!projectKey) items.push({ label: "Add email here", onSelect: () => setDialog({ kind: "email", ball: null, at }) });
      items.push({ label: "Add service here", items: serviceItems(at, null) });
      if (!projectKey) items.push({ label: "Add project here", onSelect: () => setDialog({ kind: "project", ball: null, at }) });
    }
    items.push({ label: "Find…", hint: "⌘K", onSelect: () => setFinder(true) });
    items.push({ label: "Fit to screen", onSelect: () => void flow.fitView({ ...FIT, duration: motion(300) }) });
    items.push({ label: locked ? "Edit map" : "Done editing", onSelect: toggleLock });
    return { title: "Map", items };
  }

  /** The add dialog for a project inside a service or organization. */
  const resourceDialog = (holder: Ball, at: Point | null): Dialog => ({
    kind: "resource",
    ball: holder,
    at,
    title: `Add a ${serviceName(holder)} project`,
  });

  /** Projects of yours not yet running on `target`, to pick from. */
  function useIn(target: Ball, at: Point): MenuItem {
    const using = new Set(model.lines.filter((l) => l.target === target.key).map((l) => l.source));
    return {
      label: "Use in project",
      items: [
        ...projectBalls.filter((p) => !using.has(p.key)).map((p) => ({ label: p.label, onSelect: () => void connect(target, p) })),
        { label: "New project…", onSelect: () => setDialog({ kind: "project", ball: target, at }) },
      ],
    };
  }

  function ballMenu(ball: Ball): { title: string; items: MenuItem[] } {
    const edit = !locked;
    const items: MenuItem[] = [{ label: "Show details", onSelect: () => setSelected(ball.key) }];
    const del: MenuItem = { label: "Delete", danger: true, onSelect: () => void remove(ball) };
    const rename_: MenuItem = { label: "Rename", hint: "double-click", onSelect: () => setRenaming(ball.key) };
    const field: MenuItem = { label: "Field…", onSelect: () => setDialog({ kind: "field", ball, at: null }) };
    const near = place.get(ball.key) ?? { x: 0, y: 0 };
    const beside = () => besideSpot(near, place.values());
    const keys = secretsOf(ball);
    if (keys.length > 0) {
      items.push({
        label: "Copy",
        items: keys.map((k) => ({ label: k.entry.secret.name, hint: k.entry.secret.preview, onSelect: () => void copySecret(k) })),
      });
    }
    if (ball.kind === "email") {
      if (!ball.noEmail) items.push({ label: "Copy email", onSelect: () => void copyText("the address", ball.label) });
      if (edit) {
        items.push({ label: "Add service", items: serviceItems(freeSpot({ x: near.x + 220, y: near.y }, place.values()), ball) });
        const works = new Set(model.lines.filter((l) => l.kind === "works" && l.source === ball.key).map((l) => l.target));
        items.push({
          label: "Works on",
          items: projectBalls.filter((p) => !works.has(p.key)).map((p) => ({ label: p.label, onSelect: () => void connect(ball, p) })),
        });
        items.push({ label: "Add", items: [field] });
        if (!ball.primary && !ball.noEmail) items.push({ label: "Make main email", onSelect: () => void makePrimary(ball) });
        items.push(rename_, del);
      }
    } else if (ball.kind === "account") {
      if (edit) {
        items.push({
          label: "Add",
          items: [
            { label: "Organization…", onSelect: () => setDialog({ kind: "org", ball, at: beside() }) },
            { label: `Project in ${ball.label}…`, onSelect: () => setDialog(resourceDialog(ball, beside())) },
            { label: "API key…", onSelect: () => setDialog({ kind: "api", ball, at: null }) },
            { label: "Password…", onSelect: () => setDialog({ kind: "password", ball, at: null }) },
            field,
          ],
        });
        items.push(useIn(ball, freeSpot({ x: near.x + 260, y: near.y }, place.values())));
        const owner = ownerOf(ball.id);
        items.push({
          label: "Move to email",
          items: emails.filter((e) => e.key !== owner?.key).map((e) => ({ label: e.label, onSelect: () => void connect(ball, e) })),
        });
        items.push(rename_, del);
      }
    } else if (ball.kind === "org") {
      if (edit) {
        items.push({ label: `Add project in ${ball.label}…`, onSelect: () => setDialog(resourceDialog(ball, beside())) });
        items.push({ label: "Add", items: [field] });
        const others = accountBalls.filter((a) => a.provider === ball.provider && a.key !== ball.parent);
        if (others.length > 0) {
          items.push({
            label: "Move to account",
            items: others.map((a) => ({ label: a.label, hint: ownerOf(a.id)?.label, onSelect: () => void connect(ball, a) })),
          });
        }
        items.push(rename_, del);
      }
    } else if (ball.kind === "resource") {
      if (edit) {
        items.push(useIn(ball, freeSpot({ x: near.x + 240, y: near.y }, place.values())));
        items.push({
          label: "Add",
          items: [
            { label: "API key…", onSelect: () => setDialog({ kind: "api", ball, at: null }) },
            { label: "Variable…", onSelect: () => setDialog({ kind: "secret", ball, at: null }) },
            field,
          ],
        });
        const holder = ball.parent ? byKey.get(ball.parent) : undefined;
        const account = holder?.kind === "org" ? (holder.parent ? byKey.get(holder.parent) : undefined) : holder;
        const moves: MenuItem[] = orgBalls
          .filter((o) => o.provider === ball.provider && o.key !== ball.parent)
          .map((o) => ({ label: o.label, hint: byKey.get(o.parent ?? "")?.label, onSelect: () => void connect(ball, o) }));
        if (holder?.kind === "org" && account) {
          moves.push({ label: `Out of ${holder.label}`, onSelect: () => void connect(ball, account) });
        }
        if (moves.length > 0) items.push({ label: "Move to organization", items: moves });
        items.push(rename_, del);
      }
    } else {
      if (onOpenProject && !projectKey) items.push({ label: "Open project", onSelect: () => onOpenProject(ball.id) });
      if (edit) {
        const used = new Set(model.lines.filter((l) => l.source === ball.key).map((l) => l.target));
        items.push({
          label: "Use a service",
          items: [...accountBalls, ...resourceBalls]
            .filter((a) => !used.has(a.key))
            .map((a) => ({
              label: a.label,
              hint: a.kind === "account" ? ownerOf(a.id)?.label : byKey.get(a.parent ?? "")?.label,
              onSelect: () => void connect(ball, a),
            })),
        });
        const people = new Set(model.lines.filter((l) => l.kind === "works" && l.target === ball.key).map((l) => l.source));
        items.push({
          label: "Who works on it",
          items: model.balls
            .filter((b) => b.kind === "email" && !people.has(b.key))
            .map((b) => ({ label: b.label, onSelect: () => void connect(ball, b) })),
        });
        items.push({
          label: "Add",
          items: [{ label: "Variable…", onSelect: () => setDialog({ kind: "secret", ball, at: null }) }, field],
        });
        items.push(rename_, { ...del, label: "Delete project" });
      }
    }
    return { title: `${kindLabel(ball)} · ${ball.label}`, items };
  }

  /**
   * A line dragged from a ball into empty space: what to add there. Where only
   * one thing makes sense, its form opens straight away.
   */
  function dropOn(from: Ball, at: Point, client: Point) {
    const open = (title: string, items: MenuItem[]) =>
      setMenu({ x: client.x, y: client.y, at, ball: null, line: null, title, items });
    switch (from.kind) {
      case "email":
        open(`New service for ${from.label}`, serviceItems(at, from));
        break;
      case "account":
        open(`Add to ${from.label}`, [
          { label: "Organization…", onSelect: () => setDialog({ kind: "org", ball: from, at }) },
          { label: `Project in ${from.label}…`, onSelect: () => setDialog(resourceDialog(from, at)) },
          { label: "A project of yours that uses it…", onSelect: () => setDialog({ kind: "project", ball: from, at }) },
        ]);
        break;
      case "org":
        setDialog(resourceDialog(from, at));
        break;
      case "resource":
        setDialog({ kind: "project", ball: from, at, title: `Your project that runs on ${from.label}` });
        break;
      case "project":
        open(`A service ${from.label} runs on`, [
          ...COMMON.map((p) => {
            const info = providerInfo(p);
            return { label: info?.name ?? p, onSelect: () => void addService(p, info?.name ?? p, at, null, from.id) };
          }),
          { label: "Other…", onSelect: () => setDialog({ kind: "service", ball: from, at }) },
        ]);
        break;
    }
  }

  function lineMenu(line: Line): { title: string; items: MenuItem[] } {
    const a = byKey.get(line.source)?.label ?? "";
    const b = byKey.get(line.target)?.label ?? "";
    if (line.kind === "owns") {
      const account = parseKey(line.target);
      const ball = account ? byKey.get(line.target) : null;
      return {
        title: `${b} belongs to ${a}`,
        items:
          locked || !ball
            ? [{ label: "Press Edit map to change this", disabled: true }]
            : [
                {
                  label: "Move to email",
                  items: emails.filter((e) => e.key !== line.source).map((e) => ({ label: e.label, onSelect: () => void connect(ball, e) })),
                },
              ],
      };
    }
    if (line.kind === "works") {
      return {
        title: `${a} works on ${b}`,
        items: locked
          ? [{ label: "Press Edit map to change this", disabled: true }]
          : [{ label: "Remove link", danger: true, onSelect: () => void removeLine(line) }],
      };
    }
    if (line.kind === "holds") {
      const inOrg = parseKey(line.source)?.kind === "org";
      return {
        title: `${b} is in ${a}`,
        items: locked
          ? [{ label: "Press Edit map to change this", disabled: true }]
          : inOrg
            ? [{ label: `Take out of ${a}`, danger: true, onSelect: () => void removeLine(line) }]
            : [{ label: `Drag ${b} to another ${inOrg ? "organization" : "account"} to move it`, disabled: true }],
      };
    }
    return {
      title: `${a} uses ${b}`,
      items: locked
        ? [{ label: "Press Edit map to change this", disabled: true }]
        : [{ label: "Remove link", danger: true, onSelect: () => void removeLine(line) }],
    };
  }

  // --- keyboard ----------------------------------------------------------------------

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      setFinder(true);
      return;
    }
    const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (typing || dialog || finder) return;
    if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
      e.preventDefault();
      void travel(e.key.toLowerCase() === "z" && !e.shiftKey);
      return;
    }
    if (e.key === "Escape") {
      setSelected(null);
      setSelectedLine(null);
      setNodes((n) => n.map((x) => (x.selected ? { ...x, selected: false } : x)));
    }
    if ((e.key === "Delete" || e.key === "Backspace") && !locked) {
      const line = selectedLine ? model.lines.find((l) => l.key === selectedLine) : null;
      if (line) void removeLine(line);
      else if (selected) {
        const ball = byKey.get(selected);
        if (ball) void remove(ball);
      }
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // --- render -------------------------------------------------------------------------

  if (!data) return <div className="empty">Loading…</div>;

  const selectedBall = selected ? byKey.get(selected) ?? null : null;
  const undoStep = history.current.past.at(-1);
  const redoStep = history.current.future.at(-1);
  const builtMenu = menu
    ? menu.items
      ? { title: menu.title ?? "", items: menu.items }
      : menu.line
      ? lineMenu(model.lines.find((l) => l.key === menu.line) as Line)
      : menu.ball && byKey.get(menu.ball)
        ? ballMenu(byKey.get(menu.ball) as Ball)
        : paneMenu(menu.at)
    : null;
  const focusProject = projectKey ? byKey.get(projectKey) ?? null : null;
  const findEntries: FindEntry[] = balls.map((b) => ({ key: b.key, kind: b.kind, label: b.label, sub: b.sub }));
  const empty = balls.length === 0;

  return (
    <div
      ref={wrapRef}
      className={`ledger-canvas${locked ? " locked" : ""}${projectKey ? " focus" : ""}${
        nodes.filter((n) => n.selected).length > 1 ? " multi" : ""
      }`}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="cv-toolbar">
        {focusProject && (
          <span className="cv-focus">
            <strong>{focusProject.label}</strong> and what it runs on
          </span>
        )}
        <button
          type="button"
          className={`cv-lock${locked ? "" : " editing"}`}
          aria-pressed={!locked}
          onClick={toggleLock}
          title={
            locked
              ? "The layout is locked: you can look, search and copy. Click to move, connect, rename or delete."
              : "Lock the layout again so nothing changes by accident."
          }
        >
          {locked ? "✎ Edit map" : "✓ Done editing"}
        </button>
        {!locked && (
          <>
            <button
              type="button"
              className="st-find"
              aria-label={undoStep ? `Undo ${undoStep.label}` : "Nothing to undo"}
              title={undoStep ? `Undo ${undoStep.label} (⌘Z)` : "Nothing to undo"}
              disabled={!undoStep}
              onClick={() => void travel(true)}
            >
              ↶
            </button>
            <button
              type="button"
              className="st-find"
              aria-label={redoStep ? `Redo ${redoStep.label}` : "Nothing to redo"}
              title={redoStep ? `Redo ${redoStep.label} (⇧⌘Z)` : "Nothing to redo"}
              disabled={!redoStep}
              onClick={() => void travel(false)}
            >
              ↷
            </button>
          </>
        )}
        <button type="button" className="st-find" onClick={() => setFinder(true)}>
          Find <kbd>⌘K</kbd>
        </button>
        <button type="button" className="st-find" aria-pressed={help} onClick={() => setHelp((h) => !h)}>
          How it works
        </button>
      </div>

      <div className="cv-flow">
        <ReactFlow<BallNode, Edge<LineData>>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={(changes: NodeChange<BallNode>[]) => setNodes((n) => applyNodeChanges(changes, n))}
          onNodeDragStop={(_, node, dragged) => {
            // Several selected balls move together, and are put back together.
            const group = dragged.length > 0 ? dragged : [node];
            const before = new Map(group.map((n) => [n.id, place.get(n.id) ?? n.position]));
            const after = new Map(group.map((n) => [n.id, n.position]));
            void setPositions(after);
            if (projectKey) return;
            record({
              label: group.length > 1 ? `moving ${group.length} balls` : `moving ${byKey.get(node.id)?.label ?? "a ball"}`,
              undo: () => setPositions(before),
              redo: () => setPositions(after),
              reload: false,
            });
          }}
          onConnect={(c: Connection) => {
            const a = byKey.get(c.source);
            const b = byKey.get(c.target);
            if (a && b) void connect(a, b);
          }}
          onConnectEnd={(event, state: FinalConnectionState) => {
            // Let go over empty space: offer what can be added there.
            if (locked || state.isValid || state.toNode || !state.fromNode) return;
            const from = byKey.get(state.fromNode.id);
            const point = "changedTouches" in event ? event.changedTouches[0] : event;
            if (!from || !point) return;
            const client = { x: point.clientX, y: point.clientY };
            dropOn(from, flow.screenToFlowPosition(client), client);
          }}
          isValidConnection={(c) => c.source !== c.target}
          connectionRadius={70}
          onNodeClick={(_, node) => {
            setSelectedLine(null);
            setSelected((s) => (s === node.id ? null : node.id));
          }}
          onNodeDoubleClick={(_, node) => !locked && setRenaming(node.id)}
          onNodeContextMenu={(e, node) => {
            e.preventDefault();
            setSelected(node.id);
            setMenu({ x: e.clientX, y: e.clientY, at: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), ball: node.id, line: null });
          }}
          onEdgeClick={(_, edge) => {
            setSelected(null);
            setSelectedLine((s) => (s === edge.id ? null : edge.id));
          }}
          onEdgeContextMenu={(e, edge) => {
            e.preventDefault();
            setSelectedLine(edge.id);
            setMenu({ x: e.clientX, y: e.clientY, at: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), ball: null, line: edge.id });
          }}
          onPaneContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, at: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), ball: null, line: null });
          }}
          onPaneClick={() => {
            setSelected(null);
            setSelectedLine(null);
          }}
          nodeOrigin={[0.5, 0.5]}
          nodesConnectable={!locked}
          nodesDraggable={!locked}
          // Shift-drag draws a box; Ctrl/Cmd-click adds one ball at a time.
          elementsSelectable={!locked}
          selectionKeyCode="Shift"
          deleteKeyCode={null}
          // Double-click renames; the zoom handler would swallow it first.
          zoomOnDoubleClick={false}
          minZoom={0.2}
          maxZoom={2.5}
          fitView
          fitViewOptions={FIT}
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
        >
          <Background variant={BackgroundVariant.Dots} color="#1A1A1A" bgColor="#0A0A0A" gap={22} size={1.6} />
          <Controls showInteractive={false} position="bottom-left" fitViewOptions={FIT} />
        </ReactFlow>

        {empty && !projectKey && <Guide onEmail={() => setDialog({ kind: "email", ball: null, at: { x: 0, y: 0 } })} />}
        {empty && projectKey && <div className="cv-hint">This project is not on the map.</div>}
        {!empty && focusProject && lines.length === 0 && (
          <div className="cv-hint">
            Pick the services <strong>{focusProject.label}</strong> runs on from the list on the right, or drag them in.
          </div>
        )}
        {!empty && !projectKey && projectBalls.length === 0 && emails.length > 0 && !help && (
          <div className="cv-hint">
            Next: add a project from the list on the right, then draw a line from it to each service it runs on.
          </div>
        )}
        {help && <HowItWorks onClose={() => setHelp(false)} />}
      </div>

      {selectedBall ? (
        <Details
          ball={selectedBall}
          locked={locked}
          owner={selectedBall.kind === "account" ? ownerOf(selectedBall.id) : null}
          holder={
            selectedBall.kind === "org" || selectedBall.kind === "resource"
              ? (byKey.get(selectedBall.parent ?? "") ?? null)
              : null
          }
          inside={resourceBalls
            .filter((r) => r.parent === selectedBall.key)
            .sort((a, b) => a.label.localeCompare(b.label))}
          resourceOf={(id) => data.resourceById.get(id)}
          account={selectedBall.kind === "account" ? (data.accounts.get(selectedBall.id) ?? null) : null}
          secrets={secretsOf(selectedBall)}
          fields={namedFields(selectedBall)}
          connected={[...neighbourhood(model.lines, selectedBall.key)]
            // The projects inside it are shown as cards instead.
            .filter((k) => k !== selectedBall.key && !(k.startsWith("resource:") && byKey.get(k)?.parent === selectedBall.key))
            .map((k) => byKey.get(k))
            .filter((b): b is Ball => Boolean(b))
            // Services first, then projects, then emails; by name within each.
            .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.label.localeCompare(b.label))}
          onClose={() => setSelected(null)}
          onPick={focusOn}
          onCopySecret={(s) => void copySecret(s)}
          onCopyText={(label, text) => void copyText(label, text)}
          onAdd={(kind) => {
            const beside = besideSpot(place.get(selectedBall.key) ?? { x: 0, y: 0 }, place.values());
            if (kind === "resource") setDialog(resourceDialog(selectedBall, beside));
            else setDialog({ kind, ball: selectedBall, at: kind === "org" ? beside : null });
          }}
          onOpenProject={
            onOpenProject && !projectKey && selectedBall.kind === "project"
              ? () => onOpenProject(selectedBall.id)
              : undefined
          }
        />
      ) : (
        <Shelf
          locked={locked}
          focus={focusProject}
          existing={
            focusProject
              ? [...resourceBalls, ...accountBalls].filter(
                  (a) => !lines.some((l) => l.source === focusProject.key && l.target === a.key),
                )
              : []
          }
          whereIs={(b) => (b.kind === "account" ? ownerOf(b.id)?.label : byKey.get(b.parent ?? "")?.label) ?? null}
          have={new Set(accountBalls.map((a) => a.provider ?? ""))}
          loose={
            focusProject
              ? []
              : model.balls.filter((b) => !model.lines.some((l) => l.source === b.key || l.target === b.key))
          }
          onFind={focusOn}
          canvas={wrapRef}
          onPlace={(item, client) => {
            const at = client ? flow.screenToFlowPosition(client) : null;
            if (item.kind === "email") setDialog({ kind: "email", ball: null, at: at ?? spotInView() });
            else if (item.kind === "project") setDialog({ kind: "project", ball: null, at: at ?? spotInView() });
            else if (item.kind === "other") setDialog({ kind: "service", ball: null, at: at ?? spotInView(), name: item.name });
            else if (item.kind === "existing" && focusProject) {
              const a = byKey.get(item.key);
              if (a) void connect(focusProject, a);
            } else if (item.kind === "service") {
              // A click on a service you already have means that one; dragging
              // it onto the map is how a second account is added.
              const mine = accountBalls.filter((a) => a.provider === item.provider);
              const only = mine.length === 1 ? mine[0] : undefined;
              if (!at && only) {
                if (focusProject) void connect(focusProject, only);
                else {
                  focusOn(only.key);
                  onNotify(`You already have ${only.label}. Drag it onto the map to add a second account.`);
                }
              } else void addService(item.provider, item.name, at);
            }
          }}
          onUnlock={toggleLock}
        />
      )}

      {menu && builtMenu && (
        <ContextMenu x={menu.x} y={menu.y} title={builtMenu.title} items={builtMenu.items} onClose={() => setMenu(null)} />
      )}

      {finder && (
        <Finder
          entries={findEntries}
          onPick={(entry) => {
            setFinder(false);
            focusOn(entry.key);
          }}
          onClose={() => setFinder(false)}
        />
      )}

      {dialog && (
        <AddDialog
          kind={dialog.kind}
          title={dialog.title}
          under={dialog.ball?.label ?? null}
          initialName={dialog.name}
          onCancel={() => setDialog(null)}
          onSubmit={async (values) => {
            await add(dialog, values);
          }}
        />
      )}
    </div>
  );
}

// --- the empty map ---------------------------------------------------------------------

function Guide({ onEmail }: { onEmail: () => void }) {
  return (
    <div className="cv-guide" role="region" aria-label="Getting started">
      <h2>Draw your stack</h2>
      <ol>
        <li>
          <strong>Your email</strong> — the address you sign up to services with.
        </li>
        <li>
          <strong>Services</strong> — drag GitHub, Vercel, Supabase… in from the list on the right. Each one hangs off
          the email it is dropped next to.
        </li>
        <li>
          <strong>Inside a service</strong> — drag from Supabase&apos;s dot to an empty spot to add an organization or
          the projects you have there.
        </li>
        <li>
          <strong>Projects</strong> — e.g. <em>make-it-real</em>. Draw a line from the project to each service it runs on.
        </li>
      </ol>
      <button type="button" className="primary" onClick={onEmail}>
        Add your email
      </button>
    </div>
  );
}

function HowItWorks({ onClose }: { onClose: () => void }) {
  return (
    <div className="cv-guide small" role="region" aria-label="How it works">
      <ul>
        <li>
          <strong>Connect</strong>: drag from the small dot on a ball to another ball.
        </li>
        <li>
          <strong>Service → email</strong>: who owns it. <strong>Project → service</strong>: what it runs on.
        </li>
        <li>
          <strong>Add something new</strong>: drag from a ball&apos;s dot to an empty spot. From a service you get an
          organization or a project in it; from an organization, a project in it.
        </li>
        <li>
          <strong>Add</strong>: drag from the list on the right, or right-click anywhere. Every ball takes fields with
          names of your own.
        </li>
        <li>
          <strong>Edit</strong>: right-click a ball or a line; double-click to rename.
        </li>
        <li>
          <strong>Several at once</strong>: Shift-drag a box around balls, or Ctrl/⌘-click them, then drag them together.
        </li>
        <li>
          <strong>Undo</strong>: ⌘Z / Ctrl+Z, redo with ⇧⌘Z / Ctrl+Y -- for moves, lines, renames and things you just added.
          Deleting is final, which is why it asks first.
        </li>
        <li>
          <strong>Done editing</strong> locks the layout again: nothing moves or gets deleted until you press Edit map.
        </li>
      </ul>
      <button type="button" onClick={onClose}>
        Got it
      </button>
    </div>
  );
}

// --- the list on the right ---------------------------------------------------------------

export type ShelfItem =
  | { kind: "email" }
  | { kind: "project" }
  | { kind: "service"; provider: Provider; name: string }
  | { kind: "other"; name: string }
  | { kind: "existing"; key: string };

function Shelf({
  locked,
  focus,
  existing,
  whereIs,
  have,
  loose,
  onFind,
  canvas,
  onPlace,
  onUnlock,
}: {
  locked: boolean;
  focus: Ball | null;
  /** On a project's page: services and projects in services it does not use yet. */
  existing: Ball[];
  /** The email a service belongs to, or what a project in a service is in. */
  whereIs: (ball: Ball) => string | null;
  /** Providers there is already an account for. */
  have: Set<string>;
  /** Balls with no line to anything yet. */
  loose: Ball[];
  onFind: (key: string) => void;
  canvas: React.RefObject<HTMLDivElement | null>;
  /** Add an item: where it was dropped, or null when it was clicked. */
  onPlace: (item: ShelfItem, client: Point | null) => void;
  onUnlock: () => void;
}) {
  const [query, setQuery] = useState("");
  const [ghost, setGhost] = useState<{ item: ShelfItem; label: string; x: number; y: number } | null>(null);

  const services = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PROVIDERS.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.aliases ?? []).some((a) => a.includes(q)));
  }, [query]);
  const typed = query.trim();
  const exact = PROVIDERS.some((p) => p.name.toLowerCase() === typed.toLowerCase());

  // Dragging is done with pointer events rather than HTML drag and drop, which
  // the desktop webview intercepts for file drops.
  function startDrag(e: React.PointerEvent, item: ShelfItem, label: string) {
    if (locked || e.button > 0) return;
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) dragging = true;
      if (dragging) setGhost({ item, label, x: ev.clientX, y: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setGhost(null);
      if (!dragging) {
        onPlace(item, null);
        return;
      }
      const flowEl = canvas.current?.querySelector(".cv-flow");
      const rect = flowEl?.getBoundingClientRect();
      if (rect && ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
        onPlace(item, { x: ev.clientX, y: ev.clientY });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const chip = (item: ShelfItem, label: string, icon: React.ReactNode, sub?: string | null) => (
    <button
      type="button"
      key={`${item.kind}:${label}`}
      className="cv-chip"
      disabled={locked}
      onPointerDown={(e) => startDrag(e, item, label)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPlace(item, null);
        }
      }}
      title={locked ? "Unlock the map to add" : "Click to add, or drag onto the map"}
    >
      <span className="cv-chip-icon">{icon}</span>
      <span className="cv-chip-text">
        <span>{label}</span>
        {sub && <small>{sub}</small>}
      </span>
    </button>
  );

  return (
    <aside className="cv-shelf" aria-label="Add to the map">
      <div className="cv-shelf-head">
        <strong>{focus ? `Services for ${focus.label}` : "Add to your map"}</strong>
        <small>{locked ? "The layout is locked." : "Click to add, or drag onto the map."}</small>
        {locked && (
          <button type="button" onClick={onUnlock}>
            ✎ Edit map
          </button>
        )}
      </div>

      {!focus && (
        <div className="cv-shelf-row">
          {chip({ kind: "email" }, "Email", <span className="cv-chip-glyph email">@</span>)}
          {chip({ kind: "project" }, "Project", <span className="cv-chip-glyph project">P</span>)}
        </div>
      )}

      {loose.length > 0 && (
        <>
          <div className="cv-shelf-title">Not connected yet</div>
          <div className="cv-shelf-list" aria-label="Not connected yet">
            {loose.map((b) => (
              <button
                type="button"
                key={b.key}
                className="cv-chip"
                onClick={() => onFind(b.key)}
                title="Show it on the map"
              >
                <span className="cv-chip-icon">
                  {b.provider ? (
                    <ProviderIcon provider={b.provider} name={b.label} size={18} />
                  ) : (
                    <span className={`cv-chip-glyph ${b.kind}`}>{b.kind === "email" ? "@" : "P"}</span>
                  )}
                </span>
                <span className="cv-chip-text">
                  <span>{b.label}</span>
                  <small>{kindLabel(b)}</small>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {focus && existing.length > 0 && (
        <>
          <div className="cv-shelf-title">Already in your vault</div>
          <div className="cv-shelf-list">
            {existing.map((a) =>
              chip(
                { kind: "existing", key: a.key },
                a.label,
                a.provider ? <ProviderIcon provider={a.provider} name={a.label} size={18} /> : null,
                a.kind === "resource" ? `${serviceName(a)} project · ${whereIs(a) ?? ""}` : whereIs(a),
              ),
            )}
          </div>
        </>
      )}

      <div className="cv-shelf-title">{focus ? "A new service" : "Services"}</div>
      <input
        className="cv-shelf-search"
        aria-label="Search services"
        placeholder="Search, or type any name…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={locked}
      />
      <div className="cv-shelf-list">
        {typed && !exact && chip({ kind: "other", name: typed }, `Add “${typed}”`, <span className="cv-chip-glyph">+</span>)}
        {services.map((p) =>
          chip(
            { kind: "service", provider: p.provider, name: p.name },
            p.name,
            <ProviderIcon provider={p.provider} name={p.name} size={18} />,
            have.has(p.provider) ? "On your map" : null,
          ),
        )}
      </div>

      {ghost && (
        <div className="cv-ghost" style={{ left: ghost.x, top: ghost.y }} aria-hidden>
          {ghost.label}
        </div>
      )}
    </aside>
  );
}

// --- details -------------------------------------------------------------------------------

function Details({
  ball,
  locked,
  owner,
  holder,
  account,
  secrets,
  fields,
  connected,
  inside,
  resourceOf,
  onClose,
  onPick,
  onCopySecret,
  onCopyText,
  onAdd,
  onOpenProject,
}: {
  ball: Ball;
  locked: boolean;
  owner: Ball | null;
  /** What an organization or a project in a service sits in. */
  holder: Ball | null;
  account: Account | null;
  secrets: SecretListing[];
  fields: CustomField[];
  connected: Ball[];
  /** The projects in a service or organization. */
  inside: Ball[];
  resourceOf: (id: string) => ServiceProjectSummary | undefined;
  onClose: () => void;
  onPick: (key: string) => void;
  onCopySecret: (s: SecretListing) => void;
  onCopyText: (label: string, text: string) => void;
  onAdd: (kind: AddKind) => void;
  onOpenProject?: () => void;
}) {
  const tone = (kind: string) => {
    const k = normalizeSecretKind(kind as SecretKind);
    if (k === "password") return "password";
    if (k === "env_var") return "plain";
    return "api";
  };
  const resource = ball.kind === "resource" ? resourceOf(ball.id)?.service_project : undefined;
  const holdsSecrets = ball.kind === "account" || ball.kind === "project" || ball.kind === "resource";
  const addButtons: [AddKind, string][] =
    ball.kind === "account"
      ? [["api", "+ API key"], ["password", "+ Password"], ["field", "+ Field"]]
      : ball.kind === "project"
        ? [["secret", "+ Variable"], ["field", "+ Field"]]
        : ball.kind === "resource"
          ? [["api", "+ API key"], ["secret", "+ Variable"], ["field", "+ Field"]]
          : [["field", "+ Field"]];
  const row = (term: string, value: string | null | undefined) =>
    value ? (
      <>
        <dt>{term}</dt>
        <dd>{value}</dd>
      </>
    ) : null;

  return (
    <aside className="st-info cv-details" aria-label="Details">
      <div className="st-info-head">
        {ball.provider && <ProviderIcon provider={ball.provider} name={ball.label} size={22} />}
        <div>
          <div className="st-info-kind">{kindLabel(ball)}</div>
          <div className="st-info-name" title={ball.label}>
            {ball.label}
          </div>
        </div>
        <span className="spacer" />
        <button type="button" className="ghost" aria-label="Close details" onClick={onClose}>
          ×
        </button>
      </div>

      <dl className="st-info-list">
        {ball.kind === "account" && row("Service", ball.provider ? providerLabel(ball.provider) : null)}
        {row("In", holder?.label)}
        {row("Email", owner?.label)}
        {row("Username", account?.username)}
        {row("Sign in at", account?.url)}
        {row("Region", resource?.region)}
        {row("Id", resource?.provider_ref)}
        {ball.kind === "email" && !ball.noEmail && row("Name", ball.sub)}
      </dl>

      {onOpenProject && (
        <button type="button" onClick={onOpenProject}>
          Open project
        </button>
      )}

      {(ball.kind === "account" || ball.kind === "org") && (
        <>
          <h4>Projects in {ball.label}</h4>
          {inside.length === 0 && (
            <p className="muted-p">
              None yet. {locked ? "" : `Drag from the dot on ${ball.label} to an empty spot to add one.`}
            </p>
          )}
          <div className="cv-cards">
            {inside.map((b) => {
              const r = resourceOf(b.id);
              const usedBy = r?.used_by.map((u) => u.name).join(", ");
              return (
                <button key={b.key} type="button" className="cv-card" onClick={() => onPick(b.key)}>
                  <strong>{b.label}</strong>
                  {r?.service_project.region && <small>{r.service_project.region}</small>}
                  <small className={usedBy ? "used" : undefined}>{usedBy ? `Used by ${usedBy}` : "Not in use"}</small>
                </button>
              );
            })}
          </div>
          {!locked && (
            <div className="st-info-actions">
              {ball.kind === "account" && (
                <button type="button" onClick={() => onAdd("org")}>
                  + Organization
                </button>
              )}
              <button type="button" onClick={() => onAdd("resource")}>
                + Project
              </button>
            </div>
          )}
        </>
      )}

      <h4>Connected to</h4>
      {connected.length === 0 && (
        <p className="muted-p">
          Nothing yet. Drag from the dot on this ball to{" "}
          {ball.kind === "project" ? "a service it runs on" : ball.kind === "account" ? "its email" : "another ball"}.
        </p>
      )}
      <div className="cv-connected">
        {connected.map((b) => (
          <button key={b.key} type="button" className="cv-chip" onClick={() => onPick(b.key)}>
            <span className="cv-chip-icon">
              {b.provider ? (
                <ProviderIcon provider={b.provider} name={b.label} size={16} />
              ) : (
                <span className={`cv-chip-glyph ${b.kind}`}>{b.kind === "email" ? "@" : "P"}</span>
              )}
            </span>
            <span className="cv-chip-text">
              <span>{b.label}</span>
              <small>{kindLabel(b)}</small>
            </span>
          </button>
        ))}
      </div>

      <h4>{ball.kind === "project" ? "Variables and fields" : holdsSecrets ? "Keys and fields" : "Fields"}</h4>
      {secrets.length === 0 && fields.length === 0 && <p className="muted-p">Nothing stored yet.</p>}
      {secrets.map((s) => (
        <div key={s.entry.secret.id} className={`st-info-field tone-${tone(s.entry.secret.kind)}`}>
          <span className="st-info-field-name">{s.entry.secret.name}</span>
          <span className="st-info-field-value mono">{s.entry.secret.preview}</span>
          <button type="button" onClick={() => onCopySecret(s)} aria-label={`Copy ${s.entry.secret.name}`}>
            Copy
          </button>
        </div>
      ))}
      {fields.map((f) => (
        <div key={f.id} className="st-info-field tone-plain">
          <span className="st-info-field-name">{f.label}</span>
          <span className="st-info-field-value">{f.value}</span>
          <button type="button" onClick={() => onCopyText(f.label, f.value)} aria-label={`Copy ${f.label}`}>
            Copy
          </button>
        </div>
      ))}
      {!locked && (
        <div className="st-info-actions">
          {addButtons.map(([kind, label]) => (
            <button key={kind} type="button" onClick={() => onAdd(kind)}>
              {label}
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
