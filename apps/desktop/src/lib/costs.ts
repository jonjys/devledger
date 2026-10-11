// What the recorded subscriptions cost, for the Costs tab. Pure functions over
// the subscription list; no secret values pass here.
//
// These are estimates from the plans the user wrote down, not bank data:
// yearly plans are spread across twelve months, and different currencies are
// kept apart rather than converted at a rate DevLedger would have to invent.

import { providerLabel } from "./format";
import type { SubscriptionStatus, SubscriptionSummary } from "./types";

/** Statuses that are being charged right now. */
const PAYING: ReadonlySet<SubscriptionStatus> = new Set(["active", "past_due", "unknown"]);

export interface ServiceCost {
  label: string;
  /** Monthly-equivalent, in minor units. */
  monthlyCents: number;
  plans: string[];
}

export interface CurrencyCosts {
  /** ISO code or whatever was recorded; empty when none was. */
  currency: string;
  /** Monthly-equivalent of what is charged now, in minor units. */
  monthlyCents: number;
  /** What the month will cost once the current trials convert. */
  afterTrialsCents: number;
  paying: number;
  trialing: number;
  /** Largest first. */
  services: ServiceCost[];
}

function monthly(amount: number, interval: string | null): number {
  return interval === "yearly" ? amount / 12 : amount;
}

/** Totals per currency, the biggest spend first. */
export function costsByCurrency(subs: SubscriptionSummary[]): CurrencyCosts[] {
  const out = new Map<string, CurrencyCosts>();
  const services = new Map<string, Map<string, ServiceCost>>();
  for (const s of subs) {
    const sub = s.subscription;
    if (sub.amount_cents == null || sub.amount_cents <= 0) continue;
    const paying = PAYING.has(sub.status);
    const trialing = sub.status === "trialing";
    if (!paying && !trialing) continue;

    const currency = (sub.currency ?? "").trim().toUpperCase();
    const row = out.get(currency) ?? {
      currency,
      monthlyCents: 0,
      afterTrialsCents: 0,
      paying: 0,
      trialing: 0,
      services: [],
    };
    const cents = monthly(sub.amount_cents, sub.interval);
    row.afterTrialsCents += cents;
    if (paying) {
      row.monthlyCents += cents;
      row.paying += 1;
      const byLabel = services.get(currency) ?? new Map<string, ServiceCost>();
      const label = providerLabel(s.provider);
      const svc = byLabel.get(label) ?? { label, monthlyCents: 0, plans: [] };
      svc.monthlyCents += cents;
      svc.plans.push(sub.plan);
      byLabel.set(label, svc);
      services.set(currency, byLabel);
    } else {
      row.trialing += 1;
    }
    out.set(currency, row);
  }
  for (const row of out.values()) {
    row.services = [...(services.get(row.currency)?.values() ?? [])].sort(
      (a, b) => b.monthlyCents - a.monthlyCents || a.label.localeCompare(b.label),
    );
  }
  return [...out.values()].sort((a, b) => b.monthlyCents - a.monthlyCents || b.afterTrialsCents - a.afterTrialsCents);
}

export interface MonthProgress {
  /** 1-based day of the month. */
  day: number;
  days: number;
  /** Share of the month gone, 0..1. */
  elapsed: number;
  /** Milliseconds in the month, for per-second rates. */
  ms: number;
}

export function monthProgress(now: Date): MonthProgress {
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
  const ms = end - start;
  return {
    day: now.getDate(),
    days: Math.round(ms / 86_400_000),
    elapsed: Math.min(1, Math.max(0, (now.getTime() - start) / ms)),
    ms,
  };
}

/** What a monthly spend has used up so far this month, in (fractional) minor units. */
export function spentSoFar(monthlyCents: number, now: Date): number {
  return monthlyCents * monthProgress(now).elapsed;
}

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

/** How to write an amount in this currency: symbol before, or code/"kr" after. */
export function currencyAffix(currency: string): { prefix: string; suffix: string } {
  const c = currency.toUpperCase();
  if (c === "SEK" || c === "KR" || c === "NOK" || c === "DKK") return { prefix: "", suffix: " kr" };
  if (SYMBOL[c]) return { prefix: SYMBOL[c], suffix: "" };
  return { prefix: "", suffix: c ? ` ${c}` : "" };
}

/** `$1,234.56`, `250.00 kr`, `9.99 CHF`. Two decimals always, so columns line up. */
export function money(cents: number, currency: string): string {
  const { prefix, suffix } = currencyAffix(currency);
  const n = (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${prefix}${n}${suffix}`;
}
