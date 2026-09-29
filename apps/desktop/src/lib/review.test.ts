import { describe, expect, it } from "vitest";

import { analysisFixture } from "../test/fixtures";
import {
  buildAnswers,
  buildSubmission,
  countToSave,
  defaultChoice,
  describeChoice,
  initialAnswers,
  initialChoices,
  initialRelations,
  isActionable,
  matchesFor,
  targetProjectLabel,
  unansweredRequired,
  type EntityChoice,
} from "./review";

describe("review sheet state", () => {
  it("only offers decisions for entities that carry a value", () => {
    const analysis = analysisFixture();
    const actionable = analysis.entities.filter(isActionable);
    // The URL is a plain .env line: stored as a variable, not a secret.
    expect(actionable.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(isActionable({ ...analysis.entities[0]!, kind: "email" })).toBe(false);
  });

  it("starts each row on the backend's recommendation", () => {
    const analysis = analysisFixture();
    const choices = initialChoices(analysis);
    expect(Object.keys(choices)).toEqual(["0", "1", "2"]);
    expect(choices[1]!.choice).toBe("save");
    expect(choices[2]!.choice).toBe("save");
  });

  it("starts a row on skip when the value is already stored", () => {
    const analysis = analysisFixture({
      recommendations: [
        { sort: "create" },
        { sort: "skip", reason: "Identical value already stored as ANON_KEY" },
        { sort: "create" },
      ],
    });
    expect(initialChoices(analysis)[1]!.choice).toBe("skip");
    expect(defaultChoice(undefined)).toBe("skip");
  });

  it("ticks only the relations the backend pre-selected", () => {
    const relations = initialRelations(analysisFixture());
    // Weak evidence is never auto-applied.
    expect([...relations]).toEqual([0]);
  });

  it("surfaces the matches belonging to one entity", () => {
    const analysis = analysisFixture();
    expect(matchesFor(analysis, 2)).toHaveLength(1);
    expect(matchesFor(analysis, 1)).toHaveLength(0);
  });

  it("counts what Save will actually write", () => {
    const choices: Record<number, EntityChoice> = {
      1: { choice: "save", targetSecretId: null, nameOverride: null },
      2: { choice: "skip", targetSecretId: null, nameOverride: null },
    };
    expect(countToSave(choices)).toBe(1);
  });
});

describe("buildSubmission", () => {
  it("maps each choice onto its backend decision", () => {
    const analysis = analysisFixture();
    const choices: Record<number, EntityChoice> = {
      1: { choice: "save", targetSecretId: null, nameOverride: null },
      2: { choice: "change", targetSecretId: "22222222-2222-4222-8222-222222222222", nameOverride: null },
    };
    const submission = buildSubmission(analysis, choices, new Set([0]), false, null);

    expect(submission.analysis_id).toBe(analysis.analysis_id);
    expect(submission.decisions).toEqual([
      { entity_index: 1, decision: { sort: "accept" }, name_override: null },
      {
        entity_index: 2,
        decision: { sort: "change", secret_id: "22222222-2222-4222-8222-222222222222" },
        name_override: null,
      },
    ]);
    expect(submission.accepted_relations).toEqual([0]);
    expect(submission.acknowledge_critical).toBe(false);
  });

  it("falls back to accept when Change was picked without a target", () => {
    const analysis = analysisFixture();
    const choices: Record<number, EntityChoice> = {
      2: { choice: "change", targetSecretId: null, nameOverride: null },
    };
    const submission = buildSubmission(analysis, choices, new Set(), false, null);
    expect(submission.decisions[0]!.decision).toEqual({ sort: "accept" });
  });

  it("carries a name override and a create-new override", () => {
    const analysis = analysisFixture();
    const choices: Record<number, EntityChoice> = {
      2: { choice: "create_new", targetSecretId: null, nameOverride: "SERVICE_KEY" },
    };
    const submission = buildSubmission(analysis, choices, new Set(), true, "proj-1");
    expect(submission.decisions[0]).toEqual({
      entity_index: 2,
      decision: { sort: "create_new" },
      name_override: "SERVICE_KEY",
    });
    expect(submission.acknowledge_critical).toBe(true);
    expect(submission.target_project_id).toBe("proj-1");
  });

  it("emits accepted relations in a stable order", () => {
    const analysis = analysisFixture();
    const submission = buildSubmission(analysis, {}, new Set([1, 0]), false, null);
    expect(submission.accepted_relations).toEqual([0, 1]);
  });
});

describe("describeChoice", () => {
  it("explains what each choice will do", () => {
    expect(describeChoice("save", { sort: "create" })).toMatch(/new secret/i);
    expect(describeChoice("save", { sort: "update", secret_id: "x" })).toMatch(/replace/i);
    expect(describeChoice("skip", { sort: "skip", reason: "Already stored as K" })).toBe(
      "Already stored as K",
    );
    expect(describeChoice("create_new", { sort: "update", secret_id: "x" })).toMatch(/new secret/i);
    expect(describeChoice("change", { sort: "create" })).toMatch(/overwrite/i);
  });
});

describe("open questions", () => {
  it("starts each question on its recommended candidate", () => {
    const analysis = analysisFixture();
    const answers = initialAnswers(analysis);
    expect(answers["project"]!.selection).toBe(0);
    expect(answers["organization"]!.selection).toBe(0);
  });

  it("starts an optional question with no candidates at unknown", () => {
    const analysis = analysisFixture({
      questions: [
        {
          id: "organization",
          kind: "which_organization",
          prompt: "Which organization?",
          candidates: [],
          allow_free_text: true,
          required: false,
        },
      ],
    });
    expect(initialAnswers(analysis)["organization"]!.selection).toBe("unknown");
  });

  it("turns the recommended candidate into a new_named answer", () => {
    const analysis = analysisFixture();
    const answers = buildAnswers(analysis, initialAnswers(analysis));
    expect(answers).toEqual([
      { question_id: "project", choice: { sort: "new_named", name: "Acme Storefront" } },
      { question_id: "organization", choice: { sort: "new_named", name: "AcmeOrg" } },
    ]);
  });

  it("uses an existing entity when the candidate points at one", () => {
    const analysis = analysisFixture({
      questions: [
        {
          id: "project",
          kind: "which_project",
          prompt: "Which project?",
          candidates: [
            {
              existing: { kind: "project", id: "33333333-3333-4333-8333-333333333333" },
              label: "Existing Project",
              reason: "An existing project",
              recommended: true,
            },
          ],
          allow_free_text: true,
          required: true,
        },
      ],
    });
    const answers = buildAnswers(analysis, initialAnswers(analysis));
    expect(answers[0]!.choice).toEqual({
      sort: "existing",
      entity: { kind: "project", id: "33333333-3333-4333-8333-333333333333" },
    });
  });

  it("starts on the project the paste was made in, over the recommendation", () => {
    const inside = "44444444-4444-4444-8444-444444444444";
    const analysis = analysisFixture({
      questions: [
        {
          id: "project",
          kind: "which_project",
          prompt: "Which project?",
          candidates: [
            {
              existing: { kind: "project", id: "33333333-3333-4333-8333-333333333333" },
              label: "Recommended",
              reason: "",
              recommended: true,
            },
            { existing: { kind: "project", id: inside }, label: "Open project", reason: "", recommended: false },
          ],
          allow_free_text: true,
          required: true,
        },
      ],
    });
    const answers = buildAnswers(analysis, initialAnswers(analysis, inside));
    expect(answers[0]!.choice).toEqual({ sort: "existing", entity: { kind: "project", id: inside } });
    // And the chain names it, rather than saying the project was not stated.
    expect(targetProjectLabel(analysis, inside)).toBe("Open project");
    expect(targetProjectLabel(analysis, null)).toBeNull();
  });

  it("carries a typed name through as new_named", () => {
    const analysis = analysisFixture();
    const answers = buildAnswers(analysis, {
      project: { selection: "free", freeText: "  Typed Name  " },
      organization: { selection: "unknown", freeText: "" },
    });
    expect(answers).toEqual([
      { question_id: "project", choice: { sort: "new_named", name: "Typed Name" } },
      { question_id: "organization", choice: { sort: "unknown" } },
    ]);
  });

  it("drops a free-text answer that is still empty", () => {
    const analysis = analysisFixture();
    const answers = buildAnswers(analysis, {
      project: { selection: "free", freeText: "   " },
      organization: { selection: 0, freeText: "" },
    });
    expect(answers.map((a) => a.question_id)).toEqual(["organization"]);
  });

  it("reports a required question that is unanswered or explicitly unknown", () => {
    const analysis = analysisFixture();
    expect(unansweredRequired(analysis, initialAnswers(analysis))).toHaveLength(0);

    const blank = unansweredRequired(analysis, {
      project: { selection: "free", freeText: "" },
      organization: { selection: 0, freeText: "" },
    });
    expect(blank.map((q) => q.id)).toEqual(["project"]);

    // An optional question left unknown is fine; a required one is not.
    const unknown = unansweredRequired(analysis, {
      project: { selection: "unknown", freeText: "" },
      organization: { selection: "unknown", freeText: "" },
    });
    expect(unknown.map((q) => q.id)).toEqual(["project"]);
  });

  it("includes the answers in the submission", () => {
    const analysis = analysisFixture();
    const submission = buildSubmission(
      analysis,
      {},
      new Set(),
      false,
      null,
      initialAnswers(analysis),
    );
    expect(submission.answers).toHaveLength(2);
    expect(submission.answers[0]!.question_id).toBe("project");
  });
});
