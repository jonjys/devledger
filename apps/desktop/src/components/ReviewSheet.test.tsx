import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { analysisFixture } from "../test/fixtures";
import type { ReviewSubmission } from "../lib/types";
import ReviewSheet from "./ReviewSheet";

function renderSheet(analysis = analysisFixture()) {
  const onSave = vi.fn<(submission: ReviewSubmission) => void>();
  const onCancel = vi.fn();
  render(
    <ReviewSheet analysis={analysis} onSave={onSave} onCancel={onCancel} saving={false} />,
  );
  return { onSave, onCancel };
}

describe("ReviewSheet", () => {
  it("shows detected entities, their evidence and existing matches", () => {
    renderSheet();

    expect(screen.getByText("NEXT_PUBLIC_SUPABASE_ANON_KEY")).toBeInTheDocument();
    expect(screen.getByText("SUPABASE_SERVICE_ROLE_KEY")).toBeInTheDocument();
    expect(screen.getByText("JWT payload declares role=service_role")).toBeInTheDocument();
    expect(screen.getByText(/Different value stored in my-project/)).toBeInTheDocument();
  });

  it("marks a service_role key as server-only but not an anon key", () => {
    renderSheet();
    // One "server only" tag, on the service_role row.
    expect(screen.getAllByText("server only")).toHaveLength(1);
  });

  it("never renders a raw secret value, only the masked preview", () => {
    const analysis = analysisFixture();
    renderSheet(analysis);
    // The fixture's previews are masked; assert the ellipsis survived and that
    // no full JWT body appears anywhere in the tree.
    expect(screen.getAllByText("eyJh…bGRlcg").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
  });

  it("shows the redacted provenance excerpt that will be stored", () => {
    renderSheet();
    expect(screen.getByText("NEXT_PUBLIC_SUPABASE_ANON_KEY=[REDACTED:JWT]")).toBeInTheDocument();
  });

  it("pre-ticks strong relations and leaves weak ones for the user", () => {
    renderSheet();
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();
  });

  it("submits the default decisions when Save is pressed", async () => {
    const user = userEvent.setup();
    const { onSave } = renderSheet();

    await user.click(screen.getByRole("button", { name: /^Save 2$/ }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const submission = onSave.mock.calls[0]![0];
    expect(submission.decisions).toEqual([
      { entity_index: 1, decision: { sort: "accept" }, name_override: null },
      { entity_index: 2, decision: { sort: "accept" }, name_override: null },
    ]);
    expect(submission.accepted_relations).toEqual([0]);
    expect(submission.acknowledge_critical).toBe(false);
  });

  it("drops an entity from the save count when it is skipped", async () => {
    const user = userEvent.setup();
    const { onSave } = renderSheet();

    const row = screen.getByText("SUPABASE_SERVICE_ROLE_KEY").closest(".entity");
    expect(row).not.toBeNull();
    await user.click(within(row as HTMLElement).getByRole("button", { name: "Skip" }));

    await user.click(screen.getByRole("button", { name: /^Save 1$/ }));
    const submission = onSave.mock.calls[0]![0];
    expect(submission.decisions).toContainEqual({
      entity_index: 2,
      decision: { sort: "skip" },
      name_override: null,
    });
  });

  it("routes Change onto the matched secret", async () => {
    const user = userEvent.setup();
    const { onSave } = renderSheet();

    const row = screen.getByText("SUPABASE_SERVICE_ROLE_KEY").closest(".entity");
    await user.click(within(row as HTMLElement).getByRole("button", { name: "Change" }));
    await user.click(screen.getByRole("button", { name: /^Save 2$/ }));

    const submission = onSave.mock.calls[0]![0];
    expect(submission.decisions).toContainEqual({
      entity_index: 2,
      decision: { sort: "change", secret_id: "22222222-2222-4222-8222-222222222222" },
      name_override: null,
    });
  });

  it("offers Change only where an existing match was found", () => {
    renderSheet();
    const anon = screen.getByText("NEXT_PUBLIC_SUPABASE_ANON_KEY").closest(".entity");
    expect(
      within(anon as HTMLElement).queryByRole("button", { name: "Change" }),
    ).not.toBeInTheDocument();
  });

  it("blocks Save behind an acknowledgement when a finding is critical", async () => {
    const user = userEvent.setup();
    const analysis = analysisFixture({
      blocks_save: true,
      warnings: [
        {
          code: "server_secret_in_client_variable",
          severity: "critical",
          title: "Supabase service_role key is exposed to the browser",
          detail: "Rename the variable and rotate the credential.",
          entity_indexes: [2],
        },
      ],
    });
    const { onSave } = renderSheet(analysis);

    expect(screen.getByText(/exposed to the browser/)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: /^Save 2$/ });
    expect(save).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /understand the risk/i }));
    expect(save).toBeEnabled();

    await user.click(save);
    expect(onSave.mock.calls[0]![0].acknowledge_critical).toBe(true);
  });

  it("cancels without saving", async () => {
    const user = userEvent.setup();
    const { onCancel, onSave } = renderSheet();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});
