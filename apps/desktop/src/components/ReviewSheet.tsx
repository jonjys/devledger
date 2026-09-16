import { useMemo, useState } from "react";

import { secretKindLabel } from "../lib/format";
import {
  buildSubmission,
  countToSave,
  describeChoice,
  initialChoices,
  initialRelations,
  isActionable,
  matchesFor,
  type Choice,
  type EntityChoice,
} from "../lib/review";
import type {
  DetectedEntity,
  PasteAnalysis,
  ProposedEndpoint,
  ReviewSubmission,
} from "../lib/types";

interface Props {
  analysis: PasteAnalysis;
  onCancel: () => void;
  onSave: (submission: ReviewSubmission) => void;
  saving: boolean;
}

function endpointLabel(endpoint: ProposedEndpoint): string {
  return endpoint.sort === "existing" ? endpoint.label : `${endpoint.label} (new)`;
}

/**
 * The review sheet.
 *
 * Nothing in a paste is written until this is submitted. It shows, in order:
 * the findings, each detected entity with its evidence and any existing match,
 * the proposed relations, and the redacted provenance excerpt that will be
 * stored alongside whatever is saved.
 */
export default function ReviewSheet({ analysis, onCancel, onSave, saving }: Props) {
  const [choices, setChoices] = useState<Record<number, EntityChoice>>(() =>
    initialChoices(analysis),
  );
  const [relations, setRelations] = useState<Set<number>>(() => initialRelations(analysis));
  const [acknowledged, setAcknowledged] = useState(false);

  const actionable = useMemo(
    () => analysis.entities.filter(isActionable),
    [analysis.entities],
  );
  const context = useMemo(
    () => analysis.entities.filter((e) => !isActionable(e)),
    [analysis.entities],
  );

  const toSave = countToSave(choices);
  const blocked = analysis.blocks_save && !acknowledged;

  function setChoice(index: number, choice: Choice) {
    setChoices((prev) => {
      const existing = prev[index];
      if (!existing) return prev;
      return { ...prev, [index]: { ...existing, choice } };
    });
  }

  function setTarget(index: number, secretId: string) {
    setChoices((prev) => {
      const existing = prev[index];
      if (!existing) return prev;
      return { ...prev, [index]: { ...existing, choice: "change", targetSecretId: secretId } };
    });
  }

  function toggleRelation(index: number) {
    setRelations((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function save() {
    onSave(
      buildSubmission(analysis, choices, relations, acknowledged, null),
    );
  }

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="Review paste">
      <div className="sheet">
        <header>
          <h2>Review what DevLedger found</h2>
          <p>
            {analysis.inferred_project_ref
              ? `Project ${analysis.inferred_project_ref} · nothing is saved until you choose.`
              : "Nothing is saved until you choose."}
          </p>
        </header>

        <div className="scroll">
          {analysis.warnings.length > 0 && (
            <section className="section">
              <h3>Findings</h3>
              {analysis.warnings.map((warning, i) => (
                <div key={`${warning.code}-${i}`} className={`finding ${warning.severity}`}>
                  <div className="t">{warning.title}</div>
                  <div className="d">{warning.detail}</div>
                </div>
              ))}
            </section>
          )}

          {actionable.length > 0 && (
            <section className="section">
              <h3>Detected credentials</h3>
              {actionable.map((entity) => (
                <EntityRow
                  key={entity.index}
                  entity={entity}
                  analysis={analysis}
                  choice={choices[entity.index]}
                  onChoice={(c) => setChoice(entity.index, c)}
                  onTarget={(id) => setTarget(entity.index, id)}
                />
              ))}
            </section>
          )}

          {context.length > 0 && (
            <section className="section">
              <h3>Also detected</h3>
              {context.map((entity) => (
                <div key={entity.index} className="entity">
                  <div className="head">
                    <span className="label">{entity.label}</span>
                    <span className="value">{entity.value_preview}</span>
                    <span className={`tag ${entity.evidence.level}`}>
                      {entity.evidence.level}
                    </span>
                  </div>
                  <div className="why">{entity.evidence.reason}</div>
                </div>
              ))}
            </section>
          )}

          {analysis.proposed_relations.length > 0 && (
            <section className="section">
              <h3>Proposed relations</h3>
              {analysis.proposed_relations.map((relation) => (
                <label key={relation.index} className="relation">
                  <input
                    type="checkbox"
                    checked={relations.has(relation.index)}
                    onChange={() => toggleRelation(relation.index)}
                  />
                  <span className="txt">
                    <span className="r">
                      {endpointLabel(relation.from)} → {endpointLabel(relation.to)}{" "}
                      <span className={`tag ${relation.evidence.level}`}>
                        {relation.evidence.level}
                      </span>
                    </span>
                    <span className="e">{relation.evidence.reason}</span>
                  </span>
                </label>
              ))}
            </section>
          )}

          {analysis.subscription && (
            <section className="section">
              <h3>Subscription</h3>
              <div className="entity">
                <div className="head">
                  <span className="label">{analysis.subscription.plan}</span>
                  <span className="value">{analysis.subscription.status}</span>
                  {analysis.subscription.amount_cents !== null && (
                    <span className="value">
                      {(analysis.subscription.amount_cents / 100).toFixed(2)}{" "}
                      {analysis.subscription.currency}
                      {analysis.subscription.interval
                        ? ` / ${analysis.subscription.interval === "monthly" ? "month" : "year"}`
                        : ""}
                    </span>
                  )}
                </div>
              </div>
            </section>
          )}

          <section className="section">
            <h3>Stored provenance (redacted)</h3>
            <div className="excerpt">{analysis.provenance.redacted_excerpt}</div>
          </section>
        </div>

        <footer>
          {analysis.blocks_save && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              I understand the risk above
            </label>
          )}
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={save}
            disabled={blocked || saving || toSave === 0}
          >
            {saving ? "Saving…" : toSave === 0 ? "Nothing selected" : `Save ${toSave}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface RowProps {
  entity: DetectedEntity;
  analysis: PasteAnalysis;
  choice: EntityChoice | undefined;
  onChoice: (choice: Choice) => void;
  onTarget: (secretId: string) => void;
}

function EntityRow({ entity, analysis, choice, onChoice, onTarget }: RowProps) {
  const matches = matchesFor(analysis, entity.index);
  const recommendation = analysis.recommendations[entity.index];
  const current = choice?.choice ?? "skip";
  const unsafe = entity.secret_kind !== null && entity.secret_kind !== "supabase_anon_key";

  return (
    <div className={`entity${current === "skip" ? " skipped" : ""}`}>
      <div className="head">
        <span className="label">{entity.label}</span>
        <span className="value">{entity.value_preview}</span>
        <span className="tag secret">{secretKindLabel(entity.secret_kind)}</span>
        {unsafe && <span className="tag unsafe">server only</span>}
        <span className={`tag ${entity.evidence.level}`}>{entity.evidence.level}</span>
      </div>

      <div className="why">{entity.evidence.reason}</div>

      {matches.map((match) => (
        <div key={`${match.matched.id}-${match.match_type}`} className="match">
          {match.label} — {match.detail}
        </div>
      ))}

      <div className="choices">
        <button type="button" aria-pressed={current === "save"} onClick={() => onChoice("save")}>
          Save
        </button>
        {matches.length > 0 && (
          <button
            type="button"
            aria-pressed={current === "change"}
            onClick={() => {
              const first = matches[0];
              if (first) onTarget(first.matched.id);
            }}
          >
            Change
          </button>
        )}
        <button
          type="button"
          aria-pressed={current === "create_new"}
          onClick={() => onChoice("create_new")}
        >
          Create new
        </button>
        <button
          type="button"
          aria-pressed={current === "skip"}
          onClick={() => onChoice("skip")}
        >
          Skip
        </button>
      </div>

      <div className="why">{describeChoice(current, recommendation)}</div>
    </div>
  );
}
