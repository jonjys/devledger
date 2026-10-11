import { useEffect, useMemo, useState } from "react";

import { costsByCurrency, currencyAffix, money, monthProgress, spentSoFar, type CurrencyCosts } from "../lib/costs";
import type { SubscriptionSummary } from "../lib/types";

/** The clock the counter runs on: fast enough to watch, slower if the system asks for less motion. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const calm =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const id = window.setInterval(() => setNow(new Date()), calm ? 1000 : 80);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** The running total: whole cents large, the next four digits small so the number visibly moves. */
function Ticker({ cents, currency }: { cents: number; currency: string }) {
  const { prefix, suffix } = currencyAffix(currency);
  const units = cents / 100;
  const whole = Math.floor(units * 100) / 100;
  const tail = String(Math.floor(units * 1_000_000) % 10_000).padStart(4, "0");
  const shown = whole.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <div className="costs-hero-num" aria-label={money(cents, currency)}>
      {prefix}
      {shown}
      <span className="costs-tail" aria-hidden="true">
        {tail}
      </span>
      {suffix}
    </div>
  );
}

function Bars({ row }: { row: CurrencyCosts }) {
  const max = row.services[0]?.monthlyCents ?? 0;
  if (!row.services.length) return null;
  return (
    <section className="card costs-bars">
      <h3>Per service, per month</h3>
      <ul>
        {row.services.map((s) => (
          <li key={s.label} title={`${s.label}: ${s.plans.join(", ")}`}>
            <span className="costs-bar-name">{s.label}</span>
            <span className="costs-bar-track">
              <span
                className="costs-bar"
                style={{ width: `${max ? Math.max(2, (s.monthlyCents / max) * 100) : 0}%` }}
              />
            </span>
            <span className="costs-bar-value">{money(s.monthlyCents, row.currency)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Tiles({ row }: { row: CurrencyCosts }) {
  return (
    <div className="stat-row costs-tiles">
      <div className="stat">
        <span className="stat-label">Per month</span>
        <span className="stat-num">{money(row.monthlyCents, row.currency)}</span>
      </div>
      <div className="stat">
        <span className="stat-label">Per year</span>
        <span className="stat-num">{money(row.monthlyCents * 12, row.currency)}</span>
      </div>
      <div className="stat">
        <span className="stat-label">After trials end</span>
        <span className="stat-num">{money(row.afterTrialsCents, row.currency)}</span>
        <span className="stat-label">
          {row.trialing
            ? `${row.trialing} priced trial${row.trialing === 1 ? "" : "s"} included`
            : "Same as now"}
        </span>
      </div>
      <div className="stat">
        <span className="stat-label">Paying for</span>
        <span className="stat-num">{row.paying}</span>
        <span className="stat-label">subscription{row.paying === 1 ? "" : "s"}</span>
      </div>
    </div>
  );
}

/**
 * What it all costs, as it adds up. The big number is this month's spend so
 * far: the monthly total times the share of the month that has passed, so it
 * ticks upward while you watch.
 */
export default function CostsPanel({ rows }: { rows: SubscriptionSummary[] }) {
  const now = useNow();
  const totals = useMemo(() => costsByCurrency(rows), [rows]);
  const progress = monthProgress(now);
  const month = now.toLocaleDateString("en", { month: "long" });

  if (!totals.length) {
    return (
      <div className="empty">
        <p style={{ margin: 0, fontWeight: 600 }}>Nothing to add up yet</p>
        <p style={{ marginBottom: 0 }}>Record a subscription with a price and it is counted here.</p>
      </div>
    );
  }

  const [lead, ...rest] = totals as [CurrencyCosts, ...CurrencyCosts[]];
  const perHour = lead.monthlyCents / (progress.ms / 3_600_000);
  return (
    <div className="costs">
      <section className="card costs-hero">
        <div className="stat-label">
          Spent so far in {month}
          {lead.currency ? ` · ${lead.currency}` : ""}
        </div>
        <Ticker cents={spentSoFar(lead.monthlyCents, now)} currency={lead.currency} />
        <div className="costs-rate">
          +{money(perHour, lead.currency)} per hour · {money(perHour * 24, lead.currency)} per day
        </div>
        <div
          className="costs-month"
          role="meter"
          aria-label="Month gone"
          aria-valuemin={0}
          aria-valuemax={progress.days}
          aria-valuenow={progress.day}
        >
          <span style={{ width: `${progress.elapsed * 100}%` }} />
        </div>
        <div className="stat-label">
          Day {progress.day} of {progress.days}
        </div>
      </section>

      <Tiles row={lead} />
      <Bars row={lead} />

      {rest.map((row) => (
        <section key={row.currency || "none"} className="costs-other">
          <h3>Also paid in {row.currency || "an unnamed currency"}</h3>
          <Tiles row={row} />
          <Bars row={row} />
        </section>
      ))}

      <p className="note">
        Estimated from the plans you recorded, not from your bank: yearly plans are spread over twelve
        months, trials count once they end, and different currencies are kept apart rather than
        converted.
      </p>
    </div>
  );
}
