// The Ledger canvas: balls for your emails, the services you use and your
// projects, and the lines between them. Pure functions only, so all of it is
// testable without a canvas. Nothing here holds a secret value.
//
// Every line is something the vault already records, not a drawing of its own:
//
//   email ── service          the account belongs to that email (accounts.identity_id)
//   service ── organization   a team or org inside the account
//   organization ── resource  a project inside the service (a Supabase project,
//                             a Vercel project, a repo); straight from the
//                             service when it is in no organization
//   project ── resource       your project runs on it
//   email ── project          the person works on it -- beside its services,
//                             never above them
//   project ── service        the same, through a resource drawing that line
//                             made: named after the project and nothing more,
//                             so it is drawn as the line rather than a ball
//
// So drawing a line changes the vault, and the vault decides what is drawn.
// Only where each ball sits is the canvas's own, kept in a hidden custom field
// ("_pos") on the record the ball stands for, inside the encrypted vault.

import type {
  AttentionItem,
  CustomField,
  LedgerIdentity,
  Provider,
  SecretListing,
  ServiceProjectSummary,
} from "./types";
import { providerLabel } from "./format";

/** Hidden field holding a ball's position, "x,y". */
export const POS_FIELD = "_pos";

/**
 * Hidden field marking the primary identity. Its name is historical: it was
 * first the skill tree's category list, and the identity carrying it is the
 * primary in vaults created since.
 */
export const PRIMARY_FIELD = "_skillTreeCategories";

/** Whether a custom field is internal bookkeeping rather than something the user named. */
export function isHiddenField(label: string): boolean {
  return label.startsWith("_");
}

export type BallKind = "email" | "account" | "org" | "resource" | "project";

export interface Ball {
  /** `<kind>:<id>`, e.g. `account:<id>`. */
  key: string;
  kind: BallKind;
  id: string;
  label: string;
  sub: string | null;
  provider: Provider | null;
  /** The email everything is centred on. */
  primary: boolean;
  /** A person with no address: whatever hangs off it is filed under no one. */
  noEmail: boolean;
  attention: boolean;
  /** The ball an organization or resource hangs under. */
  parent: string | null;
}

/**
 * `owns`: email to service. `holds`: service or organization to what is inside
 * it. `uses`: project to what it runs on. `works`: email to a project the
 * person works on.
 */
export type LineKind = "owns" | "holds" | "uses" | "works";

export interface Line {
  key: string;
  /** The owner or holder, or for `uses` the project. */
  source: string;
  /** What is owned, held or used. */
  target: string;
  kind: LineKind;
}

export interface Point {
  x: number;
  y: number;
}

export interface CanvasData {
  people: LedgerIdentity[];
  projects: { id: string; name: string }[];
  resources: ServiceProjectSummary[];
  secrets: SecretListing[];
  attention: AttentionItem[];
  /** Custom fields per ball key, hidden ones included. */
  fields: Map<string, CustomField[]>;
  /** Who works on what, as [identityId, projectId]. */
  worksOn: [string, string][];
}

export const ballKey = (kind: BallKind, id: string) => `${kind}:${id}`;

const KINDS: BallKind[] = ["email", "account", "org", "resource", "project"];

export function parseKey(key: string): { kind: BallKind; id: string } | null {
  const at = key.indexOf(":");
  const kind = KINDS.find((k) => k === key.slice(0, at));
  return kind ? { kind, id: key.slice(at + 1) } : null;
}

/**
 * Whether a resource is the one drawing a project–service line made: in no
 * organization, used by exactly one project and named after it. It is drawn
 * as that line; every other resource is a ball of its own.
 */
export function isImplicit(r: ServiceProjectSummary): boolean {
  const [only, ...rest] = r.used_by;
  return (
    r.service_project.organization_id === null &&
    only !== undefined &&
    rest.length === 0 &&
    only.name.trim().toLowerCase() === r.service_project.name.trim().toLowerCase()
  );
}

// --- positions --------------------------------------------------------------------

export function parsePos(value: string | null | undefined): Point | null {
  if (!value) return null;
  const [x, y] = value.split(",").map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: x as number, y: y as number } : null;
}

export function formatPos(p: Point): string {
  return `${Math.round(p.x)},${Math.round(p.y)}`;
}

export function posField(data: CanvasData, key: string): CustomField | null {
  return (data.fields.get(key) ?? []).find((f) => f.label === POS_FIELD) ?? null;
}

// --- the primary ------------------------------------------------------------------

/**
 * The primary email: the identity carrying the marker field, or until one is
 * pinned the first person with an address. An entry with no email is never it.
 */
export function primaryId(data: CanvasData): string | null {
  for (const p of data.people) {
    if ((data.fields.get(ballKey("email", p.identity.id)) ?? []).some((f) => f.label === PRIMARY_FIELD)) {
      return p.identity.id;
    }
  }
  return data.people.find((p) => p.identity.email)?.identity.id ?? null;
}

export function primaryField(data: CanvasData): CustomField | null {
  for (const p of data.people) {
    const hit = (data.fields.get(ballKey("email", p.identity.id)) ?? []).find((f) => f.label === PRIMARY_FIELD);
    if (hit) return hit;
  }
  return null;
}

// --- balls and lines --------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Which account each secret belongs to, directly or through a resource. */
function secretsPerAccount(data: CanvasData): Map<string, number> {
  const accountOf = new Map(data.resources.map((r) => [r.service_project.id, r.service_project.account_id]));
  const out = new Map<string, number>();
  for (const { entry } of data.secrets) {
    const s = entry.secret;
    const owner = s.account_id ?? (s.service_project_id ? accountOf.get(s.service_project_id) : undefined);
    if (owner) out.set(owner, (out.get(owner) ?? 0) + 1);
  }
  return out;
}

export function buildCanvas(data: CanvasData): { balls: Ball[]; lines: Line[] } {
  const flagged = new Set(data.attention.map((a) => a.entity.id));
  const primary = primaryId(data);
  const keys = secretsPerAccount(data);
  const balls: Ball[] = [];
  const lines: Line[] = [];
  const inside: Ball[] = [];
  const orgs = new Map<string, Ball>();

  for (const p of data.people) {
    const { identity } = p;
    balls.push({
      key: ballKey("email", identity.id),
      kind: "email",
      id: identity.id,
      label: identity.email ?? identity.label,
      sub: !identity.email ? "No email" : identity.label !== identity.email ? identity.label : null,
      provider: null,
      primary: identity.id === primary,
      noEmail: !identity.email,
      attention: flagged.has(identity.id),
      parent: null,
    });
    for (const { account, organizations } of p.accounts) {
      const n = keys.get(account.id) ?? 0;
      const accountKey = ballKey("account", account.id);
      balls.push({
        key: accountKey,
        kind: "account",
        id: account.id,
        label: account.label,
        sub: n > 0 ? plural(n, "key") : (account.login_email ?? account.username ?? null),
        provider: account.provider,
        primary: false,
        noEmail: false,
        attention: flagged.has(account.id),
        parent: ballKey("email", identity.id),
      });
      lines.push({
        key: `owns:${identity.id}:${account.id}`,
        source: ballKey("email", identity.id),
        target: accountKey,
        kind: "owns",
      });
      for (const { organization, service_projects } of organizations) {
        const org: Ball = {
          key: ballKey("org", organization.id),
          kind: "org",
          id: organization.id,
          label: organization.name,
          sub: service_projects.length > 0 ? plural(service_projects.length, "project") : null,
          provider: account.provider,
          primary: false,
          noEmail: false,
          attention: flagged.has(organization.id),
          parent: accountKey,
        };
        inside.push(org);
        orgs.set(organization.id, org);
        lines.push({ key: `holds:${account.id}:${organization.id}`, source: accountKey, target: org.key, kind: "holds" });
      }
    }
  }

  const accounts = new Set(balls.filter((b) => b.kind === "account").map((b) => b.id));
  const drawn = new Set<string>();
  for (const r of data.resources) {
    const sp = r.service_project;
    if (!accounts.has(sp.account_id) || isImplicit(r)) continue;
    const org = sp.organization_id ? orgs.get(sp.organization_id) : undefined;
    const parent = org?.key ?? ballKey("account", sp.account_id);
    const key = ballKey("resource", sp.id);
    inside.push({
      key,
      kind: "resource",
      id: sp.id,
      label: sp.name,
      sub: r.secret_count > 0 ? plural(r.secret_count, "key") : sp.region,
      provider: sp.provider,
      primary: false,
      noEmail: false,
      attention: flagged.has(sp.id),
      parent,
    });
    drawn.add(sp.id);
    lines.push({ key: `holds:${parseKey(parent)?.id}:${sp.id}`, source: parent, target: key, kind: "holds" });
  }
  // Organizations first, so each is placed before what goes inside it.
  balls.push(...inside.filter((b) => b.kind === "org"), ...inside.filter((b) => b.kind === "resource"));

  for (const project of data.projects) {
    const vars = data.secrets.filter((s) => s.entry.secret.project_id === project.id).length;
    const uses = new Set<string>();
    for (const r of data.resources) {
      const sp = r.service_project;
      if (!r.used_by.some((u) => u.id === project.id)) continue;
      if (drawn.has(sp.id)) uses.add(ballKey("resource", sp.id));
      else if (accounts.has(sp.account_id)) uses.add(ballKey("account", sp.account_id));
    }
    balls.push({
      key: ballKey("project", project.id),
      kind: "project",
      id: project.id,
      label: project.name,
      sub: vars > 0 ? plural(vars, "variable") : uses.size === 0 ? "No services yet" : null,
      provider: null,
      primary: false,
      noEmail: false,
      attention: flagged.has(project.id),
      parent: null,
    });
    for (const target of uses) {
      lines.push({
        key: `uses:${project.id}:${parseKey(target)?.id}`,
        source: ballKey("project", project.id),
        target,
        kind: "uses",
      });
    }
  }
  const people = new Set(data.people.map((p) => p.identity.id));
  const projects = new Set(data.projects.map((p) => p.id));
  for (const [identityId, projectId] of data.worksOn) {
    if (!people.has(identityId) || !projects.has(projectId)) continue;
    lines.push({
      key: `works:${identityId}:${projectId}`,
      source: ballKey("email", identityId),
      target: ballKey("project", projectId),
      kind: "works",
    });
  }
  return { balls: stampInstances(balls), lines };
}

/**
 * Two accounts of the same service look like the same ball. When that happens,
 * each one keeps a label of its own: the login when there is one, otherwise
 * "GitHub 1", "GitHub 2". A single account is left exactly as it was.
 */
function stampInstances(balls: Ball[]): Ball[] {
  const counts = new Map<string, number>();
  for (const b of balls) {
    if (b.kind === "account" && b.provider) counts.set(b.provider, (counts.get(b.provider) ?? 0) + 1);
  }
  const index = new Map<string, number>();
  return balls.map((b) => {
    if (b.kind !== "account" || !b.provider || (counts.get(b.provider) ?? 0) < 2) return b;
    const n = (index.get(b.provider) ?? 0) + 1;
    index.set(b.provider, n);
    const service = providerLabel(b.provider);
    const login = b.sub && !/\bkeys?$/.test(b.sub) ? b.sub : null;
    if (login && login.toLowerCase() !== service.toLowerCase()) {
      return { ...b, label: login, sub: b.sub === login ? service : `${service}${b.sub && b.sub !== login ? ` · ${b.sub}` : ""}` };
    }
    if (b.label.trim().toLowerCase() === service.toLowerCase()) return { ...b, label: `${service} ${n}` };
    return { ...b, sub: b.sub ?? service };
  });
}

export interface ServiceHull {
  key: string;
  provider: string;
  /** "GitHub ×3" */
  label: string;
  members: string[];
}

/** One hull per service that has two or more accounts on the map. */
export function serviceHulls(balls: Ball[]): ServiceHull[] {
  const groups = new Map<string, Ball[]>();
  for (const b of balls) {
    if (b.kind !== "account" || !b.provider) continue;
    const list = groups.get(b.provider) ?? [];
    list.push(b);
    groups.set(b.provider, list);
  }
  const out: ServiceHull[] = [];
  for (const [provider, members] of groups) {
    if (members.length < 2) continue;
    out.push({
      key: `hull:${provider}`,
      provider,
      label: `${providerLabel(provider)} ×${members.length}`,
      members: members.map((m) => m.key),
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** How many organizations and service-projects sit inside each account. */
export function insideCounts(balls: Ball[]): Map<string, number> {
  const byKey = new Map(balls.map((b) => [b.key, b]));
  const counts = new Map<string, number>();
  for (const b of balls) {
    if (b.kind !== "org" && b.kind !== "resource") continue;
    let p = b.parent;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      seen.add(p);
      const parent = byKey.get(p);
      if (!parent) break;
      if (parent.kind === "account") {
        counts.set(parent.key, (counts.get(parent.key) ?? 0) + 1);
        break;
      }
      p = parent.parent;
    }
  }
  return counts;
}

/**
 * Accounts start folded: their organizations and service-projects are hidden,
 * and a project that ran on one of those draws its line to the account instead.
 * `expanded` is the set of account keys the user has opened.
 */
export function foldedView(
  balls: Ball[],
  lines: Line[],
  expanded: ReadonlySet<string>,
): { balls: Ball[]; lines: Line[] } {
  const byKey = new Map(balls.map((b) => [b.key, b]));
  const accountOf = (key: string): string | null => {
    let p: string | null = key;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      seen.add(p);
      const b = byKey.get(p);
      if (!b) return null;
      if (b.kind === "account") return b.key;
      p = b.parent;
    }
    return null;
  };
  const hidden = new Set<string>();
  for (const b of balls) {
    if (b.kind !== "org" && b.kind !== "resource") continue;
    const acc = accountOf(b.key);
    if (acc && !expanded.has(acc)) hidden.add(b.key);
  }
  const shownBalls = balls.filter((b) => !hidden.has(b.key));
  const shown: Line[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    if (!hidden.has(l.source) && !hidden.has(l.target)) {
      shown.push(l);
      continue;
    }
    if (l.kind !== "uses" || !hidden.has(l.target) || hidden.has(l.source)) continue;
    const acc = accountOf(l.target);
    if (!acc) continue;
    const id = `uses:${l.source}:${acc}`;
    if (seen.has(id) || shown.some((s) => s.source === l.source && s.target === acc && s.kind === "uses")) continue;
    seen.add(id);
    shown.push({ key: `${id}:folded`, source: l.source, target: acc, kind: "uses" });
  }
  return { balls: shownBalls, lines: shown };
}

export interface SideRelations {
  /** What this ball owns or holds, one step down. */
  owns: Ball[];
  /** Who uses it, other than a project (those are listed on their own). */
  usedBy: Ball[];
  /**
   * Projects that depend on this ball. For a project, the things it depends
   * on, holders included, so the chain can be read without hovering the map.
   */
  projects: Ball[];
}

/** The three lists the details panel shows for a selected ball. */
export function sideRelations(key: string, balls: Ball[], lines: Line[]): SideRelations {
  const byKey = new Map(balls.map((b) => [b.key, b]));
  const ball = byKey.get(key);
  const owns = lines
    .filter((l) => (l.kind === "owns" || l.kind === "holds") && l.source === key)
    .map((l) => byKey.get(l.target))
    .filter((b): b is Ball => Boolean(b));

  const held = new Set<string>([key]);
  const stack = [key];
  while (stack.length) {
    const k = stack.pop() as string;
    for (const l of lines) {
      if ((l.kind === "owns" || l.kind === "holds") && l.source === k && !held.has(l.target)) {
        held.add(l.target);
        stack.push(l.target);
      }
    }
  }

  const usedBy: Ball[] = [];
  const seen = new Set<string>();
  const push = (id: string, into: Ball[], bag: Set<string>) => {
    if (id === key || bag.has(id)) return;
    const b = byKey.get(id);
    if (!b) return;
    bag.add(id);
    into.push(b);
  };
  for (const l of lines) {
    if (l.kind === "uses" && held.has(l.target)) push(l.source, usedBy, seen);
    if (l.kind === "works" && l.target === key) push(l.source, usedBy, seen);
  }

  if (ball?.kind === "project") {
    const projects: Ball[] = [];
    const bag = new Set<string>();
    for (const l of lines) {
      if (l.kind !== "uses" || l.source !== key) continue;
      push(l.target, projects, bag);
      let h = byKey.get(l.target)?.parent ?? null;
      const guard = new Set<string>();
      while (h && !guard.has(h)) {
        guard.add(h);
        push(h, projects, bag);
        h = byKey.get(h)?.parent ?? null;
      }
    }
    return { owns, usedBy, projects };
  }

  return {
    owns,
    usedBy: usedBy.filter((b) => b.kind !== "project"),
    projects: usedBy.filter((b) => b.kind === "project"),
  };
}

// --- where balls go ---------------------------------------------------------------

const COLUMN: Record<BallKind, number> = { email: 0, account: 300, org: 520, resource: 740, project: 1000 };
const ROW = 130;
/** How far to the right of its holder an organization or resource is put. */
const BESIDE = 220;

/**
 * Every ball's position: where the user left it, or for a ball never moved, a
 * spot in its column -- emails, then services, then projects, left to right --
 * below whatever is already there, so nothing new lands on top of something.
 * An organization or resource goes beside what holds it instead.
 */
export function positions(balls: Ball[], saved: Map<string, Point>): Map<string, Point> {
  const out = new Map<string, Point>();
  const lowest: Record<BallKind, number> = { email: -ROW, account: -ROW, org: -ROW, resource: -ROW, project: -ROW };
  for (const b of balls) {
    const p = saved.get(b.key);
    if (!p) continue;
    out.set(b.key, p);
    if (Math.abs(p.x - COLUMN[b.kind]) < 150) lowest[b.kind] = Math.max(lowest[b.kind], p.y);
  }
  for (const b of balls) {
    if (out.has(b.key)) continue;
    const holder = (b.kind === "org" || b.kind === "resource") && b.parent ? out.get(b.parent) : undefined;
    if (holder) {
      out.set(b.key, besideSpot(holder, out.values()));
      continue;
    }
    lowest[b.kind] += ROW;
    // Its column's next row, or the nearest free spot if a ball someone moved
    // already sits there.
    const spot = freeSpot({ x: COLUMN[b.kind], y: lowest[b.kind] }, out.values());
    out.set(b.key, spot);
    if (spot.x === COLUMN[b.kind]) lowest[b.kind] = Math.max(lowest[b.kind], spot.y);
  }
  return out;
}

export function savedPositions(data: CanvasData, balls: Ball[]): Map<string, Point> {
  const out = new Map<string, Point>();
  for (const b of balls) {
    const p = parsePos(posField(data, b.key)?.value);
    if (p) out.set(b.key, p);
  }
  return out;
}

/** The email ball nearest a point: a service dropped next to an email belongs to it. */
export function nearestEmail(balls: Ball[], at: Map<string, Point>, point: Point): Ball | null {
  let best: Ball | null = null;
  let bestDist = Infinity;
  for (const b of balls) {
    if (b.kind !== "email" || b.noEmail) continue;
    const p = at.get(b.key);
    if (!p) continue;
    const d = Math.hypot(p.x - point.x, p.y - point.y);
    if (d < bestDist) {
      best = b;
      bestDist = d;
    }
  }
  return best;
}

// --- drawing a line ---------------------------------------------------------------

export type Intent =
  | { kind: "own"; accountId: string; identityId: string }
  | { kind: "use"; accountId: string; projectId: string }
  | { kind: "link"; resourceId: string; projectId: string }
  | { kind: "work"; identityId: string; projectId: string }
  | { kind: "moveOrg"; organizationId: string; accountId: string }
  | { kind: "place"; resourceId: string; accountId: string; organizationId: string | null }
  | { kind: "none" }
  | { kind: "refuse"; reason: string };

const RANK: Record<BallKind, number> = { email: 0, account: 1, org: 2, resource: 3, project: 4 };

/** What a line drawn between two balls means, whichever end it started from. */
export function connectIntent(a: Ball, b: Ball, lines: Line[]): Intent {
  if (a.key === b.key) return { kind: "none" };
  const [first, second] = [a, b].sort((x, y) => RANK[x.kind] - RANK[y.kind]) as [Ball, Ball];
  const exists = lines.some(
    (l) => (l.source === a.key && l.target === b.key) || (l.source === b.key && l.target === a.key),
  );
  if (exists) return { kind: "none" };
  const pair = `${first.kind}-${second.kind}`;
  const otherService = () => ({
    kind: "refuse" as const,
    reason: `${second.label} is in another service than ${first.label}; it can only move within the same service.`,
  });
  const orgAccount = (org: Ball) => (org.parent ? parseKey(org.parent)?.id : undefined);

  switch (pair) {
    case "email-account":
      if (first.noEmail) {
        return { kind: "refuse", reason: "That entry has no email address. Connect the service to an email instead." };
      }
      return { kind: "own", accountId: second.id, identityId: first.id };
    case "email-org":
    case "email-resource":
      return {
        kind: "refuse",
        reason: `An email owns the service itself. Connect the email to the service ${second.label} is in.`,
      };
    case "email-project":
      return { kind: "work", identityId: first.id, projectId: second.id };
    case "account-org":
      if (first.provider !== second.provider) return otherService();
      return { kind: "moveOrg", organizationId: second.id, accountId: first.id };
    case "account-resource":
      if (first.provider !== second.provider) return otherService();
      return { kind: "place", resourceId: second.id, accountId: first.id, organizationId: null };
    case "account-project":
      return { kind: "use", accountId: first.id, projectId: second.id };
    case "org-resource": {
      const accountId = orgAccount(first);
      if (first.provider !== second.provider || !accountId) return otherService();
      return { kind: "place", resourceId: second.id, accountId, organizationId: first.id };
    }
    case "org-project":
      return {
        kind: "refuse",
        reason: `Connect ${second.label} to a project inside ${first.label}, or add one: drag from ${first.label} to an empty spot.`,
      };
    case "resource-project":
      return { kind: "link", resourceId: first.id, projectId: second.id };
    case "account-account":
      return { kind: "refuse", reason: "Two services are not linked to each other. Connect each to its email and to the projects that use it." };
    default:
      return { kind: "refuse", reason: `A ${KIND_NOUN[first.kind]} and a ${KIND_NOUN[second.kind]} cannot be connected.` };
  }
}

const KIND_NOUN: Record<BallKind, string> = {
  email: "email",
  account: "service",
  org: "organization",
  resource: "project in a service",
  project: "project",
};

/**
 * The resource to link when a project starts using an account: one already
 * named after the project under that account, else none (a new one is made).
 */
export function resourceToLink(data: CanvasData, accountId: string, projectName: string): string | null {
  const name = projectName.trim().toLowerCase();
  return (
    data.resources.find(
      (r) => r.service_project.account_id === accountId && r.service_project.name.trim().toLowerCase() === name,
    )?.service_project.id ?? null
  );
}

/**
 * What removing a project–service line touches: the resources drawn as that
 * line. One that holds nothing goes; one holding keys is only unlinked.
 */
export function resourcesToUnlink(
  data: CanvasData,
  accountId: string,
  projectId: string,
): { id: string; remove: boolean }[] {
  return data.resources
    .filter((r) => r.service_project.account_id === accountId && isImplicit(r) && r.used_by.some((u) => u.id === projectId))
    .map((r) => ({ id: r.service_project.id, remove: r.secret_count === 0 && r.used_by.length === 1 }));
}

// --- what a ball is connected to --------------------------------------------------

/**
 * A ball and what it is connected to. For a project: what it runs on and
 * everything that holds those, up to the email. For anything else: what holds
 * it, up to the email; everything inside it; and the projects using any of that.
 */
export function neighbourhood(lines: Line[], key: string): Set<string> {
  const out = new Set([key]);
  const holder = new Map<string, string>();
  const held = new Map<string, string[]>();
  for (const l of lines) {
    if (l.kind === "uses" || l.kind === "works") continue;
    holder.set(l.target, l.source);
    held.set(l.source, [...(held.get(l.source) ?? []), l.target]);
  }
  const up = (k: string) => {
    for (let h = holder.get(k); h && !out.has(h); h = holder.get(h)) out.add(h);
  };

  if (parseKey(key)?.kind === "project") {
    for (const l of lines) {
      if (l.kind === "uses" && l.source === key) {
        out.add(l.target);
        up(l.target);
      }
      if (l.kind === "works" && l.target === key) out.add(l.source);
    }
    return out;
  }
  up(key);
  const below = new Set([key]);
  const down = (k: string) => {
    for (const c of held.get(k) ?? []) {
      if (below.has(c)) continue;
      below.add(c);
      out.add(c);
      down(c);
    }
  };
  down(key);
  for (const l of lines) {
    if (l.kind === "uses" && below.has(l.target)) out.add(l.source);
    if (l.kind === "works" && l.source === key) out.add(l.target);
  }
  return out;
}

// --- laying out a whole tree ------------------------------------------------------

/** What holds each ball: the email owning a service, the service holding a project in it. */
function holderMap(lines: Line[]): Map<string, string> {
  return new Map(lines.filter((l) => l.kind === "owns" || l.kind === "holds").map((l) => [l.target, l.source]));
}

/** A stable order for siblings: the main email first, then by kind and name. */
function rank(b: Ball | undefined, key: string): string {
  return `${b?.primary ? 0 : 1}${b ? RANK[b.kind] : 9}${(b?.label ?? "").toLowerCase()}\u0000${key}`;
}

const byRank = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function comparePaths(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const c = byRank(a[i] as string, b[i] as string);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

const mean = (ys: number[]) => ys.reduce((s, y) => s + y, 0) / ys.length;

/**
 * Heights for one column: each item as close to where it wants to be as it can
 * get, in the same order, never closer than `gap` to the next, and the column
 * as a whole centred where its items wanted it.
 */
function spread(items: { key: string; want: number }[], gap: number): Map<string, number> {
  const sorted = [...items].sort((a, b) => a.want - b.want);
  const ys: number[] = [];
  for (const it of sorted) ys.push(ys.length === 0 ? it.want : Math.max(it.want, (ys.at(-1) as number) + gap));
  const shift = sorted.length > 0 ? mean(sorted.map((i) => i.want)) - mean(ys) : 0;
  return new Map(sorted.map((it, i) => [it.key, Math.round((ys[i] as number) + shift)]));
}

/** How far apart the columns on a project's page are. */
const FOCUS_COLUMN = 220;
/** Standing upright, for a narrow screen: how far apart the levels and the balls on one level are. */
const UPRIGHT_LEVEL = 170;
const UPRIGHT_GAP = 150;

/**
 * What a project's page shows: the project, what it runs on and whatever
 * holds that, who works on it, every email of yours -- so a service can be
 * given to one by drawing a line from it -- and the organizations inside the
 * services shown, so one just added appears beside its service.
 */
export function projectView(balls: Ball[], lines: Line[], projectKey: string): Set<string> {
  if (!balls.some((b) => b.key === projectKey)) return new Set();
  const out = neighbourhood(lines, projectKey);
  for (const b of balls) if (b.kind === "email" && !b.noEmail) out.add(b.key);
  for (const b of balls) if (b.kind === "org" && b.parent && out.has(b.parent)) out.add(b.key);
  return out;
}

/**
 * A project's page draws it on its own: the project on the left, what it runs
 * on beside it, and then whatever holds those -- organizations, services,
 * emails -- a column each. People who work on it without owning any of it
 * stand on its other side. Positions here are for that page only and are
 * never saved.
 *
 * What it runs on is sorted by what holds it, so things in the same service
 * and under the same email sit together, and every holder sits level with the
 * middle of what it holds: no two lines cross and none runs through a ball.
 *
 * `upright` stands the same layout on its end for a narrow screen: the project
 * at the top and each column a row below it, so a phone shows it larger.
 */
export function focusLayout(
  balls: Ball[],
  lines: Line[],
  projectKey: string,
  opts: { upright?: boolean } = {},
): Map<string, Point> {
  const out = new Map<string, Point>([[projectKey, { x: 0, y: 0 }]]);
  const byKey = new Map(balls.map((b) => [b.key, b]));
  const holder = holderMap(lines);
  const order = (k: string) => rank(byKey.get(k), k);
  // What holds a ball on this page, from the email down.
  const above = (k: string) => {
    const chain: string[] = [];
    for (let h = holder.get(k); h && byKey.has(h) && !chain.includes(h); h = holder.get(h)) chain.unshift(h);
    return chain;
  };

  const used = [
    ...new Set(lines.filter((l) => l.kind === "uses" && l.source === projectKey && byKey.has(l.target)).map((l) => l.target)),
  ];
  // An organization in a service the project uses directly, holding nothing it
  // uses -- just added, perhaps -- gets a row of its own under that service, so
  // the line from the service to its email does not run through it.
  const chains = new Set(used.flatMap(above));
  const loose = balls
    .filter((b) => b.kind === "org" && b.parent && used.includes(b.parent) && !chains.has(b.key) && !used.includes(b.key))
    .map((b) => b.key);
  const targets = [...used, ...loose];
  const paths = new Map(targets.map((t) => [t, [...above(t), t].map(order)]));
  targets.sort((a, b) => comparePaths(paths.get(a) ?? [], paths.get(b) ?? []));
  targets.forEach((t, i) => out.set(t, { x: FOCUS_COLUMN, y: (i - (targets.length - 1) / 2) * ROW }));

  // Each holder, level with the middle of what it holds, a column per kind.
  const below = new Map<string, number[]>();
  for (const t of targets) {
    const y = out.get(t)?.y ?? 0;
    for (const a of above(t)) if (!out.has(a)) below.set(a, [...(below.get(a) ?? []), y]);
  }
  const heightOf = (k: string) => out.get(k)?.y ?? (below.has(k) ? mean(below.get(k) as number[]) : undefined);
  // Any other organization in a service on this page: level with its service,
  // in the organizations' column.
  for (const b of balls) {
    const y = b.kind === "org" && b.parent && !out.has(b.key) && !below.has(b.key) ? heightOf(b.parent) : undefined;
    if (y !== undefined) below.set(b.key, [y]);
  }

  const people = [
    ...new Set(lines.filter((l) => l.kind === "works" && l.target === projectKey).map((l) => l.source)),
  ]
    .filter((k) => byKey.has(k) && !out.has(k) && !below.has(k))
    .sort((a, b) => byRank(order(a), order(b)));
  people.forEach((k, i) => out.set(k, { x: -FOCUS_COLUMN, y: (i - (people.length - 1) / 2) * ROW }));

  // Your other emails, below the ones in use, so a service can be given to
  // one by drawing a line from it.
  const idle = balls
    .filter((b) => b.kind === "email" && !out.has(b.key) && !below.has(b.key))
    .map((b) => b.key)
    .sort((a, b) => byRank(order(a), order(b)));
  const inUse = [...below].filter(([k]) => byKey.get(k)?.kind === "email").map(([, ys]) => mean(ys));
  const first = inUse.length > 0 ? Math.max(...inUse) + ROW : -((idle.length - 1) / 2) * ROW;
  idle.forEach((k, i) => below.set(k, [first + i * ROW]));

  const kinds = (["org", "account", "email"] as BallKind[]).filter((k) =>
    [...below.keys()].some((a) => byKey.get(a)?.kind === k),
  );
  kinds.forEach((kind, i) => {
    const column = [...below].filter(([a]) => byKey.get(a)?.kind === kind).map(([key, ys]) => ({ key, want: mean(ys) }));
    // Emails are the largest balls, with the longest names under them.
    for (const [key, y] of spread(column, kind === "email" ? ROW : 100)) out.set(key, { x: FOCUS_COLUMN * (i + 2), y });
  });

  let spare = 0;
  for (const b of balls) if (!out.has(b.key)) out.set(b.key, { x: 0, y: ROW * ++spare });
  if (!opts.upright) return out;
  return new Map(
    [...out].map(([k, p]) => [
      k,
      { x: Math.round((p.y / ROW) * UPRIGHT_GAP), y: Math.round((p.x / FOCUS_COLUMN) * UPRIGHT_LEVEL) },
    ]),
  );
}

/** Where the empty slot for a project's first service goes, beside or below the project. */
export function slotSpot(project: Point, upright: boolean): Point {
  return upright ? { x: project.x, y: project.y + UPRIGHT_LEVEL } : { x: project.x + FOCUS_COLUMN, y: project.y };
}

/**
 * The whole map, tidied: emails on the left, each service beside the email
 * that owns it, what is inside a service beside that, and each project level
 * with what it runs on. Every ball at the end of a chain gets a row of its own
 * and every holder sits level with the middle of what it holds, so no two
 * lines of the same tree cross. A service a project uses directly takes the
 * top row of its block, so that project's line does not run through what is
 * inside it.
 */
export function tidyLayout(balls: Ball[], lines: Line[]): Map<string, Point> {
  const out = new Map<string, Point>();
  const byKey = new Map(balls.map((b) => [b.key, b]));
  const holder = holderMap(lines);
  const order = (k: string) => rank(byKey.get(k), k);
  const children = new Map<string, string[]>();
  for (const [child, parent] of holder) {
    if (byKey.has(child) && byKey.has(parent)) children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  for (const list of children.values()) list.sort((a, b) => byRank(order(a), order(b)));
  const usedDirectly = new Set(lines.filter((l) => l.kind === "uses").map((l) => l.target));

  let next = 0;
  const visit = (k: string): number => {
    const kind = byKey.get(k)?.kind ?? "email";
    out.set(k, { x: COLUMN[kind], y: 0 });
    const kids = (children.get(k) ?? []).filter((c) => !out.has(c));
    let y: number;
    if (kids.length === 0 || usedDirectly.has(k)) {
      y = next;
      next += ROW;
      kids.forEach(visit);
    } else {
      const ys = kids.map(visit);
      y = ((ys[0] as number) + (ys.at(-1) as number)) / 2;
    }
    out.set(k, { x: COLUMN[kind], y });
    return y;
  };
  const roots = balls
    .filter((b) => b.kind !== "project" && !byKey.has(holder.get(b.key) ?? ""))
    .map((b) => b.key)
    .sort((a, b) => byRank(order(a), order(b)));
  for (const r of roots) {
    if (out.has(r)) continue;
    visit(r);
    // A little air between one email's things and the next.
    next += ROW / 2;
  }

  const projects = balls.filter((b) => b.kind === "project");
  const heights = (keys: string[]) => keys.map((k) => out.get(k)?.y).filter((y): y is number => y !== undefined);
  const wants = projects.map((p) => {
    const used = heights(lines.filter((l) => l.kind === "uses" && l.source === p.key).map((l) => l.target));
    const people = heights(lines.filter((l) => l.kind === "works" && l.target === p.key).map((l) => l.source));
    return { key: p.key, want: used.length > 0 ? mean(used) : people.length > 0 ? mean(people) : null };
  });
  const placed = spread(
    wants.filter((w): w is { key: string; want: number } => w.want !== null),
    ROW,
  );
  let bottom = Math.max(next, ...[...placed.values()].map((y) => y + ROW));
  for (const w of wants) {
    const y = placed.get(w.key) ?? bottom;
    if (!placed.has(w.key)) bottom += ROW;
    out.set(w.key, { x: COLUMN.project, y });
  }
  return out;
}

/**
 * The email a new service on a project's page belongs to: the one that already
 * owns most of what the project runs on, else someone who works on it, else
 * the main email, else the first. Null only when there is no email at all.
 */
export function ownerFor(projectKey: string, emails: Ball[], lines: Line[]): Ball | null {
  if (emails.length === 0) return null;
  const holder = holderMap(lines);
  const root = (k: string) => {
    const seen = new Set<string>();
    let r = k;
    for (let h = holder.get(r); h && !seen.has(h); h = holder.get(h)) {
      seen.add(h);
      r = h;
    }
    return r;
  };
  const owns = new Map<string, number>();
  for (const l of lines) {
    if (l.kind !== "uses" || l.source !== projectKey) continue;
    const r = root(l.target);
    owns.set(r, (owns.get(r) ?? 0) + 1);
  }
  const best = (list: Ball[]) =>
    [...list].sort((a, b) => (owns.get(b.key) ?? 0) - (owns.get(a.key) ?? 0) || Number(b.primary) - Number(a.primary))[0];
  const owner = best(emails.filter((e) => owns.has(e.key)));
  if (owner) return owner;
  const workers = emails.filter((e) => lines.some((l) => l.kind === "works" && l.source === e.key && l.target === projectKey));
  return best(workers) ?? emails.find((e) => e.primary) ?? emails[0] ?? null;
}

/**
 * Beside what holds it: to the right, at the same height if that is free,
 * else the nearest free spot above or below.
 */
export function besideSpot(holder: Point, taken: Iterable<Point>, gap = 100): Point {
  const spots = [...taken];
  const x = holder.x + BESIDE;
  for (let i = 0; i < 24; i += 1) {
    const step = Math.ceil(i / 2) * (i % 2 === 1 ? 1 : -1);
    const p = { x, y: holder.y + step * gap };
    if (spots.every((s) => Math.hypot(s.x - p.x, s.y - p.y) >= gap)) return p;
  }
  return freeSpot({ x, y: holder.y }, spots);
}

/** The nearest spot to `at` that is at least `gap` from every taken one. */
export function freeSpot(at: Point, taken: Iterable<Point>, gap = 110): Point {
  const spots = [...taken];
  const free = (p: Point) => spots.every((s) => Math.hypot(s.x - p.x, s.y - p.y) >= gap);
  if (free(at)) return at;
  for (let ring = 1; ring <= 12; ring += 1) {
    for (let step = 0; step < 8; step += 1) {
      const angle = (step / 8) * Math.PI * 2;
      const p = { x: Math.round(at.x + Math.cos(angle) * gap * ring), y: Math.round(at.y + Math.sin(angle) * gap * ring) };
      if (free(p)) return p;
    }
  }
  return at;
}
