// The browser demo's stand-in backend must answer the real UI with the shapes
// the Rust side sends, and must never pretend to do what only the desktop app can.

/// <reference types="vite/client" />

import * as api from "../../lib/api";
import apiSource from "../../lib/api.ts?raw";
import { BrowserVault, STORAGE_KEY } from "../app/store";
import {
  DEMO_COMMANDS,
  IDLE_LOCK_MS,
  handle,
  reset,
  runOnPersistentVault,
  setAssistantTransport,
  setClipboard,
} from "./backend";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => handle(command, args),
}));

/** Every command `lib/api.ts` can send, read from its source. */
const DESKTOP_COMMANDS = [...apiSource.matchAll(/call<[^>]*>\(\s*"([a-z_]+)"/g)].map((m) => m[1]!);

beforeEach(() => reset());

describe("demo backend", () => {
  it("answers every command the frontend can send", () => {
    expect(DESKTOP_COMMANDS.length).toBeGreaterThan(70);
    expect(DESKTOP_COMMANDS.filter((c) => !DEMO_COMMANDS.includes(c))).toEqual([]);
  });

  it("opens straight onto the sample vault, with one primary person", async () => {
    expect(await api.vaultStatus()).toEqual({ initialized: true, unlocked: true });
    const people = await api.ledgerOverview();
    expect(people.map((p) => p.identity.email)).toEqual(["demo@example.com", "weekend@example.org"]);
    const main = people[0]!;
    expect(main.projects.map((p) => p.name)).toEqual(["Make It Real", "Recipe Box"]);
    expect(main.secret_count).toBeGreaterThan(0);
    const supabase = main.accounts.find((a) => a.account.provider === "supabase")!;
    expect(supabase.organizations[0]!.organization.name).toBe("Demo Studio");
    expect(supabase.organizations[0]!.service_projects).toHaveLength(2);
  });

  it("uses only invented addresses and keys that say they are fake", async () => {
    for (const p of await api.ledgerOverview()) {
      for (const e of p.emails) expect(e.address).toMatch(/@example\.(com|org)$/);
    }
    for (const { entry } of await api.listAllSecrets()) {
      const value = await api.revealSecret(entry.secret.id);
      expect(value).toMatch(/demo|DEMO|example\.com/);
      expect(entry.secret).not.toHaveProperty("value");
    }
  });

  it("counts a project's secrets through the resources it uses", async () => {
    const [mir] = (await api.listProjects()).filter((p) => p.project.name === "Make It Real");
    const secrets = await api.listSecrets(mir!.project.id);
    expect(secrets).toHaveLength(mir!.secret_count);
    expect(mir!.providers).toEqual(expect.arrayContaining(["supabase", "github", "vercel", "stripe"]));
  });

  it("flags a resource that holds keys but no project uses", async () => {
    const items = await api.needsAttention();
    expect(items.map((i) => i.kind)).toEqual(["unlinked_service_project", "stale_secret", "trial_ending_soon"]);
  });

  it("words the date-based checks the way the vault does", async () => {
    const items = await api.needsAttention();
    expect(items.find((i) => i.kind === "stale_secret")!.title).toMatch(/^GITHUB_TOKEN has not changed in \d+ months$/);
    const trial = items.find((i) => i.kind === "trial_ending_soon")!;
    expect(trial.title).toBe("Plus trial on OpenAI ends in 5 days");
    expect(trial.detail).toBe(
      "It turns into 20.00 USD/month unless you cancel it with OpenAI. Removing it here does not cancel it.",
    );
    // A plain variable or an anon key is never "stale": rotating it protects nothing.
    expect(items.filter((i) => i.kind === "stale_secret")).toHaveLength(1);
  });

  it("asks whether one provider is paid for twice", async () => {
    await api.createSubscriptionManual({
      email: "weekend@example.org",
      provider: "vercel",
      plan: "Team",
      status: "active",
      amountCents: 4000,
      currency: "USD",
      interval: "monthly",
      renewsAt: null,
    });
    const twice = (await api.needsAttention()).filter((i) => i.kind === "paying_twice");
    expect(twice.map((i) => i.title)).toEqual(["You pay for Vercel 2 times"]);
    expect(twice[0]!.detail).toContain("Team on weekend@example.org");
  });

  it("creates, links and deletes like the vault does", async () => {
    const [person] = await api.listIdentities();
    const account = await api.createAccountManual(person!.id, "other:Fly.io", "Fly.io");
    const resource = await api.createServiceProjectManual(account.id, null, "other:Fly.io", "api", null, "production");
    const project = await api.createProject("New thing", null);
    await api.linkServiceProject(resource.id, project.id);
    await api.storeSecret(
      { owner: { project_id: null, service_project_id: resource.id, account_id: null }, kind: "generic_api_key", name: "FLY_TOKEN", environment: "production", notes: null },
      "demo-token",
    );
    expect((await api.listSecrets(project.id)).map((s) => s.secret.name)).toEqual(["FLY_TOKEN"]);

    await api.deleteAccount(account.id);
    expect(await api.listSecrets(project.id)).toEqual([]);
    expect((await api.listServiceProjects()).some((r) => r.service_project.id === resource.id)).toBe(false);
  });

  it("refuses an empty name with the vault's error code", async () => {
    await expect(api.createProject("  ", null)).rejects.toMatchObject({ code: "invalid" });
  });

  it("copies to the clipboard without returning the value", async () => {
    const copied: string[] = [];
    setClipboard(async (t) => void copied.push(t));
    const [first] = await api.listAllSecrets();
    expect(await api.copySecret(first!.entry.secret.id)).toBeUndefined();
    expect(copied).toHaveLength(1);
  });

  describe("environment export", () => {
    async function addVariable(projectId: string, name: string, value: string, environment: "production" | "development" = "production") {
      return api.storeSecret(
        { owner: { project_id: projectId, service_project_id: null, account_id: null }, kind: "env_var", name, environment, notes: null },
        value,
      );
    }

    it("sorts and quotes values exactly as the desktop exporter does", async () => {
      const copied = vi.fn(async (_text: string) => {});
      setClipboard(copied);
      const project = await api.createProject("Export formatting", null);
      for (const [name, value] of [
        ["z_VALUE", "plain"],
        ["PATH_LABEL", String.raw`C:\demo\files "A"`],
        ["HASH_LABEL", "Storefront#1"],
        ["APP_LABEL", "Synthetic Storefront"],
        ["BACKSLASH", String.raw`C:\demo\files`],
        ["_TOKEN", "synthetic"],
      ]) {
        await addVariable(project.id, name!, value!);
      }

      expect(await api.copyEnv(project.id, "production")).toBe(6);
      expect(copied).toHaveBeenCalledExactlyOnceWith([
        'APP_LABEL="Synthetic Storefront"',
        String.raw`BACKSLASH=C:\demo\files`,
        'HASH_LABEL="Storefront#1"',
        String.raw`PATH_LABEL="C:\\demo\\files \"A\""`,
        "_TOKEN=synthetic",
        "z_VALUE=plain",
        "",
      ].join("\n"));
    });

    it.each(["1TOKEN", "API-TOKEN", "A=B", "TOKEN\nOTHER"])("refuses invalid variable name %j without changing the clipboard", async (name) => {
      const copied = vi.fn(async (_text: string) => {});
      setClipboard(copied);
      const project = await api.createProject("Invalid name", null);
      await addVariable(project.id, name, "synthetic");
      await expect(api.copyEnv(project.id, null)).rejects.toMatchObject({ code: "invalid" });
      expect(copied).not.toHaveBeenCalled();
    });

    it.each(["first\nINJECTED=value", "first\rINJECTED=value", "first\r\nINJECTED=value"])("refuses line breaks in value %j without changing the clipboard", async (value) => {
      const copied = vi.fn(async (_text: string) => {});
      setClipboard(copied);
      const project = await api.createProject("Line break", null);
      await addVariable(project.id, "A_SAFE", "synthetic");
      await addVariable(project.id, "Z_UNSAFE", value);
      await expect(api.copyEnv(project.id, null)).rejects.toMatchObject({ code: "invalid" });
      expect(copied).not.toHaveBeenCalled();
    });

    it("deduplicates linked resources and refuses conflicting environments until one is chosen", async () => {
      const copied = vi.fn(async (_text: string) => {});
      setClipboard(copied);
      const project = await api.createProject("Scoped export", null);
      const [person] = await api.listIdentities();
      const account = await api.createAccountManual(person!.id, "supabase", "Export account");
      const resource = await api.createServiceProjectManual(account.id, null, "supabase", "Export database", null, "production");
      await api.linkServiceProject(resource.id, project.id);
      await api.storeSecret(
        { owner: { project_id: null, service_project_id: resource.id, account_id: null }, kind: "env_var", name: "DATABASE_URL", environment: "production", notes: null },
        "postgres://synthetic@example.com/production",
      );
      await addVariable(project.id, "DATABASE_URL", "postgres://synthetic@example.com/production");
      expect(await api.copyEnv(project.id, null)).toBe(1);
      expect(copied).toHaveBeenLastCalledWith("DATABASE_URL=postgres://synthetic@example.com/production\n");

      await addVariable(project.id, "DATABASE_URL", "postgres://synthetic@localhost/development", "development");
      copied.mockClear();
      await expect(api.copyEnv(project.id, null)).rejects.toMatchObject({ code: "invalid" });
      expect(copied).not.toHaveBeenCalled();
      expect(await api.copyEnv(project.id, "production")).toBe(1);
      expect(copied).toHaveBeenLastCalledWith("DATABASE_URL=postgres://synthetic@example.com/production\n");
      expect(await api.copyEnv(project.id, "development")).toBe(1);
      expect(copied).toHaveBeenLastCalledWith("DATABASE_URL=postgres://synthetic@localhost/development\n");
    });

    it("copies an empty string for a project without variables", async () => {
      const copied = vi.fn(async (_text: string) => {});
      setClipboard(copied);
      const project = await api.createProject("Empty export", null);
      expect(await api.copyEnv(project.id, null)).toBe(0);
      expect(copied).toHaveBeenCalledExactlyOnceWith("");
    });
  });

  it("sends the UI back to the gate when locked", async () => {
    await api.vaultLock();
    await expect(api.listProjects()).rejects.toMatchObject({ code: "vault_locked" });
    await api.vaultUnlock("any passphrase");
    expect(await api.listProjects()).not.toHaveLength(0);
  });

  it("says Smart Paste and connectors need the desktop app", async () => {
    await expect(api.analyzePaste("OPENAI_API_KEY=x")).rejects.toThrow(/desktop app/);
    await expect(api.connectorConnect("supabase", "sbp_x", "x")).rejects.toThrow(/desktop app/);
  });

  it("hands out copies, so the UI cannot change the store by accident", async () => {
    const [p] = await api.listProjects();
    p!.project.name = "changed";
    expect((await api.listProjects()).some((x) => x.project.name === "changed")).toBe(false);
  });

  it("calls a NEXT_PUBLIC_ variable public, and a key server-only whatever its name", async () => {
    const byName = new Map((await api.listAllSecrets()).map(({ entry }) => [entry.secret.name, entry]));
    expect(byName.get("NEXT_PUBLIC_SITE_URL")!.client_unsafe).toBe(false);
    expect(byName.get("STRIPE_SECRET_KEY")!.client_unsafe).toBe(true);
    const preview = await api.assistantPreview({ task: "review" });
    expect(preview.user.split("\n").find((l) => l.includes("NEXT_PUBLIC_SITE_URL"))).toContain("safe in client code");
  });

  it("sends the assistant an outline with no values, previews or addresses", async () => {
    const secrets = await api.listAllSecrets();
    const preview = await api.assistantPreview({ task: "review" });
    for (const { entry } of secrets) {
      expect(preview.user).not.toContain(await api.revealSecret(entry.secret.id));
      expect(preview.user).not.toContain(entry.secret.preview);
    }
    expect(preview.user).not.toMatch(/@example\.(com|org)/);
    expect(preview.user).toContain("STRIPE_SECRET_KEY");
    expect(preview.addresses_hidden).toBeGreaterThan(0);
  });

  it("asks through the site and puts the real addresses back", async () => {
    // Built at run time so the source never holds a key-shaped string.
    const pasted = ["sk", "live", "FAKE0000DEMO1111TEST2222"].join("_");
    let sent = "";
    setAssistantTransport(async (_task, user) => {
      sent = user;
      return { text: "Move it off <email-1>.", model: "claude-opus-5-5", input_tokens: 1, output_tokens: 1, truncated: false };
    });
    const answer = await api.assistantAsk({ task: "ask", question: `Is ${pasted} safe?` });
    expect(sent).not.toContain(pasted);
    expect(answer.text).toMatch(/Move it off \S+@example\.(com|org)\./);
  });
});

describe("web app vault", () => {
  const PASS = "a long enough passphrase";
  let raw: Map<string, string>;

  beforeEach(() => {
    raw = new Map();
    runOnPersistentVault(
      new BrowserVault({ get: (k) => raw.get(k) ?? null, set: (k, v) => void raw.set(k, v) }, { m: 8_192, t: 1, p: 1 }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    reset();
  });

  it("starts with no vault, then keeps what you add across a lock", async () => {
    expect(await api.vaultStatus()).toEqual({ initialized: false, unlocked: false });
    await expect(api.listProjects()).rejects.toMatchObject({ code: "vault_locked" });
    await expect(api.vaultInitialize("short")).rejects.toMatchObject({ code: "invalid" });

    await api.vaultInitialize(PASS);
    expect(await api.ledgerOverview()).toEqual([]);
    const shop = await api.createProject("Shop", "The web shop");
    expect(shop.id).not.toMatch(/^de300000-/);
    expect(raw.get(STORAGE_KEY)).not.toContain("Shop");

    await api.vaultLock();
    expect(await api.vaultStatus()).toEqual({ initialized: true, unlocked: false });
    await expect(api.vaultUnlock("this is the wrong one")).rejects.toMatchObject({ code: "invalid_passphrase" });
    await api.vaultUnlock(PASS);
    expect((await api.listProjects()).map((p) => p.project.name)).toEqual(["Shop"]);
  });

  it("keeps the layout in the encrypted vault, across a lock", async () => {
    await api.vaultInitialize(PASS);
    expect(await api.uiLayoutGet()).toEqual({ layout: null });
    await expect(api.uiLayoutSet("[1]")).rejects.toMatchObject({ code: "invalid" });
    await api.uiLayoutSet(JSON.stringify({ v: 1, boxes: [{ id: "n", kind: "note", text: "secret plan" }] }));
    expect(raw.get(STORAGE_KEY)).not.toContain("secret plan");
    await api.vaultLock();
    await api.vaultUnlock(PASS);
    expect((await api.uiLayoutGet()).layout).toContain("secret plan");
  });

  it("locks itself after 15 minutes without use", async () => {
    vi.useFakeTimers();
    await api.vaultInitialize(PASS);
    vi.advanceTimersByTime(IDLE_LOCK_MS + 1);
    expect(await api.vaultStatus()).toEqual({ initialized: true, unlocked: false });
  });
});
