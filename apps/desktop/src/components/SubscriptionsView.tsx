import { useCallback, useEffect, useState } from "react";

import * as api from "../lib/api";
import { formatTime, providerLabel } from "../lib/format";
import { useMode } from "../lib/mode";
import type { BillingInterval, SubscriptionStatus, SubscriptionSummary } from "../lib/types";

import Modal from "./Modal";

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

const STATUS_OPTIONS: [SubscriptionStatus, string][] = [
  ["active", "Active"],
  ["trialing", "Trialing"],
  ["past_due", "Past due"],
  ["canceled", "Canceled"],
];

/** Subscriptions and trials, whether saved from a paste or added by hand. */
export default function SubscriptionsView({ onNotify }: Props) {
  const { dev } = useMode();
  const [rows, setRows] = useState<SubscriptionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

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

  async function remove(id: string, plan: string) {
    if (!window.confirm(`Delete the "${plan}" subscription?`)) return;
    try {
      await api.deleteSubscription(id);
      await load();
      onNotify(`Deleted ${plan}`);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  return (
    <div>
      <div className="vault-head">
        <div>
          <h1>Subscriptions &amp; trials</h1>
          <div className="sub">What you are paying for, and on which account.</div>
        </div>
        <span className="spacer" />
        <div className="acts">
          <button type="button" className="primary" onClick={() => setAdding(true)}>
            + Add Subscription
          </button>
        </div>
      </div>

      {loading ? (
        <div className="empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <p style={{ margin: 0, fontWeight: 600 }}>No subscriptions recorded</p>
          <p style={{ marginBottom: 0 }}>
            Paste a billing page, or press <strong>+ Add Subscription</strong> to record one
            by hand.
          </p>
        </div>
      ) : (
        <table className="secrets">
          <thead>
            <tr>
              <th>Plan</th>
              <th>Status</th>
              <th>Price</th>
              <th>Account</th>
              <th>Renews / ends</th>
              <th>Recorded</th>
              <th />
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
                  {subscription.interval
                    ? ` / ${subscription.interval === "monthly" ? "mo" : "yr"}`
                    : ""}
                </td>
                <td style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
                  {dev ? `${providerLabel(provider)} · ` : ""}
                  {identity_email ?? account_label}
                </td>
                <td className="pv">{subscription.trial_ends_at ?? "—"}</td>
                <td style={{ color: "var(--text-faint)", fontSize: 12 }}>
                  {formatTime(subscription.created_at)}
                </td>
                <td>
                  <div className="row-acts">
                    <button
                      type="button"
                      className="danger"
                      onClick={() => remove(subscription.id, subscription.plan)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adding && (
        <AddSubscription
          onCancel={() => setAdding(false)}
          onNotify={onNotify}
          onSaved={async () => {
            setAdding(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

interface AddProps {
  onCancel: () => void;
  onSaved: () => void;
  onNotify: (message: string, bad?: boolean) => void;
}

/** Record a subscription by hand — no Smart Paste required. */
function AddSubscription({ onCancel, onSaved, onNotify }: AddProps) {
  const [plan, setPlan] = useState("");
  const [email, setEmail] = useState("");
  const [price, setPrice] = useState("");
  const [interval, setInterval] = useState<BillingInterval>("monthly");
  const [renewsAt, setRenewsAt] = useState("");
  const [status, setStatus] = useState<SubscriptionStatus>("active");
  const [busy, setBusy] = useState(false);

  function parsePrice(): number | null {
    const cleaned = price.replace(/[^0-9.]/g, "");
    if (!cleaned) return null;
    const value = Number.parseFloat(cleaned);
    if (Number.isNaN(value)) return null;
    return Math.round(value * 100);
  }

  async function save() {
    if (!plan.trim() || busy) return;
    setBusy(true);
    try {
      await api.createSubscriptionManual({
        email: email.trim() || null,
        provider: "unknown",
        plan: plan.trim(),
        status,
        amountCents: parsePrice(),
        currency: price.includes("€") ? "EUR" : price.includes("£") ? "GBP" : "USD",
        interval,
        renewsAt: renewsAt.trim() || null,
      });
      onNotify(`Added ${plan.trim()}`);
      onSaved();
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal label="Add subscription" onClose={onCancel} maxWidth={520}>
      <header>
        <h2>Add a subscription</h2>
        <p>Record what you are paying for. Nothing here leaves your machine.</p>
      </header>

      <div className="scroll">
        <div className="field">
          <label htmlFor="sub-plan">Plan name</label>
          <input
            id="sub-plan"
            autoFocus
            placeholder="Pro Plan"
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="sub-email">Identity / email</label>
          <input
            id="sub-email"
            placeholder="fkornelind@hotmail.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="sub-price">Price</label>
            <input
              id="sub-price"
              placeholder="$12"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="sub-interval">Billing interval</label>
            <select
              id="sub-interval"
              value={interval}
              onChange={(e) => setInterval(e.target.value as BillingInterval)}
            >
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="sub-renews">Expiration / renewal</label>
            <input
              id="sub-renews"
              placeholder="12/26"
              value={renewsAt}
              onChange={(e) => setRenewsAt(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="sub-status">Status</label>
            <select
              id="sub-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as SubscriptionStatus)}
            >
              {STATUS_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <footer>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          onClick={save}
          disabled={busy || !plan.trim()}
        >
          {busy ? "Saving…" : "Save subscription"}
        </button>
      </footer>
    </Modal>
  );
}
