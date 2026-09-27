import { describe, expect, it } from "vitest";

import {
  environmentLabel,
  environmentName,
  isCustomProvider,
  plural,
  providerFromInput,
  providerLabel,
  secretHeadline,
  secretKindColumn,
  secretKindLabel,
  severityRank,
} from "./format";

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

  it("names an unassigned environment instead of leaving a blank", () => {
    expect(environmentName("unknown")).toBe("Unassigned");
    expect(environmentName("staging")).toBe("Staging");
  });
});

describe("providers", () => {
  it("labels known providers, including the spelling an older build sent", () => {
    expect(providerLabel("github")).toBe("GitHub");
    expect(providerLabel("git_hub")).toBe("GitHub");
    expect(providerLabel("openai")).toBe("OpenAI");
  });

  it("labels a custom service by the name the user gave it", () => {
    expect(providerLabel("other:Loopia")).toBe("Loopia");
    expect(isCustomProvider("other:Loopia")).toBe(true);
    expect(isCustomProvider("supabase")).toBe(false);
  });

  it("turns what the user typed into the same tag the backend would", () => {
    expect(providerFromInput("Supabase")).toBe("supabase");
    expect(providerFromInput("  GITHUB ")).toBe("github");
    expect(providerFromInput("My NAS")).toBe("other:My NAS");
    expect(providerFromInput("")).toBe("unknown");
  });
});

describe("secret rows", () => {
  it("leads with the name where the kind says nothing", () => {
    expect(secretHeadline("env_var", "DATABASE_URL", false)).toEqual({
      title: "DATABASE_URL",
      sub: null,
    });
    expect(secretHeadline("password", "Login", false).title).toBe("Login");
  });

  it("leads with a meaningful kind in Indie mode, keeping the name visible", () => {
    expect(secretHeadline("stripe_secret_key", "STRIPE_SECRET_KEY", false)).toEqual({
      title: "Stripe secret key",
      sub: "STRIPE_SECRET_KEY",
    });
  });

  it("never prints the word Unknown in the kind column", () => {
    expect(secretKindColumn("env_var", "unknown", false)).toBe("Environment variable");
    expect(secretKindColumn("stripe_secret_key", "stripe", false)).toBe("Stripe");
  });
});

describe("provider names from the registry", () => {
  it("files a known service by its alias and a catalog service by its own name", () => {
    expect(providerFromInput("Claude")).toBe("anthropic");
    expect(providerFromInput("resend")).toBe("other:Resend");
    expect(providerFromInput("cloudflare")).toBe("other:Cloudflare");
  });
});

describe("secret kinds as the backend spells them", () => {
  it("labels git_hub_token and open_ai_api_key like their canonical spellings", () => {
    expect(secretKindLabel("git_hub_token")).toBe("GitHub token");
    expect(secretKindLabel("open_ai_api_key")).toBe("OpenAI API key");
  });
});
