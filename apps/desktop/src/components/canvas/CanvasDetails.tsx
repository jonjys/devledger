// The details panel for the selected ball.

import { type Ball } from "../../lib/canvas";
import { normalizeSecretKind, providerLabel } from "../../lib/format";
import type { Account, CustomField, SecretKind, SecretListing, ServiceProjectSummary } from "../../lib/types";
import { type AddKind } from "../CanvasParts";
import ProviderIcon from "../ProviderIcon";

import { kindLabel } from "./labels";

export function Details({
  ball,
  locked,
  owner,
  holder,
  account,
  secrets,
  fields,
  connected,
  inside,
  resourceOf,
  onClose,
  onPick,
  onCopySecret,
  onCopyText,
  onAdd,
  onOpenProject,
}: {
  ball: Ball;
  locked: boolean;
  owner: Ball | null;
  /** What an organization or a project in a service sits in. */
  holder: Ball | null;
  account: Account | null;
  secrets: SecretListing[];
  fields: CustomField[];
  connected: Ball[];
  /** The projects in a service or organization. */
  inside: Ball[];
  resourceOf: (id: string) => ServiceProjectSummary | undefined;
  onClose: () => void;
  onPick: (key: string) => void;
  onCopySecret: (s: SecretListing) => void;
  onCopyText: (label: string, text: string) => void;
  onAdd: (kind: AddKind) => void;
  onOpenProject?: () => void;
}) {
  const tone = (kind: string) => {
    const k = normalizeSecretKind(kind as SecretKind);
    if (k === "password") return "password";
    if (k === "env_var") return "plain";
    return "api";
  };
  const resource = ball.kind === "resource" ? resourceOf(ball.id)?.service_project : undefined;
  const holdsSecrets = ball.kind === "account" || ball.kind === "project" || ball.kind === "resource";
  const addButtons: [AddKind, string][] =
    ball.kind === "account"
      ? [["api", "+ API key"], ["password", "+ Password"], ["field", "+ Field"]]
      : ball.kind === "project"
        ? [["secret", "+ Variable"], ["field", "+ Field"]]
        : ball.kind === "resource"
          ? [["api", "+ API key"], ["secret", "+ Variable"], ["field", "+ Field"]]
          : [["field", "+ Field"]];
  const row = (term: string, value: string | null | undefined) =>
    value ? (
      <>
        <dt>{term}</dt>
        <dd>{value}</dd>
      </>
    ) : null;

  return (
    <aside className="st-info cv-details" aria-label="Details">
      <div className="st-info-head">
        {ball.provider && <ProviderIcon provider={ball.provider} name={ball.label} size={22} />}
        <div>
          <div className="st-info-kind">{kindLabel(ball)}</div>
          <div className="st-info-name" title={ball.label}>
            {ball.label}
          </div>
        </div>
        <span className="spacer" />
        <button type="button" className="ghost" aria-label="Close details" onClick={onClose}>
          ×
        </button>
      </div>

      <dl className="st-info-list">
        {ball.kind === "account" && row("Service", ball.provider ? providerLabel(ball.provider) : null)}
        {row("In", holder?.label)}
        {row("Email", owner?.label)}
        {row("Username", account?.username)}
        {row("Sign in at", account?.url)}
        {row("Region", resource?.region)}
        {row("Id", resource?.provider_ref)}
        {ball.kind === "email" && !ball.noEmail && row("Name", ball.sub)}
      </dl>

      {onOpenProject && (
        <button type="button" onClick={onOpenProject}>
          Open project
        </button>
      )}

      {(ball.kind === "account" || ball.kind === "org") && (
        <>
          <h4>Projects in {ball.label}</h4>
          {inside.length === 0 && (
            <p className="muted-p">
              None yet. {locked ? "" : `Drag from the dot on ${ball.label} to an empty spot to add one.`}
            </p>
          )}
          <div className="cv-cards">
            {inside.map((b) => {
              const r = resourceOf(b.id);
              const usedBy = r?.used_by.map((u) => u.name).join(", ");
              return (
                <button key={b.key} type="button" className="cv-card" onClick={() => onPick(b.key)}>
                  <strong>{b.label}</strong>
                  {r?.service_project.region && <small>{r.service_project.region}</small>}
                  <small className={usedBy ? "used" : undefined}>{usedBy ? `Used by ${usedBy}` : "Not in use"}</small>
                </button>
              );
            })}
          </div>
          {!locked && (
            <div className="st-info-actions">
              {ball.kind === "account" && (
                <button type="button" onClick={() => onAdd("org")}>
                  + Organization
                </button>
              )}
              <button type="button" onClick={() => onAdd("resource")}>
                + Project
              </button>
            </div>
          )}
        </>
      )}

      <h4>Connected to</h4>
      {connected.length === 0 && (
        <p className="muted-p">
          Nothing yet. Drag from the dot on this ball to{" "}
          {ball.kind === "project" ? "a service it runs on" : ball.kind === "account" ? "its email" : "another ball"}.
        </p>
      )}
      <div className="cv-connected">
        {connected.map((b) => (
          <button key={b.key} type="button" className="cv-chip" onClick={() => onPick(b.key)}>
            <span className="cv-chip-icon">
              {b.provider ? (
                <ProviderIcon provider={b.provider} name={b.label} size={16} />
              ) : (
                <span className={`cv-chip-glyph ${b.kind}`}>{b.kind === "email" ? "@" : "P"}</span>
              )}
            </span>
            <span className="cv-chip-text">
              <span>{b.label}</span>
              <small>{kindLabel(b)}</small>
            </span>
          </button>
        ))}
      </div>

      <h4>{ball.kind === "project" ? "Variables and fields" : holdsSecrets ? "Keys and fields" : "Fields"}</h4>
      {secrets.length === 0 && fields.length === 0 && <p className="muted-p">Nothing stored yet.</p>}
      {secrets.map((s) => (
        <div key={s.entry.secret.id} className={`st-info-field tone-${tone(s.entry.secret.kind)}`}>
          <span className="st-info-field-name">{s.entry.secret.name}</span>
          <span className="st-info-field-value mono">{s.entry.secret.preview}</span>
          <button type="button" onClick={() => onCopySecret(s)} aria-label={`Copy ${s.entry.secret.name}`}>
            Copy
          </button>
        </div>
      ))}
      {fields.map((f) => (
        <div key={f.id} className="st-info-field tone-plain">
          <span className="st-info-field-name">{f.label}</span>
          <span className="st-info-field-value">{f.value}</span>
          <button type="button" onClick={() => onCopyText(f.label, f.value)} aria-label={`Copy ${f.label}`}>
            Copy
          </button>
        </div>
      ))}
      {!locked && (
        <div className="st-info-actions">
          {addButtons.map(([kind, label]) => (
            <button key={kind} type="button" onClick={() => onAdd(kind)}>
              {label}
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
