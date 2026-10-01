import { useCallback, useEffect, useState } from "react";

import * as api from "../lib/api";
import { plural, providerLabel } from "../lib/format";
import {
  dominantCurrency,
  formatMoney,
  monthlyCents,
  monthlyTotalCents,
  relativeTime,
  trialsFrom,
  type Trial,
} from "../lib/overview";
import type { WordKind } from "./AddAnythingDialog";
import type { AuditEntry, IdentityNode, ProjectSummary, SubscriptionSummary } from "../lib/types";

interface Props {
  onNotify: (message: string, bad?: boolean) => void;
  onNavigate: (view: string) => void;
  onChanged: () => void;
  refreshKey: number;
  /** Open "Add anything" with a kind already chosen. */
  onAdd?: (kind: WordKind) => void;
}

function initials(label: string): string {
  const clean = label.replace(/^https?:\/\//, "").trim();
  return (clean[0] ?? "?").toUpperCase();
}

const TODAY = () =>
  new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

/** The landing dashboard: a glanceable summary of the whole ledger. */
export default function OverviewView({
  onNotify,
  onNavigate,
  onChanged,
  refreshKey,
  onAdd,
}: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [identities, setIdentities] = useState<IdentityNode[]>([]);
  const [subs, setSubs] = useState<SubscriptionSummary[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, g, s, a] = await Promise.all([
        api.listProjects(),
        api.identityGraph(),
        api.listSubscriptions(),
        // Fetch extra: DevLedger's own bookkeeping is dropped below.
        api.recentAudit(40),
      ]);
      setProjects(p);
      setIdentities(g);
      setSubs(s);
      // The Ledger map saves where each ball sits in a hidden field whenever one
      // is moved. That is housekeeping, not something the user did to their ledger.
      setAudit(a.filter((e) => !/\bfield _/.test(e.detail)).slice(0, 8));
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function cancelTrial(t: Trial) {
    const plan = t.summary.subscription.plan;
    if (
      !window.confirm(
        `Remove "${plan}" from your ledger? This does not cancel it with the provider.`,
      )
    ) {
      return;
    }
    try {
      await api.deleteSubscription(t.summary.subscription.id);
      onNotify(`Cancelled ${plan}`);
      await load();
      onChanged();
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }

  if (loading) return <div className="empty">Loading…</div>;

  const trials = trialsFrom(subs);
  const currency = dominantCurrency(subs);
  const monthly = monthlyTotalCents(subs);
  const spendRows = subs.filter((s) => monthlyCents(s) > 0 || s.subscription.status === "trialing");

  return (
    <div className="dash">
      <div className="dash-head">
        <h1>Overview</h1>
        <div className="dash-date">{TODAY()}</div>
      </div>

      {projects.length === 0 && identities.length === 0 && (
        <section className="card get-started" aria-label="Get started">
          <div className="card-title">Get started — by hand, no token needed</div>
          <p className="muted">
            DevLedger works with any service, not only the ones it can connect to. Start with
            what you know; everything can be corrected later.
          </p>
          <ol className="start-steps">
            <li>
              <button type="button" onClick={() => onAdd?.("email")}>
                Add your email address
              </button>
              <span className="muted">— every address you sign in with becomes part of you.</span>
            </li>
            <li>
              <button type="button" onClick={() => onAdd?.("service")}>
                Add an account
              </button>
              <span className="muted">— any service: hosting, a registrar, your bank, a forum.</span>
            </li>
            <li>
              <button type="button" onClick={() => onAdd?.("project")}>
                Add a project
              </button>
              <span className="muted">— then link what it uses, and add its variables.</span>
            </li>
          </ol>
          <p className="muted">
            Optional shortcuts: paste text into the bar above and DevLedger recognises what it
            can, or connect a provider under Connections to read its structure automatically.
          </p>
        </section>
      )}

      <div className="stat-row">
        <button type="button" className="stat" onClick={() => onNavigate("projects")}>
          <div className="stat-num">{projects.length}</div>
          <div className="stat-label">Projects</div>
        </button>
        <button type="button" className="stat" onClick={() => onNavigate("identities")}>
          <div className="stat-num">{identities.length}</div>
          <div className="stat-label">Identities</div>
        </button>
        <button type="button" className="stat" onClick={() => onNavigate("subscriptions")}>
          <div className="stat-num accent">{trials.length}</div>
          <div className="stat-label">Trials ending</div>
        </button>
        <button type="button" className="stat" onClick={() => onNavigate("subscriptions")}>
          <div className="stat-num accent">{formatMoney(monthly, currency)}</div>
          <div className="stat-label">Monthly spend</div>
        </button>
      </div>

      {trials.length > 0 && (
        <section className="card warn-card">
          <div className="card-title">⚠ Trials ending soon</div>
          {trials.map((t) => {
            const sub = t.summary.subscription;
            const left =
              t.daysLeft === null
                ? ""
                : t.daysLeft <= 0
                  ? " — due now"
                  : ` — ${plural(t.daysLeft, "day")} left`;
            return (
              <div key={sub.id} className="trial-row">
                <span className="avatar">{initials(t.summary.provider)}</span>
                <div className="trial-body">
                  <div className="trial-title">
                    {sub.plan} trial{sub.trial_ends_at ? ` ends ${sub.trial_ends_at}` : ""}
                    {left}
                  </div>
                  <div className="trial-sub">
                    {sub.amount_cents !== null
                      ? `Starts charging ${formatMoney(sub.amount_cents, sub.currency)}${
                          sub.interval ? `/${sub.interval === "monthly" ? "month" : "year"}` : ""
                        } · `
                      : ""}
                    Account: {t.summary.identity_email ?? t.summary.account_label}
                  </div>
                  <div className="trial-acts">
                    {/* "Set reminder" and "Keep" used to sit here. Neither did
                        anything but show a toast claiming it had -- there is no
                        reminder system -- so they are gone until one exists. */}
                    <button type="button" className="outline tiny" onClick={() => cancelTrial(t)}>
                      Remove from ledger
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section className="card">
        <div className="card-title">Recent activity</div>
        {audit.length === 0 ? (
          <p className="muted-p">Nothing yet. Paste something to get started.</p>
        ) : (
          audit.map((e) => (
            <div key={e.seq} className="act-row">
              <span className={`act-dot ${e.action.split(".")[0]}`} />
              <div className="act-body">
                <div className="act-title">{e.detail}</div>
                <div className="act-meta">
                  {e.action.replace(/\./g, " · ")} · {relativeTime(e.at)}
                </div>
              </div>
            </div>
          ))
        )}
      </section>

      <section className="card">
        <div className="card-title">
          Monthly spend <span className="muted">{plural(spendRows.length, "subscription")}</span>
        </div>
        {spendRows.length === 0 ? (
          <p className="muted-p">No subscriptions recorded.</p>
        ) : (
          <>
            {spendRows.map((s) => (
              <div key={s.subscription.id} className="spend-row">
                <div>
                  <span className="spend-name">{s.subscription.plan}</span>
                  {s.subscription.status === "trialing" && (
                    <span className="tag heuristic">trial</span>
                  )}
                  <div className="spend-sub">
                    {providerLabel(s.provider)} · {s.identity_email ?? s.account_label}
                  </div>
                </div>
                <div className="spend-amt">
                  {s.subscription.amount_cents !== null
                    ? formatMoney(s.subscription.amount_cents, s.subscription.currency)
                    : "—"}
                </div>
              </div>
            ))}
            <div className="spend-row total">
              <div className="spend-name">Total / month</div>
              <div className="spend-amt accent">{formatMoney(monthly, currency)}</div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
