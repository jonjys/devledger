import { useCallback, useEffect, useState } from "react";

import * as api from "../lib/api";
import { formatTime, providerLabel } from "../lib/format";
import { useMode } from "../lib/mode";
import type { BillingInterval, SubscriptionStatus, SubscriptionSummary } from "../lib/types";

import Modal from "./Modal";

interface Props {
  onNotify: (message: string, bad?: boolean) => void;
  onChanged?: () => void;
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
export default function SubscriptionsView({ onNotify, onChanged }: Props) {
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
      onChanged?.();
      onNotify(`Deleted ${plan}`);
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  return (
    <div>
      <div className="vault-head column">
        <div>
          <h1>Subscriptions &amp; trials</h1>
          <div className="sub">What you are paying for, and on which account.</div>
        </div>
        {rows.length > 0 && (
          <button type="button" className="primary" onClick={() => setAdding(true)}>
            + Add Subscription
          </button>
        )}
      </div>

      {loading ? (
        <div className="empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <p style={{ margin: 0, fontWeight: 600 }}>No subscriptions recorded</p>
          <p style={{ marginBottom: 0 }}>
            Paste a billing page above, or record one by hand.
          </p>
          <button type="button" className="primary add-card" onClick={() => setAdding(true)}>
            + Add Subscription
          </button>
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
            onChanged?.();
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

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function parseIso(iso: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

function toIso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function formatPretty(iso: string): string {
  const parts = parseIso(iso);
  if (!parts) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(parts.y, parts.m - 1, parts.d)));
}

/** Record a subscription by hand — no Smart Paste required. */
function AddSubscription({ onCancel, onSaved, onNotify }: AddProps) {
  const [plan, setPlan] = useState("");
  const [email, setEmail] = useState("");
  const [price, setPrice] = useState("");
  const [interval, setInterval] = useState<BillingInterval>("monthly");
  const [renewsAt, setRenewsAt] = useState("");
  const [status, setStatus] = useState<SubscriptionStatus>("active");
  const [remind, setRemind] = useState("1");
  const [customDays, setCustomDays] = useState("7");
  const [warn, setWarn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [calOpen, setCalOpen] = useState(false);
  const today = new Date();
  const [view, setView] = useState({ y: today.getFullYear(), m: today.getMonth() + 1 });

  function chooseDate(iso: string) {
    setRenewsAt(iso);
    const parts = parseIso(iso);
    if (parts) setView({ y: parts.y, m: parts.m });
  }

  function onInterval(next: BillingInterval) {
    setInterval(next);
  }

  function onRenewInput(value: string) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) chooseDate(value);
  }

  function toggleCalendar() {
    const parts = parseIso(renewsAt);
    if (parts) setView({ y: parts.y, m: parts.m });
    setCalOpen((open) => !open);
  }

  function reminderDays(): number | null {
    if (!warn) return null;
    if (remind === "custom") {
      const n = Number.parseInt(customDays, 10);
      return Number.isFinite(n) && n > 0 ? n : 1;
    }
    return Number.parseInt(remind, 10);
  }

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
        renewsAt: parseIso(renewsAt) ? renewsAt : null,
        reminderDays: reminderDays(),
        warnEnabled: warn,
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
    <Modal label="Add subscription" onClose={onCancel} maxWidth={640}>
      <header className="sub-head">
        <div>
          <h2>Add a subscription</h2>
          <p>Create a new subscription and set renewal reminders</p>
        </div>
        <button type="button" className="ghost sub-close" aria-label="Close" onClick={onCancel}>
          ×
        </button>
      </header>

      <div className="scroll">
        <div className="sub-grid">
          <div className="field">
            <label htmlFor="sub-plan">Plan name</label>
            <input
              id="sub-plan"
              autoFocus
              placeholder="Cursor pro"
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="sub-email">Identity / email</label>
            <div className="icon-field">
              <span className="field-icon" aria-hidden="true">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="m4 7 8 6 8-6" />
                </svg>
              </span>
              <input
                id="sub-email"
                placeholder="fkornelind@gmail.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="sub-price">Price</label>
            <input
              id="sub-price"
              placeholder="$ 25"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="sub-interval">Billing interval</label>
            <select
              id="sub-interval"
              value={interval}
              onChange={(e) => onInterval(e.target.value as BillingInterval)}
            >
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="sub-renews">Expiration / renewal</label>
            <div className="icon-field">
              <input
                id="sub-renews"
                readOnly
                placeholder="Pick a date"
                value={renewsAt ? formatPretty(renewsAt) : ""}
                onChange={(e) => onRenewInput(e.target.value)}
                onClick={toggleCalendar}
              />
              <button
                type="button"
                className="field-trail"
                aria-label="Open calendar"
                onClick={toggleCalendar}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="3" y="5" width="18" height="16" rx="2" />
                  <path d="M3 10h18M8 3v4M16 3v4" />
                </svg>
              </button>
            </div>
          </div>

          <div className="field">
            <label htmlFor="sub-status">Status</label>
            <div className={`status-field status-${status}`}>
              <span className="status-dot" aria-hidden="true" />
              <select
                id="sub-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as SubscriptionStatus)}
              >
                {STATUS_OPTIONS.map(([value, name]) => (
                  <option key={value} value={value}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {calOpen && (
            <RenewalCalendar
              view={view}
              selected={renewsAt}
              onView={setView}
              onPick={(iso) => {
                chooseDate(iso);
                setCalOpen(false);
              }}
            />
          )}

          <div className={`remind-block ${calOpen ? "" : "sub-span"}`}>
            <h3>Remind me</h3>
            <div className="remind-row">
              <div className="field">
                <label htmlFor="sub-remind">Reminder time</label>
                <select id="sub-remind" value={remind} onChange={(e) => setRemind(e.target.value)}>
                  <option value="1">1 day before</option>
                  <option value="2">2 days before</option>
                  <option value="3">3 days before</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              <div className="warn-toggle">
                <span>Turn on warning</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={warn}
                  aria-label="Turn on warning"
                  className={`switch ${warn ? "on" : ""}`}
                  onClick={() => setWarn((on) => !on)}
                />
              </div>
            </div>
            {remind === "custom" && (
              <div className="field">
                <label htmlFor="sub-custom">Custom days before</label>
                <input
                  id="sub-custom"
                  inputMode="numeric"
                  value={customDays}
                  onChange={(e) => setCustomDays(e.target.value)}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <footer>
        <span className="spacer" />
        <button type="button" className="sub-cancel" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          aria-label="Save subscription"
          onClick={save}
          disabled={busy || !plan.trim()}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </footer>
    </Modal>
  );
}

function RenewalCalendar({
  view,
  selected,
  onView,
  onPick,
}: {
  view: { y: number; m: number };
  selected: string;
  onView: (next: { y: number; m: number }) => void;
  onPick: (iso: string) => void;
}) {
  const firstWeekday = new Date(Date.UTC(view.y, view.m - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(view.y, view.m, 0)).getUTCDate();
  const cells: Array<number | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];
  const picked = parseIso(selected);

  function shift(delta: number) {
    const date = new Date(Date.UTC(view.y, view.m - 1 + delta, 1));
    onView({ y: date.getUTCFullYear(), m: date.getUTCMonth() + 1 });
  }

  return (
    <div className="renew-cal" aria-label="Expiration calendar">
      <div className="renew-cal-head">
        <button type="button" aria-label="Previous month" onClick={() => shift(-1)}>
          ‹
        </button>
        <strong>
          {MONTHS[view.m - 1]} {view.y}
        </strong>
        <button type="button" aria-label="Next month" onClick={() => shift(1)}>
          ›
        </button>
      </div>
      <div className="renew-cal-grid">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
          <span key={day} className="renew-dow">
            {day}
          </span>
        ))}
        {cells.map((day, index) =>
          day === null ? (
            <span key={`pad-${index}`} />
          ) : (
            <button
              key={day}
              type="button"
              className={
                picked && picked.y === view.y && picked.m === view.m && picked.d === day
                  ? "picked"
                  : ""
              }
              onClick={() => onPick(toIso(view.y, view.m, day))}
            >
              {day}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
