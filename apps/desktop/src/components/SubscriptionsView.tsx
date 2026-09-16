import { useCallback, useEffect, useState } from "react";

import * as api from "../lib/api";
import { formatTime } from "../lib/format";
import type { SubscriptionSummary } from "../lib/types";

interface Props {
  onNotify: (message: string, bad?: boolean) => void;
}

function money(cents: number | null, currency: string | null): string {
  if (cents === null) return "—";
  const amount = (cents / 100).toFixed(2);
  return currency ? `${amount} ${currency}` : amount;
}

const STATUS_TONE: Record<string, string> = {
  active: "strong",
  trialing: "heuristic",
  past_due: "unsafe",
  canceled: "weak",
  free: "explicit",
  unknown: "weak",
};

/** Subscriptions and trials, once they have been saved from a paste. */
export default function SubscriptionsView({ onNotify }: Props) {
  const [rows, setRows] = useState<SubscriptionSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.listSubscriptions());
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <div className="empty">Loading…</div>;

  if (rows.length === 0) {
    return (
      <div className="empty">
        <p style={{ margin: 0, fontWeight: 600 }}>No subscriptions recorded</p>
        <p style={{ marginBottom: 0 }}>
          Paste a billing page — something like &ldquo;Pro plan $25 per month&rdquo; or
          &ldquo;Team plan, trial ends 2026-12-01&rdquo; — and it will be filed against
          that account.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="vault-head">
        <div>
          <h1>Subscriptions &amp; trials</h1>
          <div className="sub">What you are paying for, and on which account.</div>
        </div>
      </div>

      <table className="secrets">
        <thead>
          <tr>
            <th>Plan</th>
            <th>Status</th>
            <th>Price</th>
            <th>Account</th>
            <th>Trial ends</th>
            <th>Recorded</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ subscription, account_label, identity_email, provider }) => (
            <tr key={subscription.id}>
              <td className="nm">{subscription.plan}</td>
              <td>
                <span className={`tag ${STATUS_TONE[subscription.status] ?? "weak"}`}>
                  {subscription.status.replace("_", " ")}
                </span>
              </td>
              <td className="pv">
                {money(subscription.amount_cents, subscription.currency)}
                {subscription.interval ? ` / ${subscription.interval === "monthly" ? "mo" : "yr"}` : ""}
              </td>
              <td style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
                {provider} · {identity_email ?? account_label}
              </td>
              <td className="pv">{subscription.trial_ends_at ?? "—"}</td>
              <td style={{ color: "var(--text-faint)", fontSize: 12 }}>
                {formatTime(subscription.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
