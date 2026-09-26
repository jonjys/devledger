import { describe, expect, it } from "vitest";

import {
  dominantCurrency,
  formatMoney,
  monthlyCents,
  monthlyTotalCents,
  trialsFrom,
} from "./overview";
import type { SubscriptionSummary } from "./types";

function sub(over: Partial<SubscriptionSummary["subscription"]> = {}): SubscriptionSummary {
  return {
    subscription: {
      id: crypto.randomUUID(),
      account_id: "a",
      plan: "Pro",
      status: "active",
      amount_cents: 1000,
      currency: "USD",
      interval: "monthly",
      trial_ends_at: null,
      created_at: "2026-09-01T00:00:00Z",
      ...over,
    },
    provider: "supabase",
    account_label: "acc",
    identity_email: "test@gmail.com",
  };
}

describe("formatMoney", () => {
  it("renders SEK as a kr suffix", () => {
    expect(formatMoney(25000, "SEK")).toBe("250 kr");
  });
  it("renders known symbols as a prefix", () => {
    expect(formatMoney(1200, "USD")).toBe("$12");
    expect(formatMoney(999, "EUR")).toBe("€9.99");
  });
  it("falls back to a trailing currency code", () => {
    expect(formatMoney(500, "CHF")).toBe("5 CHF");
    expect(formatMoney(500, null)).toBe("5");
  });
});

describe("monthlyCents", () => {
  it("passes monthly amounts through", () => {
    expect(monthlyCents(sub({ amount_cents: 1200, interval: "monthly" }))).toBe(1200);
  });
  it("spreads yearly across twelve months", () => {
    expect(monthlyCents(sub({ amount_cents: 12000, interval: "yearly" }))).toBe(1000);
  });
  it("ignores canceled subscriptions", () => {
    expect(monthlyCents(sub({ status: "canceled", amount_cents: 9999 }))).toBe(0);
  });
});

describe("monthlyTotalCents", () => {
  it("sums active subscriptions", () => {
    const total = monthlyTotalCents([
      sub({ amount_cents: 2500 }),
      sub({ amount_cents: 12000, interval: "yearly" }),
      sub({ status: "canceled", amount_cents: 5000 }),
    ]);
    expect(total).toBe(3500);
  });
});

describe("trialsFrom", () => {
  it("picks up trialing status and trial dates", () => {
    const trials = trialsFrom([
      sub({ status: "trialing" }),
      sub({ trial_ends_at: "2099-01-01" }),
      sub({ status: "active", trial_ends_at: null }),
    ]);
    expect(trials).toHaveLength(2);
  });
});

describe("dominantCurrency", () => {
  it("returns the most common currency", () => {
    expect(
      dominantCurrency([sub({ currency: "USD" }), sub({ currency: "USD" }), sub({ currency: "EUR" })]),
    ).toBe("USD");
  });
});
