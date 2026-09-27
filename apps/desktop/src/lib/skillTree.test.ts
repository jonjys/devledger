import { describe, expect, it } from "vitest";

import { IDS, vault } from "../test/tree-fixtures";
import {
  toneFor,
  buildTree,
  dropTarget,
  findPrimary,
  initialLit,
  layout,
  newCategoryId,
  parseState,
  pathTo,
  placeAccount,
  serializeState,
  setStatus,
  shortId,
  toggleLit,
  walk,
  type TreeItem,
  type TreeState,
} from "./skillTree";

const STATE: TreeState = {
  categories: [
    { id: "k1", name: "Code", accounts: [shortId(IDS.github)] },
    { id: "k2", name: "Payments", accounts: [shortId(IDS.stripe)] },
  ],
  statuses: {},
};

function tree(state: TreeState = STATE, projectId: string | null = null): TreeItem {
  const data = vault(serializeState(state));
  const root = buildTree(data, state, findPrimary(data), projectId);
  if (!root) throw new Error("no tree");
  return root;
}

function find(root: TreeItem, key: string): TreeItem {
  const hit = walk(root).find((w) => w.item.key === key);
  if (!hit) throw new Error(`no ${key}`);
  return hit.item;
}

describe("the hidden state field", () => {
  it("round-trips categories and statuses", () => {
    const state = setStatus(STATE, "abcd1234", "missing");
    expect(parseState(serializeState(state))).toEqual(state);
  });

  it("treats a damaged value as empty rather than failing", () => {
    expect(parseState("{not json")).toEqual({ categories: [], statuses: {} });
    expect(parseState('{"c":[{"i":1}],"s":{"x":"zz"}}')).toEqual({ categories: [], statuses: {} });
    expect(parseState(null)).toEqual({ categories: [], statuses: {} });
  });

  it("stores short ids, so a big vault still fits in one field", () => {
    const many: TreeState = {
      categories: [{ id: "k1", name: "All", accounts: Array.from({ length: 250 }, (_, i) => shortId(`${i}`.padStart(8, "a") + "-x")) }],
      statuses: {},
    };
    expect(serializeState(many).length).toBeLessThan(4000);
  });

  it("moves an account between categories without leaving a copy behind", () => {
    const moved = placeAccount(STATE, IDS.github, "k2");
    expect(moved.categories[0]?.accounts).toEqual([]);
    expect(moved.categories[1]?.accounts).toEqual([shortId(IDS.stripe), shortId(IDS.github)]);
    const out = placeAccount(moved, IDS.github, null);
    expect(out.categories.flatMap((c) => c.accounts)).toEqual([shortId(IDS.stripe)]);
  });

  it("never reuses a category id", () => {
    expect(newCategoryId(STATE)).toBe("k3");
    const taken: TreeState = { categories: [{ id: "k2", name: "x", accounts: [] }], statuses: {} };
    expect(newCategoryId(taken)).not.toBe("k2");
  });
});

describe("the primary identity", () => {
  it("is whoever carries the hidden field", () => {
    const data = vault(serializeState(STATE));
    expect(findPrimary(data)).toMatchObject({ identityId: IDS.me, marked: true });
  });

  it("falls back to the first person with an email until one is pinned", () => {
    const data = vault(null);
    data.people.reverse(); // the person without an email comes first
    expect(findPrimary(data)).toMatchObject({ identityId: IDS.me, marked: false });
  });

  it("does not exist in an empty vault", () => {
    const data = vault(null);
    data.people = [];
    expect(findPrimary(data)).toBeNull();
  });
});

describe("building the tree", () => {
  it("puts the primary email at the centre, then categories, then the rest", () => {
    const root = tree();
    expect(root.kind).toBe("primary");
    expect(root.label).toBe("primary@example.com");
    expect(root.children.map((c) => `${c.kind}:${c.label}`)).toEqual([
      "category:Code",
      "category:Payments",
      "account:Supabase",
      "identity:Unidentified",
    ]);
  });

  it("files accounts under their categories", () => {
    const root = tree();
    expect(find(root, "category:k1").children.map((c) => c.label)).toEqual(["GitHub"]);
    expect(find(root, "category:k2").children.map((c) => c.label)).toEqual(["Stripe"]);
  });

  it("colours fields by what they are", () => {
    const root = tree();
    const github = find(root, `account:${IDS.github}`);
    expect(github.children.map((f) => [f.label, f.tone])).toEqual([
      ["Username", "plain"],
      ["Password", "password"],
    ]);
    expect(find(root, `secret:${IDS.stripeKey}`).tone).toBe("api");
  });

  it("shows the fields a user named but never DevLedger's own", () => {
    const root = tree();
    const labels = find(root, `account:${IDS.supabase}`).children.map((f) => f.label);
    expect(labels).toEqual(["Region"]);
  });

  it("only ever carries masked previews", () => {
    const root = tree();
    expect(find(root, `secret:${IDS.ghPassword}`).sub).toBe("ex•••le");
  });

  it("marks a secret whose value is missing, and the account above it", () => {
    const data = vault(serializeState(STATE));
    data.attention = [
      { kind: "secret_value_missing", title: "", detail: "", entity: { kind: "secret", id: IDS.ghPassword } },
    ];
    const root = buildTree(data, STATE, findPrimary(data));
    if (!root) throw new Error("no tree");
    expect(find(root, `secret:${IDS.ghPassword}`).status).toBe("missing");
    expect(find(root, `account:${IDS.github}`).status).toBe("attention");
  });

  it("lets a status set by hand win", () => {
    const state = setStatus(STATE, shortId(IDS.stripe), "attention");
    expect(find(tree(state), `account:${IDS.stripe}`).status).toBe("attention");
  });

  it("filters to one project's accounts and shows its own variables", () => {
    const root = tree(STATE, IDS.project);
    const keys = walk(root).map((w) => w.item.key);
    expect(keys).toContain(`account:${IDS.supabase}`);
    expect(keys).not.toContain(`account:${IDS.github}`);
    expect(keys).not.toContain(`identity:${IDS.other}`);
    expect(find(root, `project:${IDS.project}`).children.map((c) => c.label)).toEqual(["DATABASE_URL"]);
  });
});

describe("lighting", () => {
  it("starts with the centre, categories and people lit, and accounts dark", () => {
    const root = tree();
    const lit = initialLit(root);
    expect(lit.has("primary")).toBe(true);
    expect(lit.has("category:k1")).toBe(true);
    expect(lit.has(`account:${IDS.github}`)).toBe(false);
  });

  it("lights the whole path back to the centre", () => {
    const root = tree();
    const lit = toggleLit(root, new Set(["primary"]), `secret:${IDS.ghPassword}`);
    expect([...lit].sort()).toEqual(pathTo(root, `secret:${IDS.ghPassword}`).sort());
  });

  it("puts out everything beyond a node, but never the centre", () => {
    const root = tree();
    const on = toggleLit(root, initialLit(root), `secret:${IDS.ghPassword}`);
    const off = toggleLit(root, on, "category:k1");
    expect(off.has(`account:${IDS.github}`)).toBe(false);
    expect(off.has(`secret:${IDS.ghPassword}`)).toBe(false);
    expect(toggleLit(root, off, "primary").has("primary")).toBe(true);
  });
});

describe("layout", () => {
  it("centres the primary and puts each level further out", () => {
    const root = tree();
    const placed = layout(root, toggleLit(root, initialLit(root), `account:${IDS.github}`));
    const at = new Map(placed.map((p) => [p.item.key, p]));
    expect(at.get("primary")).toMatchObject({ x: 0, y: 0 });
    const r = (key: string) => Math.hypot(at.get(key)?.x ?? 0, at.get(key)?.y ?? 0);
    expect(r(`account:${IDS.github}`)).toBeGreaterThan(r("category:k1"));
    expect(r(`secret:${IDS.ghPassword}`)).toBeGreaterThan(r(`account:${IDS.github}`));
  });

  it("hides the children of a dark node", () => {
    const root = tree();
    const keys = layout(root, initialLit(root)).map((p) => p.item.key);
    expect(keys).toContain(`account:${IDS.github}`);
    expect(keys).not.toContain(`secret:${IDS.ghPassword}`);
  });

  it("keeps nodes on the same ring apart, even with many accounts", () => {
    const data = vault(null);
    const me = data.people[0];
    if (!me) throw new Error("fixture");
    const template = me.accounts[0];
    if (!template) throw new Error("fixture");
    for (let i = 0; i < 60; i += 1) {
      me.accounts.push({ ...template, account: { ...template.account, id: `acc-${i}`, label: `A${i}` } });
    }
    const root = buildTree(data, { categories: [], statuses: {} }, findPrimary(data));
    if (!root) throw new Error("no tree");
    const ring = layout(root, initialLit(root)).filter((p) => p.depth === 1);
    let closest = Infinity;
    for (const a of ring) {
      for (const b of ring) {
        if (a !== b) closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    expect(closest).toBeGreaterThan(60);
  });
});

describe("dropping an account", () => {
  it("lands on the nearest category within reach, never on itself", () => {
    const root = tree();
    const placed = layout(root, initialLit(root));
    const payments = placed.find((p) => p.item.key === "category:k2");
    if (!payments) throw new Error("fixture");
    const hit = dropTarget(placed, payments.x + 20, payments.y - 10, `account:${IDS.github}`);
    expect(hit?.item.key).toBe("category:k2");
  });

  it("does nothing when dropped in open space", () => {
    const root = tree();
    const placed = layout(root, initialLit(root));
    expect(dropTarget(placed, 5000, 5000, `account:${IDS.github}`)).toBeNull();
  });

  it("takes an account out of its category when dropped on the centre", () => {
    const root = tree();
    const placed = layout(root, initialLit(root));
    expect(dropTarget(placed, 10, -15, `account:${IDS.github}`)?.item.kind).toBe("primary");
  });
});

describe("field colours", () => {
  it("treats the backend's spelling of a GitHub or OpenAI key as an API key", () => {
    // serde's snake_case sends git_hub_token and open_ai_api_key; the tree
    // coloured those as generic secrets.
    expect(toneFor("git_hub_token")).toBe("api");
    expect(toneFor("open_ai_api_key")).toBe("api");
    expect(toneFor("password")).toBe("password");
    expect(toneFor("jwt_secret")).toBe("secret");
  });
});
