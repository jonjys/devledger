// Pure helpers behind the Overview dashboard. No secret values ever pass here.

import type { SubscriptionSummary } from "./types";

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
};

/** Format minor units + currency for display, e.g. `250 kr`, `$12`, `9.99 CHF`. */
export function formatMoney(cents: number, currency: string | null): string {
  const amount = cents / 100;
  const n = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  const cur = (currency ?? "").trim();
  if (cur.toUpperCase() === "SEK" || cur.toLowerCase() === "kr") return `${n} kr`;
  const sym = CURRENCY_SYMBOL[cur.toUpperCase()];
  if (sym) return `${sym}${n}`;
  return cur ? `${n} ${cur}` : n;
}

/** Whole days from now until an ISO date, or null when it cannot be parsed. */
export function daysUntil(dateish: string | null): number | null {
  if (!dateish) return null;
  const parsed = new Date(dateish);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.ceil((parsed.getTime() - Date.now()) / 86_400_000);
}

export interface Trial {
  summary: SubscriptionSummary;
  daysLeft: number | null;
}

/** Subscriptions that are trials or carry a trial/renewal date. */
export function trialsFrom(subs: SubscriptionSummary[]): Trial[] {
  return subs
    .filter(
      (s) => s.subscription.status === "trialing" || Boolean(s.subscription.trial_ends_at),
    )
    .map((s) => ({ summary: s, daysLeft: daysUntil(s.subscription.trial_ends_at) }));
}

/** Monthly-equivalent cost of one subscription (yearly is spread across 12). */
export function monthlyCents(s: SubscriptionSummary): number {
  const sub = s.subscription;
  if (sub.status === "canceled" || sub.amount_cents == null) return 0;
  if (sub.interval === "yearly") return Math.round(sub.amount_cents / 12);
  return sub.amount_cents;
}

/** Total monthly-equivalent spend across all active subscriptions. */
export function monthlyTotalCents(subs: SubscriptionSummary[]): number {
  return subs.reduce((total, s) => total + monthlyCents(s), 0);
}

/** The dominant currency among subscriptions, for the total line. */
export function dominantCurrency(subs: SubscriptionSummary[]): string | null {
  const counts = new Map<string, number>();
  for (const s of subs) {
    const c = s.subscription.currency;
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [c, n] of counts) {
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  }
  return best;
}

/** Compact relative time, e.g. `just now`, `2h ago`, `3d ago`. */
export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return `${months}mo ago`;
}
