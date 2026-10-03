import { describe, expect, it } from "vitest";

import { IDS, canvasVault, resource } from "../test/canvas-fixtures";
import {
  besideSpot,
  buildCanvas,
  focusLayout,
  freeSpot,
  connectIntent,
  formatPos,
  nearestEmail,
  neighbourhood,
  parsePos,
  positions,
  primaryId,
  resourceToLink,
  resourcesToUnlink,
  savedPositions,
  type Ball,
} from "./canvas";

function canvas(opts: { pinned?: boolean } = {}) {
  const data = canvasVault(opts);
  return { data, ...buildCanvas(data) };
}

function ball(balls: Ball[], key: string): Ball {
  const hit = balls.find((b) => b.key === key);
  if (!hit) throw new Error(`no ${key}`);
  return hit;
}

const email = (id: string) => `email:${id}`;
const account = (id: string) => `account:${id}`;
const project = (id: string) => `project:${id}`;
const org = (id: string) => `org:${id}`;
const res = (id: string) => `resource:${id}`;

describe("balls", () => {
  it("draws every email, service and project as a ball", () => {
    const { balls } = canvas();
    expect(balls.map((b) => `${b.kind}:${b.label}`)).toEqual([
      "email:Unidentified",
      "account:Loopia",
      "email:primary@example.com",
      "account:GitHub",
      "account:Stripe",
      "account:Supabase",
      "email:work@example.com",
      "org:acme's Org",
      "resource:shop-db",
      "project:shop",
      "project:blog",
    ]);
  });

  it("says what each ball holds", () => {
    const { balls } = canvas();
    expect(ball(balls, account(IDS.github)).sub).toBe("1 key");
    expect(ball(balls, account(IDS.supabase)).sub).toBeNull();
    expect(ball(balls, project(IDS.project)).sub).toBe("1 variable");
    expect(ball(balls, project(IDS.blog)).sub).toBe("No services yet");
    expect(ball(balls, email(IDS.other))).toMatchObject({ noEmail: true, sub: "No email" });
  });

  it("centres on the first email until one is pinned, never on an entry with no email", () => {
    expect(primaryId(canvasVault())).toBe(IDS.me);
    expect(ball(canvas().balls, email(IDS.me)).primary).toBe(true);
    expect(primaryId(canvasVault({ pinned: true }))).toBe(IDS.work);
  });
});

describe("lines", () => {
  it("joins each service to the email that owns it", () => {
    const { lines } = canvas();
    const owns = lines.filter((l) => l.kind === "owns").map((l) => `${l.source}>${l.target}`);
    expect(owns).toContain(`${email(IDS.me)}>${account(IDS.github)}`);
    expect(owns).toContain(`${email(IDS.other)}>${account(IDS.loopia)}`);
    expect(owns).toHaveLength(4);
  });

  it("joins a project to what it runs on: a project inside a service, or the service itself", () => {
    const { lines } = canvas();
    const uses = lines.filter((l) => l.kind === "uses").map((l) => `${l.source}>${l.target}`);
    expect(uses).toEqual([`${project(IDS.project)}>${res(IDS.resource)}`, `${project(IDS.project)}>${account(IDS.stripe)}`]);
  });

  it("hangs an organization under its service, and its projects under it", () => {
    const { balls, lines } = canvas();
    const holds = lines.filter((l) => l.kind === "holds").map((l) => `${l.source}>${l.target}`);
    expect(holds).toEqual([`${account(IDS.supabase)}>${org(IDS.org)}`, `${org(IDS.org)}>${res(IDS.resource)}`]);
    expect(ball(balls, org(IDS.org))).toMatchObject({ sub: "1 project", provider: "supabase", parent: account(IDS.supabase) });
    expect(ball(balls, res(IDS.resource))).toMatchObject({ parent: org(IDS.org) });
  });

  it("draws a project in no organization straight under its service", () => {
    const data = canvasVault();
    data.resources.push(resource("r-free", IDS.supabase, "scratch", []));
    const { balls, lines } = buildCanvas(data);
    expect(ball(balls, res("r-free")).parent).toBe(account(IDS.supabase));
    expect(lines.some((l) => l.source === account(IDS.supabase) && l.target === res("r-free"))).toBe(true);
  });

  it("draws the resource a project–service line made as that line, not as a ball", () => {
    const { balls } = canvas();
    expect(balls.some((b) => b.key === res(IDS.stripeShop))).toBe(false);
  });
});

describe("drawing a line", () => {
  it("makes an email the owner of a service, whichever end the line started from", () => {
    const { balls, lines } = canvas();
    const gh = ball(balls, account(IDS.github));
    const work = ball(balls, email(IDS.work));
    expect(connectIntent(gh, work, lines)).toEqual({ kind: "own", accountId: IDS.github, identityId: IDS.work });
    expect(connectIntent(work, gh, lines)).toEqual({ kind: "own", accountId: IDS.github, identityId: IDS.work });
  });

  it("makes a project use a service", () => {
    const { balls, lines } = canvas();
    expect(connectIntent(ball(balls, project(IDS.blog)), ball(balls, account(IDS.github)), lines)).toEqual({
      kind: "use",
      accountId: IDS.github,
      projectId: IDS.blog,
    });
  });

  it("does nothing for a line that is already there", () => {
    const { balls, lines } = canvas();
    expect(connectIntent(ball(balls, email(IDS.me)), ball(balls, account(IDS.github)), lines)).toEqual({ kind: "none" });
  });

  it("lets a person work on a project, whichever end the line started from", () => {
    const { balls, lines } = canvas();
    const want = { kind: "work", identityId: IDS.work, projectId: IDS.blog };
    expect(connectIntent(ball(balls, project(IDS.blog)), ball(balls, email(IDS.work)), lines)).toEqual(want);
    expect(connectIntent(ball(balls, email(IDS.work)), ball(balls, project(IDS.blog)), lines)).toEqual(want);
  });

  it("explains the lines that mean nothing", () => {
    const { balls, lines } = canvas();
    const refuse = (a: string, b: string) => connectIntent(ball(balls, a), ball(balls, b), lines).kind;
    expect(refuse(account(IDS.github), account(IDS.stripe))).toBe("refuse");
    expect(refuse(email(IDS.me), email(IDS.work))).toBe("refuse");
    expect(refuse(account(IDS.github), email(IDS.other))).toBe("refuse");
  });

  it("reuses a resource named after the project, and otherwise makes one", () => {
    const data = canvasVault();
    data.resources.push(resource("r-blog", IDS.github, "Blog", []));
    expect(resourceToLink(data, IDS.github, "blog")).toBe("r-blog");
    expect(resourceToLink(data, IDS.stripe, "blog")).toBeNull();
  });

  it("removes only the empty resource a line made, and unlinks one holding keys", () => {
    const data = canvasVault();
    expect(resourcesToUnlink(data, IDS.stripe, IDS.project)).toEqual([{ id: IDS.stripeShop, remove: true }]);
    const made = data.resources[1];
    if (!made) throw new Error("fixture");
    made.secret_count = 2;
    expect(resourcesToUnlink(data, IDS.stripe, IDS.project)).toEqual([{ id: IDS.stripeShop, remove: false }]);
    // A project inside a service has a line of its own; this one never touches it.
    expect(resourcesToUnlink(data, IDS.supabase, IDS.project)).toEqual([]);
  });

  it("puts a project into an organization, or moves an organization, within one service only", () => {
    const data = canvasVault();
    data.resources.push(resource("r-free", IDS.supabase, "scratch", []));
    const { balls, lines } = buildCanvas(data);
    const acme = ball(balls, org(IDS.org));
    expect(connectIntent(ball(balls, res("r-free")), acme, lines)).toEqual({
      kind: "place",
      resourceId: "r-free",
      accountId: IDS.supabase,
      organizationId: IDS.org,
    });
    expect(connectIntent(ball(balls, res(IDS.resource)), ball(balls, account(IDS.supabase)), lines)).toEqual({
      kind: "place",
      resourceId: IDS.resource,
      accountId: IDS.supabase,
      organizationId: null,
    });
    expect(connectIntent(acme, ball(balls, account(IDS.github)), lines).kind).toBe("refuse");
  });

  it("lets a project run on a project inside a service, and explains the lines that cannot be", () => {
    const { balls, lines } = canvas();
    expect(connectIntent(ball(balls, project(IDS.blog)), ball(balls, res(IDS.resource)), lines)).toEqual({
      kind: "link",
      resourceId: IDS.resource,
      projectId: IDS.blog,
    });
    expect(connectIntent(ball(balls, project(IDS.blog)), ball(balls, org(IDS.org)), lines).kind).toBe("refuse");
    expect(connectIntent(ball(balls, email(IDS.me)), ball(balls, org(IDS.org)), lines).kind).toBe("refuse");
  });
});

describe("positions", () => {
  it("round-trips and rejects junk", () => {
    expect(parsePos(formatPos({ x: 12.4, y: -7.6 }))).toEqual({ x: 12, y: -8 });
    expect(parsePos("nope")).toBeNull();
    expect(parsePos(null)).toBeNull();
  });

  it("keeps a moved ball where it was left and lays out the rest by kind", () => {
    const { data, balls } = canvas();
    const at = positions(balls, savedPositions(data, balls));
    expect(at.get(account(IDS.github))).toEqual({ x: 320, y: -40 });
    const xs = (kind: string) => new Set(balls.filter((b) => b.kind === kind && b.id !== IDS.github).map((b) => at.get(b.key)?.x));
    expect([...xs("email")]).toEqual([0]);
    expect([...xs("account")]).toEqual([300]);
    expect([...xs("project")]).toEqual([1000]);
  });

  it("puts an organization beside its service, and a project in it beside that", () => {
    const { data, balls } = canvas();
    const at = positions(balls, savedPositions(data, balls));
    const supabase = at.get(account(IDS.supabase));
    expect(at.get(org(IDS.org))).toEqual({ x: (supabase?.x ?? 0) + 220, y: supabase?.y });
    expect(at.get(res(IDS.resource))).toEqual({ x: (supabase?.x ?? 0) + 440, y: supabase?.y });
  });

  it("never stacks two new balls on one spot, or on a moved one", () => {
    const { data, balls } = canvas();
    const at = positions(balls, savedPositions(data, balls));
    const spots = [...at.values()].map((p) => `${p.x},${p.y}`);
    expect(new Set(spots).size).toBe(spots.length);
    const gh = at.get(account(IDS.github));
    for (const b of balls) {
      if (b.key === account(IDS.github)) continue;
      const p = at.get(b.key);
      expect(Math.hypot((p?.x ?? 0) - (gh?.x ?? 0), (p?.y ?? 0) - (gh?.y ?? 0))).toBeGreaterThan(60);
    }
  });

  it("finds a free spot when a moved ball sits where a new one would go", () => {
    const { balls } = canvas();
    // Move a project to exactly where the first service would be placed.
    const at = positions(balls, new Map([[project(IDS.blog), { x: 300, y: 0 }]]));
    for (const b of balls) {
      if (b.key === project(IDS.blog)) continue;
      const p = at.get(b.key);
      expect(Math.hypot((p?.x ?? 0) - 300, p?.y ?? 0)).toBeGreaterThanOrEqual(110);
    }
  });

  it("gives a dropped service to the nearest email that has an address", () => {
    const { balls } = canvas();
    const at = new Map([
      [email(IDS.me), { x: 0, y: 0 }],
      [email(IDS.work), { x: 0, y: 400 }],
      [email(IDS.other), { x: 0, y: 380 }],
    ]);
    expect(nearestEmail(balls, at, { x: 200, y: 350 })?.id).toBe(IDS.work);
    expect(nearestEmail(balls, at, { x: 200, y: 50 })?.id).toBe(IDS.me);
    expect(nearestEmail([], at, { x: 0, y: 0 })).toBeNull();
  });
});

describe("a person working on a project", () => {
  const withWork = () => {
    const data = canvasVault();
    data.worksOn = [[IDS.work, IDS.project], [IDS.work, "gone"]];
    return { data, ...buildCanvas(data) };
  };

  it("is a line from the email to the project, and nothing moves under the email", () => {
    const { balls, lines } = withWork();
    expect(lines.filter((l) => l.kind === "works").map((l) => `${l.source}>${l.target}`)).toEqual([
      `${email(IDS.work)}>${project(IDS.project)}`,
    ]);
    expect(ball(balls, project(IDS.project)).parent).toBeNull();
  });

  it("shows the person with the project, and the project with the person, but not the person's other ties", () => {
    const { lines } = withWork();
    expect(neighbourhood(lines, project(IDS.project)).has(email(IDS.work))).toBe(true);
    expect([...neighbourhood(lines, email(IDS.work))].sort()).toEqual([email(IDS.work), project(IDS.project)].sort());
  });

  it("puts the person with the emails on the project's page", () => {
    const { balls, lines } = withWork();
    const at = focusLayout(balls, lines, project(IDS.project));
    expect(at.get(email(IDS.work))?.x).toBe(at.get(email(IDS.me))?.x);
    expect(at.get(email(IDS.work))?.y).not.toBe(at.get(email(IDS.me))?.y);
  });
});

describe("what a ball is connected to", () => {
  it("shows what a project runs on and everything that holds it, and nothing else", () => {
    const { lines } = canvas();
    expect([...neighbourhood(lines, project(IDS.project))].sort()).toEqual(
      [project(IDS.project), res(IDS.resource), org(IDS.org), account(IDS.supabase), account(IDS.stripe), email(IDS.me)].sort(),
    );
  });

  it("shows a service's email, what is inside it and the projects using any of it", () => {
    const { lines } = canvas();
    expect([...neighbourhood(lines, account(IDS.supabase))].sort()).toEqual(
      [account(IDS.supabase), email(IDS.me), org(IDS.org), res(IDS.resource), project(IDS.project)].sort(),
    );
  });

  it("shows an organization's service, email, projects, and who uses them", () => {
    const { lines } = canvas();
    expect([...neighbourhood(lines, org(IDS.org))].sort()).toEqual(
      [org(IDS.org), account(IDS.supabase), email(IDS.me), res(IDS.resource), project(IDS.project)].sort(),
    );
  });

  it("shows an email's services and the projects using those", () => {
    const { lines } = canvas();
    const near = neighbourhood(lines, email(IDS.me));
    expect(near.has(account(IDS.github))).toBe(true);
    expect(near.has(project(IDS.project))).toBe(true);
    expect(near.has(email(IDS.work))).toBe(false);
  });
});

describe("a project's own page", () => {
  it("puts the project first, what it runs on beside it, and a column for each kind that holds those", () => {
    const { balls, lines } = canvas();
    const at = focusLayout(balls, lines, project(IDS.project));
    expect(at.get(project(IDS.project))).toEqual({ x: 0, y: 0 });
    expect(at.get(res(IDS.resource))).toEqual({ x: 220, y: -65 });
    expect(at.get(account(IDS.stripe))).toEqual({ x: 220, y: 65 });
    // Each holder sits level with what it holds; the email between its two services.
    expect(at.get(org(IDS.org))).toEqual({ x: 440, y: -65 });
    expect(at.get(account(IDS.supabase))).toEqual({ x: 660, y: -65 });
    expect(at.get(email(IDS.me))).toEqual({ x: 880, y: 0 });
  });
});

describe("placing something new", () => {
  it("uses the spot asked for when it is free, and the nearest free one when not", () => {
    expect(freeSpot({ x: 0, y: 0 }, [{ x: 500, y: 0 }])).toEqual({ x: 0, y: 0 });
    const p = freeSpot({ x: 0, y: 0 }, [{ x: 0, y: 0 }]);
    expect(Math.hypot(p.x, p.y)).toBeGreaterThanOrEqual(110);
  });

  it("puts a new thing beside what holds it, stepping up or down past what is there", () => {
    expect(besideSpot({ x: 0, y: 0 }, [])).toEqual({ x: 220, y: 0 });
    expect(besideSpot({ x: 0, y: 0 }, [{ x: 220, y: 0 }])).toEqual({ x: 220, y: 100 });
    expect(besideSpot({ x: 0, y: 0 }, [{ x: 220, y: 0 }, { x: 220, y: 100 }])).toEqual({ x: 220, y: -100 });
  });
});
