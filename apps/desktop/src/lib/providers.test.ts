import { describe, expect, it } from "vitest";

import { catalogProviders, providerForName, providerInfo } from "./providers";

describe("provider registry", () => {
  it("never files a named catalog service as unknown", () => {
    // The backend renames `unknown` to whatever label was typed, so a card that
    // sent it filed a Cloudflare account under the user's email address.
    for (const info of catalogProviders()) {
      expect(info.provider).not.toBe("unknown");
    }
  });

  it("puts Supabase in the catalog like any other service", () => {
    expect(catalogProviders().map((p) => p.name)).toContain("Supabase");
  });

  it("looks a service up by tag, by name and by alias", () => {
    expect(providerInfo("other:Resend")?.name).toBe("Resend");
    expect(providerInfo("RESEND")?.provider).toBe("other:Resend");
    expect(providerInfo("claude")?.provider).toBe("anthropic");
    expect(providerInfo("github")?.icon?.title).toBe("GitHub");
  });

  it("keeps a name it has never heard of exactly as typed", () => {
    expect(providerForName("  My NAS ")).toBe("other:My NAS");
    expect(providerForName("")).toBe("unknown");
    expect(providerInfo("My NAS")).toBeNull();
  });
});
