// The skill tree's model: what hangs off what, where it is drawn, and which
// branches are lit. Pure functions only, so all of it is testable without a
// canvas. Nothing here ever holds a secret value -- only the masked previews
// the backend sends.

import { normalizeSecretKind } from "./format";
import type {
  AttentionItem,
  CustomField,
  LedgerIdentity,
  Provider,
  SecretKind,
  SecretListing,
  ServiceProjectSummary,
} from "./types";

// --- the hidden field ---------------------------------------------------------
//
// Categories are the user's own grouping ("AI", "Payments"), not something the
// backend models. They are kept in one custom field on the primary identity,
// so they sit inside the encrypted vault with everything else and travel with a
// backup. The identity carrying the field *is* the primary: moving the field is
// how "Make Primary" works, and there is never an email address in the code.

/** Label of the hidden field. Fields whose label starts with `_` are never listed. */
export const STATE_FIELD = "_skillTreeCategories";

export type Status = "healthy" | "missing" | "attention";

const STATUS_CODE: Record<Status, string> = { healthy: "h", missing: "m", attention: "a" };
const CODE_STATUS: Record<string, Status> = { h: "healthy", m: "missing", a: "attention" };

export interface Category {
  id: string;
  name: string;
  /** Short ids of the accounts filed here, in order. */
  accounts: string[];
}

export interface TreeState {
  categories: Category[];
  /** Status set by hand, by short id. Absent means "work it out". */
  statuses: Record<string, Status>;
}

/** Whether a custom field is internal bookkeeping rather than something the user named. */
export function isHiddenField(label: string): boolean {
  return label.startsWith("_");
}

/**
 * First eight hex digits of a UUID.
 *
 * The field holds at most 4000 characters; a full UUID per account would run
 * out at around sixty accounts. Eight hex digits collide once in about four
 * billion pairs, and a lookup that finds no match just leaves the account
 * uncategorised.
 */
export function shortId(uuid: string): string {
  return uuid.replace(/-/g, "").slice(0, 8).toLowerCase();
}

/** Read the field, tolerating anything: a broken value must never break the tree. */
export function parseState(value: string | null | undefined): TreeState {
  if (!value) return { categories: [], statuses: {} };
  try {
    const raw = JSON.parse(value) as {
      c?: { i?: unknown; n?: unknown; a?: unknown }[];
      s?: Record<string, unknown>;
    };
    const categories: Category[] = [];
    for (const c of Array.isArray(raw.c) ? raw.c : []) {
      if (typeof c?.i !== "string" || typeof c?.n !== "string") continue;
      const accounts = Array.isArray(c.a) ? c.a.filter((a): a is string => typeof a === "string") : [];
      categories.push({ id: c.i, name: c.n, accounts });
    }
    const statuses: Record<string, Status> = {};
    for (const [k, v] of Object.entries(raw.s ?? {})) {
      if (typeof v === "string" && CODE_STATUS[v]) statuses[k] = CODE_STATUS[v];
    }
    return { categories, statuses };
  } catch {
    return { categories: [], statuses: {} };
  }
}

export function serializeState(state: TreeState): string {
  const s: Record<string, string> = {};
  for (const [k, v] of Object.entries(state.statuses)) s[k] = STATUS_CODE[v];
  return JSON.stringify({
    v: 1,
    c: state.categories.map((c) => ({ i: c.id, n: c.name, a: c.accounts })),
    s,
  });
}

export function newCategoryId(state: TreeState): string {
  let n = state.categories.length + 1;
  const taken = new Set(state.categories.map((c) => c.id));
  while (taken.has(`k${n}`)) n += 1;
  return `k${n}`;
}

/** File an account under a category, or under none when `categoryId` is null. */
export function placeAccount(state: TreeState, accountId: string, categoryId: string | null): TreeState {
  const id = shortId(accountId);
  return {
    ...state,
    categories: state.categories.map((c) => {
      const without = c.accounts.filter((a) => a !== id);
      return c.id === categoryId ? { ...c, accounts: [...without, id] } : { ...c, accounts: without };
    }),
  };
}

export function setStatus(state: TreeState, id: string, status: Status | null): TreeState {
  const statuses = { ...state.statuses };
  if (status) statuses[id] = status;
  else delete statuses[id];
  return { ...state, statuses };
}

// --- the tree -----------------------------------------------------------------

export type NodeKind = "primary" | "identity" | "category" | "account" | "field" | "project";

/** How a field is coloured: API key green, password red, other secrets amber. */
export type FieldTone = "api" | "password" | "secret" | "plain";

export interface TreeItem {
  key: string;
  kind: NodeKind;
  label: string;
  sub: string | null;
  provider: Provider | null;
  tone: FieldTone | null;
  status: Status;
  /** Id of the record behind the node: identity, account, secret, custom field or project. */
  id: string | null;
  /** What sort of record `id` is, for fields. */
  source: "secret" | "custom" | "detail" | null;
  children: TreeItem[];
}

export interface SkillData {
  people: LedgerIdentity[];
  secrets: SecretListing[];
  /** Custom fields per account id, hidden ones included (they are filtered here). */
  accountFields: Map<string, CustomField[]>;
  /** Custom fields per identity id, used to find the state field. */
  identityFields: Map<string, CustomField[]>;
  attention: AttentionItem[];
  resources: ServiceProjectSummary[];
  /** Project ids and names, for the project node shown while filtering. */
  projects: { id: string; name: string }[];
}

export interface Primary {
  identityId: string;
  /** Whether an identity actually carries the field, or this is a fallback. */
  marked: boolean;
  field: CustomField | null;
}

/**
 * The primary identity: the one carrying the hidden field.
 *
 * Before anything has been saved there is no field, so the first identity with
 * an email address stands in -- the tree says it is not pinned yet, and the
 * first change pins it.
 */
export function findPrimary(data: SkillData): Primary | null {
  for (const person of data.people) {
    const field = (data.identityFields.get(person.identity.id) ?? []).find(
      (f) => f.label === STATE_FIELD,
    );
    if (field) return { identityId: person.identity.id, marked: true, field };
  }
  const fallback = data.people.find((p) => p.identity.email) ?? data.people[0];
  return fallback ? { identityId: fallback.identity.id, marked: false, field: null } : null;
}

const API_KINDS = new Set<SecretKind>([
  "generic_api_key",
  "github_token",
  "stripe_secret_key",
  "openai_api_key",
  "aws_access_key_id",
  "supabase_anon_key",
]);

export function toneFor(kind: SecretKind): FieldTone {
  if (kind === "password") return "password";
  if (API_KINDS.has(normalizeSecretKind(kind))) return "api";
  return "secret";
}

function worst(statuses: Status[]): Status {
  if (statuses.includes("missing") || statuses.includes("attention")) return "attention";
  return "healthy";
}

/** Everything the backend flags, by entity id. */
function flagged(attention: AttentionItem[]): Map<string, Status> {
  const out = new Map<string, Status>();
  for (const item of attention) {
    out.set(item.entity.id, item.kind === "secret_value_missing" ? "missing" : "attention");
  }
  return out;
}

/** Account ids a project uses, through the resources linked to it. */
export function accountsForProject(data: SkillData, projectId: string): Set<string> {
  const ids = new Set<string>();
  for (const r of data.resources) {
    if (r.used_by.some((p) => p.id === projectId)) ids.add(r.service_project.account_id);
  }
  return ids;
}

/**
 * Build the tree: primary -> categories -> accounts -> fields, with the
 * primary's uncategorised accounts and any other people hanging off the centre.
 *
 * With `projectId`, only accounts that project uses are kept, and the project's
 * own variables -- a pasted `.env` -- appear as a project node.
 */
export function buildTree(
  data: SkillData,
  state: TreeState,
  primary: Primary | null,
  projectId: string | null = null,
): TreeItem | null {
  if (!primary) return null;
  const flags = flagged(data.attention);
  const keep = projectId ? accountsForProject(data, projectId) : null;
  const override = (id: string): Status | undefined => state.statuses[shortId(id)];

  const secretsByAccount = new Map<string, SecretListing[]>();
  const accountOfResource = new Map<string, string>();
  for (const r of data.resources) accountOfResource.set(r.service_project.id, r.service_project.account_id);
  for (const listing of data.secrets) {
    const s = listing.entry.secret;
    const owner = s.account_id ?? (s.service_project_id ? accountOfResource.get(s.service_project_id) : undefined);
    if (!owner) continue;
    const list = secretsByAccount.get(owner) ?? [];
    list.push(listing);
    secretsByAccount.set(owner, list);
  }

  const accountItem = (node: LedgerIdentity["accounts"][number]): TreeItem => {
    const a = node.account;
    const fields: TreeItem[] = [];
    if (a.login_email) fields.push(detail(a.id, "login_email", "Login email", a.login_email));
    if (a.username) fields.push(detail(a.id, "username", "Username", a.username));
    for (const listing of secretsByAccount.get(a.id) ?? []) {
      const s = listing.entry.secret;
      fields.push({
        key: `secret:${s.id}`,
        kind: "field",
        label: s.name,
        sub: s.preview,
        provider: null,
        tone: toneFor(s.kind),
        status: override(s.id) ?? flags.get(s.id) ?? "healthy",
        id: s.id,
        source: "secret",
        children: [],
      });
    }
    for (const f of data.accountFields.get(a.id) ?? []) {
      if (isHiddenField(f.label)) continue;
      fields.push({
        key: `custom:${f.id}`,
        kind: "field",
        label: f.label,
        sub: f.value,
        provider: null,
        tone: "plain",
        status: override(f.id) ?? "healthy",
        id: f.id,
        source: "custom",
        children: [],
      });
    }
    const derived = flags.get(a.id) ?? worst(fields.map((f) => f.status));
    return {
      key: `account:${a.id}`,
      kind: "account",
      label: a.label,
      sub: a.login_email ?? a.username ?? null,
      provider: a.provider,
      tone: null,
      status: override(a.id) ?? derived,
      id: a.id,
      source: null,
      children: fields,
    };
  };

  const placed = new Map<string, string>();
  for (const c of state.categories) for (const a of c.accounts) placed.set(a, c.id);

  const allAccounts = new Map<string, TreeItem>();
  const ownerOf = new Map<string, string>();
  for (const person of data.people) {
    for (const node of person.accounts) {
      if (keep && !keep.has(node.account.id)) continue;
      allAccounts.set(node.account.id, accountItem(node));
      ownerOf.set(node.account.id, person.identity.id);
    }
  }
  const accountsIn = (categoryId: string | null, identityId: string | null) =>
    [...allAccounts.entries()]
      .filter(([id]) => {
        const cat = placed.get(shortId(id)) ?? null;
        if (categoryId) return cat === categoryId;
        return cat === null && ownerOf.get(id) === identityId;
      })
      .map(([, item]) => item);

  const categories: TreeItem[] = state.categories
    .map((c): TreeItem => {
      const children = accountsIn(c.id, null);
      return {
        key: `category:${c.id}`,
        kind: "category",
        label: c.name,
        sub: children.length === 1 ? "1 account" : `${children.length} accounts`,
        provider: null,
        tone: null,
        status: state.statuses[c.id] ?? worst(children.map((ch) => ch.status)),
        id: c.id,
        source: null,
        children,
      };
    })
    // While filtering by project, an empty category is noise.
    .filter((c) => !keep || c.children.length > 0);

  const me = data.people.find((p) => p.identity.id === primary.identityId);
  const others: TreeItem[] = data.people
    .filter((p) => p.identity.id !== primary.identityId)
    .map((p): TreeItem => {
      const children = accountsIn(null, p.identity.id);
      return {
        key: `identity:${p.identity.id}`,
        kind: "identity",
        label: p.identity.email ?? p.identity.label,
        sub: !p.identity.email ? "No email" : p.identity.label !== p.identity.email ? p.identity.label : null,
        provider: null,
        tone: null,
        status: override(p.identity.id) ?? flags.get(p.identity.id) ?? worst(children.map((c) => c.status)),
        id: p.identity.id,
        source: null,
        children,
      };
    })
    .filter((p) => !keep || p.children.length > 0);

  const projectNode: TreeItem[] = [];
  if (projectId) {
    const project = data.projects.find((p) => p.id === projectId);
    const vars = data.secrets.filter((l) => l.entry.secret.project_id === projectId);
    if (project) {
      projectNode.push({
        key: `project:${project.id}`,
        kind: "project",
        label: project.name,
        sub: vars.length === 1 ? "1 variable" : `${vars.length} variables`,
        provider: null,
        tone: null,
        status: worst(vars.map((v) => flags.get(v.entry.secret.id) ?? "healthy")),
        id: project.id,
        source: null,
        children: vars.map((l) => ({
          key: `secret:${l.entry.secret.id}`,
          kind: "field" as const,
          label: l.entry.secret.name,
          sub: l.entry.secret.preview,
          provider: null,
          tone: toneFor(l.entry.secret.kind),
          status: flags.get(l.entry.secret.id) ?? "healthy",
          id: l.entry.secret.id,
          source: "secret" as const,
          children: [],
        })),
      });
    }
  }

  const direct = accountsIn(null, primary.identityId);
  return {
    key: "primary",
    kind: "primary",
    label: me?.identity.email ?? me?.identity.label ?? "Primary",
    // The name under the address, unless it is just the address again.
    sub: me?.identity.email && me.identity.label !== me.identity.email ? me.identity.label : null,
    provider: null,
    tone: null,
    status: override(primary.identityId) ?? flags.get(primary.identityId) ?? "healthy",
    id: primary.identityId,
    source: null,
    children: [...projectNode, ...categories, ...direct, ...others],
  };
}

function detail(accountId: string, field: string, label: string, value: string): TreeItem {
  return {
    key: `detail:${accountId}:${field}`,
    kind: "field",
    label,
    sub: value,
    provider: null,
    tone: "plain",
    status: "healthy",
    id: accountId,
    source: "detail",
    children: [],
  };
}

/** Every node, depth first, with its parent's key. */
export function walk(root: TreeItem): { item: TreeItem; parent: string | null; depth: number }[] {
  const out: { item: TreeItem; parent: string | null; depth: number }[] = [];
  const visit = (item: TreeItem, parent: string | null, depth: number) => {
    out.push({ item, parent, depth });
    for (const child of item.children) visit(child, item.key, depth + 1);
  };
  visit(root, null, 0);
  return out;
}

/** Keys from the root down to `key`, inclusive; empty when absent. */
export function pathTo(root: TreeItem, key: string): string[] {
  const trail: string[] = [];
  const visit = (item: TreeItem): boolean => {
    trail.push(item.key);
    if (item.key === key) return true;
    for (const child of item.children) if (visit(child)) return true;
    trail.pop();
    return false;
  };
  return visit(root) ? trail : [];
}

// --- lighting -------------------------------------------------------------------
//
// As in a passive tree, a lit node is one you have walked to. Lighting a node
// lights the path back to the centre; putting one out puts out everything
// beyond it. The centre is always lit.

export function toggleLit(root: TreeItem, lit: Set<string>, key: string): Set<string> {
  const next = new Set(lit);
  if (key !== root.key && next.has(key)) {
    const drop = (item: TreeItem) => {
      next.delete(item.key);
      item.children.forEach(drop);
    };
    const found = walk(root).find((w) => w.item.key === key);
    if (found) drop(found.item);
  } else {
    for (const k of pathTo(root, key)) next.add(k);
  }
  next.add(root.key);
  return next;
}

/** What is lit (and so expanded) on first view: the centre, categories and people. */
export function initialLit(root: TreeItem): Set<string> {
  const lit = new Set<string>([root.key]);
  for (const child of root.children) {
    if (child.kind === "category" || child.kind === "identity" || child.kind === "project") {
      lit.add(child.key);
    }
  }
  return lit;
}

// --- layout -------------------------------------------------------------------------

export interface Placed {
  item: TreeItem;
  parent: string | null;
  depth: number;
  x: number;
  y: number;
}

const RING = [0, 260, 470, 650];
const RING_GAP = 190;
/** Arc length each leaf needs so neighbours do not touch. */
const LEAF_SPACING = 150;

/**
 * Radial layout: the primary at the origin, each ring one level further out,
 * and every subtree given a wedge in proportion to how many leaves it shows.
 *
 * Only children of lit nodes are shown. Ring radii grow with the number of
 * visible leaves, so a big vault spreads out instead of overlapping.
 */
export function layout(root: TreeItem, lit: Set<string>): Placed[] {
  const visibleChildren = (item: TreeItem) => (lit.has(item.key) ? item.children : []);
  const leaves = new Map<string, number>();
  const count = (item: TreeItem): number => {
    const kids = visibleChildren(item);
    const n = kids.length === 0 ? 1 : kids.reduce((sum, k) => sum + count(k), 0);
    leaves.set(item.key, n);
    return n;
  };
  const total = count(root);

  const radius: number[] = [0];
  const ringFor = (depth: number): number => {
    while (radius.length <= depth) {
      const d = radius.length;
      const inner = radius[d - 1] ?? 0;
      const base = RING[d] ?? inner + RING_GAP;
      const needed = (total * LEAF_SPACING) / (2 * Math.PI);
      radius.push(Math.max(base, inner + RING_GAP * 0.9, needed));
    }
    return radius[depth] ?? 0;
  };

  const out: Placed[] = [];
  const place = (item: TreeItem, parent: string | null, depth: number, from: number, to: number) => {
    const angle = (from + to) / 2;
    const r = ringFor(depth);
    out.push({ item, parent, depth, x: Math.round(r * Math.cos(angle)), y: Math.round(r * Math.sin(angle)) });
    let cursor = from;
    const span = to - from;
    const mine = leaves.get(item.key) ?? 1;
    for (const child of visibleChildren(item)) {
      const share = ((leaves.get(child.key) ?? 1) / mine) * span;
      place(child, item.key, depth + 1, cursor, cursor + share);
      cursor += share;
    }
  };
  // Start at the top so the first category sits above the centre.
  place(root, null, 0, -Math.PI / 2, (3 * Math.PI) / 2);
  return out;
}

/** How close a dropped account must land to a node for the drop to count. */
const DROP_REACH = 110;

/**
 * Where an account dropped at (x, y) should go: the nearest category, person or
 * the centre, if one is within reach. Worked out from the layout rather than
 * from rendered boxes, so it does not depend on how big a node happens to be.
 */
export function dropTarget(placed: Placed[], x: number, y: number, dragged: string): Placed | null {
  let best: Placed | null = null;
  let bestDistance = Infinity;
  for (const p of placed) {
    if (p.item.key === dragged) continue;
    if (p.item.kind !== "category" && p.item.kind !== "identity" && p.item.kind !== "primary") continue;
    const distance = Math.hypot(p.x - x, p.y - y);
    if (distance < bestDistance) {
      best = p;
      bestDistance = distance;
    }
  }
  return best && bestDistance <= DROP_REACH ? best : null;
}
