import { costsByCurrency, money, monthProgress, spentSoFar } from "./costs";
import type { SubscriptionSummary } from "./types";

function sub(
  provider: string,
  plan: string,
  over: Partial<SubscriptionSummary["subscription"]> = {},
): SubscriptionSummary {
  return {
    subscription: {
      id: `${provider}-${plan}`,
      account_id: "a",
      plan,
      status: "active",
      amount_cents: 1000,
      currency: "USD",
      interval: "monthly",
      trial_ends_at: null,
      created_at: "2026-09-01T00:00:00Z",
      ...over,
    },
    provider: provider as SubscriptionSummary["provider"],
    account_label: "demo@example.com",
    identity_email: "demo@example.com",
  };
}

describe("costs", () => {
  it("adds up what is charged now, spreads yearly plans and keeps trials apart", () => {
    const [usd] = costsByCurrency([
      sub("vercel", "Pro", { amount_cents: 2000 }),
      sub("supabase", "Pro", { amount_cents: 2500 }),
      sub("github", "Team", { amount_cents: 12000, interval: "yearly" }),
      sub("openai", "Plus", { amount_cents: 2000, status: "trialing" }),
      sub("stripe", "Old", { amount_cents: 900, status: "canceled" }),
      sub("netlify", "Free", { amount_cents: null, status: "free" }),
    ]);
    expect(usd!.monthlyCents).toBe(2000 + 2500 + 1000);
    expect(usd!.afterTrialsCents).toBe(2000 + 2500 + 1000 + 2000);
    expect(usd!.paying).toBe(3);
    expect(usd!.trialing).toBe(1);
    expect(usd!.services.map((s) => s.label)).toEqual(["Supabase", "Vercel", "GitHub"]);
  });

  it("never converts between currencies", () => {
    const totals = costsByCurrency([
      sub("vercel", "Pro", { amount_cents: 2000, currency: "USD" }),
      sub("other:Loopia", "Domain", { amount_cents: 19900, currency: "sek" }),
    ]);
    expect(totals.map((t) => [t.currency, t.monthlyCents])).toEqual([
      ["SEK", 19900],
      ["USD", 2000],
    ]);
    expect(money(19900, "SEK")).toBe("199.00 kr");
    expect(money(123456, "USD")).toBe("$1,234.56");
  });

  it("counts the month gone so far", () => {
    // January has no daylight-saving transition in the test environments;
    // October's extra hour makes its calendar midpoint differ from elapsed time.
    const mid = new Date(2026, 0, 16, 12, 0, 0);
    const p = monthProgress(mid);
    expect(p.days).toBe(31);
    expect(p.day).toBe(16);
    expect(p.elapsed).toBeCloseTo(0.5, 2);
    expect(spentSoFar(3100, mid)).toBeCloseTo(1550, 0);
  });
});
