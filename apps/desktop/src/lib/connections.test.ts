import { describe, expect, it } from "vitest";

import { reportFixture } from "../test/connect-fixtures";
import {
  byConnector,
  countToImport,
  groupReport,
  initialSelection,
  isSelectable,
  statusTone,
  summarise,
} from "./connections";
import type { ConnectionSummary } from "./types";

describe("import selection", () => {
  it("pre-ticks only what is safe to write", () => {
    const selected = initialSelection(reportFixture());
    // The two new rows and the one needing completion; never the conflict,
    // never the possible match, never something already matched.
    expect([...selected].sort()).toEqual([
      "aaaaaaaaaaaaaaaaaaaa",
      "cccccccccccccccccccc",
      "org_a",
    ]);
  });

  it("refuses to make a conflict or an already-matched row selectable", () => {
    const report = reportFixture();
    const conflict = report.items.find((i) => i.status === "conflict")!;
    const matched = report.items.find((i) => i.status === "matched")!;
    const fresh = report.items.find((i) => i.status === "unmatched")!;

    expect(isSelectable(conflict)).toBe(false);
    expect(isSelectable(matched)).toBe(false);
    expect(isSelectable(fresh)).toBe(true);
  });

  it("counts only rows that would actually be written", () => {
    const report = reportFixture();
    const selected = initialSelection(report);
    expect(countToImport(report, selected)).toBe(3);

    // Ticking a conflict does not increase the count.
    selected.add("dddddddddddddddddddd");
    expect(countToImport(report, selected)).toBe(3);
  });

  it("allows a possible match to be opted into", () => {
    const report = reportFixture();
    const selected = initialSelection(report);
    expect(selected.has("eeeeeeeeeeeeeeeeeeee")).toBe(false);
    selected.add("eeeeeeeeeeeeeeeeeeee");
    expect(countToImport(report, selected)).toBe(4);
  });
});

describe("report grouping", () => {
  it("nests projects under their organization", () => {
    const groups = groupReport(reportFixture());
    const acme = groups.find((g) => g.organization?.provider_id === "org_a");
    expect(acme).toBeDefined();
    expect(acme!.projects.map((p) => p.name)).toEqual([
      "Storefront",
      "Staging",
      "Legacy",
      "Shared",
    ]);
  });

  it("puts projects with no visible organization in their own group", () => {
    const groups = groupReport(reportFixture());
    const orphans = groups.find((g) => g.organization === null);
    expect(orphans).toBeDefined();
    expect(orphans!.projects.map((p) => p.name)).toEqual(["Orphan"]);
  });
});

describe("summaries", () => {
  it("reads as a sentence", () => {
    expect(summarise(reportFixture())).toBe(
      "2 new, 1 to complete, 1 possible, 1 already known, 1 in conflict",
    );
  });

  it("says so when there is nothing", () => {
    expect(
      summarise({
        connection_id: "x",
        items: [],
        matched: 0,
        unmatched: 0,
        possible: 0,
        conflicts: 0,
        needs_attention: 0,
      }),
    ).toBe("nothing found");
  });

  it("gives a conflict the alarming tone and a match the calm one", () => {
    expect(statusTone("conflict")).toBe("unsafe");
    expect(statusTone("matched")).toBe("explicit");
    expect(statusTone("unmatched")).toBe("strong");
  });
});

describe("byConnector", () => {
  it("groups several accounts under one provider", () => {
    const make = (id: string, label: string): ConnectionSummary => ({
      connection: {
        id,
        connector_id: "supabase",
        identity_id: `identity-${id}`,
        account_id: `account-${id}`,
        label,
        account_fingerprint: `fp-${id}`,
        created_at: "2026-09-16T00:00:00Z",
        last_checked_at: null,
      },
      identity_email: label,
      organization_count: 1,
      resource_count: 2,
    });

    const grouped = byConnector([make("1", "a@example.com"), make("2", "b@example.com")]);
    expect(grouped.size).toBe(1);
    expect(grouped.get("supabase")).toHaveLength(2);
  });
});
