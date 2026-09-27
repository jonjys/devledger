import { describe, expect, it } from "vitest";

import { pasteHints } from "./pasteHints";

describe("paste hints", () => {
  it("counts .env lines and names the keys it recognises", () => {
    const text = [
      "RESEND_API_KEY=re_exampleNotReal123",
      "export STRIPE_SECRET_KEY=sk_test_exampleNotReal",
      "# a comment",
      "DATABASE_URL=postgres://user:pass@localhost:5432/db",
    ].join("\n");
    expect(pasteHints(text)).toEqual([
      { label: ".env variables", count: 3 },
      { label: "Resend API key", count: 1 },
      { label: "Stripe secret key", count: 1 },
      { label: "Postgres URL", count: 1 },
    ]);
  });

  it("tells an Anthropic key from an OpenAI one", () => {
    expect(pasteHints("sk-ant-api03-exampleNotReal").map((h) => h.label)).toEqual(["Anthropic key"]);
    expect(pasteHints("sk-proj-exampleNotRealExample").map((h) => h.label)).toEqual(["OpenAI key"]);
  });

  it("accepts resend_ as well as re_", () => {
    expect(pasteHints("resend_exampleNotReal")[0]?.label).toBe("Resend API key");
  });

  it("says nothing about text it does not recognise", () => {
    expect(pasteHints("just some notes about the project")).toEqual([]);
  });
});
