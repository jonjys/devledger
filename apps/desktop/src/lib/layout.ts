// The user's own layout: which boxes the home page shows and in what order,
// which tabs the menu shows, where the app opens, and saved templates.
//
// It is one JSON document stored in the vault (`ui_layout_get/set`). Anything
// read back -- a saved layout, or a template code someone shared -- goes
// through `parseLayout` / `parseTemplate`, which keep only known kinds and cap
// every length, so a bad document can never break the interface.

export type ViewId =
  | "home"
  | "projects"
  | "ledger"
  | "assistant"
  | "connections"
  | "subscriptions"
  | "secrets"
  | "attention";

export const ALL_VIEWS: ViewId[] = [
  "home",
  "projects",
  "ledger",
  "assistant",
  "connections",
  "subscriptions",
  "secrets",
  "attention",
];

export type BoxKind =
  | "stats"
  | "projects"
  | "trials"
  | "costs"
  | "attention"
  | "activity"
  | "secrets"
  | "assistant"
  | "note";

/** What each box is, for the "Add a box" catalog. */
export const BOX_CATALOG: { kind: BoxKind; name: string; summary: string }[] = [
  { kind: "note", name: "Note", summary: "Write anything: a checklist, links, what to do next." },
  { kind: "stats", name: "Numbers", summary: "Projects, people, trials ending and monthly spend at a glance." },
  { kind: "projects", name: "Projects", summary: "Your projects and what each one runs on." },
  { kind: "costs", name: "Monthly spend", summary: "Every paid plan and the total per month." },
  { kind: "trials", name: "Trials ending", summary: "Free trials about to turn into a bill." },
  { kind: "attention", name: "Needs attention", summary: "Gaps: keys filed nowhere, unused resources." },
  { kind: "activity", name: "Recent activity", summary: "What changed in your ledger lately." },
  { kind: "secrets", name: "Keys", summary: "Names of your keys and variables. Never the values." },
  { kind: "assistant", name: "Ask the AI", summary: "One tap to review your setup." },
];

export interface Box {
  id: string;
  kind: BoxKind;
  /** The user's own title; the catalog name when absent. */
  title?: string;
  /** Spans both columns on a wide screen. Phones always show one column. */
  wide?: boolean;
  /** A note's text. */
  text?: string;
}

export interface Template {
  id: string;
  name: string;
  description?: string;
  boxes: Box[];
  tabs?: ViewId[];
  start?: ViewId;
  /** Built into DevLedger rather than made by the user. */
  builtin?: boolean;
}

export interface Layout {
  v: 1;
  boxes: Box[];
  /** The tabs the menu shows, in order. The rest are hidden. */
  tabs: ViewId[];
  /** Where the app opens after unlocking. */
  start: ViewId;
  /** Templates the user saved or imported. */
  templates: Template[];
}

export const LIMITS = { boxes: 24, title: 60, text: 4000, templates: 30, name: 60, description: 200 };

let seq = 0;
export const newBoxId = () => `b${Date.now().toString(36)}${(seq++).toString(36)}`;

const box = (kind: BoxKind, extra: Partial<Box> = {}): Box => ({ id: `${kind}-${seq++}`, kind, ...extra });

/** The templates DevLedger ships with. "Recommended" is what a new vault gets. */
export const BUILTIN_TEMPLATES: Template[] = [
  {
    id: "recommended",
    name: "Recommended",
    description: "A bit of everything: what you have, what it costs and what needs fixing.",
    builtin: true,
    start: "projects",
    // The order DevLedger has always had, with Home where Overview was.
    tabs: ["projects", "ledger", "assistant", "home", "connections", "subscriptions", "secrets", "attention"],
    boxes: [
      box("stats", { wide: true }),
      box("note", {
        title: "Next up",
        text: "- Add the email you sign up with\n- Add the accounts it owns\n- Add a project and link what it runs on",
      }),
      box("trials"),
      box("projects", { wide: true }),
      box("attention"),
      box("costs"),
    ],
  },
  {
    id: "solo",
    name: "Solo developer",
    description: "Projects first, keys close at hand, the map one tap away.",
    builtin: true,
    start: "home",
    tabs: ["home", "projects", "ledger", "secrets", "attention", "subscriptions", "assistant", "connections"],
    boxes: [
      box("projects", { wide: true }),
      box("secrets"),
      box("attention"),
      box("note", { title: "Ideas", text: "" }),
      box("activity"),
    ],
  },
  {
    id: "clients",
    name: "Agency / clients",
    description: "One note per client, every project and who works on what.",
    builtin: true,
    start: "home",
    tabs: ["home", "projects", "ledger", "subscriptions", "attention", "secrets", "assistant", "connections"],
    boxes: [
      box("stats", { wide: true }),
      box("note", { title: "Client A", text: "Contact:\nProjects:\nRenews:" }),
      box("note", { title: "Client B", text: "Contact:\nProjects:\nRenews:" }),
      box("projects", { wide: true }),
      box("costs"),
      box("trials"),
    ],
  },
  {
    id: "creator",
    name: "Creator / social",
    description: "Instagram, TikTok, scheduling tools and what each one costs.",
    builtin: true,
    start: "home",
    tabs: ["home", "ledger", "subscriptions", "projects", "attention", "assistant", "secrets", "connections"],
    boxes: [
      box("costs", { wide: true }),
      box("trials"),
      box("note", {
        title: "Channels",
        text: "- Instagram:\n- TikTok:\n- YouTube:\n- Scheduler:",
      }),
      box("attention"),
      box("activity"),
    ],
  },
  {
    id: "costs",
    name: "Cost watcher",
    description: "Only the money: plans, trials and the monthly total.",
    builtin: true,
    start: "home",
    tabs: ["home", "subscriptions", "projects", "ledger", "attention", "secrets", "assistant", "connections"],
    boxes: [
      box("stats", { wide: true }),
      box("trials"),
      box("costs"),
      box("note", { title: "Cancel this month", text: "" }),
    ],
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Just a note and your projects. Add what you miss.",
    builtin: true,
    start: "home",
    tabs: ["home", "projects", "ledger"],
    boxes: [box("note", { title: "Notes", text: "" }), box("projects", { wide: true })],
  },
];

const RECOMMENDED = BUILTIN_TEMPLATES[0]!;

/** A layout made from a template: fresh box ids, the template's tabs and start page. */
export function applyTemplate(base: Layout, t: Template): Layout {
  const tabs = t.tabs ? cleanTabs(t.tabs) : base.tabs;
  const start = t.start && tabs.includes(t.start) ? t.start : tabs[0]!;
  return { ...base, boxes: t.boxes.map((b) => ({ ...b, id: newBoxId() })), tabs, start };
}

export function recommendedLayout(): Layout {
  return applyTemplate({ v: 1, boxes: [], tabs: [...ALL_VIEWS], start: "projects", templates: [] }, RECOMMENDED);
}

// --- reading untrusted documents --------------------------------------------------

const KINDS = new Set<BoxKind>(BOX_CATALOG.map((c) => c.kind));
const VIEWS = new Set<ViewId>(ALL_VIEWS);

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" ? v.slice(0, max) : undefined;

function cleanBoxes(raw: unknown): Box[] {
  if (!Array.isArray(raw)) return [];
  const out: Box[] = [];
  for (const r of raw.slice(0, LIMITS.boxes * 8)) {
    if (out.length >= LIMITS.boxes) break;
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (!KINDS.has(o.kind as BoxKind)) continue;
    const b: Box = { id: str(o.id, 40) || newBoxId(), kind: o.kind as BoxKind };
    const title = str(o.title, LIMITS.title)?.trim();
    if (title) b.title = title;
    if (o.wide === true) b.wide = true;
    if (b.kind === "note") b.text = str(o.text, LIMITS.text) ?? "";
    out.push(b);
  }
  // Ids must be unique for React and for moving boxes.
  const seen = new Set<string>();
  return out.map((b) => {
    if (seen.has(b.id)) b = { ...b, id: newBoxId() };
    seen.add(b.id);
    return b;
  });
}

/** Known tabs only, each once; Home is always kept so the layout stays reachable. */
function cleanTabs(raw: unknown): ViewId[] {
  const tabs: ViewId[] = [];
  if (Array.isArray(raw)) {
    for (const t of raw) if (VIEWS.has(t as ViewId) && !tabs.includes(t as ViewId)) tabs.push(t as ViewId);
  }
  if (!tabs.includes("home")) tabs.unshift("home");
  return tabs;
}

function cleanTemplate(raw: unknown, builtin = false): Template | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = str(o.name, LIMITS.name)?.trim();
  if (!name) return null;
  const t: Template = { id: str(o.id, 40) || newBoxId(), name, boxes: cleanBoxes(o.boxes) };
  const description = str(o.description, LIMITS.description)?.trim();
  if (description) t.description = description;
  if (o.tabs !== undefined) t.tabs = cleanTabs(o.tabs);
  if (VIEWS.has(o.start as ViewId)) t.start = o.start as ViewId;
  if (builtin) t.builtin = true;
  return t;
}

/** A saved layout, or the recommended one when there is none or it cannot be read. */
export function parseLayout(json: string | null): Layout {
  if (!json) return recommendedLayout();
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return recommendedLayout();
  }
  if (!raw || typeof raw !== "object") return recommendedLayout();
  const o = raw as Record<string, unknown>;
  const tabs = cleanTabs(o.tabs);
  const start = VIEWS.has(o.start as ViewId) && tabs.includes(o.start as ViewId) ? (o.start as ViewId) : tabs[0]!;
  const templates = Array.isArray(o.templates)
    ? o.templates
        .slice(0, LIMITS.templates)
        .map((t) => cleanTemplate(t))
        .filter((t): t is Template => t !== null)
    : [];
  return { v: 1, boxes: cleanBoxes(o.boxes), tabs, start, templates };
}

export const serializeLayout = (l: Layout) => JSON.stringify(l);

// --- sharing templates --------------------------------------------------------------

const CODE_PREFIX = "devledger-template:";

/** A template as text someone can paste into their own DevLedger. */
export function templateCode(t: Template): string {
  const { builtin: _builtin, ...rest } = t;
  const json = JSON.stringify({ v: 1, ...rest, boxes: rest.boxes.map(({ id: _id, ...b }) => b) });
  return CODE_PREFIX + btoa(unescape(encodeURIComponent(json)));
}

/** Read a shared template code. Returns null for anything that is not one. */
export function parseTemplate(code: string): Template | null {
  const text = code.trim();
  if (!text.startsWith(CODE_PREFIX)) return null;
  try {
    const json = decodeURIComponent(escape(atob(text.slice(CODE_PREFIX.length))));
    const t = cleanTemplate(JSON.parse(json));
    return t ? { ...t, id: newBoxId() } : null;
  } catch {
    return null;
  }
}

/** Save the current boxes, tabs and start page as a template of the user's own. */
export function templateFrom(l: Layout, name: string, description?: string): Template {
  return {
    id: newBoxId(),
    name: name.trim().slice(0, LIMITS.name) || "My layout",
    ...(description?.trim() ? { description: description.trim().slice(0, LIMITS.description) } : {}),
    boxes: l.boxes.map((b) => ({ ...b })),
    tabs: [...l.tabs],
    start: l.start,
  };
}

/** Move `items[index]` by `delta`, clamped. Returns a new array. */
export function move<T>(items: T[], index: number, delta: number): T[] {
  const to = Math.max(0, Math.min(items.length - 1, index + delta));
  if (to === index) return items;
  const copy = [...items];
  const [it] = copy.splice(index, 1);
  copy.splice(to, 0, it!);
  return copy;
}
