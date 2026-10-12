// The web app's vault: what lands in the browser's storage, and what it takes to open it.

import type { AuditEntry } from "../../lib/types";
import { emptyDb } from "../demo/seed";
import { BrowserVault, STORAGE_KEY, WrongPassphrase, type Backing } from "./store";

const PASS = "correct horse battery staple";
const VALUE = ["sk", "live", "FAKE0000WEBVAULT1111NOTREAL"].join("_");

function memory(): Backing & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return { raw, get: (k) => raw.get(k) ?? null, set: (k, v) => void raw.set(k, v) };
}

function contents() {
  const db = emptyDb();
  db.values.set("k1", VALUE);
  db.projects.push({
    id: "p1",
    name: "Shop",
    description: null,
    created_at: "2026-10-12T00:00:00Z",
    updated_at: "2026-10-12T00:00:00Z",
  } as never);
  const audit: AuditEntry[] = [];
  return { db, audit };
}

describe("browser vault", () => {
  it("stores only ciphertext, and opens again with the passphrase", async () => {
    const backing = memory();
    const vault = new BrowserVault(backing);
    expect(vault.exists()).toBe(false);
    await vault.create(PASS, contents());

    const stored = backing.raw.get(STORAGE_KEY)!;
    expect(stored).not.toContain(VALUE);
    expect(stored).not.toContain("Shop");
    expect(JSON.parse(stored)).toMatchObject({ v: 1, kdf: "pbkdf2-sha256", rounds: 600_000 });

    vault.close();
    const opened = await new BrowserVault(backing).open(PASS);
    expect(opened.db.values.get("k1")).toBe(VALUE);
    expect(opened.db.projects[0]!.name).toBe("Shop");
  });

  it("refuses a wrong passphrase and never replaces an existing vault", async () => {
    const backing = memory();
    const vault = new BrowserVault(backing);
    await vault.create(PASS, contents());
    await expect(new BrowserVault(backing).open("not the passphrase at all")).rejects.toBeInstanceOf(
      WrongPassphrase,
    );
    await expect(new BrowserVault(backing).create(PASS, contents())).rejects.toThrow(/already exists/);
  });

  it("seals each save with a fresh IV and cannot save once closed", async () => {
    const backing = memory();
    const vault = new BrowserVault(backing);
    await vault.create(PASS, contents());
    const first = JSON.parse(backing.raw.get(STORAGE_KEY)!).iv;
    await vault.save(contents());
    expect(JSON.parse(backing.raw.get(STORAGE_KEY)!).iv).not.toBe(first);
    vault.close();
    await expect(vault.save(contents())).rejects.toThrow(/locked/);
  });
});
