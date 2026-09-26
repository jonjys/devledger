import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import type { SubscriptionSummary } from "../lib/types";
import SubscriptionsView from "./SubscriptionsView";

vi.mock("../lib/api");

const mocked = vi.mocked(api);

function summary(overrides: Partial<SubscriptionSummary["subscription"]> = {}): SubscriptionSummary {
  return {
    subscription: {
      id: "sub-1",
      account_id: "account-1",
      plan: "Pro Plan",
      status: "active",
      amount_cents: 1200,
      currency: "USD",
      interval: "monthly",
      trial_ends_at: "12/26",
      created_at: "2026-09-16T10:00:00Z",
      ...overrides,
    },
    provider: "unknown",
    account_label: "test@gmail.com",
    identity_email: "test@gmail.com",
  };
}

function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  date.setUTCDate(date.getUTCDate() + days);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("Subscriptions screen", () => {
  it("offers to add a subscription even when the list is empty", async () => {
    mocked.listSubscriptions.mockResolvedValue([]);
    render(<SubscriptionsView onNotify={vi.fn()} />);

    expect(
      await screen.findByRole("button", { name: "+ Add Subscription" }),
    ).toBeInTheDocument();
    expect(screen.getByText("No subscriptions recorded")).toBeInTheDocument();
  });

  it("records a manual subscription with a parsed price and interval", async () => {
    mocked.listSubscriptions.mockResolvedValue([]);
    mocked.createSubscriptionManual.mockResolvedValue(summary().subscription);
    const user = userEvent.setup();
    render(<SubscriptionsView onNotify={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "+ Add Subscription" }));

    const dialog = screen.getByRole("dialog", { name: "Add subscription" });
    await user.type(within(dialog).getByLabelText("Plan name"), "Pro Plan");
    await user.type(within(dialog).getByLabelText("Identity / email"), "test@gmail.com");
    await user.type(within(dialog).getByLabelText("Price"), "$12");
    fireEvent.change(within(dialog).getByLabelText("Expiration / renewal"), {
      target: { value: "2026-12-26" },
    });
    await user.click(within(dialog).getByRole("button", { name: "Save subscription" }));

    await waitFor(() => expect(mocked.createSubscriptionManual).toHaveBeenCalled());
    expect(mocked.createSubscriptionManual).toHaveBeenCalledWith({
      email: "test@gmail.com",
      provider: "unknown",
      plan: "Pro Plan",
      status: "active",
      amountCents: 1200,
      currency: "USD",
      interval: "monthly",
      renewsAt: "2026-12-26",
      reminderDays: 1,
      warnEnabled: true,
    });
  });

  it("requires a future renewal, colors status from that date, and picks YYYY-MM-DD from the calendar", async () => {
    mocked.listSubscriptions.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<SubscriptionsView onNotify={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "+ Add Subscription" }));
    const dialog = screen.getByRole("dialog", { name: "Add subscription" });
    const save = within(dialog).getByRole("button", { name: "Save subscription" });
    expect(save).toBeDisabled();

    await user.type(within(dialog).getByLabelText("Plan name"), "Pro Plan");
    await user.type(within(dialog).getByLabelText("Price"), "$12");
    expect(save).toBeDisabled();

    const renew = within(dialog).getByLabelText("Expiration / renewal");
    fireEvent.change(renew, { target: { value: "2020-01-01" } });
    expect(within(dialog).getByLabelText("Status")).toHaveValue("expired");
    expect(save).toBeDisabled();

    const soon = new Date();
    soon.setDate(soon.getDate() + 3);
    const soonIso = [
      soon.getFullYear(),
      String(soon.getMonth() + 1).padStart(2, "0"),
      String(soon.getDate()).padStart(2, "0"),
    ].join("-");
    fireEvent.change(renew, { target: { value: soonIso } });
    expect(within(dialog).getByLabelText("Status")).toHaveValue("expiring_soon");
    expect(save).toBeEnabled();
    expect(within(dialog).getByText(`Reminds on ${shiftIso(soonIso, -1)}`)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Custom" }));
    expect(within(dialog).getByLabelText("X days")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Open calendar" }));
    const calendar = within(dialog).getByLabelText("Expiration calendar");
    const day = String(soon.getDate());
    await user.click(within(calendar).getByRole("button", { name: day }));
    expect(renew).toHaveValue(soonIso);
    expect(screen.queryByLabelText("Expiration calendar")).not.toBeInTheDocument();
  });

  it("closes the calendar on Escape and leaves the dialog open", async () => {
    mocked.listSubscriptions.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<SubscriptionsView onNotify={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "+ Add Subscription" }));
    const dialog = screen.getByRole("dialog", { name: "Add subscription" });
    await user.click(within(dialog).getByRole("button", { name: "Open calendar" }));
    expect(within(dialog).getByLabelText("Expiration calendar")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Expiration calendar")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Add subscription" })).toBeInTheDocument();
  });

  it("deletes a subscription from its row", async () => {
    mocked.listSubscriptions.mockResolvedValue([summary()]);
    mocked.deleteSubscription.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<SubscriptionsView onNotify={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mocked.deleteSubscription).toHaveBeenCalledWith("sub-1"));
  });
});
