import { useCallback, useEffect, useState } from "react";

import * as api from "../lib/api";
import { plural, providerLabel } from "../lib/format";
import {
  BOX_CATALOG,
  LIMITS,
  move,
  newBoxId,
  type Box,
  type BoxKind,
  type Layout,
} from "../lib/layout";
import { Markdown } from "../lib/markdown";
import {
  dominantCurrency,
  formatMoney,
  monthlyCents,
  monthlyTotalCents,
  relativeTime,
  trialsFrom,
  type Trial,
} from "../lib/overview";
import type {
  AttentionItem,
  AuditEntry,
  IdentityNode,
  ProjectSummary,
  SecretListing,
  SubscriptionSummary,
} from "../lib/types";
import type { WordKind } from "./AddAnythingDialog";
import ProviderIcon from "./ProviderIcon";

interface Props {
  layout: Layout;
  onLayout: (next: Layout) => void;
  onOpenLayoutPanel: () => void;
  onNotify: (message: string, bad?: boolean) => void;
  onNavigate: (view: string) => void;
  onOpenProject?: (id: string) => void;
  onChanged: () => void;
  refreshKey: number;
  /** Open "Add anything" with a kind already chosen. */
  onAdd?: (kind: WordKind) => void;
}

interface Data {
  projects: ProjectSummary[];
  identities: IdentityNode[];
  subs: SubscriptionSummary[];
  audit: AuditEntry[];
  attention: AttentionItem[];
  secrets: SecretListing[];
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

const catalogName = (kind: BoxKind) => BOX_CATALOG.find((c) => c.kind === kind)?.name ?? kind;

/**
 * Home: a page of boxes the user arranges. Each box is one view of the ledger
 * (projects, trials, spend...) or a note they write themselves. "Edit layout"
 * turns on moving, renaming, resizing and removing boxes; templates and the
 * menu order live in the layout panel.
 */
export default function HomeView({
  layout,
  onLayout,
  onOpenLayoutPanel,
  onNotify,
  onNavigate,
  onOpenProject,
  onChanged,
  refreshKey,
  onAdd,
}: Props) {
  const [data, setData] = useState<Data | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);

  const kinds = new Set(layout.boxes.map((b) => b.kind));
  const needs = (k: BoxKind[]) => k.some((x) => kinds.has(x));
  const wantAudit = needs(["activity"]);
  const wantAttention = needs(["attention"]);
  const wantSecrets = needs(["secrets"]);

  const load = useCallback(async () => {
    try {
      const [projects, identities, subs, audit, attention, secrets] = await Promise.all([
        api.listProjects(),
        api.identityGraph(),
        api.listSubscriptions(),
        // Fetch extra: DevLedger's own bookkeeping is dropped below.
        wantAudit ? api.recentAudit(40) : Promise.resolve([] as AuditEntry[]),
        wantAttention ? api.needsAttention() : Promise.resolve([] as AttentionItem[]),
        wantSecrets ? api.listAllSecrets() : Promise.resolve([] as SecretListing[]),
      ]);
      setData({
        projects,
        identities,
        subs,
        // The Ledger map saves where each ball sits in a hidden field whenever
        // one is moved. That is housekeeping, not something the user did.
        audit: audit.filter((e) => !/\bfield _/.test(e.detail)).slice(0, 8),
        attention,
        secrets,
      });
    } catch (e: unknown) {
      onNotify(e instanceof Error ? e.message : String(e), true);
    }
  }, [onNotify, wantAudit, wantAttention, wantSecrets]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const setBoxes = (boxes: Box[]) => onLayout({ ...layout, boxes });
  const update = (id: string, patch: Partial<Box>) =>
    setBoxes(layout.boxes.map((b) => (b.id === id ? { ...b, ...patch } : b)));

  function addBox(kind: BoxKind) {
    if (layout.boxes.length >= LIMITS.boxes) {
      onNotify(`A home page holds up to ${LIMITS.boxes} boxes.`, true);
      return;
    }
    const b: Box = { id: newBoxId(), kind, ...(kind === "note" ? { title: "Note", text: "" } : {}) };
    setBoxes([...layout.boxes, b]);
    setAdding(false);
  }

  async function cancelTrial(t: Trial) {
    const plan = t.summary.subscription.plan;
    if (!window.confirm(`Remove "${plan}" from your ledger? This does not cancel it with the provider.`)) {
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

  if (!data) return <div className="empty">Loading…</div>;

  const fresh = data.projects.length === 0 && data.identities.length === 0;

  return (
    <div className="dash home">
      <div className="dash-head">
        <div>
          <h1>Home</h1>
          <div className="dash-date">{TODAY()}</div>
        </div>
        <div className="home-acts">
          <button type="button" className="outline tiny" onClick={onOpenLayoutPanel}>
            Templates & menu
          </button>
          <button
            type="button"
            className={editing ? "primary tiny" : "outline tiny"}
            aria-pressed={editing}
            onClick={() => {
              setEditing((e) => !e);
              setAdding(false);
            }}
          >
            {editing ? "Done" : "Edit layout"}
          </button>
        </div>
      </div>

      {fresh && (
        <section className="card get-started" aria-label="Get started">
          <div className="card-title">Get started — by hand, no token needed</div>
          <p className="muted">
            DevLedger works with any service, not only the ones it can connect to. Start with what you know;
            everything can be corrected later.
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
        </section>
      )}

      {editing && (
        <p className="home-hint">
          Move boxes with the arrows, rename them, make them wide or remove them. Notes are yours to write in.
        </p>
      )}

      <div className="home-grid">
        {layout.boxes.map((b, i) => (
          <section
            key={b.id}
            className={`card home-box box-${b.kind}${b.wide ? " wide" : ""}${editing ? " editing" : ""}`}
            aria-label={b.title || catalogName(b.kind)}
          >
            {editing ? (
              <div className="box-bar">
                <input
                  className="box-title-input"
                  aria-label="Box title"
                  value={b.title ?? ""}
                  placeholder={catalogName(b.kind)}
                  maxLength={LIMITS.title}
                  onChange={(e) => update(b.id, { title: e.target.value })}
                />
                <div className="box-tools">
                  <button type="button" className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => setBoxes(move(layout.boxes, i, -1))}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Move down"
                    disabled={i === layout.boxes.length - 1}
                    onClick={() => setBoxes(move(layout.boxes, i, 1))}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={b.wide ? "Make narrow" : "Make wide"}
                    aria-pressed={!!b.wide}
                    title={b.wide ? "Half width" : "Full width"}
                    onClick={() => update(b.id, { wide: !b.wide })}
                  >
                    {b.wide ? "⇥" : "⇔"}
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    aria-label="Remove box"
                    onClick={() => setBoxes(layout.boxes.filter((x) => x.id !== b.id))}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ) : (
              b.kind !== "stats" && <div className="card-title">{b.title || catalogName(b.kind)}</div>
            )}
            <BoxBody
              box={b}
              data={data}
              editing={editing}
              onText={(text) => update(b.id, { text })}
              onNavigate={onNavigate}
              onOpenProject={onOpenProject}
              onCancelTrial={cancelTrial}
            />
          </section>
        ))}

        {editing &&
          (adding ? (
            <section className="card home-box wide add-catalog" aria-label="Add a box">
              <div className="card-title">Add a box</div>
              <div className="catalog-list">
                {BOX_CATALOG.map((c) => (
                  <button key={c.kind} type="button" className="catalog-item" onClick={() => addBox(c.kind)}>
                    <strong>{c.name}</strong>
                    <span>{c.summary}</span>
                  </button>
                ))}
              </div>
              <button type="button" className="link-btn" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </section>
          ) : (
            <button type="button" className="home-add" onClick={() => setAdding(true)}>
              + Add a box
            </button>
          ))}
      </div>

      {layout.boxes.length === 0 && !editing && (
        <p className="muted-p">
          Your home page is empty. <button type="button" className="link-btn" onClick={() => setEditing(true)}>Add a box</button>{" "}
          or <button type="button" className="link-btn" onClick={onOpenLayoutPanel}>pick a template</button>.
        </p>
      )}
    </div>
  );
}

interface BodyProps {
  box: Box;
  data: Data;
  editing: boolean;
  onText: (text: string) => void;
  onNavigate: (view: string) => void;
  onOpenProject?: (id: string) => void;
  onCancelTrial: (t: Trial) => void;
}

function BoxBody({ box, data, editing, onText, onNavigate, onOpenProject, onCancelTrial }: BodyProps) {
  const trials = trialsFrom(data.subs);
  const currency = dominantCurrency(data.subs);
  const monthly = monthlyTotalCents(data.subs);

  switch (box.kind) {
    case "note":
      return <NoteBody text={box.text ?? ""} forceEdit={editing} onText={onText} />;

    case "stats":
      return (
        <div className="stat-row">
          <button type="button" className="stat" onClick={() => onNavigate("projects")}>
            <div className="stat-num">{data.projects.length}</div>
            <div className="stat-label">Projects</div>
          </button>
          <button type="button" className="stat" onClick={() => onNavigate("ledger")}>
            <div className="stat-num">{data.identities.length}</div>
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
      );

    case "projects":
      return data.projects.length === 0 ? (
        <p className="muted-p">No projects yet.</p>
      ) : (
        <div className="home-projects">
          {data.projects.map((p) => (
            <button
              key={p.project.id}
              type="button"
              className="home-project"
              onClick={() => (onOpenProject ? onOpenProject(p.project.id) : onNavigate("projects"))}
            >
              <span className="home-project-name">{p.project.name}</span>
              <span className="home-project-icons">
                {p.providers.slice(0, 5).map((prov) => (
                  <ProviderIcon key={prov} provider={prov} name={providerLabel(prov)} size={14} />
                ))}
              </span>
              <span className="muted">
                {plural(p.service_project_count, "resource")} · {plural(p.secret_count, "secret")}
              </span>
            </button>
          ))}
        </div>
      );

    case "trials":
      return trials.length === 0 ? (
        <p className="muted-p">No trials about to turn into a bill.</p>
      ) : (
        <>
          {trials.map((t) => {
            const sub = t.summary.subscription;
            const left =
              t.daysLeft === null ? "" : t.daysLeft <= 0 ? " — due now" : ` — ${plural(t.daysLeft, "day")} left`;
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
                    <button type="button" className="outline tiny" onClick={() => onCancelTrial(t)}>
                      Remove from ledger
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </>
      );

    case "costs": {
      const rows = data.subs.filter((s) => monthlyCents(s) > 0 || s.subscription.status === "trialing");
      return rows.length === 0 ? (
        <p className="muted-p">No subscriptions recorded.</p>
      ) : (
        <>
          {rows.map((s) => (
            <div key={s.subscription.id} className="spend-row">
              <div>
                <span className="spend-name">{s.subscription.plan}</span>
                {s.subscription.status === "trialing" && <span className="tag heuristic">trial</span>}
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
      );
    }

    case "attention":
      return data.attention.length === 0 ? (
        <p className="muted-p">Nothing needs attention.</p>
      ) : (
        <>
          {data.attention.slice(0, 6).map((a, i) => (
            <div key={i} className="act-row">
              <span className="act-dot attention" />
              <div className="act-body">
                <div className="act-title">{a.title}</div>
                <div className="act-meta">{a.detail}</div>
              </div>
            </div>
          ))}
          <button type="button" className="link-btn" onClick={() => onNavigate("attention")}>
            See all {data.attention.length}
          </button>
        </>
      );

    case "activity":
      return data.audit.length === 0 ? (
        <p className="muted-p">Nothing yet.</p>
      ) : (
        <>
          {data.audit.map((e) => (
            <div key={e.seq} className="act-row">
              <span className={`act-dot ${e.action.split(".")[0]}`} />
              <div className="act-body">
                <div className="act-title">{e.detail}</div>
                <div className="act-meta">
                  {e.action.replace(/\./g, " · ")} · {relativeTime(e.at)}
                </div>
              </div>
            </div>
          ))}
        </>
      );

    case "secrets":
      return data.secrets.length === 0 ? (
        <p className="muted-p">No keys yet. You don't need any to use the map.</p>
      ) : (
        <>
          <ul className="home-keys">
            {data.secrets.slice(0, 8).map(({ entry, owner }) => (
              <li key={entry.secret.id}>
                <code>{entry.secret.name}</code>
                <span className="muted"> {owner}</span>
              </li>
            ))}
          </ul>
          <button type="button" className="link-btn" onClick={() => onNavigate("secrets")}>
            All {plural(data.secrets.length, "key")}
          </button>
        </>
      );

    case "assistant":
      return (
        <div className="home-ai">
          <p className="muted-p">Spot risks, gaps and money to save. It reads names, never key values.</p>
          <button type="button" className="primary tiny" onClick={() => onNavigate("assistant")}>
            Review my setup
          </button>
        </div>
      );
  }
}

/** A note: Markdown to read, a text area to write. Tap the text to edit it. */
function NoteBody({ text, forceEdit, onText }: { text: string; forceEdit: boolean; onText: (t: string) => void }) {
  const [writing, setWriting] = useState(false);
  const open = writing || forceEdit || text.trim() === "";
  if (open) {
    return (
      <textarea
        className="note-input"
        aria-label="Note text"
        value={text}
        maxLength={LIMITS.text}
        placeholder="Write anything: a checklist, links, what to do next. - starts a list, **bold** works."
        onChange={(e) => onText(e.target.value)}
        // While it has focus it stays a text area, even once it is no longer empty.
        onFocus={() => setWriting(true)}
        onBlur={() => setWriting(false)}
        rows={Math.min(12, Math.max(3, text.split("\n").length + 1))}
      />
    );
  }
  return (
    <div
      className="note-view"
      role="button"
      tabIndex={0}
      title="Tap to edit"
      onClick={() => setWriting(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") setWriting(true);
      }}
    >
      <Markdown source={text} />
    </div>
  );
}
