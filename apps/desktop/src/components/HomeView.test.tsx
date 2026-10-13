import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import type { Layout } from "../lib/layout";
import type { SubscriptionSummary } from "../lib/types";
import HomeView from "./HomeView";

vi.mock("../lib/api");

const mocked = vi.mocked(api);
const AT = "2026-09-16T10:00:00Z";

function emptyVault() {
  mocked.listProjects.mockResolvedValue([]);
  mocked.identityGraph.mockResolvedValue([]);
  mocked.listSubscriptions.mockResolvedValue([]);
  mocked.recentAudit.mockResolvedValue([]);
  mocked.needsAttention.mockResolvedValue([]);
  mocked.listAllSecrets.mockResolvedValue([]);
}

const layoutOf = (boxes: Layout["boxes"]): Layout => ({ v: 1, boxes, tabs: ["home", "projects"], start: "home", templates: [] });

/** HomeView with its layout held in state, the way DesktopShell holds it. */
function Harness({ initial, onAdd, onSaved }: { initial: Layout; onAdd?: () => void; onSaved?: (l: Layout) => void }) {
  const [layout, setLayout] = useState(initial);
  return (
    <HomeView
      layout={layout}
      onLayout={(l) => {
        setLayout(l);
        onSaved?.(l);
      }}
      onOpenLayoutPanel={vi.fn()}
      onNotify={vi.fn()}
      onNavigate={vi.fn()}
      onChanged={vi.fn()}
      refreshKey={0}
      onAdd={onAdd}
    />
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(false);
});

describe("Home on a fresh install", () => {
  it("starts with manual entry, not with a connector", async () => {
    emptyVault();
    render(<Harness initial={layoutOf([])} />);

    const card = await screen.findByRole("region", { name: "Get started" });
    expect(within(card).getByText(/no token needed/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Add your email address" })).toBeInTheDocument();
    expect(within(card).queryByText(/Supabase/)).toBeNull();
  });

  it("opens Add with the right kind already chosen", async () => {
    const user = userEvent.setup();
    emptyVault();
    const onAdd = vi.fn();
    render(<Harness initial={layoutOf([])} onAdd={onAdd} />);
    await user.click(await screen.findByRole("button", { name: "Add an account" }));
    expect(onAdd).toHaveBeenCalledWith("service");
  });
});

describe("editing the layout", () => {
  it("adds, renames, moves and removes boxes", async () => {
    const user = userEvent.setup();
    emptyVault();
    const saved: Layout[] = [];
    render(
      <Harness
        initial={layoutOf([{ id: "a", kind: "costs" }, { id: "b", kind: "activity" }])}
        onSaved={(l) => saved.push(l)}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Edit layout" }));
    await user.click(screen.getByRole("button", { name: "+ Add a box" }));
    await user.click(screen.getByRole("button", { name: /^Trials ending/ }));
    expect(saved.at(-1)!.boxes.map((b) => b.kind)).toEqual(["costs", "activity", "trials"]);

    const titles = screen.getAllByLabelText("Box title");
    await user.type(titles[0]!, "Pengar");
    expect(saved.at(-1)!.boxes[0]!.title).toBe("Pengar");

    await user.click(screen.getAllByRole("button", { name: "Move down" })[0]!);
    expect(saved.at(-1)!.boxes.map((b) => b.kind)).toEqual(["activity", "costs", "trials"]);

    await user.click(screen.getAllByRole("button", { name: "Make wide" })[0]!);
    expect(saved.at(-1)!.boxes[0]!.wide).toBe(true);

    await user.click(screen.getAllByRole("button", { name: "Remove box" })[2]!);
    expect(saved.at(-1)!.boxes.map((b) => b.kind)).toEqual(["activity", "costs"]);

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("region", { name: "Pengar" })).toBeInTheDocument();
  });

  it("lets you write in a note and shows it formatted", async () => {
    const user = userEvent.setup();
    emptyVault();
    render(<Harness initial={layoutOf([{ id: "n", kind: "note", title: "Next up", text: "" }])} />);

    const area = await screen.findByLabelText("Note text");
    await user.type(area, "**Ring** banken");
    expect(screen.getByLabelText("Note text")).toHaveValue("**Ring** banken");
    await user.tab();
    const box = screen.getByRole("region", { name: "Next up" });
    expect(await within(box).findByText("Ring")).toHaveProperty("tagName", "STRONG");
  });
});

describe("boxes", () => {
  const trial: SubscriptionSummary = {
    subscription: {
      id: "sub-1",
      account_id: "acc-1",
      plan: "Pro",
      status: "trialing",
      amount_cents: 2500,
      currency: "USD",
      interval: "monthly",
      trial_ends_at: "2026-10-01",
      created_at: AT,
    },
    provider: "vercel",
    account_label: "Work",
    identity_email: "me@example.com",
  };

  it("says plainly that removing a trial does not cancel it with the provider", async () => {
    const user = userEvent.setup();
    emptyVault();
    mocked.listSubscriptions.mockResolvedValue([trial]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Harness initial={layoutOf([{ id: "t", kind: "trials" }])} />);

    await screen.findByText(/Pro trial/);
    expect(screen.queryByRole("button", { name: "Set reminder" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Remove from ledger" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("does not cancel it"));
    expect(mocked.deleteSubscription).not.toHaveBeenCalled();
  });

  it("leaves the map's bookkeeping out of recent activity", async () => {
    emptyVault();
    mocked.recentAudit.mockResolvedValue([
      { seq: 2, at: "2026-09-27T10:00:00Z", action: "field.update", entity_kind: "field", entity_id: null, detail: "Updated field _skillTreeCategories" },
      { seq: 1, at: "2026-09-27T09:00:00Z", action: "field.create", entity_kind: "field", entity_id: null, detail: "Added field Customer number" },
    ]);
    render(<Harness initial={layoutOf([{ id: "a", kind: "activity" }])} />);
    expect(await screen.findByText("Added field Customer number")).toBeInTheDocument();
    expect(screen.queryByText(/_skillTreeCategories/)).toBeNull();
  });

  it("only asks for the data its boxes show", async () => {
    emptyVault();
    render(<Harness initial={layoutOf([{ id: "n", kind: "note", text: "hi" }])} />);
    await screen.findByText("hi");
    expect(mocked.recentAudit).not.toHaveBeenCalled();
    expect(mocked.listAllSecrets).not.toHaveBeenCalled();
    expect(mocked.needsAttention).not.toHaveBeenCalled();
  });

  it("lists key names, never values", async () => {
    emptyVault();
    mocked.listAllSecrets.mockResolvedValue([
      {
        owner: "Shop",
        entry: {
          client_unsafe: true,
          provider: "stripe",
          service_project_name: null,
          secret: { id: "s1", name: "STRIPE_SECRET_KEY", preview: "sk_l…33", kind: "stripe_secret_key" } as never,
        },
      },
    ]);
    render(<Harness initial={layoutOf([{ id: "k", kind: "secrets" }])} />);
    expect(await screen.findByText("STRIPE_SECRET_KEY")).toBeInTheDocument();
    expect(screen.queryByText(/sk_l/)).toBeNull();
    expect(mocked.revealSecret).not.toHaveBeenCalled();
  });
});
