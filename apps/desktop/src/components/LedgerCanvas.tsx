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

function readLocked(): boolean {
  try {
    return window.localStorage.getItem(LOCK_KEY) === "1";
  } catch {
    return false;
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
  const [people, projects, resources, secrets, attention] = await Promise.all([
    api.ledgerOverview(),
    api.listProjects(),
    api.listServiceProjects(),
    api.listAllSecrets(),
    api.needsAttention(),
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
  const [locked, setLocked] = useState(readLocked);
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
    setNodes(
      balls.map((b) => {
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
          selectable: false,
          data: {
            ball: b,
            selected: selected === b.key,
            dim: lit !== null && !lit.has(b.key),
            renaming: renaming === b.key,
            locked,
            onRename,
          },
        };
      }),
    );
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

  // --- saving positions -------------------------------------------------------------

  async function savePosition(key: string, p: Point) {
    const ball = byKey.get(key);
    if (!ball || !data || projectKey) return;
    const existing = posField(data, key);
    try {
      if (existing) {
        await api.updateCustomField(existing.id, POS_FIELD, formatPos(p));
      } else {
        const created = await api.addCustomField(entityOf(ball), POS_FIELD, formatPos(p));
        setData((d) => {
          if (!d) return d;
          const fields = new Map(d.fields);
          fields.set(key, [...(fields.get(key) ?? []), created]);
          return { ...d, fields };
        });
      }
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
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
    if (!data) return;
    const intent = connectIntent(a, b, model.lines);
    try {
      if (intent.kind === "refuse") {
        onNotify(intent.reason, true);
        return;
      }
      if (intent.kind === "none") return;
      const name = (kind: Ball["kind"], id: string) => byKey.get(ballKey(kind, id))?.label ?? "";
      switch (intent.kind) {
        case "own":
          await api.moveAccount(intent.accountId, intent.identityId);
          onNotify(`${name("account", intent.accountId)} now belongs to ${name("email", intent.identityId)}`);
          break;
        case "use":
          await use(intent.accountId, intent.projectId);
          break;
        case "link": {
          await api.linkServiceProject(intent.resourceId, intent.projectId);
          // The line straight to the service said less than this one does. If
          // nothing is stored on what that line stood for, it goes.
          const account = data.resourceById.get(intent.resourceId)?.service_project.account_id;
          for (const r of account ? resourcesToUnlink(data, account, intent.projectId) : []) {
            if (r.remove) await api.deleteServiceProject(r.id);
          }
          onNotify(`${name("project", intent.projectId)} now runs on ${name("resource", intent.resourceId)}`);
          break;
        }
        case "moveOrg":
          await api.moveOrganization(intent.organizationId, intent.accountId);
          onNotify(`${name("org", intent.organizationId)} is now under ${name("account", intent.accountId)}`);
          break;
        case "place": {
          const r = data.resourceById.get(intent.resourceId)?.service_project;
          if (r && r.account_id === intent.accountId) {
            await api.assignOrganization(intent.resourceId, intent.organizationId);
          } else {
            await api.moveServiceProject(intent.resourceId, intent.accountId, intent.organizationId);
          }
          const into = intent.organizationId ? name("org", intent.organizationId) : name("account", intent.accountId);
          onNotify(`${name("resource", intent.resourceId)} is now in ${into}`);
          break;
        }
      }
      await changed();
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  /**
   * Record that a project runs on a service: a resource under the account,
   * linked. `fresh` is an account created a moment ago, not in `data` yet.
   */
  async function use(accountId: string, projectId_: string, fresh?: Account) {
    if (!data) return;
    const account = fresh ?? data.accounts.get(accountId);
    const project = data.projects.find((p) => p.id === projectId_);
    if (!account || !project) throw new Error("That service or project is no longer in your vault.");
    const existing = resourceToLink(data, accountId, project.name);
    const resourceId =
      existing ??
      (await api.createServiceProjectManual(accountId, null, account.provider, project.name, null, "unknown")).id;
    await api.linkServiceProject(resourceId, project.id);
    onNotify(`${project.name} now uses ${account.label}`);
  }

  async function removeLine(line: Line) {
    if (!data || locked) return;
    if (line.kind === "owns") {
      onNotify("A service always belongs to one email. Draw a line from it to another email to move it.");
      return;
    }
    const from = parseKey(line.source);
    const to = parseKey(line.target);
    if (!from || !to) return;
    const a = byKey.get(line.source)?.label;
    const b = byKey.get(line.target)?.label;
    if (line.kind === "holds" && from.kind !== "org") {
      onNotify(
        to.kind === "org"
          ? `${b} always belongs to a service. Draw it to another account to move it, or delete it.`
          : `${b} always belongs to a service. Draw it to an organization to put it there, or delete it.`,
      );
      return;
    }
    try {
      if (line.kind === "holds") {
        await api.assignOrganization(to.id, null);
        onNotify(`${b} is no longer in ${a}; it stays under ${serviceName(byKey.get(line.target) as Ball)}`);
      } else if (to.kind === "resource") {
        await api.unlinkServiceProject(to.id, from.id);
        onNotify(`${a} no longer runs on ${b}`);
      } else {
        for (const r of resourcesToUnlink(data, to.id, from.id)) {
          if (r.remove) await api.deleteServiceProject(r.id);
          else await api.unlinkServiceProject(r.id, from.id);
        }
        onNotify(`${a} no longer uses ${b}`);
      }
      setSelectedLine(null);
      await changed();
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  async function addService(
    provider: Provider,
    typed: string,
    at: Point | null,
    owner: Ball | null = null,
    forProject: string | null = projectId,
  ) {
    if (locked) return;
    const spot = at ?? spotInView();
    const to = owner ?? nearestEmail(emails, place, spot);
    if (!to) {
      onNotify("Add your email first: every service belongs to an email.");
      setDialog({ kind: "email", ball: null, at: freeSpot({ x: spot.x - 300, y: spot.y }, place.values()) });
      return;
    }
    try {
      const label = serviceLabel(typed, provider);
      const account = await api.createAccountManual(to.id, provider, label);
      await placeNew({ kind: "account", id: account.id }, spot);
      if (forProject) await use(account.id, forProject, account);
      else onNotify(`Added ${label} under ${to.label} · draw a line to another email to move it`);
      // The list stays open, so several services can be added in a row.
      await changed();
    } catch (e: unknown) {
      onNotify(message(e), true);
    }
  }

  async function add(d: Dialog, values: AddValues) {
    switch (d.kind) {
      case "email": {
        const identity = await api.createIdentityManual(values.label || values.name, values.name);
        await placeNew({ kind: "identity", id: identity.id }, d.at);
        onNotify(`Added ${values.name}`);
        break;
      }
      case "project": {
        const existing = data?.projects.find((p) => p.name.toLowerCase() === values.name.toLowerCase());
        if (existing) throw new Error(`There is already a project called ${existing.name}.`);
        const project = await api.createProject(values.name, null);
        await placeNew({ kind: "project", id: project.id }, d.at);
        if (d.ball?.kind === "resource") {
          await api.linkServiceProject(d.ball.id, project.id);
        } else if (d.ball?.kind === "account") {
          await reload();
          const resource = await api.createServiceProjectManual(
            d.ball.id,
            null,
            data?.accounts.get(d.ball.id)?.provider ?? "unknown",
            project.name,
            null,
            "unknown",
          );
          await api.linkServiceProject(resource.id, project.id);
        }
        onNotify(`Added ${project.name} · draw a line from it to each service it runs on`);
        break;
      }
      case "service":
        setDialog(null);
        await addService(
          providerForName(values.name),
          values.name,
          d.at,
          d.ball?.kind === "email" ? d.ball : null,
          d.ball?.kind === "project" ? d.ball.id : projectId,
        );
        return;
      case "org": {
        const account = d.ball ? data?.accounts.get(d.ball.id) : undefined;
        if (!account) return;
        const taken = [...(data?.orgs.values() ?? [])].find(
          (o) => o.account_id === account.id && o.name.toLowerCase() === values.name.toLowerCase(),
        );
        if (taken) throw new Error(`${account.label} already has an organization called ${taken.name}.`);
        const org = await api.createOrganization(account.id, values.name);
        await placeNew({ kind: "organization", id: org.id }, d.at);
        onNotify(`Added ${org.name} in ${account.label} · drag from it to add its projects`);
        break;
      }
      case "resource": {
        const org = d.ball?.kind === "org" ? data?.orgs.get(d.ball.id) : undefined;
        const account = data?.accounts.get(org?.account_id ?? d.ball?.id ?? "");
        if (!account) return;
        const taken = data?.resources.find(
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
        break;
      }
      case "api":
      case "password":
      case "secret": {
        if (!d.ball) return;
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
        if (!d.ball) return;
        await api.addCustomField(entityOf(d.ball), values.name, values.value);
        onNotify(`Added ${values.name}`);
        break;
    }
    setDialog(null);
    await changed();
  }

  async function rename(key: string, raw: string | null) {
    setRenaming(null);
    const ball = byKey.get(key);
    const value = raw?.trim();
    if (!ball || !value || locked) return;
    try {
      if (ball.kind === "email") {
        if (value.includes("@") && value !== ball.label) {
          // A new address: add it as the person's main one, drop the old.
          const old = (await api.identityEmails(ball.id)).find((e) => e.address === ball.label);
          await api.addIdentityEmail(ball.id, value, true);
          if (old) await api.removeIdentityEmail(ball.id, old.id);
        } else if (!value.includes("@")) {
          await api.updateIdentity(ball.id, value);
        } else {
          return;
        }
      } else if (ball.kind === "account") {
        const account = data?.accounts.get(ball.id);
        if (!account || value === account.label) return;
        await api.updateAccount(account.id, value, {
          login_email: account.login_email,
          username: account.username,
          url: account.url,
          notes: account.notes,
        });
      } else if (ball.kind === "org") {
        if (value === ball.label) return;
        await api.renameOrganization(ball.id, value);
      } else if (ball.kind === "resource") {
        const r = data?.resourceById.get(ball.id)?.service_project;
        if (!r || value === r.name) return;
        await api.updateResource(r.id, {
          name: value,
          provider_ref: r.provider_ref,
          region: r.region,
          environment: r.environment,
          url: r.url,
          notes: r.notes,
        });
      } else {
        if (value === ball.label) return;
        await api.updateProject(ball.id, value, null);
      }
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
    onNotify(next ? "Map locked: nothing can be moved, connected or deleted" : "Map unlocked: you can edit again");
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
    items.push({ label: locked ? "Unlock map" : "Lock map", onSelect: toggleLock });
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
            ? [{ label: "Unlock the map to change this", disabled: true }]
            : [
                {
                  label: "Move to email",
                  items: emails.filter((e) => e.key !== line.source).map((e) => ({ label: e.label, onSelect: () => void connect(ball, e) })),
                },
              ],
      };
    }
    if (line.kind === "holds") {
      const inOrg = parseKey(line.source)?.kind === "org";
      return {
        title: `${b} is in ${a}`,
        items: locked
          ? [{ label: "Unlock the map to change this", disabled: true }]
          : inOrg
            ? [{ label: `Take out of ${a}`, danger: true, onSelect: () => void removeLine(line) }]
            : [{ label: `Drag ${b} to another ${inOrg ? "organization" : "account"} to move it`, disabled: true }],
      };
    }
    return {
      title: `${a} uses ${b}`,
      items: locked
        ? [{ label: "Unlock the map to change this", disabled: true }]
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
    if (e.key === "Escape") {
      setSelected(null);
      setSelectedLine(null);
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
      className={`ledger-canvas${locked ? " locked" : ""}${projectKey ? " focus" : ""}`}
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
          className={`cv-lock${locked ? " on" : ""}`}
          aria-pressed={locked}
          onClick={toggleLock}
          title={locked ? "Locked: nothing can be moved, connected or deleted. Click to edit." : "Lock the map so nothing changes by accident."}
        >
          {locked ? "🔒 Locked" : "🔓 Editing"}
        </button>
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
          onNodeDragStop={(_, node) => {
            setMoved((m) => new Map(m).set(node.id, node.position));
            void savePosition(node.id, node.position);
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
          elementsSelectable={false}
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
          onSubmit={(values) => add(dialog, values)}
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
          <strong>Lock</strong> the map when you are done: nothing moves or gets deleted until you unlock it.
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
        <small>{locked ? "The map is locked." : "Click to add, or drag onto the map."}</small>
        {locked && (
          <button type="button" onClick={onUnlock}>
            Unlock to edit
          </button>
        )}
      </div>

      {!focus && (
        <div className="cv-shelf-row">
          {chip({ kind: "email" }, "Email", <span className="cv-chip-glyph email">@</span>)}
          {chip({ kind: "project" }, "Project", <span className="cv-chip-glyph project">P</span>)}
        </div>
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
          <div className="st-info-name">{ball.label}</div>
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
