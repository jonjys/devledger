import { describe, expect, it } from "vitest";

import { environmentLabel, plural, secretKindLabel, severityRank } from "./format";

describe("formatting helpers", () => {
  it("labels every secret kind", () => {
    expect(secretKindLabel("supabase_service_role_key")).toBe("Supabase service_role key");
    expect(secretKindLabel("github_token")).toBe("GitHub token");
    expect(secretKindLabel(null)).toBe("Value");
  });

  it("hides the unknown environment rather than printing it", () => {
    expect(environmentLabel("production")).toBe("Production");
    expect(environmentLabel("unknown")).toBe("");
  });

  it("orders severities so critical sorts first", () => {
    expect(severityRank("critical")).toBeGreaterThan(severityRank("warning"));
    expect(severityRank("warning")).toBeGreaterThan(severityRank("info"));
  });

  it("pluralises counts", () => {
    expect(plural(1, "secret")).toBe("1 secret");
    expect(plural(3, "secret")).toBe("3 secrets");
    expect(plural(2, "entity", "entities")).toBe("2 entities");
  });
});
