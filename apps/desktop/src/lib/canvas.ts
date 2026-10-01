// The Ledger canvas: balls for your emails, the services you use and your
// projects, and the lines between them. Pure functions only, so all of it is
// testable without a canvas. Nothing here holds a secret value.
//
// Every line is something the vault already records, not a drawing of its own:
//
//   email ── service   the account belongs to that email (accounts.identity_id)
//   project ── service the project uses a resource under that account
//                      (a Vercel project, a repo, a Supabase project)
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

export type BallKind = "email" | "account" | "project";

export interface Ball {
  /** `email:<id>`, `account:<id>` or `project:<id>`. */
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
}

export type LineKind = "owns" | "uses";

export interface Line {
  key: string;
  /** For `owns` the email, for `uses` the project. */
  source: string;
  /** Always the service account. */
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

export function parseKey(key: string): { kind: BallKind; id: string } | null {
  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  if (kind !== "email" && kind !== "account" && kind !== "project") return null;
  return { kind, id: key.slice(at + 1) };
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
    });
    for (const { account } of p.accounts) {
      const n = keys.get(account.id) ?? 0;
      balls.push({
        key: ballKey("account", account.id),
        kind: "account",
        id: account.id,
        label: account.label,
        sub: n > 0 ? plural(n, "key") : (account.login_email ?? account.username ?? null),
        provider: account.provider,
        primary: false,
        noEmail: false,
        attention: flagged.has(account.id),
      });
      lines.push({
        key: `owns:${identity.id}:${account.id}`,
        source: ballKey("email", identity.id),
        target: ballKey("account", account.id),
        kind: "owns",
      });
    }
  }

  const accounts = new Set(balls.filter((b) => b.kind === "account").map((b) => b.id));
  for (const project of data.projects) {
    const vars = data.secrets.filter((s) => s.entry.secret.project_id === project.id).length;
    const uses = new Set<string>();
    for (const r of data.resources) {
      if (r.used_by.some((u) => u.id === project.id) && accounts.has(r.service_project.account_id)) {
        uses.add(r.service_project.account_id);
      }
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
    });
    for (const accountId of uses) {
      lines.push({
        key: `uses:${project.id}:${accountId}`,
        source: ballKey("project", project.id),
        target: ballKey("account", accountId),
        kind: "uses",
      });
    }
  }
  return { balls, lines };
}

// --- where balls go ---------------------------------------------------------------

const COLUMN: Record<BallKind, number> = { email: 0, account: 300, project: 600 };
const ROW = 130;

/**
 * Every ball's position: where the user left it, or for a ball never moved, a
 * spot in its column -- emails, then services, then projects, left to right --
 * below whatever is already there, so nothing new lands on top of something.
 */
export function positions(balls: Ball[], saved: Map<string, Point>): Map<string, Point> {
  const out = new Map<string, Point>();
  const lowest: Record<BallKind, number> = { email: -ROW, account: -ROW, project: -ROW };
  for (const b of balls) {
    const p = saved.get(b.key);
    if (!p) continue;
    out.set(b.key, p);
    if (Math.abs(p.x - COLUMN[b.kind]) < 150) lowest[b.kind] = Math.max(lowest[b.kind], p.y);
  }
  for (const b of balls) {
    if (out.has(b.key)) continue;
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
  | { kind: "none" }
  | { kind: "refuse"; reason: string };

/** What a line drawn between two balls means, whichever end it started from. */
export function connectIntent(a: Ball, b: Ball, lines: Line[]): Intent {
  if (a.key === b.key) return { kind: "none" };
  const pair = [a, b].sort((x, y) => x.kind.localeCompare(y.kind));
  const [first, second] = pair as [Ball, Ball];
  const exists = lines.some(
    (l) => (l.source === a.key && l.target === b.key) || (l.source === b.key && l.target === a.key),
  );
  if (exists) return { kind: "none" };

  // account < email < project, alphabetically.
  if (first.kind === "account" && second.kind === "email") {
    if (second.noEmail) {
      return { kind: "refuse", reason: "That entry has no email address. Connect the service to an email instead." };
    }
    return { kind: "own", accountId: first.id, identityId: second.id };
  }
  if (first.kind === "account" && second.kind === "project") {
    return { kind: "use", accountId: first.id, projectId: second.id };
  }
  if (first.kind === "email" && second.kind === "project") {
    return {
      kind: "refuse",
      reason: "A project connects to the services it runs on, and each service to its email. Draw project → GitHub, then GitHub → email.",
    };
  }
  if (first.kind === "account" && second.kind === "account") {
    return { kind: "refuse", reason: "Two services are not linked to each other. Connect each to its email and to the projects that use it." };
  }
  return { kind: "refuse", reason: `Two ${first.kind === "email" ? "emails" : "projects"} cannot be connected.` };
}

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
 * What removing a project–service line touches: every resource under the
 * account the project uses. A resource that holds nothing and nothing else
 * uses -- the one drawing the line made -- goes; any other is only unlinked.
 */
export function resourcesToUnlink(
  data: CanvasData,
  accountId: string,
  projectId: string,
): { id: string; remove: boolean }[] {
  return data.resources
    .filter((r) => r.service_project.account_id === accountId && r.used_by.some((u) => u.id === projectId))
    .map((r) => ({ id: r.service_project.id, remove: r.secret_count === 0 && r.used_by.length === 1 }));
}

// --- what a ball is connected to --------------------------------------------------

/**
 * A ball and what it is connected to: a project's services and their emails;
 * a service's email and the projects using it; an email's services and the
 * projects using those.
 */
export function neighbourhood(lines: Line[], key: string): Set<string> {
  const out = new Set([key]);
  const near = (k: string) =>
    lines.filter((l) => l.source === k || l.target === k).map((l) => (l.source === k ? l.target : l.source));
  const kind = parseKey(key)?.kind;
  for (const service of near(key)) {
    out.add(service);
    if (kind === "account") continue;
    const far = kind === "project" ? "email:" : "project:";
    for (const k of near(service)) if (k.startsWith(far)) out.add(k);
  }
  return out;
}

/**
 * A project's page draws it on its own: the project on the left, the
 * services it uses beside it, and their emails beyond. Positions here are
 * for that page only and are never saved.
 */
export function focusLayout(balls: Ball[], lines: Line[], projectKey: string): Map<string, Point> {
  const out = new Map<string, Point>([[projectKey, { x: 0, y: 0 }]]);
  const column = (keys: string[], x: number) =>
    keys.forEach((k, i) => out.set(k, { x, y: (i - (keys.length - 1) / 2) * ROW }));
  const services = lines.filter((l) => l.source === projectKey).map((l) => l.target);
  column(services, 220);
  const emails: string[] = [];
  for (const s of services) {
    const owner = lines.find((l) => l.kind === "owns" && l.target === s)?.source;
    if (owner && !emails.includes(owner)) emails.push(owner);
  }
  column(emails, 440);
  let spare = 0;
  for (const b of balls) if (!out.has(b.key)) out.set(b.key, { x: 0, y: ROW * ++spare });
  return out;
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
