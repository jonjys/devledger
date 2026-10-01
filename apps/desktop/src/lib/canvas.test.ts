import { describe, expect, it } from "vitest";

import { IDS, canvasVault, resource } from "../test/canvas-fixtures";
import {
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

  it("joins a project to the services it uses through a resource", () => {
    const { lines } = canvas();
    const uses = lines.filter((l) => l.kind === "uses").map((l) => `${l.source}>${l.target}`);
    expect(uses).toEqual([`${project(IDS.project)}>${account(IDS.supabase)}`]);
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

  it("explains the lines that mean nothing", () => {
    const { balls, lines } = canvas();
    const refuse = (a: string, b: string) => connectIntent(ball(balls, a), ball(balls, b), lines).kind;
    expect(refuse(project(IDS.blog), email(IDS.me))).toBe("refuse");
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

  it("removes only the empty resource a line made, and unlinks any other", () => {
    const data = canvasVault();
    expect(resourcesToUnlink(data, IDS.supabase, IDS.project)).toEqual([{ id: IDS.resource, remove: true }]);
    const first = data.resources[0];
    if (!first) throw new Error("fixture");
    first.secret_count = 2;
    expect(resourcesToUnlink(data, IDS.supabase, IDS.project)).toEqual([{ id: IDS.resource, remove: false }]);
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
    expect([...xs("project")]).toEqual([600]);
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

describe("what a ball is connected to", () => {
  it("shows a project's services and their emails, and nothing else", () => {
    const { lines } = canvas();
    expect([...neighbourhood(lines, project(IDS.project))].sort()).toEqual(
      [project(IDS.project), account(IDS.supabase), email(IDS.me)].sort(),
    );
  });

  it("shows a service's email and the projects using it", () => {
    const { lines } = canvas();
    expect([...neighbourhood(lines, account(IDS.supabase))].sort()).toEqual(
      [account(IDS.supabase), email(IDS.me), project(IDS.project)].sort(),
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
  it("puts the project first, its services beside it and their emails beyond", () => {
    const { balls, lines } = canvas();
    const at = focusLayout(balls, lines, project(IDS.project));
    expect(at.get(project(IDS.project))).toEqual({ x: 0, y: 0 });
    expect(at.get(account(IDS.supabase))).toEqual({ x: 220, y: 0 });
    expect(at.get(email(IDS.me))).toEqual({ x: 440, y: 0 });
  });
});

describe("placing something new", () => {
  it("uses the spot asked for when it is free, and the nearest free one when not", () => {
    expect(freeSpot({ x: 0, y: 0 }, [{ x: 500, y: 0 }])).toEqual({ x: 0, y: 0 });
    const p = freeSpot({ x: 0, y: 0 }, [{ x: 0, y: 0 }]);
    expect(Math.hypot(p.x, p.y)).toBeGreaterThanOrEqual(110);
  });
});
