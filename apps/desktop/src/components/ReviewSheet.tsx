import { useMemo, useState } from "react";

import { secretKindLabel } from "../lib/format";
import {
  buildSubmission,
  countToSave,
  describeChoice,
  initialAnswers,
  initialChoices,
  initialRelations,
  isActionable,
  matchesFor,
  targetProjectLabel,
  unansweredRequired,
  type AnswerState,
  type Choice,
  type EntityChoice,
} from "../lib/review";
import type {
  ChainNode,
  DetectedEntity,
  OpenQuestion,
  PasteAnalysis,
  ProposedEndpoint,
  ReviewSubmission,
} from "../lib/types";
import { CHAIN_ROLE_LABEL, RELATION_VERB } from "../lib/types";

interface Props {
  analysis: PasteAnalysis;
  onCancel: () => void;
  onSave: (submission: ReviewSubmission) => void;
  saving: boolean;
  /** The project the paste was made in, if it was made inside one. */
  targetProjectId?: string | null;
}

function endpointLabel(endpoint: ProposedEndpoint): string {
  if (endpoint.sort === "existing") return endpoint.label;
  if (endpoint.sort === "chain") {
    return `${endpoint.label} (${CHAIN_ROLE_LABEL[endpoint.role].toLowerCase()})`;
  }
  return `${endpoint.label} (new)`;
}

/**
 * The review sheet.
 *
 * Nothing in a paste is written until this is submitted. It shows, in order:
 * the findings, each detected entity with its evidence and any existing match,
 * the proposed relations, and the redacted provenance excerpt that will be
 * stored alongside whatever is saved.
 */
export default function ReviewSheet({
  analysis,
  onCancel,
  onSave,
  saving,
  targetProjectId = null,
}: Props) {
  const [choices, setChoices] = useState<Record<number, EntityChoice>>(() =>
    initialChoices(analysis),
  );
  const [relations, setRelations] = useState<Set<number>>(() => initialRelations(analysis));
  const [answers, setAnswers] = useState<Record<string, AnswerState>>(() =>
    initialAnswers(analysis, targetProjectId),
  );
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
  const missing = unansweredRequired(analysis, answers);
  const blocked = (analysis.blocks_save && !acknowledged) || missing.length > 0;

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

  function setAnswer(questionId: string, next: Partial<AnswerState>) {
    setAnswers((prev) => {
      const existing = prev[questionId] ?? { selection: "unknown", freeText: "" };
      return { ...prev, [questionId]: { ...existing, ...next } };
    });
  }

  function save() {
    onSave(
      buildSubmission(analysis, choices, relations, acknowledged, targetProjectId, answers),
    );
  }

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Review paste"
      onClick={onCancel}
    >
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Review what DevLedger found</h2>
          <p>
            {analysis.chain.project
              ? `${analysis.chain.project.label} · nothing is saved until you choose.`
              : "Nothing is saved until you choose."}
          </p>
        </header>

        <div className="scroll">
          <ChainSummary analysis={analysis} pastedInto={targetProjectLabel(analysis, targetProjectId)} />

          {analysis.questions.length > 0 && (
            <section className="section">
              <h3>Confirm</h3>
              {analysis.questions.map((question) => (
                <QuestionBlock
                  key={question.id}
                  question={question}
                  state={answers[question.id]}
                  onChange={(next) => setAnswer(question.id, next)}
                />
              ))}
            </section>
          )}

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
              <h3>To save</h3>
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
                      {endpointLabel(relation.from)}{" "}
                      <span className="verb">{RELATION_VERB[relation.kind]}</span>{" "}
                      {endpointLabel(relation.to)}{" "}
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
            disabled={blocked || saving}
            title={
              missing.length > 0
                ? `Answer: ${missing.map((q) => q.prompt).join(", ")}`
                : undefined
            }
          >
            {saving
              ? "Saving…"
              : missing.length > 0
                ? "Answer the questions above"
                : toSave === 0
                  ? "Save links only"
                  : `Save ${toSave}`}
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
        <span className="tag secret">
          {entity.kind === "env_var" ? "Variable" : secretKindLabel(entity.secret_kind)}
        </span>
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

/** The Identity → Account → Organization → Resource → Project chain. */
function ChainSummary({
  analysis,
  pastedInto,
}: {
  analysis: PasteAnalysis;
  pastedInto: string | null;
}) {
  const rungs: [string, ChainNode | null][] = [
    ["identity", analysis.chain.identity],
    ["account", analysis.chain.account],
    ["organization", analysis.chain.organization],
    ["service_project", analysis.chain.service_project],
    ["project", analysis.chain.project],
  ];
  if (rungs.every(([, node]) => node === null)) return null;

  return (
    <section className="section">
      <h3>How this fits together</h3>
      <div className="chain">
        {rungs.map(([role, node]) => (
          <div key={role} className={`rung${node ? "" : " unknown"}`}>
            <span className="role">{CHAIN_ROLE_LABEL[role as keyof typeof CHAIN_ROLE_LABEL]}</span>
            {node ? (
              <>
                <span className="val">{node.label}</span>
                <span className={`tag ${node.evidence.level}`}>{node.evidence.level}</span>
                <span className="why">{node.evidence.reason}</span>
              </>
            ) : role === "project" && pastedInto ? (
              <>
                <span className="val">{pastedInto}</span>
                <span className="why">You pasted it inside this project</span>
              </>
            ) : (
              <span className="val muted">not stated</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

interface QuestionProps {
  question: OpenQuestion;
  state: AnswerState | undefined;
  onChange: (next: Partial<AnswerState>) => void;
}

/**
 * One decision DevLedger will not take on its own.
 *
 * "I don't know" is a first-class answer: it stores the gap rather than a
 * guess, and the item shows up under Needs attention afterwards.
 */
function QuestionBlock({ question, state, onChange }: QuestionProps) {
  const selection = state?.selection ?? "unknown";
  return (
    <div className="question">
      <div className="q-prompt">
        {question.prompt}
        {question.required && <span className="req">required</span>}
      </div>
      <div className="q-options">
        {question.candidates.map((candidate, i) => (
          <button
            key={`${candidate.label}-${i}`}
            type="button"
            aria-pressed={selection === i}
            onClick={() => onChange({ selection: i })}
            title={candidate.reason}
          >
            {candidate.label}
            {candidate.existing && <span className="existing-dot" aria-hidden="true" />}
          </button>
        ))}
        {question.allow_free_text && (
          <button
            type="button"
            aria-pressed={selection === "free"}
            onClick={() => onChange({ selection: "free" })}
          >
            Something else…
          </button>
        )}
        {!question.required && (
          <button
            type="button"
            aria-pressed={selection === "unknown"}
            onClick={() => onChange({ selection: "unknown" })}
          >
            I don&apos;t know
          </button>
        )}
      </div>
      {selection === "free" && (
        <input
          className="q-free"
          autoFocus
          placeholder="Type a name"
          value={state?.freeText ?? ""}
          onChange={(e) => onChange({ freeText: e.target.value })}
          aria-label={question.prompt}
        />
      )}
      {selection === "unknown" && (
        <p className="q-note">
          Stored as unknown. It will appear under Needs attention so you can fill it in later.
        </p>
      )}
    </div>
  );
}
