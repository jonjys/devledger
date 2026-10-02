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

/** `owns`: email to service. `holds`: service or organization to what is inside it. `uses`: project to what it runs on. */
export type LineKind = "owns" | "holds" | "uses";

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
  return { balls, lines };
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
      return {
        kind: "refuse",
        reason: "A project connects to the services it runs on, and each service to its email. Draw project → GitHub, then GitHub → email.",
      };
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
    if (l.kind === "uses") continue;
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
  for (const l of lines) if (l.kind === "uses" && below.has(l.target)) out.add(l.source);
  return out;
}

/**
 * A project's page draws it on its own: the project on the left, what it runs
 * on beside it, and then whatever holds those -- organizations, services,
 * emails -- a column each. Positions here are for that page only and are never
 * saved.
 */
export function focusLayout(balls: Ball[], lines: Line[], projectKey: string): Map<string, Point> {
  const out = new Map<string, Point>([[projectKey, { x: 0, y: 0 }]]);
  const byKey = new Map(balls.map((b) => [b.key, b]));
  const holder = new Map(lines.filter((l) => l.kind !== "uses").map((l) => [l.target, l.source]));
  const columns: string[][] = [];
  const add = (k: string, column: number) => {
    if (columns.some((c) => c.includes(k))) return;
    (columns[column] ??= []).push(k);
  };
  // What the project runs on, then a column per kind further up the chain.
  const order: BallKind[] = ["resource", "org", "account", "email"];
  const targets = lines.filter((l) => l.kind === "uses" && l.source === projectKey).map((l) => l.target);
  for (const t of targets) add(t, 0);
  const chain = new Set<string>();
  for (const t of targets) for (let h = holder.get(t); h; h = holder.get(h)) chain.add(h);
  const kinds = order.filter((k) => [...chain].some((c) => byKey.get(c)?.kind === k && !targets.includes(c)));
  for (const c of chain) {
    const kind = byKey.get(c)?.kind;
    if (kind) add(c, 1 + kinds.indexOf(kind));
  }
  // What the project runs on is spread evenly; everything further up sits
  // level with what it holds, so no line has to run through a ball it does
  // not belong to.
  const first = columns[0] ?? [];
  first.forEach((k, j) => out.set(k, { x: 220, y: (j - (first.length - 1) / 2) * ROW }));
  columns.slice(1).forEach((keys, i) => {
    const want = (keys ?? []).map((k) => {
      const held = [...out.entries()].filter(([c]) => holder.get(c) === k).map(([, p]) => p.y);
      return { k, y: held.length > 0 ? held.reduce((a, b) => a + b, 0) / held.length : 0 };
    });
    want.sort((a, b) => a.y - b.y);
    let last = -Infinity;
    for (const w of want) {
      const y = Math.max(w.y, last + 100);
      out.set(w.k, { x: 220 * (i + 2), y });
      last = y;
    }
  });
  let spare = 0;
  for (const b of balls) if (!out.has(b.key)) out.set(b.key, { x: 0, y: ROW * ++spare });
  return out;
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
