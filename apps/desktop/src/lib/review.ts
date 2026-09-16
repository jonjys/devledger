// Pure helpers behind the review sheet.
//
// The sheet's state is a map of per-entity choices; turning that into a
// `ReviewSubmission` is plain data transformation, so it lives here where it
// can be tested without rendering anything.

import type {
  DetectedEntity,
  EntityDecision,
  ExistingMatch,
  PasteAnalysis,
  RecommendedAction,
  ReviewSubmission,
} from "./types";

/** The three buttons on each row, plus the implicit "leave it out". */
export type Choice = "save" | "change" | "create_new" | "skip";

/** What the sheet tracks per entity. */
export interface EntityChoice {
  choice: Choice;
  /** Set when `choice` is `change`: which existing secret to overwrite. */
  targetSecretId: string | null;
  /** Set when the user renamed the variable. */
  nameOverride: string | null;
}

/** Entities the user can actually decide about: the ones carrying a value. */
export function isActionable(entity: DetectedEntity): boolean {
  return entity.kind === "secret";
}

/**
 * The choice a row starts on.
 *
 * It mirrors the backend's recommendation so that pressing Save without
 * touching anything does exactly what the sheet says it will.
 */
export function defaultChoice(recommendation: RecommendedAction | undefined): Choice {
  if (!recommendation) return "skip";
  switch (recommendation.sort) {
    case "create":
      return "save";
    case "update":
      return "save";
    case "skip":
      return "skip";
  }
}

/** Build the initial state for a freshly opened sheet. */
export function initialChoices(analysis: PasteAnalysis): Record<number, EntityChoice> {
  const state: Record<number, EntityChoice> = {};
  for (const entity of analysis.entities) {
    if (!isActionable(entity)) continue;
    state[entity.index] = {
      choice: defaultChoice(analysis.recommendations[entity.index]),
      targetSecretId: null,
      nameOverride: null,
    };
  }
  return state;
}

/** Plain-language summary of what Save will do to one row. */
export function describeChoice(
  choice: Choice,
  recommendation: RecommendedAction | undefined,
): string {
  switch (choice) {
    case "skip":
      return recommendation?.sort === "skip"
        ? recommendation.reason
        : "Will not be saved";
    case "create_new":
      return "Will be stored as a new secret";
    case "change":
      return "Will overwrite the secret you pick";
    case "save":
      if (recommendation?.sort === "update") return "Will replace the existing value";
      if (recommendation?.sort === "skip") return recommendation.reason;
      return "Will be stored as a new secret";
  }
}

function toDecision(entry: EntityChoice): EntityDecision {
  switch (entry.choice) {
    case "save":
      return { sort: "accept" };
    case "create_new":
      return { sort: "create_new" };
    case "skip":
      return { sort: "skip" };
    case "change":
      // Falling back to `accept` keeps the submission well-formed if the user
      // picked "Change" but never chose a target.
      return entry.targetSecretId
        ? { sort: "change", secret_id: entry.targetSecretId }
        : { sort: "accept" };
  }
}

/** Assemble the payload sent to `smart_paste_commit`. */
export function buildSubmission(
  analysis: PasteAnalysis,
  choices: Record<number, EntityChoice>,
  acceptedRelations: Set<number>,
  acknowledgeCritical: boolean,
  targetProjectId: string | null,
): ReviewSubmission {
  return {
    analysis_id: analysis.analysis_id,
    decisions: Object.entries(choices).map(([index, entry]) => ({
      entity_index: Number(index),
      decision: toDecision(entry),
      name_override: entry.nameOverride,
    })),
    accepted_relations: [...acceptedRelations].sort((a, b) => a - b),
    acknowledge_critical: acknowledgeCritical,
    target_project_id: targetProjectId,
  };
}

/** Matches that concern one entity. */
export function matchesFor(analysis: PasteAnalysis, entityIndex: number): ExistingMatch[] {
  return analysis.matches.filter((m) => m.entity_index === entityIndex);
}

/** Relations ticked when the sheet opens. */
export function initialRelations(analysis: PasteAnalysis): Set<number> {
  return new Set(
    analysis.proposed_relations.filter((r) => r.selected_by_default).map((r) => r.index),
  );
}

/** How many secrets Save would actually write. */
export function countToSave(choices: Record<number, EntityChoice>): number {
  return Object.values(choices).filter((c) => c.choice !== "skip").length;
}
