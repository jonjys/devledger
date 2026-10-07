// The browser demo's stand-in backend must answer the real UI with the shapes
// the Rust side sends, and must never pretend to do what only the desktop app can.

/// <reference types="vite/client" />

import * as api from "../../lib/api";
import apiSource from "../../lib/api.ts?raw";
import { DEMO_COMMANDS, handle, reset, setClipboard } from "./backend";

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
    expect(items.map((i) => i.kind)).toEqual(["unlinked_service_project"]);
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
});
