import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import type { SubscriptionSummary } from "../lib/types";
import OverviewView from "./OverviewView";

vi.mock("../lib/api");

const mocked = vi.mocked(api);
const AT = "2026-09-16T10:00:00Z";

function emptyVault() {
  mocked.listProjects.mockResolvedValue([]);
  mocked.identityGraph.mockResolvedValue([]);
  mocked.listSubscriptions.mockResolvedValue([]);
  mocked.recentAudit.mockResolvedValue([]);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(false);
});

describe("Overview on a fresh install", () => {
  it("starts with manual entry, not with a connector", async () => {
    emptyVault();
    render(
      <OverviewView onNotify={vi.fn()} onNavigate={vi.fn()} onChanged={vi.fn()} refreshKey={0} />,
    );

    const card = await screen.findByRole("region", { name: "Get started" });
    expect(within(card).getByText(/no token needed/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Add your email address" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Add an account" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Add a project" })).toBeInTheDocument();
    expect(within(card).queryByText(/Supabase/)).toBeNull();
  });

  it("opens Add with the right kind already chosen", async () => {
    const user = userEvent.setup();
    emptyVault();
    const onAdd = vi.fn();
    render(
      <OverviewView
        onNotify={vi.fn()}
        onNavigate={vi.fn()}
        onChanged={vi.fn()}
        refreshKey={0}
        onAdd={onAdd}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Add an account" }));
    expect(onAdd).toHaveBeenCalledWith("service");
  });
});

describe("Trials", () => {
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

  it("offers no button that claims to do something it does not", async () => {
    mocked.listProjects.mockResolvedValue([]);
    mocked.identityGraph.mockResolvedValue([]);
    mocked.listSubscriptions.mockResolvedValue([trial]);
    mocked.recentAudit.mockResolvedValue([]);
    render(
      <OverviewView onNotify={vi.fn()} onNavigate={vi.fn()} onChanged={vi.fn()} refreshKey={0} />,
    );

    await screen.findByText(/Pro trial/);
    // There is no reminder system, so there must be no "Set reminder".
    expect(screen.queryByRole("button", { name: "Set reminder" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Keep/ })).toBeNull();
  });

  it("says plainly that removing does not cancel with the provider", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mocked.listProjects.mockResolvedValue([]);
    mocked.identityGraph.mockResolvedValue([]);
    mocked.listSubscriptions.mockResolvedValue([trial]);
    mocked.recentAudit.mockResolvedValue([]);
    render(
      <OverviewView onNotify={vi.fn()} onNavigate={vi.fn()} onChanged={vi.fn()} refreshKey={0} />,
    );

    await user.click(await screen.findByRole("button", { name: "Remove from ledger" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("does not cancel it"));
    expect(mocked.deleteSubscription).not.toHaveBeenCalled();
  });

  it("leaves the skill tree's bookkeeping out of recent activity", async () => {
    mocked.listProjects.mockResolvedValue([]);
    mocked.identityGraph.mockResolvedValue([]);
    mocked.listSubscriptions.mockResolvedValue([]);
    mocked.recentAudit.mockResolvedValue([
      { seq: 2, at: "2026-09-27T10:00:00Z", action: "field.update", entity_kind: "field", entity_id: null, detail: "Updated field _skillTreeCategories" },
      { seq: 1, at: "2026-09-27T09:00:00Z", action: "field.create", entity_kind: "field", entity_id: null, detail: "Added field Customer number" },
    ]);
    render(
      <OverviewView onNotify={vi.fn()} onNavigate={vi.fn()} onChanged={vi.fn()} refreshKey={0} />,
    );

    expect(await screen.findByText("Added field Customer number")).toBeInTheDocument();
    expect(screen.queryByText(/_skillTreeCategories/)).toBeNull();
  });
});
